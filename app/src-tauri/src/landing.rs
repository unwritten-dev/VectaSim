//! `landing_analysis`: loads everything the landing debrief needs (track,
//! touchdowns, runways around the touchdown point, METAR) and runs the pure
//! analysis in `vectasim_core::landing`.
//!
//! Wind: the METAR stored with the flight at the landing (see
//! `online::capture_metar`) when there is one for this touchdown, otherwise the
//! current METAR – but only for landings less than 2 h old.

use crate::manager::ProviderManager;
use crate::online::{OnlineState, metar_candidates, nearest_report};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use vectasim_core::landing::{self, LandingAnalysis, LandingConfig, LandingSample, RunwayEnd, WindInput};
use vectasim_data::{Airport, AirportIndex, Runway};
use vectasim_online::Metar;
use vectasim_store::{FlightRow, Store, TrackSample};

/// The METAR describes the weather now; for older landings it says nothing about the wind then.
const METAR_MAX_LANDING_AGE_MS: u64 = 2 * 3600 * 1000;
/// A stored METAR describes a touchdown captured within this time of it (touch-and-goes
/// share the flight's one arrival METAR).
const STORED_METAR_MAX_GAP_MS: u64 = 90 * 60 * 1000;
const METAR_TIMEOUT: Duration = Duration::from_secs(5);
/// Search box around the touchdown for candidate runways (thresholds can be far from the ARP).
const RUNWAY_SEARCH_DEG: f64 = 0.08;
const NEAREST_AIRPORT_NM: f64 = 5.0;
const FT_TO_M: f64 = 0.3048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingDebrief {
    pub flight: FlightRow,
    pub touchdown_count: usize,
    pub analysis: LandingAnalysis,
    /// Airport of the matched runway, else the nearest within 5 nm.
    pub airport: Option<Airport>,
    /// Database record of the matched runway (declared length/width in ft).
    pub runway_data: Option<Runway>,
    pub metar: Option<Metar>,
    /// True when `metar` is the one stored at the landing, false when it is the current one.
    pub metar_at_landing: bool,
    /// Why no METAR wind was used, if none was, or where it came from.
    pub metar_note: Option<String>,
}

fn to_sample(s: &TrackSample) -> LandingSample {
    LandingSample {
        t_ms: s.t_ms,
        latitude: s.latitude,
        longitude: s.longitude,
        altitude_msl_ft: s.altitude_msl_ft,
        altitude_agl_ft: s.altitude_agl_ft,
        ground_speed_kt: s.ground_speed_kt,
        ias_kt: s.ias_kt,
        vertical_speed_fpm: s.vertical_speed_fpm,
        heading_true_deg: s.heading_true_deg,
        pitch_deg: s.pitch_deg,
        bank_deg: s.bank_deg,
        g_force: s.g_force,
        on_ground: s.on_ground,
        flaps_index: s.flaps_index,
        gear_pct: s.gear_pct,
    }
}

/// Both landing directions of every runway with coordinates near the point.
fn runway_ends_near(airports: &AirportIndex, lat: f64, lon: f64) -> Vec<(RunwayEnd, Runway)> {
    let dlon = RUNWAY_SEARCH_DEG / lat.to_radians().cos().max(0.2);
    let mut out = Vec::new();
    for a in airports.in_bbox(lon - dlon, lat - RUNWAY_SEARCH_DEG, lon + dlon, lat + RUNWAY_SEARCH_DEG, 60) {
        for r in airports.runways(&a.ident) {
            let (Some(le_lat), Some(le_lon), Some(he_lat), Some(he_lon)) = (r.le_latitude, r.le_longitude, r.he_latitude, r.he_longitude) else {
                continue;
            };
            let width_m = r.width_ft.map(|w| w as f64 * FT_TO_M).unwrap_or(0.0);
            // geometry from the thresholds (length_m 0): the diagram and distances use the same runway
            let base = RunwayEnd { airport: a.ident.clone(), width_m, surface: r.surface.clone(), length_m: 0.0, ..Default::default() };
            out.push((
                RunwayEnd {
                    ident: r.le_ident.clone(),
                    opposite_ident: r.he_ident.clone(),
                    threshold_lat: le_lat,
                    threshold_lon: le_lon,
                    end_lat: he_lat,
                    end_lon: he_lon,
                    ..base.clone()
                },
                r.clone(),
            ));
            out.push((
                RunwayEnd {
                    ident: r.he_ident.clone(),
                    opposite_ident: r.le_ident.clone(),
                    threshold_lat: he_lat,
                    threshold_lon: he_lon,
                    end_lat: le_lat,
                    end_lon: le_lon,
                    ..base
                },
                r.clone(),
            ));
        }
    }
    out
}

fn wind_of(m: &Metar) -> Option<WindInput> {
    m.wind.as_ref().map(|w| WindInput {
        direction_deg: w.direction_deg.map(f64::from),
        speed_kt: w.speed_kt as f64,
        gust_kt: w.gust_kt.map(f64::from),
    })
}

