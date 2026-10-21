//! `approach_analysis`: every approach of a flight (touchdowns and go-arounds) from the
//! stored 1 Hz track, the phase events and the touchdowns, with the runways around each
//! approach's end point – the pure assessment in `vectasim_core::approach`.
//!
//! `approach_facts_recent`: the flat facts of the last approaches for the flight strip and
//! the approach scatter, cached per flight in `approach_facts` (versioned, filled lazily
//! here and right after a flight ends by [`spawn_store_facts`]).
//!
//! Track decoding costs a few ms per flight, so both commands run on a blocking thread.

use crate::landing::{aircraft_ref, resolve_runway, runway_ends_near, to_sample, user_runways_near};
use crate::manager::ProviderManager;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use vectasim_core::approach::{
    self, ApproachAnalysis, ApproachBand, ApproachConfig, ApproachSample, ElevationSource, GoAroundSource, LateralBand, PhaseMark,
};
use vectasim_core::landing::{CriterionKind, LandingSample, RunwayEnd, RunwayGeometry, RunwayGeometrySource};
use vectasim_data::AirportIndex;
use vectasim_store::{
    APPROACH_FACTS_VERSION, ApproachFactRow, FlightRow, RecentApproaches, Store, TrackSample, icao_from_atc_model, normalize_registration,
    resolve_registration,
};

const FACTS_DEFAULT_LIMIT: u32 = 20;
const FACTS_MAX_LIMIT: u32 = 200;
/// Flights looked at to find `limit` approaches.
const FACTS_SCAN_MAX: u32 = 200;

/// Every approach of a flight, in time order. `live` is the recorder's buffer of the running
/// flight; it replaces the stored track when it is longer (the store is flushed every 15 s,
/// `FLUSH_INTERVAL_MS` in the recorder, so the live buffer is up to date and the stored one not).
pub(crate) fn analyze(store: &Store, airports: &AirportIndex, flight_id: &str, live: Option<Vec<TrackSample>>) -> Result<Vec<ApproachAnalysis>, String> {
    let detail = store.get_flight(flight_id).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
    let mut track = store.get_track(flight_id).map_err(|e| e.to_string())?.unwrap_or_default();
    let is_live = live.is_some();
    if let Some(live) = live
        && live.len() > track.len()
    {
        track = live;
    }
    let samples: Vec<ApproachSample> = track.iter().map(TrackSample::to_approach_sample).collect();
    let phases: Vec<PhaseMark> = detail.phases.iter().map(|p| PhaseMark { from: p.from, to: p.to, t_ms: p.timestamp_ms }).collect();
    let cfg = ApproachConfig::default();
    // learn runways only from finished (not live), non-demo flights
    let remember = (!is_live && !matches!(detail.flight.provider.as_deref(), Some("mock" | "replay"))).then_some(flight_id);

    // candidate runways around every approach end (touchdown point / lowest point of a go-around):
    // for a landing the same resolution as the landing debrief (database → remembered →
    // derived from the track), then the database and remembered runways around every end.
    // Go-arounds at a field without any of these stay without runway.
    let mut ends: Vec<RunwayEnd> = Vec::new();
    let mut geometry: Vec<RunwayGeometry> = Vec::new();
    let mut push = |end: RunwayEnd, g: RunwayGeometry| {
        if !ends.iter().any(|e| e.airport == end.airport && e.ident == end.ident) {
            ends.push(end);
            geometry.push(g);
        }
    };
    let airport_elevation = |icao: &str| airports.get(icao).and_then(|ap| ap.elevation_ft).map(f64::from);
    let mut landing_samples: Option<Vec<LandingSample>> = None;
    for a in approach::find_attempts(&samples, &phases, &detail.touchdowns, &cfg) {
        if let Some(k) = a.outcome.touchdown_index() {
            let track_ref = &track;
            let load = || landing_samples.get_or_insert_with(|| track_ref.iter().map(to_sample).collect()).clone();
            if let Some(mut c) = resolve_runway(store, airports, &detail.touchdowns, k, load, remember) {
                if c.geometry.source == RunwayGeometrySource::Database {
                    c.end.elevation_ft = airport_elevation(&c.end.airport);
                }
                push(c.end, c.geometry);
            }
        }
        for (mut end, _) in runway_ends_near(airports, a.latitude, a.longitude) {
            // OurAirports has no threshold elevation: the airport elevation is the database value
            end.elevation_ft = airport_elevation(&end.airport);
            push(end, RunwayGeometry::database());
        }
        for c in user_runways_near(store, airports, a.latitude, a.longitude) {
            push(c.end, c.geometry);
        }
    }
    // the airframe's Vapp / landing flaps from the fleet, if the pilot entered them; the
    // aircraft constants of track v2 (VS0, flap handle positions) from the recording
    let mut aircraft = aircraft_ref(store, flight_id);
    aircraft.vs0_kt = aircraft.vs0_kt.or_else(|| track.iter().rev().find_map(|s| s.design_vs0_kt));
    aircraft.flap_positions = aircraft.flap_positions.or_else(|| track.iter().rev().find_map(|s| s.flap_positions));
    let mut out = approach::analyze_flight(&samples, &phases, &detail.touchdowns, &ends, &aircraft, &cfg);
    for a in &mut out {
        if let Some(r) = a.runway.as_ref()
            && let Some(i) = ends.iter().position(|e| e.airport == r.airport && e.ident == r.ident)
        {
            // derived geometry: the lateral band is not assessable
            approach::apply_runway_geometry(a, &geometry[i]);
        }
    }
    Ok(out)
}

