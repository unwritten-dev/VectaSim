//! `landing_analysis`: loads everything the landing debrief needs (track,
//! touchdowns, runways around the touchdown point, METAR) and runs the pure
//! analysis in `vectasim_core::landing`.
//!
//! `landing_facts_recent`: the touchdown point of the last landings for the dispersion
//! view, from the same runway match and analysis, cached per touchdown in the store.
//!
//! Wind: the METAR stored with the flight at the landing (see
//! `online::capture_metar`) when there is one for this touchdown, otherwise the
//! current METAR – but only for landings less than 2 h old. The report's own
//! observation time ("DDHHMMZ") is resolved against the touchdown and handed to the
//! UI, which flags a report more than 60 min from the landing.
//!
//! Runways: OurAirports gives the coordinates of the runway ends; a displaced threshold
//! (`le/he_displaced_threshold_ft`) moves the landing threshold that far along the axis,
//! the far end stays the opposite runway end (so the length is the distance available
//! from the threshold). 59 % of the OurAirports runways have no coordinates, so the match
//! goes runways set by the pilot (`user_runways` source `user`, they override the database
//! runway of the same designator) and database → remembered runways derived from earlier
//! landings → derived from this landing's track ([`resolve_runway`]); derived geometry
//! is marked as such (`RunwayMatch::source`, no centreline offset, ±50 m touchdown distance).

use crate::manager::ProviderManager;
use crate::online::{OnlineState, metar_candidates, nearest_report};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use vectasim_core::approach::AircraftRef;
use vectasim_core::landing::{
    self, AirportHint, LandingAnalysis, LandingConfig, LandingSample, RunwayEnd, RunwayGeometry, RunwayGeometrySource, RunwayHint, WindInput,
    derive_runway_from_track,
};
use vectasim_core::{LandingRateSource, TouchdownReport};
use vectasim_data::{Airport, AirportIndex, Runway};
use vectasim_online::Metar;
use vectasim_store::store::{LandingFactCache, RecentLanding};
use vectasim_store::{
    FlightRow, RunwayRefinement, Store, TrackSample, UserRunway, UserRunwayEdit, UserRunwaySource, icao_from_atc_model, normalize_registration,
    resolve_registration,
};

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
    /// Observation time of `metar` (its "DDHHMMZ" group nearest to the touchdown), Unix ms.
    pub metar_observed_ms: Option<u64>,
    /// Threshold displacement of the matched runway end from the database, m (None = none).
    pub threshold_displaced_m: Option<f64>,
}

