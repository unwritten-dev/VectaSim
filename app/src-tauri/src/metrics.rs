//! `flight_metrics_recent`: the per-flight metrics (take-off rotation, gear-down and
//! landing-flaps height, stable-approach result; `vectasim_store::metrics`) of the last
//! completed flights for the debrief comparison and the trends – the same window and demo rule
//! as `approach_facts_recent`.
//!
//! New flights get their row at flight end (`approach::spawn_store_facts`). Flights recorded
//! before the metrics existed (or with an older `FLIGHT_METRICS_VERSION`) are filled in the
//! background, never inside the command: the command answers at once with what is stored and
//! the number still missing, and starts one backfill thread (at most one at a time) that works
//! through the missing flights of that window newest first – one track decode + approach
//! analysis each, a short pause between flights so the recorder and the UI get the store, and
//! `flight:metrics` after every [`BATCH`] flights and at the end so the frontend reloads.

use crate::approach;
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use vectasim_data::AirportIndex;
use vectasim_store::{FlightMetricsRow, FlightRow, RecentMetrics, Store, icao_from_atc_model, metrics};

/// Event after metrics were stored (payload: the flight id, or null after a backfill batch).
pub(crate) const EVENT: &str = "flight:metrics";

const DEFAULT_LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 200;
/// Flights looked at (and at most backfilled per run): the window of the comparisons.
const SCAN_MAX: u32 = 200;
/// Flights between two `flight:metrics` events of a backfill.
const BATCH: usize = 10;
/// Pause between two backfilled flights.
const PAUSE: Duration = Duration::from_millis(25);

static BACKFILL_RUNNING: AtomicBool = AtomicBool::new(false);

/// One flight's metrics with what the comparison needs of the flight.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightMetricsFact {
    pub flight_id: String,
    /// Landing (else on-block / off-block / created) time, epoch ms.
    pub timestamp_ms: u64,
    pub aircraft_icao_type: Option<String>,
    pub aircraft_title: Option<String>,
    pub provider: Option<String>,
    #[serde(flatten)]
    pub row: FlightMetricsRow,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightMetricsResult {
    /// Newest first.
    pub facts: Vec<FlightMetricsFact>,
    /// Flights of the window still being computed in the background (`flight:metrics` follows).
    pub pending: u32,
}

fn to_fact(f: &FlightRow, row: FlightMetricsRow) -> FlightMetricsFact {
    let non_empty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
    FlightMetricsFact {
        flight_id: f.id.clone(),
        timestamp_ms: f.landing_ms.or(f.on_block_ms).or(f.off_block_ms).unwrap_or(f.created_ms),
        aircraft_icao_type: icao_from_atc_model(&f.aircraft.atc_model),
        aircraft_title: non_empty(&f.aircraft.title),
        provider: f.provider.clone(),
        row,
    }
}

/// Split the window into stored facts and the flights still to compute. A flight without a
/// track is settled at once (its touchdowns alone give nothing, the row only marks it done).
fn collect(store: &Store, recent: Vec<RecentMetrics>, limit: usize) -> (Vec<FlightMetricsFact>, Vec<String>) {
    let mut facts = Vec::with_capacity(limit);
    let mut missing = Vec::new();
    for r in recent {
        if !r.is_stale() {
            if facts.len() < limit {
                facts.push(to_fact(&r.flight, r.metrics.unwrap_or_default()));
            }
        } else if !r.has_track {
            let m = metrics::derive(&[], &[], &[]);
            if let Err(e) = store.put_flight_metrics(&r.flight.id, &m) {
                log::warn!("flight metrics: {e}");
            }
        } else {
            missing.push(r.flight.id);
        }
    }
    (facts, missing)
}

/// Compute the metrics of `ids` (newest first) on one background thread; a second call while
/// one runs does nothing (the running one sees the same window).
fn start_backfill(app: AppHandle, store: Store, airports: Arc<AirportIndex>, ids: Vec<String>) {
    if ids.is_empty() || BACKFILL_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    /// Clears the flag however the thread ends (a panic in one flight's analysis included).
    struct Running;
    impl Drop for Running {
        fn drop(&mut self) {
            BACKFILL_RUNNING.store(false, Ordering::Release);
        }
    }
    let spawned = std::thread::Builder::new().name("flight-metrics".into()).spawn(move || {
        let _running = Running;
        let started = std::time::Instant::now();
        let mut done = 0usize;
        for (i, id) in ids.iter().enumerate() {
            // `approach_facts_recent` may have computed it inline since the list was read
            if store.flight_results_fresh(id).unwrap_or(false) {
                continue;
            }
            if let Err(e) = approach::store_facts(&store, &airports, id) {
                log::warn!("flight metrics of flight {id}: {e}");
                // settle it anyway, so a broken track is not retried on every read
                let _ = store.put_flight_metrics(id, &metrics::derive(&[], &[], &[]));
            }
            done += 1;
            if (i + 1) % BATCH == 0 {
                let _ = app.emit(EVENT, ());
            }
            std::thread::sleep(PAUSE);
        }
        log::info!("flight metrics: {done} flight(s) computed in the background in {} ms", started.elapsed().as_millis());
        drop(_running);
        let _ = app.emit(EVENT, ());
    });
    if let Err(e) = spawned {
        BACKFILL_RUNNING.store(false, Ordering::Release);
        log::warn!("flight metrics thread: {e}");
    }
}

/// Metrics of the last `limit` (default 20) completed flights, newest first. Flights not
/// computed yet are filled in the background (see the module docs); `pending` says how many.
#[tauri::command]
pub async fn flight_metrics_recent(
    limit: Option<u32>,
    include_demo: Option<bool>,
    app: AppHandle,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<FlightMetricsResult, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let (store, airports) = (store.inner().clone(), airports.inner().clone());
    let include_demo = include_demo.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let recent = store.recent_flight_metrics(SCAN_MAX, include_demo).map_err(|e| e.to_string())?;
        let (facts, missing) = collect(&store, recent, limit);
        let pending = missing.len() as u32;
        start_backfill(app, store, airports, missing);
        Ok(FlightMetricsResult { facts, pending })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_settles_trackless_flights_and_lists_the_rest() {
        let store = Store::open_in_memory().unwrap();
        let row = |id: &str, has_track: bool, metrics: Option<FlightMetricsRow>| RecentMetrics {
            flight: FlightRow {
                id: id.into(),
                landing_ms: Some(5),
                aircraft: vectasim_core::AircraftInfo { atc_model: "A20N".into(), ..Default::default() },
                ..Default::default()
            },
            has_track,
            metrics,
        };
        let fresh =
            FlightMetricsRow { version: vectasim_store::FLIGHT_METRICS_VERSION, rotation_rate_deg_s: Some(2.5), ..Default::default() };
        let stale = FlightMetricsRow { version: 0, ..Default::default() };
        let (facts, missing) = collect(
            &store,
            vec![row("a", true, Some(fresh)), row("b", true, Some(stale)), row("c", false, None), row("d", true, None)],
            20,
        );
        assert_eq!(facts.len(), 1);
        assert_eq!((facts[0].flight_id.as_str(), facts[0].timestamp_ms, facts[0].row.rotation_rate_deg_s), ("a", 5, Some(2.5)));
        assert_eq!(missing, vec!["b".to_string(), "d".to_string()]);
        let v = serde_json::to_value(&facts[0]).unwrap();
        assert_eq!(v["rotationRateDegS"], 2.5);
        assert_eq!(v["flightId"], "a");
        assert!(v["stable1000"].is_null());
    }
}