/// Compute and cache the approach facts of a flight; returns the rows written.
pub(crate) fn store_facts(store: &Store, airports: &AirportIndex, flight_id: &str) -> Result<Vec<ApproachFactRow>, String> {
    let rows: Vec<ApproachFactRow> = analyze(store, airports, flight_id, None)?.iter().map(ApproachFactRow::from_analysis).collect();
    store.put_approach_facts(flight_id, APPROACH_FACTS_VERSION, &rows).map_err(|e| e.to_string())?;
    Ok(rows)
}

/// After a flight ended: compute its approach facts in the background so the logbook strip
/// has them at once, then emit `approach:facts` with the flight id.
pub(crate) fn spawn_store_facts(app: AppHandle, store: Store, flight_id: String) {
    let spawned = std::thread::Builder::new().name("approach-facts".into()).spawn(move || {
        let Some(airports) = app.try_state::<Arc<AirportIndex>>().map(|s| s.inner().clone()) else { return };
        match store_facts(&store, &airports, &flight_id) {
            Ok(rows) => {
                log::info!("approach facts of flight {flight_id}: {} approach(es)", rows.len());
                let _ = app.emit("approach:facts", flight_id.as_str());
            }
            Err(e) => log::warn!("approach facts of flight {flight_id}: {e}"),
        }
    });
    if let Err(e) = spawned {
        log::warn!("approach facts thread: {e}");
    }
}

/// Approach assessment of one flight (all approaches, go-arounds included).
#[tauri::command]
pub async fn approach_analysis(
    flight_id: String,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
    manager: State<'_, ProviderManager>,
) -> Result<Vec<ApproachAnalysis>, String> {
    let store = store.inner().clone();
    let airports = airports.inner().clone();
    let live = (store.active_flight_id().ok().flatten().as_deref() == Some(flight_id.as_str())).then(|| manager.live_track());
    tauri::async_runtime::spawn_blocking(move || analyze(&store, &airports, &flight_id, live)).await.map_err(|e| e.to_string())?
}