pub(crate) fn to_sample(s: &TrackSample) -> LandingSample {
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

/// Displacement of a runway end in metres (None for none/unknown).
fn displaced_m(ft: Option<i32>) -> Option<f64> {
    ft.filter(|v| *v > 0).map(|v| v as f64 * FT_TO_M)
}

/// Displaced threshold of the end that lands on `ident` of database runway `r`, m.
pub(crate) fn threshold_displacement_m(r: &Runway, ident: &str) -> Option<f64> {
    if r.le_ident == ident { displaced_m(r.le_displaced_threshold_ft) } else { displaced_m(r.he_displaced_threshold_ft) }
}

/// Both landing directions of every runway with coordinates near the point. A displaced
/// threshold moves the threshold along the axis; `end` stays the opposite runway end.
pub(crate) fn runway_ends_near(airports: &AirportIndex, lat: f64, lon: f64) -> Vec<(RunwayEnd, Runway)> {
    let dlon = RUNWAY_SEARCH_DEG / lat.to_radians().cos().max(0.2);
    let mut out = Vec::new();
    for a in airports.in_bbox(lon - dlon, lat - RUNWAY_SEARCH_DEG, lon + dlon, lat + RUNWAY_SEARCH_DEG, 60) {
        for r in airports.runways(&a.ident) {
            let (Some(le_lat), Some(le_lon), Some(he_lat), Some(he_lon)) = (r.le_latitude, r.le_longitude, r.he_latitude, r.he_longitude) else {
                continue;
            };
            let width_m = r.width_ft.map(|w| w as f64 * FT_TO_M).unwrap_or(0.0);
            // geometry from the coordinates (length_m 0): the diagram and distances use the same runway
            let base = RunwayEnd { airport: a.ident.clone(), width_m, surface: r.surface.clone(), length_m: 0.0, ..Default::default() };
            let threshold = |lat: f64, lon: f64, to_lat: f64, to_lon: f64, disp: Option<f64>| match disp {
                Some(d) => landing::point_along(lat, lon, to_lat, to_lon, d),
                None => (lat, lon),
            };
            let (lt_lat, lt_lon) = threshold(le_lat, le_lon, he_lat, he_lon, displaced_m(r.le_displaced_threshold_ft));
            let (ht_lat, ht_lon) = threshold(he_lat, he_lon, le_lat, le_lon, displaced_m(r.he_displaced_threshold_ft));
            out.push((
                RunwayEnd {
                    ident: r.le_ident.clone(),
                    opposite_ident: r.he_ident.clone(),
                    threshold_lat: lt_lat,
                    threshold_lon: lt_lon,
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
                    threshold_lat: ht_lat,
                    threshold_lon: ht_lon,
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

// ---- runway resolution: database → remembered → derived ---------------------------------

/// A touchdown this close to an airport (nm) may derive a runway for it.
const DERIVE_AIRPORT_NM: f64 = 3.0;

/// A runway the analyses can match, with what is known about it.
#[derive(Clone, Debug)]
pub(crate) struct RunwayCandidate {
    pub end: RunwayEnd,
    /// OurAirports record of this runway (declared length/width), also for remembered and
    /// derived runways whose designator it has.
    pub db: Option<Runway>,
    pub geometry: RunwayGeometry,
    /// The remembered derived runway this candidate is (refined by further landings).
    pub derived_row: Option<UserRunway>,
}

fn search_box(lat: f64) -> (f64, f64) {
    (RUNWAY_SEARCH_DEG, RUNWAY_SEARCH_DEG / lat.to_radians().cos().max(0.2))
}

/// Provider of demo (mock) and replayed flights: nothing is learnt from them.
fn is_demo(provider: Option<&str>) -> bool {
    matches!(provider, Some("mock" | "replay"))
}

/// What OurAirports knows about the runways of an airport, for the derivation.
fn airport_hint(airports: &AirportIndex, icao: &str) -> AirportHint {
    let ft = |v: Option<i32>| v.filter(|x| *x > 0).map(|x| x as f64 * FT_TO_M);
    AirportHint {
        icao: icao.to_string(),
        runways: airports
            .runways(icao)
            .iter()
            .map(|r| RunwayHint {
                le_ident: r.le_ident.clone(),
                he_ident: r.he_ident.clone(),
                le_heading_deg: r.le_heading_deg,
                he_heading_deg: r.he_heading_deg,
                length_m: ft(r.length_ft),
                width_m: ft(r.width_ft),
                surface: r.surface.clone(),
                has_coordinates: r.le_latitude.is_some() && r.le_longitude.is_some() && r.he_latitude.is_some() && r.he_longitude.is_some(),
            })
            .collect(),
    }
}

/// OurAirports runway of `icao` that has `ident` at one of its ends.
fn db_runway(airports: &AirportIndex, icao: &str, ident: &str) -> Option<Runway> {
    airports.runways(icao).iter().find(|r| r.le_ident.eq_ignore_ascii_case(ident) || r.he_ident.eq_ignore_ascii_case(ident)).cloned()
}

/// A remembered runway as candidate(s): the stored direction, plus the reverse one for a
/// runway the pilot set (both of its ends are thresholds).
fn user_candidates(airports: &AirportIndex, row: &UserRunway) -> Vec<RunwayCandidate> {
    let db = db_runway(airports, &row.airport_icao, &row.ident);
    let geometry = match row.source {
        UserRunwaySource::User => RunwayGeometry::user(),
        UserRunwaySource::Derived => {
            // designator confirmed by a coordinate-less database runway
            let confirmed = db.as_ref().is_some_and(|r| r.le_latitude.is_none() || r.he_latitude.is_none());
            let source = if confirmed { RunwayGeometrySource::DatabaseDerived } else { RunwayGeometrySource::Derived };
            RunwayGeometry::derived(source, row.length_estimated, row.uses)
        }
    };
    let surface = db.as_ref().map(|r| r.surface.clone()).unwrap_or_default();
    let elevation = row.elevation_ft.or_else(|| airports.get(&row.airport_icao).and_then(|a| a.elevation_ft).map(f64::from));
    let mut out = vec![RunwayCandidate {
        end: RunwayEnd { surface: surface.clone(), elevation_ft: elevation, ..row.runway_end() },
        db: db.clone(),
        geometry: geometry.clone(),
        derived_row: (row.source == UserRunwaySource::Derived).then(|| row.clone()),
    }];
    if let Some(rev) = row.reverse_end() {
        out.push(RunwayCandidate {
            db: db_runway(airports, &row.airport_icao, &rev.ident).or(db),
            end: RunwayEnd { surface, elevation_ft: elevation, ..rev },
            geometry,
            derived_row: None,
        });
    }
    out
}

/// Remembered runways (`user_runways`) around a point.
pub(crate) fn user_runways_near(store: &Store, airports: &AirportIndex, lat: f64, lon: f64) -> Vec<RunwayCandidate> {
    let (dlat, dlon) = search_box(lat);
    match store.user_runways_near(lat, lon, dlat, dlon) {
        Ok(rows) => rows.iter().flat_map(|r| user_candidates(airports, r)).collect(),
        Err(e) => {
            log::warn!("remembered runways: {e}");
            Vec::new()
        }
    }
}

fn pick(cands: &[RunwayCandidate], td: &TouchdownReport, cfg: &LandingConfig) -> Option<RunwayCandidate> {
    let ends: Vec<RunwayEnd> = cands.iter().map(|c| c.end.clone()).collect();
    landing::match_runway(td.latitude, td.longitude, td.heading_true_deg, &ends, cfg).map(|(i, _)| cands[i].clone())
}

/// Runway of touchdown `index`: runways the pilot set (`user_runways` source `user`; one
/// replaces the OurAirports runway with the same designator at either end) together with
/// OurAirports with coordinates → remembered derived runways → derived from the track
/// ([`landing::derive_runway_from_track`], for the nearest airport within 3 nm). `track` is
/// only loaded when neither the pilot's nor the database runways match.
/// With `remember` (flight id; finished, non-demo flights only) a derived runway is stored
/// on its first landing and a remembered derived one refined by every further landing
/// (each landing counted once). None: nothing to match and nothing to derive from.
pub(crate) fn resolve_runway(
    store: &Store,
    airports: &AirportIndex,
    touchdowns: &[TouchdownReport],
    index: usize,
    track: impl FnOnce() -> Vec<LandingSample>,
    remember: Option<&str>,
) -> Option<RunwayCandidate> {
    let td = touchdowns.get(index)?;
    let cfg = LandingConfig::default();
    let (user, derived): (Vec<RunwayCandidate>, Vec<RunwayCandidate>) = user_runways_near(store, airports, td.latitude, td.longitude)
        .into_iter()
        .partition(|c| c.geometry.source == RunwayGeometrySource::User);
    // a runway the pilot set overrides the database one it names (both of its ends are candidates)
    let overridden = |e: &RunwayEnd| user.iter().any(|u| u.end.airport.eq_ignore_ascii_case(&e.airport) && u.end.ident.eq_ignore_ascii_case(&e.ident));
    let mut first = user.clone();
    first.extend(
        runway_ends_near(airports, td.latitude, td.longitude)
            .into_iter()
            .filter(|(end, _)| !overridden(end))
            .map(|(end, r)| RunwayCandidate { end, db: Some(r), geometry: RunwayGeometry::database(), derived_row: None }),
    );
    if let Some(c) = pick(&first, td, &cfg) {
        return Some(c);
    }
    let samples = track();
    if let Some(c) = pick(&derived, td, &cfg) {
        let Some((row, flight_id)) = c.derived_row.as_ref().zip(remember) else { return Some(c) };
        // a further landing on a remembered derived runway refines it
        let estimate = derive_runway_from_track(&samples, td, &airport_hint(airports, &row.airport_icao)).filter(|d| d.rollout_complete);
        let Some(d) = estimate else { return Some(c) };
        let observed = RunwayEnd { airport: row.airport_icao.clone(), ident: row.ident.clone(), ..d.end };
        return match store.refine_derived_runway(&observed, d.geometry.length_estimated, flight_id, index as u32) {
            Ok(r) => {
                if matches!(r, RunwayRefinement::Refined(_)) {
                    log::info!("runway {} {} refined ({} landings)", row.airport_icao, row.ident, r.runway().uses);
                }
                user_candidates(airports, r.runway()).into_iter().next().or(Some(c))
            }
            Err(e) => {
                log::warn!("refining runway {} {}: {e}", row.airport_icao, row.ident);
                Some(c)
            }
        };
    }
    let airport = airports.nearest(td.latitude, td.longitude, DERIVE_AIRPORT_NM)?.airport;
    let d = derive_runway_from_track(&samples, td, &airport_hint(airports, &airport.ident))?;
    if let Some(flight_id) = remember.filter(|_| d.rollout_complete) {
        match store.refine_derived_runway(&d.end, d.geometry.length_estimated, flight_id, index as u32) {
            Ok(RunwayRefinement::Inserted(r)) => {
                log::info!("runway {} {} derived from the track and remembered", r.airport_icao, r.ident);
                // landings there that matched nothing before may match it now
                if let Err(e) = store.invalidate_runway_facts(None) {
                    log::warn!("landing facts cache: {e}");
                }
            }
            Ok(other) => log::info!("derived runway {} {} not stored: {other:?}", d.end.airport, d.end.ident),
            Err(e) => log::warn!("storing derived runway {} {}: {e}", d.end.airport, d.end.ident),
        }
    }
    let mut end = d.end;
    if end.elevation_ft.is_none() {
        end.elevation_ft = airport.elevation_ft.map(f64::from);
    }
    Some(RunwayCandidate { db: db_runway(airports, &airport.ident, &end.ident), end, geometry: d.geometry, derived_row: None })
}

fn wind_of(m: &Metar) -> Option<WindInput> {
    m.wind.as_ref().map(|w| WindInput {
        direction_deg: w.direction_deg.map(f64::from),
        speed_kt: w.speed_kt as f64,
        gust_kt: w.gust_kt.map(f64::from),
        variable_from_deg: w.variable_from_deg.map(f64::from),
        variable_to_deg: w.variable_to_deg.map(f64::from),
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

/// What the logbook knows about the aircraft of a flight: the Vapp the pilot entered for the
/// airframe it is booked onto (fleet). Without one the analyses fall back to the flown median.
pub(crate) fn aircraft_ref(store: &Store, flight_id: &str) -> AircraftRef {
    let vapp_kt = store.flight_vapp_kt(flight_id).unwrap_or_else(|e| {
        log::warn!("airframe Vapp of flight {flight_id}: {e}");
        None
    });
    AircraftRef { vapp_kt, ..Default::default() }
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
    // flight, track (decoding blocks) and the active-flight check off the async worker threads
    let (detail, mut track, active, aircraft) = {
        let store = store.inner().clone();
        let id = flight_id.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let detail = store.get_flight(&id).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
            let track = store.get_track(&id).map_err(|e| e.to_string())?.unwrap_or_default();
            let active = store.active_flight_id().ok().flatten().as_deref() == Some(id.as_str());
            Ok((detail, track, active, aircraft_ref(&store, &id)))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    if detail.touchdowns.is_empty() {
        return Err("Für diesen Flug wurde keine Landung aufgezeichnet.".into());
    }
    let index = touchdown_index.unwrap_or(detail.touchdowns.len() - 1).min(detail.touchdowns.len() - 1);
    let td = detail.touchdowns[index].clone();

    // a running flight is flushed periodically; the live buffer is fresher
    if active {
        let live = manager.live_track();
        if live.len() > track.len() {
            track = live;
        }
    }
    let samples: Vec<LandingSample> = track.iter().map(to_sample).collect();

    let cfg = LandingConfig::default();
    // database → remembered → derived; learning only from finished, non-demo flights
    let remember = (!active && !is_demo(detail.flight.provider.as_deref())).then(|| flight_id.clone());
    let matched: Option<RunwayCandidate> = {
        let (store, airports, touchdowns, samples) = (store.inner().clone(), airports.inner().clone(), detail.touchdowns.clone(), samples.clone());
        tauri::async_runtime::spawn_blocking(move || resolve_runway(&store, &airports, &touchdowns, index, move || samples, remember.as_deref()))
            .await
            .map_err(|e| e.to_string())?
    };

    let airport = match &matched {
        Some(c) => airports.get(&c.end.airport).cloned(),
        None => airports.nearest(td.latitude, td.longitude, NEAREST_AIRPORT_NM).map(|n| n.airport),
    };
    let runway_data = matched.as_ref().and_then(|c| c.db.clone());

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
    let metar_observed_ms = metar.as_ref().and_then(|m| m.time.as_deref()).and_then(|t| vectasim_online::metar::observation_ms(t, td.timestamp_ms));
    // displaced thresholds are database facts: only with database geometry
    let threshold_displaced_m = matched
        .as_ref()
        .filter(|c| c.geometry.source == RunwayGeometrySource::Database)
        .and_then(|c| threshold_displacement_m(c.db.as_ref()?, &c.end.ident));

    // only the matched end goes in, so the analysis uses exactly that runway
    let rwy: Vec<RunwayEnd> = matched.iter().map(|c| c.end.clone()).collect();
    let mut analysis =
        landing::analyze_with(&samples, &detail.touchdowns, index, &rwy, wind.as_ref(), &aircraft, &cfg).ok_or("Landung nicht gefunden")?;
    if let Some(c) = &matched {
        landing::apply_runway_geometry(&mut analysis, &c.geometry);
    }

    Ok(LandingDebrief {
        touchdown_count: detail.touchdowns.len(),
        flight: detail.flight,
        analysis,
        airport,
        runway_data,
        metar,
        metar_at_landing,
        metar_note,
        metar_observed_ms,
        threshold_displaced_m,
    })
}

// ---- dispersion ---------------------------------------------------------------------

/// Version of the cached facts; bump when the runway match or the touchdown point
/// changes so old rows are recomputed.
/// 2: touchdown zone from the threshold, displaced thresholds.
/// 3: remembered and track-derived runways (fields without coordinates), geometry source.
const LANDING_FACTS_VERSION: u32 = 3;
const FACTS_DEFAULT_LIMIT: u32 = 20;
const FACTS_MAX_LIMIT: u32 = 200;
/// Landings looked at to find `limit` with a runway (unmatched ones are skipped).
const FACTS_SCAN_MAX: u32 = 1000;

/// One evaluated landing: where it touched down on its runway.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingFact {
    pub flight_id: String,
    /// Index within the flight's touchdowns (as `landing_analysis` takes it).
    pub touchdown_index: u32,
    pub timestamp_ms: u64,
    pub airport_icao: String,
    pub runway_ident: String,
    pub aircraft_icao_type: Option<String>,
    pub aircraft_title: Option<String>,
    pub registration: Option<String>,
    /// Headline landing rate, fpm, negative = descending.
    pub landing_rate_fpm: f64,
    pub landing_rate_source: LandingRateSource,
    pub peak_g: f64,
    pub bounces: u32,
    /// Along the runway from the threshold, metres (negative = before it).
    pub touchdown_distance_m: f64,
    /// ± metres of `touchdown_distance_m` (derived threshold); None = database/user geometry.
    pub touchdown_distance_uncertainty_m: Option<f64>,
    /// Signed metres from the centreline in landing direction: negative = left, positive = right.
    /// None = not measurable (runway derived from the own track).
    pub centerline_offset_m: Option<f64>,
    pub in_touchdown_zone: bool,
    /// Where the runway geometry comes from.
    pub runway_source: RunwayGeometrySource,
    pub provider: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandingFactsResult {
    /// Newest first.
    pub facts: Vec<LandingFact>,
    /// Landings looked at but left out because no runway matched.
    pub skipped: u32,
}

/// Runway match and touchdown point of one touchdown – the same resolution and analysis as
/// `landing_analysis` (the touchdown point needs neither track nor wind; the track is only
/// decoded when the database has no runway, to derive one).
fn compute_fact(store: &Store, airports: &AirportIndex, flight: &FlightRow, touchdowns: &[TouchdownReport], index: usize) -> LandingFactCache {
    let none = LandingFactCache { version: LANDING_FACTS_VERSION, ..Default::default() };
    let load = || store.get_track(&flight.id).ok().flatten().unwrap_or_default().iter().map(to_sample).collect();
    let remember = (!is_demo(flight.provider.as_deref())).then_some(flight.id.as_str());
    let Some(c) = resolve_runway(store, airports, touchdowns, index, load, remember) else { return none };
    let cfg = LandingConfig::default();
    let mut analysis = landing::analyze(&[], touchdowns, index, std::slice::from_ref(&c.end), None, &cfg);
    if let Some(a) = analysis.as_mut() {
        landing::apply_runway_geometry(a, &c.geometry);
    }
    match analysis.as_ref().and_then(|a| Some((a.runway.as_ref()?, a.touchdown_point.as_ref()?))) {
        Some((r, tp)) => LandingFactCache {
            version: LANDING_FACTS_VERSION,
            matched: true,
            airport_icao: Some(r.airport.clone()),
            runway_ident: Some(r.ident.clone()),
            touchdown_distance_m: Some(tp.distance_m),
            centerline_offset_m: tp.lateral_measurable.then_some(tp.lateral_m),
            in_touchdown_zone: tp.in_tdz,
            runway_source: Some(r.geometry.source.as_str().to_string()),
        },
        None => none,
    }
}

fn to_fact(l: &RecentLanding, c: &LandingFactCache) -> Option<LandingFact> {
    let f = &l.flight;
    let non_empty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
    let source = c.runway_source.as_deref().and_then(RunwayGeometrySource::parse).unwrap_or_default();
    Some(LandingFact {
        flight_id: f.id.clone(),
        touchdown_index: l.touchdown_index,
        timestamp_ms: l.touchdown.timestamp_ms,
        airport_icao: c.airport_icao.clone()?,
        runway_ident: c.runway_ident.clone()?,
        aircraft_icao_type: icao_from_atc_model(&f.aircraft.atc_model),
        aircraft_title: non_empty(&f.aircraft.title),
        registration: f
            .airframe_reg
            .as_deref()
            .and_then(normalize_registration)
            .or_else(|| resolve_registration(None, Some(&f.aircraft.atc_id))),
        landing_rate_fpm: l.touchdown.landing_rate_fpm,
        landing_rate_source: l.touchdown.landing_rate_source,
        peak_g: l.touchdown.peak_g,
        bounces: l.touchdown.bounces,
        touchdown_distance_m: c.touchdown_distance_m?,
        touchdown_distance_uncertainty_m: source.is_derived().then_some(landing::DERIVED_ALONG_UNCERTAINTY_M),
        centerline_offset_m: c.centerline_offset_m,
        in_touchdown_zone: c.in_touchdown_zone,
        runway_source: source,
        provider: f.provider.clone(),
    })
}

/// Touchdown points of the last `limit` (default 20) full-stop landings of completed
/// flights that matched a runway, newest first. Facts missing from the cache (or of an
/// older version) are computed and stored on the way.
#[tauri::command]
pub async fn landing_facts_recent(
    limit: Option<u32>,
    include_demo: Option<bool>,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<LandingFactsResult, String> {
    let limit = limit.unwrap_or(FACTS_DEFAULT_LIMIT).clamp(1, FACTS_MAX_LIMIT) as usize;
    let (store, airports) = (store.inner().clone(), airports.inner().clone());
    let include_demo = include_demo.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || facts_recent(&store, &airports, limit, include_demo)).await.map_err(|e| e.to_string())?
}

fn facts_recent(store: &Store, airports: &AirportIndex, limit: usize, include_demo: bool) -> Result<LandingFactsResult, String> {
    let landings = store.recent_landings(FACTS_SCAN_MAX, include_demo).map_err(|e| e.to_string())?;
    let mut facts = Vec::with_capacity(limit);
    let mut skipped = 0u32;
    for l in &landings {
        if facts.len() >= limit {
            break;
        }
        let cached = match &l.cached {
            Some(c) if c.version == LANDING_FACTS_VERSION => c.clone(),
            _ => {
                let touchdowns = store.get_flight(&l.flight.id).map_err(|e| e.to_string())?.map(|d| d.touchdowns).unwrap_or_default();
                let c = compute_fact(store, airports, &l.flight, &touchdowns, l.touchdown_index as usize);
                if let Err(e) = store.put_landing_fact(&l.flight.id, l.touchdown_index, &c) {
                    log::warn!("landing facts cache: {e}");
                }
                c
            }
        };
        match cached.matched.then(|| to_fact(l, &cached)).flatten() {
            Some(f) => facts.push(f),
            None => skipped += 1,
        }
    }
    Ok(LandingFactsResult { facts, skipped })
}

// ---- remembered runways ----------------------------------------------------------------

/// Remembered runways of an airport (derived from the own landings or set by the pilot).
#[tauri::command]
pub async fn list_user_runways(icao: String, store: State<'_, Store>) -> Result<Vec<UserRunway>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.list_user_runways(&icao)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

/// Save a runway the pilot set or corrected (threshold, far end, designator; `previousIdent`
/// renames). Stored as `user`: it wins over a derived one and is never changed by landings.
/// Cached landing/approach facts at that airport are recomputed on the next read.
#[tauri::command]
pub async fn save_user_runway(edit: UserRunwayEdit, store: State<'_, Store>) -> Result<UserRunway, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = store.upsert_user_runway(&edit, UserRunwaySource::User).map_err(|e| e.to_string())?;
        store.invalidate_runway_facts(Some(&r.airport_icao)).map_err(|e| e.to_string())?;
        Ok(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forget a remembered runway; the next landing there derives it afresh. False if none.
#[tauri::command]
pub async fn delete_user_runway(icao: String, ident: String, store: State<'_, Store>) -> Result<bool, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deleted = store.delete_user_runway(&icao, &ident).map_err(|e| e.to_string())?;
        if deleted {
            store.invalidate_runway_facts(Some(&icao)).map_err(|e| e.to_string())?;
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displaced_threshold_moves_along_the_runway() {
        let airports = AirportIndex::load();
        let r = airports.runways("KLAX").iter().find(|r| r.le_ident == "6R").expect("KLAX 6R").clone();
        let (le_lat, le_lon, he_lat, he_lon) = (r.le_latitude.unwrap(), r.le_longitude.unwrap(), r.he_latitude.unwrap(), r.he_longitude.unwrap());
        let ends = runway_ends_near(&airports, le_lat, le_lon);
        let six_r = &ends.iter().find(|(e, _)| e.airport == "KLAX" && e.ident == "6R").expect("6R end").0;
        // 530 ft = 161.5 m from the runway end, towards the opposite end; the far end stays the 24L runway end
        let moved = vectasim_data::haversine_nm(le_lat, le_lon, six_r.threshold_lat, six_r.threshold_lon) * 1852.0;
        assert!((moved - 530.0 * FT_TO_M).abs() < 1.0, "{moved}");
        assert_eq!((six_r.end_lat, six_r.end_lon), (he_lat, he_lon));
        let (x, y) = landing::RunwayFrame::new(&RunwayEnd { threshold_lat: le_lat, threshold_lon: le_lon, end_lat: he_lat, end_lon: he_lon, ..Default::default() })
            .project(six_r.threshold_lat, six_r.threshold_lon);
        assert!((x - 161.5).abs() < 1.0 && y.abs() < 0.5, "{x} {y}");
        assert_eq!(threshold_displacement_m(&r, "6R").map(|m| m.round()), Some(162.0));
        assert_eq!(threshold_displacement_m(&r, "24L").map(|m| m.round()), Some(244.0));
        // no displacement: the threshold is the runway end
        let eddf = airports.runways("EDDF").iter().find(|r| r.le_ident == "07C").unwrap();
        assert_eq!(threshold_displacement_m(eddf, "25C"), None);
    }

    /// Straight-in landing at 1 Hz touching down at (lat, lon) on true course `course`:
    /// 60 s on a 3° path at 65 kt, then braking at 1.5 m/s² below 30 kt.
    fn landing_at(lat: f64, lon: f64, course: f64, t0: u64) -> (Vec<LandingSample>, TouchdownReport) {
        let gs0 = 65.0 * 0.514_444;
        let mut out = Vec::new();
        for k in -60i64..0 {
            let d = gs0 * k as f64; // negative = before the touchdown point
            let (la, lo) = landing::offset_point(lat, lon, course, d);
            let h = (-d * 3f64.to_radians().tan() / 0.3048).max(0.0);
            out.push(LandingSample {
                t_ms: (t0 as i64 + k * 1000) as u64,
                latitude: la,
                longitude: lo,
                altitude_msl_ft: 500.0 + h,
                altitude_agl_ft: h,
                ground_speed_kt: 65.0,
                ias_kt: 65.0,
                vertical_speed_fpm: -350.0,
                heading_true_deg: course,
                on_ground: false,
                flaps_index: 2,
                gear_pct: 100.0,
                ..Default::default()
            });
        }
        let (mut x, mut gs) = (0.0, gs0);
        for k in 0..60u64 {
            let (la, lo) = landing::offset_point(lat, lon, course, x);
            out.push(LandingSample {
                t_ms: t0 + k * 1000,
                latitude: la,
                longitude: lo,
                altitude_msl_ft: 500.0,
                ground_speed_kt: gs / 0.514_444,
                ias_kt: gs / 0.514_444,
                heading_true_deg: course,
                on_ground: true,
                gear_pct: 100.0,
                ..Default::default()
            });
            x += gs;
            gs = (gs - 1.5).max(0.0);
        }
        let td = TouchdownReport {
            timestamp_ms: t0,
            vs_fpm_measured: -180.0,
            vs_fpm_sim: -180.0,
            vs_fpm_hardest: -180.0,
            peak_g: 1.1,
            pitch_deg: 3.0,
            bank_deg: 0.0,
            ground_speed_kt: 65.0,
            heading_true_deg: course,
            latitude: lat,
            longitude: lon,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: -180.0,
            landing_rate_source: LandingRateSource::Sim,
        };
        (out, td)
    }

    /// A German field whose only runway has no coordinates, with no known runway nearby
    /// that a landing on its course could match: (icao, ident, course, lat, lon).
    fn field_without_coordinates(airports: &AirportIndex) -> (String, String, f64, f64, f64) {
        for a in airports.in_bbox(6.0, 47.5, 14.5, 54.5, 100_000) {
            let rwys = airports.runways(&a.ident);
            let [r] = rwys else { continue };
            if r.le_latitude.is_some() || r.he_latitude.is_some() || r.length_ft.is_none() {
                continue;
            }
            let Some(n) = landing::ident_number(&r.le_ident) else { continue };
            let course = r.le_heading_deg.unwrap_or(n as f64 * 10.0);
            if airports.nearest(a.latitude, a.longitude, DERIVE_AIRPORT_NM).map(|n| n.airport.ident) != Some(a.ident.clone()) {
                continue;
            }
            let ends: Vec<RunwayEnd> = runway_ends_near(airports, a.latitude, a.longitude).into_iter().map(|(e, _)| e).collect();
            if landing::match_runway(a.latitude, a.longitude, course, &ends, &LandingConfig::default()).is_some() {
                continue;
            }
            return (a.ident.clone(), r.le_ident.clone(), course, a.latitude, a.longitude);
        }
        panic!("no field without runway coordinates found");
    }

    #[test]
    fn runway_is_derived_remembered_refined_and_overridden_by_the_pilot() {
        let airports = AirportIndex::load();
        let store = Store::open_in_memory().unwrap();
        let (icao, ident, course, lat, lon) = field_without_coordinates(&airports);
        let (track, td) = landing_at(lat, lon, course, 1_000_000);
        let tds = [td];

        // live flight: derived, but nothing stored
        let c = resolve_runway(&store, &airports, &tds, 0, || track.clone(), None).expect("derived");
        assert_eq!((c.end.airport.as_str(), c.end.ident.as_str()), (icao.as_str(), ident.as_str()));
        assert_eq!(c.geometry.source, RunwayGeometrySource::DatabaseDerived, "designator and length from OurAirports");
        assert!(c.db.is_some() && !c.geometry.length_estimated);
        assert!(store.list_user_runways(&icao).unwrap().is_empty());

        // finished flight: remembered on the first landing, counted once
        let c = resolve_runway(&store, &airports, &tds, 0, || track.clone(), Some("f1")).unwrap();
        assert_eq!(c.geometry.derived_from_landings, Some(1));
        let rows = store.list_user_runways(&icao).unwrap();
        assert_eq!((rows.len(), rows[0].uses, rows[0].source), (1, 1, UserRunwaySource::Derived));
        resolve_runway(&store, &airports, &tds, 0, || track.clone(), Some("f1")).unwrap();
        assert_eq!(store.list_user_runways(&icao).unwrap()[0].uses, 1);

        // the fact of that landing: matched, centreline not measurable, distance with uncertainty
        let mut flight = FlightRow { id: "f1".into(), ..Default::default() };
        let fact = compute_fact(&store, &airports, &flight, &tds, 0);
        assert!(fact.matched && fact.centerline_offset_m.is_none(), "{fact:?}");
        assert_eq!(fact.runway_source.as_deref(), Some("databaseDerived"));
        // the aiming point of the declared length (150–400 m), or less on a short strip
        assert!(fact.touchdown_distance_m.is_some_and(|d| (0.0..=401.0).contains(&d)), "{fact:?}");

        // a second landing 60 m further down the runway refines the remembered one
        let (la, lo) = landing::offset_point(lat, lon, course, 60.0);
        let (track2, td2) = landing_at(la, lo, course, 5_000_000);
        let c2 = resolve_runway(&store, &airports, &[td2], 0, || track2.clone(), Some("f2")).unwrap();
        assert_eq!(c2.geometry.derived_from_landings, Some(2));
        let row = store.list_user_runways(&icao).unwrap().remove(0);
        assert_eq!(row.uses, 2);
        let moved = landing::RunwayFrame::new(&c.end).project(row.lat_thr, row.lon_thr);
        assert!((moved.0 - 30.0).abs() < 5.0 && moved.1.abs() < 2.0, "threshold moved {moved:?}");

        // the pilot sets the runway: it wins and is not refined any more
        let thr = landing::offset_point(lat, lon, course, -250.0);
        let far = landing::offset_point(lat, lon, course, 450.0);
        let edit = UserRunwayEdit {
            airport_icao: icao.clone(),
            ident: ident.clone(),
            lat_thr: thr.0,
            lon_thr: thr.1,
            lat_end: far.0,
            lon_end: far.1,
            width_m: Some(20.0),
            ..Default::default()
        };
        store.upsert_user_runway(&edit, UserRunwaySource::User).unwrap();
        let c3 = resolve_runway(&store, &airports, &tds, 0, || track.clone(), Some("f3")).unwrap();
        assert_eq!(c3.geometry, RunwayGeometry::user());
        assert_eq!(c3.end.width_m, 20.0);
        flight.id = "f3".into();
        let fact = compute_fact(&store, &airports, &flight, &tds, 0);
        assert_eq!(fact.runway_source.as_deref(), Some("user"));
        assert!(fact.centerline_offset_m.is_some_and(|y| y.abs() < 1.0), "measurable against the pilot's runway");
        assert!(fact.touchdown_distance_m.is_some_and(|d| (d - 250.0).abs() < 1.0));
        assert_eq!(store.list_user_runways(&icao).unwrap()[0].uses, 2, "not refined");

        // landing the other way round matches the reverse end of the pilot's runway
        let (track4, td4) = landing_at(far.0, far.1, course + 180.0, 9_000_000);
        let c4 = resolve_runway(&store, &airports, &[td4], 0, || track4.clone(), Some("f4")).unwrap();
        assert_eq!((c4.end.ident.clone(), c4.geometry.source), (landing::opposite_ident(&ident), RunwayGeometrySource::User));

        // demo flights never teach
        assert!(is_demo(Some("mock")) && is_demo(Some("replay")) && !is_demo(Some("msfs")) && !is_demo(None));
    }

    #[test]
    fn a_runway_set_by_the_pilot_overrides_the_database_one() {
        let airports = AirportIndex::load();
        let store = Store::open_in_memory().unwrap();
        let ends = runway_ends_near(&airports, 50.0379, 8.5622);
        let end = |ident: &str| ends.iter().find(|(e, _)| e.airport == "EDDF" && e.ident == ident).map(|(e, _)| e.clone()).expect(ident);
        let (c07, c07r) = (end("07C"), end("07R"));
        let frame = landing::RunwayFrame::new(&c07);
        // touchdown 400 m behind the database threshold of 07C
        let (lat, lon) = landing::offset_point(c07.threshold_lat, c07.threshold_lon, frame.heading_deg, 400.0);
        let (track, td) = landing_at(lat, lon, frame.heading_deg, 1_000_000);
        let c = resolve_runway(&store, &airports, std::slice::from_ref(&td), 0, || track.clone(), Some("f1")).unwrap();
        assert_eq!((c.end.ident.as_str(), c.geometry.source), ("07C", RunwayGeometrySource::Database));

        // the pilot moves the threshold of 07C 100 m further down: it wins over OurAirports
        let thr = landing::offset_point(c07.threshold_lat, c07.threshold_lon, frame.heading_deg, 100.0);
        let edit = UserRunwayEdit {
            airport_icao: "EDDF".into(),
            ident: "07C".into(),
            lat_thr: thr.0,
            lon_thr: thr.1,
            lat_end: c07.end_lat,
            lon_end: c07.end_lon,
            width_m: Some(45.0),
            ..Default::default()
        };
        store.upsert_user_runway(&edit, UserRunwaySource::User).unwrap();
        let c = resolve_runway(&store, &airports, std::slice::from_ref(&td), 0, || panic!("no track needed"), Some("f1")).unwrap();
        assert_eq!((c.end.ident.as_str(), c.geometry.source), ("07C", RunwayGeometrySource::User));
        let x = landing::RunwayFrame::new(&c.end).project(lat, lon).0;
        assert!((x - 300.0).abs() < 1.0, "{x}");
        // the reverse end (25C) is the pilot's too
        let (track25, td25) = landing_at(c07.end_lat, c07.end_lon, frame.heading_deg + 180.0, 2_000_000);
        let c = resolve_runway(&store, &airports, &[td25], 0, || track25.clone(), None).unwrap();
        assert_eq!((c.end.ident.as_str(), c.geometry.source), ("25C", RunwayGeometrySource::User));

        // the parallel runway still comes from the database
        let f7r = landing::RunwayFrame::new(&c07r);
        let (la, lo) = landing::offset_point(c07r.threshold_lat, c07r.threshold_lon, f7r.heading_deg, 400.0);
        let (track7r, td7r) = landing_at(la, lo, f7r.heading_deg, 3_000_000);
        let c = resolve_runway(&store, &airports, &[td7r], 0, || track7r.clone(), None).unwrap();
        assert_eq!((c.end.ident.as_str(), c.geometry.source), ("07R", RunwayGeometrySource::Database));

        // forgetting it falls back to the database
        assert!(store.delete_user_runway("EDDF", "07C").unwrap());
        let c = resolve_runway(&store, &airports, &[td], 0, || track.clone(), None).unwrap();
        assert_eq!(c.geometry.source, RunwayGeometrySource::Database);
    }
}
