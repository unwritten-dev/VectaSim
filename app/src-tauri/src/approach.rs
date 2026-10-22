//! `approach_analysis`: every approach of a flight (touchdowns and go-arounds) from the
//! stored 1 Hz track, the phase events and the touchdowns, with the runways around each
//! approach's end point – the pure assessment in `vectasim_core::approach`.
//!
//! `approach_facts_recent`: the flat facts of the last approaches for the flight strip and
//! the approach scatter, cached per flight in `approach_facts` (versioned, filled lazily
//! here and right after a flight ends by [`spawn_store_facts`]). The same analysis also
//! yields the per-flight metrics (`flight_metrics`, see `crate::metrics`).
//!
//! Track decoding costs a few ms per flight, so both commands run on a blocking thread.
//!
//! Assessment profiles (`vectasim_core::approach_profile`): every analysis runs with the
//! flight's profile (airframe choice → ICAO type → engine type → generic, see
//! [`flight_config`]); `approach_profiles`, `import_approach_profile` and
//! `delete_approach_profile` serve the settings. A changed profile drops the cached facts and
//! metrics it affects; they are recomputed by the same lazy paths as after a version bump
//! (`approach_facts_recent` inline, `flight_metrics_recent` in the background).

use crate::landing::{aircraft_ref, resolve_runway, runway_ends_near, to_sample, user_runways_near};
use crate::manager::ProviderManager;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use vectasim_core::approach::{
    self, ApproachAnalysis, ApproachBand, ApproachConfig, ApproachSample, ElevationSource, GoAroundSource, LateralBand, PhaseMark,
};
use vectasim_core::approach_profile::{self, ApproachProfile, EngineClass, OVERRIDE_KEYS, OverrideKey, OverrideValue};
use vectasim_core::landing::{CriterionKind, LandingSample, RunwayEnd, RunwayGeometry, RunwayGeometrySource};
use vectasim_data::AirportIndex;
use vectasim_store::{
    APPROACH_FACTS_VERSION, ApproachFactRow, FlightDetail, FlightMetricsRow, FlightRow, RecentApproaches, Store, TrackSample,
    icao_from_atc_model, metrics, normalize_registration, resolve_registration,
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
    Ok(analyze_loaded(store, airports, flight_id, &detail, &track, is_live))
}

/// [`analyze`] over an already loaded flight and track (the metrics read the same track).
fn analyze_loaded(
    store: &Store,
    airports: &AirportIndex,
    flight_id: &str,
    detail: &FlightDetail,
    track: &[TrackSample],
    is_live: bool,
) -> Vec<ApproachAnalysis> {
    let samples: Vec<ApproachSample> = track.iter().map(TrackSample::to_approach_sample).collect();
    let phases: Vec<PhaseMark> = detail.phases.iter().map(|p| PhaseMark { from: p.from, to: p.to, t_ms: p.timestamp_ms }).collect();
    let cfg = flight_config(store, flight_id, track);
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
            let load = || landing_samples.get_or_insert_with(|| track.iter().map(to_sample).collect()).clone();
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
    out
}

/// Below this median IAS low over the ground (≤ [`PISTON_LOW_AGL_FT`]) a flight without turbine
/// N1 is taken for a piston aircraft.
const PISTON_MAX_LOW_IAS_KT: f64 = 120.0;
const PISTON_LOW_AGL_FT: f64 = 1_000.0;