/// One cached approach with what the strip and the scatter need of its flight.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachFact {
    pub flight_id: String,
    #[serde(flatten)]
    pub row: ApproachFactRow,
    pub band: Option<ApproachBand>,
    pub elevation_source: Option<ElevationSource>,
    pub exceeded: Vec<CriterionKind>,
    pub exceedances_below_500: u32,
    pub vapp_plausible: Option<bool>,
    pub threshold_height_ft: Option<f64>,
    pub go_around_detected_by: Option<GoAroundSource>,
    /// Where the runway geometry comes from (None: no runway, or cached before v3).
    pub runway_source: Option<RunwayGeometrySource>,
    /// Localizer RMS 1000 → 50 ft, dots (None: not measurable, derived runway, or cached before v4).
    pub loc_rms_dots: Option<f64>,
    pub lateral_band: Option<LateralBand>,
    pub aircraft_icao_type: Option<String>,
    pub aircraft_title: Option<String>,
    pub registration: Option<String>,
    pub provider: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachFactsResult {
    /// Newest first (within a flight: the later approach first).
    pub facts: Vec<ApproachFact>,
    /// Completed flights looked at without any assessable approach (no track, no touchdown or go-around).
    pub skipped: u32,
}

fn to_fact(f: &FlightRow, row: ApproachFactRow) -> ApproachFact {
    let non_empty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
    let d = row.detail();
    ApproachFact {
        flight_id: f.id.clone(),
        band: d.as_ref().and_then(|d| d.band),
        elevation_source: d.as_ref().map(|d| d.elevation_source),
        exceeded: d.as_ref().map(|d| d.exceeded.clone()).unwrap_or_default(),
        exceedances_below_500: d.as_ref().map_or(0, |d| d.exceedances_below_500),
        vapp_plausible: d.as_ref().and_then(|d| d.vapp_plausible),
        threshold_height_ft: d.as_ref().and_then(|d| d.threshold_height_ft),
        go_around_detected_by: d.as_ref().and_then(|d| d.go_around_detected_by),
        runway_source: d.as_ref().and_then(|d| d.runway_source),
        loc_rms_dots: d.as_ref().and_then(|d| d.loc_rms_dots),
        lateral_band: d.as_ref().and_then(|d| d.lateral_band),
        aircraft_icao_type: icao_from_atc_model(&f.aircraft.atc_model),
        aircraft_title: non_empty(&f.aircraft.title),
        registration: f.airframe_reg.as_deref().and_then(normalize_registration).or_else(|| resolve_registration(None, Some(&f.aircraft.atc_id))),
        provider: f.provider.clone(),
        row,
    }
}

fn facts_recent(store: &Store, airports: &AirportIndex, limit: usize, include_demo: bool) -> Result<ApproachFactsResult, String> {
    let flights: Vec<RecentApproaches> = store.recent_approach_facts(FACTS_SCAN_MAX, include_demo).map_err(|e| e.to_string())?;
    let mut facts = Vec::with_capacity(limit);
    let mut skipped = 0u32;
    for f in flights {
        if facts.len() >= limit {
            break;
        }
        let rows = if f.cached_version == Some(APPROACH_FACTS_VERSION) {
            f.facts
        } else if !f.has_track {
            if let Err(e) = store.put_approach_facts(&f.flight.id, APPROACH_FACTS_VERSION, &[]) {
                log::warn!("approach facts cache: {e}");
            }
            Vec::new()
        } else {
            match store_facts(store, airports, &f.flight.id) {
                Ok(rows) => rows,
                Err(e) => {
                    log::warn!("approach facts of flight {}: {e}", f.flight.id);
                    Vec::new()
                }
            }
        };
        if rows.is_empty() {
            skipped += 1;
        }
        for row in rows.into_iter().rev() {
            facts.push(to_fact(&f.flight, row));
        }
    }
    facts.truncate(limit);
    Ok(ApproachFactsResult { facts, skipped })
}

/// Facts of the last `limit` (default 20) approaches of completed flights, newest first.
/// Flights missing from the cache (or of an older version) are computed and stored on the way.
#[tauri::command]
pub async fn approach_facts_recent(
    limit: Option<u32>,
    include_demo: Option<bool>,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<ApproachFactsResult, String> {
    let limit = limit.unwrap_or(FACTS_DEFAULT_LIMIT).clamp(1, FACTS_MAX_LIMIT) as usize;
    let (store, airports) = (store.inner().clone(), airports.inner().clone());
    let include_demo = include_demo.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || facts_recent(&store, &airports, limit, include_demo)).await.map_err(|e| e.to_string())?
}