/// Note for a report from another station than the landing airport.
fn neighbour_note(airports: &AirportIndex, m: &Metar, a: &Airport) -> Option<String> {
    if m.station == a.ident {
        return None;
    }
    let d = airports.get(&m.station).map(|s| vectasim_data::haversine_nm(a.latitude, a.longitude, s.latitude, s.longitude));
    Some(match d {
        Some(d) => format!("{} hat keine METAR – Wind von {} ({} nm entfernt)", a.ident, m.station, d.round()),
        None => format!("Wind von {}", m.station),
    })
}

/// Landing debrief for one touchdown of a flight (default: the last one).
#[tauri::command]
pub async fn landing_analysis(
    flight_id: String,
    touchdown_index: Option<usize>,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
    online: State<'_, OnlineState>,
    manager: State<'_, ProviderManager>,
) -> Result<LandingDebrief, String> {
    let detail = store.get_flight(&flight_id).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
    if detail.touchdowns.is_empty() {
        return Err("Für diesen Flug wurde keine Landung aufgezeichnet.".into());
    }
    let index = touchdown_index.unwrap_or(detail.touchdowns.len() - 1).min(detail.touchdowns.len() - 1);
    let td = detail.touchdowns[index].clone();

    let mut track = store.get_track(&flight_id).map_err(|e| e.to_string())?.unwrap_or_default();
    // a running flight is flushed periodically; the live buffer is fresher
    if store.active_flight_id().ok().flatten().as_deref() == Some(flight_id.as_str()) {
        let live = manager.live_track();
        if live.len() > track.len() {
            track = live;
        }
    }
    let samples: Vec<LandingSample> = track.iter().map(to_sample).collect();

    let cfg = LandingConfig::default();
    let candidates = runway_ends_near(&airports, td.latitude, td.longitude);
    let ends: Vec<RunwayEnd> = candidates.iter().map(|(e, _)| e.clone()).collect();
    let matched = landing::match_runway(td.latitude, td.longitude, td.heading_true_deg, &ends, &cfg).map(|(i, _)| i);

    let airport = match matched {
        Some(i) => airports.get(&ends[i].airport).cloned(),
        None => airports.nearest(td.latitude, td.longitude, NEAREST_AIRPORT_NM).map(|n| n.airport),
    };
    let runway_data = matched.map(|i| candidates[i].1.clone());

    let age_ms = vectasim_core::now_ms().saturating_sub(td.timestamp_ms);
    let stored = match (&detail.flight.arr_metar, detail.flight.arr_metar_ms) {
        (Some(raw), Some(at)) if at.abs_diff(td.timestamp_ms) <= STORED_METAR_MAX_GAP_MS => {
            let mut m = vectasim_online::metar::decode(raw);
            m.source = "logbook".into();
            Some(m)
        }
        _ => None,
    };
    let metar_at_landing = stored.is_some();
    let (metar, metar_note) = match (&airport, stored) {
        (Some(a), Some(m)) => {
            let note = neighbour_note(&airports, &m, a);
            (Some(m), note)
        }
        (None, Some(m)) => (Some(m), None),
        (None, None) => (None, Some("Kein Flugplatz in der Nähe – keine METAR".to_string())),
        (Some(_), None) if age_ms > METAR_MAX_LANDING_AGE_MS => (
            None,
            Some("Keine METAR von der Landung gespeichert, und die Landung liegt über 2 h zurück – die aktuelle sagt nichts über den Wind beim Aufsetzen".to_string()),
        ),
        (Some(a), None) => match tokio::time::timeout(METAR_TIMEOUT, online.metar.get_many(&metar_candidates(&airports, a))).await {
            // nearest station that reports: the airport itself, else a neighbour (small fields often have none)
            Ok(Ok(found)) => match nearest_report(&airports, found, a) {
                Some((m, _)) => {
                    let note = neighbour_note(&airports, &m, a);
                    (Some(m), note)
                }
                None => (None, Some(format!("Für {} und Umgebung gibt es keine METAR", a.ident))),
            },
            Ok(Err(e)) => {
                log::warn!("METAR for landing debrief: {e}");
                (None, Some("METAR nicht abrufbar (offline?)".to_string()))
            }
            Err(_) => (None, Some("METAR-Abruf hat zu lange gedauert".to_string())),
        },
    };
    let wind = metar.as_ref().and_then(wind_of);

    // only the matched end goes in, so the analysis uses exactly that runway
    let rwy: Vec<RunwayEnd> = matched.map(|i| vec![ends[i].clone()]).unwrap_or_default();
    let analysis = landing::analyze(&samples, &detail.touchdowns, index, &rwy, wind.as_ref(), &cfg).ok_or("Landung nicht gefunden")?;

    Ok(LandingDebrief {
        touchdown_count: detail.touchdowns.len(),
        flight: detail.flight,
        analysis,
        airport,
        runway_data,
        metar,
        metar_at_landing,
        metar_note,
    })
}