/// What the recording tells about the engines: a v2 track whose N1 never left 0 in the air
/// and that flew slowly low over the ground (median IAS below 1000 ft AGL under 120 kt) is a
/// piston aircraft (piston engines report no turbine N1). Without the speed check a jet whose
/// add-on leaves `TURB ENG N1` at 0 was assessed with the GA piston gates. The sim's
/// `ENGINE TYPE` is not recorded, so turboprop and jet cannot be told apart here (both → None,
/// the type mapping or generic decides).
fn engine_hint(track: &[TrackSample], cfg: &ApproachConfig) -> Option<EngineClass> {
    let mut airborne_n1 = track.iter().filter(|s| !s.on_ground).filter_map(|s| s.n1_pct).peekable();
    airborne_n1.peek()?;
    if !airborne_n1.all(|n| n <= cfg.n1_valid_min_pct) {
        return None;
    }
    let mut low_ias: Vec<f64> = track
        .iter()
        .filter(|s| !s.on_ground && s.altitude_agl_ft <= PISTON_LOW_AGL_FT && s.ias_kt.is_finite() && s.ias_kt > 0.0)
        .map(|s| s.ias_kt)
        .collect();
    if low_ias.is_empty() {
        return None;
    }
    low_ias.sort_by(f64::total_cmp);
    (low_ias[low_ias.len() / 2] < PISTON_MAX_LOW_IAS_KT).then_some(EngineClass::Piston)
}

/// The thresholds a flight is assessed with: its profile's config (generic when the logbook
/// cannot tell).
pub(crate) fn flight_config(store: &Store, flight_id: &str, track: &[TrackSample]) -> ApproachConfig {
    let engine = engine_hint(track, &ApproachConfig::default());
    match store.resolve_flight_profile(flight_id, engine, None) {
        Ok((p, _)) => p.config(),
        Err(e) => {
            log::warn!("assessment profile of flight {flight_id}: {e}");
            ApproachConfig::default()
        }
    }
}

/// Compute and store what a flight's track yields for the comparisons: the approach facts and
/// the per-flight metrics (`vectasim_store::metrics`), from one track decode and one analysis.
/// Returns the approach rows and the metrics computed.
///
/// The write is conditional ([`Store::put_flight_results`]): when the pilot changed a profile,
/// a Vapp, a runway … while the analysis ran, the invalidation already dropped the old row and
/// this result (computed with the old inputs) is not stored; the next lazy read computes it
/// again. Both parts are written in one transaction.
pub(crate) fn store_facts(
    store: &Store,
    airports: &AirportIndex,
    flight_id: &str,
) -> Result<(Vec<ApproachFactRow>, FlightMetricsRow), String> {
    let epoch = store.results_epoch();
    let detail = store.get_flight(flight_id).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
    let track = store.get_track(flight_id).map_err(|e| e.to_string())?.unwrap_or_default();
    let analyses = analyze_loaded(store, airports, flight_id, &detail, &track, false);
    let rows: Vec<ApproachFactRow> = analyses.iter().map(ApproachFactRow::from_analysis).collect();
    let m = metrics::derive_from_analysis(&track, &detail.touchdowns, &analyses);
    if !store.put_flight_results(flight_id, epoch, APPROACH_FACTS_VERSION, &rows, &m).map_err(|e| e.to_string())? {
        log::info!("approach facts of flight {flight_id}: inputs changed during the analysis, not stored (recomputed on the next read)");
    }
    Ok((rows, m))
}

/// [`store_facts`] for the lazy paths (`approach_facts_recent` inline, the metrics backfill):
/// both see the same missing flights after a version bump and ran the same analysis twice.
/// A flight the other path stored meanwhile is taken from the cache instead.
pub(crate) fn store_facts_unless_fresh(
    store: &Store,
    airports: &AirportIndex,
    flight_id: &str,
) -> Result<(Vec<ApproachFactRow>, FlightMetricsRow), String> {
    if store.flight_results_fresh(flight_id).map_err(|e| e.to_string())? {
        let rows = store.approach_facts_for_flight(flight_id).map_err(|e| e.to_string())?;
        let m = store.flight_metrics(flight_id).map_err(|e| e.to_string())?.unwrap_or_default();
        return Ok((rows, m));
    }
    store_facts(store, airports, flight_id)
}

/// After a flight ended: compute its approach facts and metrics in the background so the
/// logbook strip and the debrief comparison have them at once, then emit `approach:facts` and
/// `flight:metrics` with the flight id.
pub(crate) fn spawn_store_facts(app: AppHandle, store: Store, flight_id: String) {
    let spawned = std::thread::Builder::new().name("approach-facts".into()).spawn(move || {
        let Some(airports) = app.try_state::<Arc<AirportIndex>>().map(|s| s.inner().clone()) else { return };
        match store_facts(&store, &airports, &flight_id) {
            Ok((rows, _)) => {
                log::info!("approach facts and metrics of flight {flight_id}: {} approach(es)", rows.len());
                let _ = app.emit("approach:facts", flight_id.as_str());
                let _ = app.emit(crate::metrics::EVENT, flight_id.as_str());
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
    /// Hard gate of the profile the approach was assessed with, ft (None: cached before v6 = 500 ft).
    pub hard_gate_ft: Option<f64>,
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
        hard_gate_ft: d.as_ref().and_then(|d| d.hard_gate_ft),
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
            match store_facts_unless_fresh(store, airports, &f.flight.id) {
                Ok((rows, _)) => rows,
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

// ---- assessment profiles (settings) --------------------------------------------------------

/// One profile for the settings: the profile and its effective values that differ from generic
/// (a custom profile's base included), in the order of the key table.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    #[serde(flatten)]
    pub profile: ApproachProfile,
    pub effective: Vec<EffectiveValue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveValue {
    pub key: &'static str,
    pub value: OverrideValue,
    /// The generic value it replaces.
    pub generic: Option<OverrideValue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachProfiles {
    /// Built-ins first (generic, airbus, boeing, turboprop, ga_piston), then the custom ones.
    pub profiles: Vec<ProfileInfo>,
    /// Every key a custom profile may set, with its range.
    pub keys: &'static [OverrideKey],
}

fn info(p: ApproachProfile) -> ProfileInfo {
    let generic = ApproachConfig::default();
    let effective = p
        .effective_overrides()
        .into_iter()
        .map(|(key, value)| EffectiveValue { key, value, generic: approach_profile::value_of(&generic, key) })
        .collect();
    ProfileInfo { profile: p, effective }
}

fn profiles_of(store: &Store) -> Result<ApproachProfiles, String> {
    let custom = store.custom_approach_profiles().map_err(crate::lang::ui_error)?;
    let profiles = approach_profile::builtins().into_iter().chain(custom).map(info).collect();
    Ok(ApproachProfiles { profiles, keys: OVERRIDE_KEYS })
}

/// Built-in and custom assessment profiles with their values.
#[tauri::command]
pub fn approach_profiles(store: State<'_, Store>) -> Result<ApproachProfiles, String> {
    profiles_of(&store)
}

/// What `import_approach_profile` answers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImport {
    pub profile: ProfileInfo,
    /// An existing custom profile with the same id was replaced.
    pub replaced: bool,
}

const PROFILE_EXTENSIONS: &[&str] = &["json"];

fn profiles_changed(app: &AppHandle) {
    let _ = app.emit("approach:profiles", ());
    // facts assessed with a replaced / deleted profile were dropped: the lists reload (and refill)
    let _ = app.emit("approach:facts", ());
    let _ = app.emit(crate::metrics::EVENT, ());
}

/// Import a custom profile from a JSON file (`docs/approach-profiles.md`); a profile with the
/// same id is replaced. Refusals carry the reason (`store.approach_profile_invalid`).
#[tauri::command]
pub fn import_approach_profile(path: String, app: AppHandle, store: State<'_, Store>) -> Result<ProfileImport, String> {
    let src = crate::data::check_path(&path, PROFILE_EXTENSIONS, &[])?;
    let shown = src.display().to_string();
    let meta = std::fs::metadata(&src).map_err(|e| format!("{shown}: {e}"))?;
    if meta.len() > approach_profile::CUSTOM_MAX_BYTES as u64 {
        let e = vectasim_store::StoreError::from(vectasim_store::Invalid::ApproachProfileInvalid {
            cause: approach_profile::ProfileError::TooLarge { max_bytes: approach_profile::CUSTOM_MAX_BYTES },
        });
        return Err(crate::lang::ui_error(e));
    }
    let json = std::fs::read_to_string(&src).map_err(|e| format!("{shown}: {e}"))?;
    let (p, replaced) = store.import_approach_profile(&json).map_err(crate::lang::ui_error)?;
    log::info!("approach profile {} imported{}", p.id, if replaced { " (replaced)" } else { "" });
    profiles_changed(&app);
    Ok(ProfileImport { profile: info(p), replaced })
}

/// Delete a custom profile (airframes that used it go back to automatic).
#[tauri::command]
pub fn delete_approach_profile(id: String, app: AppHandle, store: State<'_, Store>) -> Result<bool, String> {
    let ok = store.delete_approach_profile(&id).map_err(crate::lang::ui_error)?;
    if ok {
        log::info!("approach profile {id} deleted");
        profiles_changed(&app);
        let _ = app.emit("airframes:changed", "");
    }
    Ok(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(on_ground: bool, n1: Option<f64>) -> TrackSample {
        TrackSample { on_ground, n1_pct: n1, ..Default::default() }
    }

    fn low(ias: f64, n1: Option<f64>) -> TrackSample {
        TrackSample { on_ground: false, n1_pct: n1, ias_kt: ias, altitude_agl_ft: 800.0, ..Default::default() }
    }

    #[test]
    fn piston_is_told_by_n1_zero_in_the_air_and_a_slow_approach() {
        let cfg = ApproachConfig::default();
        assert_eq!(engine_hint(&[], &cfg), None);
        // v1 track: no N1 at all
        assert_eq!(engine_hint(&[sample(false, None), sample(false, None)], &cfg), None);
        assert_eq!(
            engine_hint(&[sample(true, Some(60.0)), low(85.0, Some(0.0)), low(75.0, Some(0.0)), low(70.0, Some(0.0))], &cfg),
            Some(EngineClass::Piston)
        );
        assert_eq!(engine_hint(&[low(85.0, Some(0.0)), low(85.0, Some(55.0))], &cfg), None);
    }

    #[test]
    fn a_jet_without_n1_is_not_taken_for_a_piston() {
        // an add-on that leaves TURB ENG N1 at 0: 140 kt on the approach is no piston single
        let cfg = ApproachConfig::default();
        let cruise = TrackSample { on_ground: false, n1_pct: Some(0.0), ias_kt: 280.0, altitude_agl_ft: 30_000.0, ..Default::default() };
        assert_eq!(engine_hint(&[cruise.clone(), low(150.0, Some(0.0)), low(140.0, Some(0.0)), low(135.0, Some(0.0))], &cfg), None);
        // never low over the ground: cannot tell
        assert_eq!(engine_hint(&[cruise], &cfg), None);
        // a fast piston cruise, slow approach: still a piston
        let fast = TrackSample { on_ground: false, n1_pct: Some(0.0), ias_kt: 170.0, altitude_agl_ft: 8_000.0, ..Default::default() };
        assert_eq!(engine_hint(&[fast, low(90.0, Some(0.0)), low(80.0, Some(0.0))], &cfg), Some(EngineClass::Piston));
    }

    #[test]
    fn profiles_list_builtins_with_their_differences() {
        let store = Store::open_in_memory().unwrap();
        let list = profiles_of(&store).unwrap();
        let ids: Vec<&str> = list.profiles.iter().map(|p| p.profile.id.as_str()).collect();
        assert_eq!(ids, ["generic", "airbus", "boeing", "turboprop", "ga_piston"]);
        let airbus = &list.profiles[1];
        assert_eq!(airbus.effective.len(), 1);
        let e = &airbus.effective[0];
        assert_eq!((e.key, e.value, e.generic), ("gateSpeedAboveKt", OverrideValue::Number(10.0), Some(OverrideValue::Number(20.0))));
        assert!(list.profiles[0].effective.is_empty() && list.profiles[2].effective.is_empty());
        let v = serde_json::to_value(&list.profiles[4]).unwrap();
        assert_eq!(v["id"], "ga_piston");
        assert_eq!(v["overrides"]["hardGateFt"], 300.0);
        assert_eq!(v["effective"][6]["key"], "hardGateFt");
        let keys = serde_json::to_value(list.keys).unwrap();
        assert!(keys.as_array().unwrap().iter().any(|k| k["key"] == "thrustCheck" && k["kind"] == "bool"));
    }
}
