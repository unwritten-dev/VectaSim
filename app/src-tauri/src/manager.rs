//! Owns the active sim provider, runs the `FlightSession` and `FlightRecorder`
//! over its telemetry, forwards everything to the webview and keeps a snapshot
//! the frontend can query on startup.
//!
//! Events emitted: `sim:status` (StatusSnapshot), `sim:telemetry` (Telemetry,
//! throttled to 10 Hz), `sim:flight` (FlightSummary, with each telemetry emit
//! and on every flight event), `sim:flight-event` (FlightEvent), `sim:aircraft`
//! (AircraftInfo), `sim:event` (SimEvent), `sim:stats` (Stats, 1 Hz: frame
//! count and measured provider rate), `logbook:changed` (a flight was created
//! or completed – the logbook view should refetch).

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use vectasim_core::{
    AircraftInfo, FlightEvent, FlightPhase, FlightSession, FlightState, FlightSummary, MockProvider, ProviderEvent, SimEvent, SimProvider,
    Telemetry,
};
use vectasim_simconnect::SimConnectProvider;
use vectasim_store::{AirportResolver, FlightRecorder, LiveTrack, MetarSlot, PlannedSlot, RecorderContext, Store, TrackSample};

pub const PROVIDERS: &[&str] = &["simconnect", "mock"];

const TELEMETRY_EMIT_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub provider: String,
    /// idle | connecting | connected | disconnected | error
    pub state: String,
    pub detail: String,
    pub sim_name: Option<String>,
    pub sim_version: Option<String>,
    pub aircraft: Option<AircraftInfo>,
    pub last_telemetry: Option<Telemetry>,
    pub flight: Option<FlightSummary>,
    pub frames: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub frames: u64,
    pub rate_hz: f64,
}

struct Active {
    stop: Arc<AtomicBool>,
}

pub struct ProviderManager {
    active: Mutex<Option<Active>>,
    status: Arc<Mutex<StatusSnapshot>>,
    /// 1 Hz samples of the flight being recorded; one buffer across provider restarts.
    live: LiveTrack,
    /// Dispatch plan to attach to the next flight that starts.
    pub planned: PlannedSlot,
    /// True while a flight is open; the SimConnect provider keeps its reconnect backoff short otherwise.
    flight_active: Arc<AtomicBool>,
}

impl ProviderManager {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            status: Arc::new(Mutex::new(StatusSnapshot { state: "idle".into(), ..Default::default() })),
            live: LiveTrack::default(),
            planned: PlannedSlot::default(),
            flight_active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        self.status.lock().unwrap().clone()
    }

    pub fn live_track(&self) -> Vec<TrackSample> {
        self.live.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn make_provider(&self, kind: &str) -> Result<Box<dyn SimProvider>, String> {
        match kind {
            "mock" => Ok(Box::new(MockProvider::default())),
            "simconnect" => Ok(Box::new(SimConnectProvider { flight_active: self.flight_active.clone(), ..Default::default() })),
            other => Err(format!("unknown provider '{other}'")),
        }
    }

    /// Stop whatever is running and start `kind`. A new provider gets a fresh flight session and recorder.
    pub fn start(&self, app: AppHandle, store: Store, resolver: Arc<dyn AirportResolver>, kind: &str) -> Result<(), String> {
        let provider = self.make_provider(kind)?;
        // a new provider starts a new flight session
        self.flight_active.store(false, Ordering::Relaxed);
        let mut active = self.active.lock().unwrap();
        if let Some(old) = active.take() {
            old.stop.store(true, Ordering::Relaxed);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<ProviderEvent>();
        let provider_name = provider.name().to_string();
        {
            let mut s = self.status.lock().unwrap();
            *s = StatusSnapshot { provider: provider_name.clone(), state: "connecting".into(), ..Default::default() };
            let _ = app.emit("sim:status", s.clone());
        }
        let _handle = provider.start(tx, stop.clone());
        *active = Some(Active { stop: stop.clone() });

        let status = self.status.clone();
        let metar_store = store.clone();
        let recorder = FlightRecorder::new(store, RecorderContext { provider: provider_name, ..Default::default() })
            .with_live_track(self.live.clone())
            .with_resolver(resolver)
            .with_planned(self.planned.clone());
        std::thread::Builder::new()
            .name("provider-forwarder".into())
            .spawn({
                let flight_active = self.flight_active.clone();
                move || forward(rx, app, status, stop, recorder, metar_store, flight_active)
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn forward(
    rx: mpsc::Receiver<ProviderEvent>,
    app: AppHandle,
    status: Arc<Mutex<StatusSnapshot>>,
    stop: Arc<AtomicBool>,
    mut recorder: FlightRecorder,
    store: Store,
    flight_active: Arc<AtomicBool>,
) {
    let mut last_emit = Instant::now() - TELEMETRY_EMIT_INTERVAL;
    let mut last_stats = Instant::now();
    let mut frames_since_stats: u64 = 0;
    let mut session = FlightSession::new();
    while let Ok(ev) = rx.recv() {
        // A superseded provider may still flush a few events after being told to stop.
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match ev {
            ProviderEvent::Telemetry(t) => {
                let events = session.update(&t);
                if !events.is_empty() {
                    flight_active.store(session.summary().state == FlightState::Active, Ordering::Relaxed);
                }
                if let Err(e) = recorder.on_telemetry(&t, session.summary(), &events) {
                    log::error!("logbook write failed: {e}");
                }
                for fe in &events {
                    log::info!("flight event: {fe:?}");
                    capture_metar(&app, &store, &recorder, session.summary(), fe);
                    let _ = app.emit("sim:flight-event", fe);
                    if matches!(fe, FlightEvent::FlightStarted { .. } | FlightEvent::FlightEnded { .. }) {
                        let _ = app.emit("logbook:changed", ());
                    }
                }
                frames_since_stats += 1;
                let mut s = status.lock().unwrap();
                s.frames += 1;
                let frames = s.frames;
                s.last_telemetry = Some(t.clone());
                if !events.is_empty() {
                    s.flight = Some(session.summary().clone());
                }
                if s.state != "connected" {
                    s.state = "connected".into();
                    let _ = app.emit("sim:status", s.clone());
                }
                drop(s);
                if !events.is_empty() {
                    let _ = app.emit("sim:flight", session.summary());
                }
                if last_emit.elapsed() >= TELEMETRY_EMIT_INTERVAL {
                    last_emit = Instant::now();
                    let _ = app.emit("sim:telemetry", &t);
                    if events.is_empty() {
                        let _ = app.emit("sim:flight", session.summary());
                    }
                }
                let since_stats = last_stats.elapsed();
                if since_stats >= Duration::from_secs(1) {
                    let rate_hz = frames_since_stats as f64 / since_stats.as_secs_f64();
                    let _ = app.emit("sim:stats", Stats { frames, rate_hz });
                    last_stats = Instant::now();
                    frames_since_stats = 0;
                }
            }
            ProviderEvent::Aircraft(info) => {
                if let Err(e) = recorder.set_aircraft(info.clone()) {
                    log::error!("logbook aircraft update failed: {e}");
                }
                status.lock().unwrap().aircraft = Some(info.clone());
                let _ = app.emit("sim:aircraft", &info);
                if recorder.current_flight_id().is_some() {
                    // the ATC ID may just have booked the running flight onto an airframe
                    let _ = app.emit("airframes:changed", info.atc_id.as_str());
                }
            }
            ProviderEvent::Sim(e) => {
                if matches!(e, SimEvent::Crashed) {
                    session.mark_crashed();
                }
                let _ = app.emit("sim:event", &e);
            }
            ProviderEvent::Connecting => set_state(&app, &status, "connecting", String::new(), None),
            ProviderEvent::Connected { sim_name, sim_version } => {
                recorder.set_sim_name(Some(sim_name.clone()));
                set_state(&app, &status, "connected", format!("{sim_name} {sim_version}"), Some((sim_name, sim_version)))
            }
            ProviderEvent::Disconnected { reason } => set_state(&app, &status, "disconnected", reason, None),
            ProviderEvent::Error { message } => set_state(&app, &status, "error", message, None),
        }
    }
    // Provider gone (sim quit, provider switched): keep what we have of an open flight.
    let last_ts = status.lock().unwrap().last_telemetry.as_ref().map(|t| t.timestamp_ms);
    if let Some(ts) = last_ts
        && let Err(e) = recorder.checkpoint(session.summary(), ts)
    {
        log::error!("logbook checkpoint failed: {e}");
    }
    log::info!("provider forwarder finished");
}

/// Weather at off-block and at the landing is kept with the flight (the debrief shows
/// the wind of the landing, not today's).
fn capture_metar(app: &AppHandle, store: &Store, recorder: &FlightRecorder, summary: &FlightSummary, ev: &FlightEvent) {
    let Some(id) = recorder.current_flight_id() else { return };
    let (slot, lat, lon, at_ms) = match ev {
        FlightEvent::FlightStarted { timestamp_ms } => match summary.departure {
            Some(p) => (MetarSlot::Departure, p.latitude, p.longitude, *timestamp_ms),
            None => return,
        },
        FlightEvent::PhaseChanged(tr) if tr.to == FlightPhase::Landing => {
            (MetarSlot::Arrival, tr.telemetry.latitude, tr.telemetry.longitude, tr.timestamp_ms)
        }
        _ => return,
    };
    crate::online::capture_metar(app, store.clone(), id.to_string(), slot, lat, lon, at_ms);
}

fn set_state(app: &AppHandle, status: &Mutex<StatusSnapshot>, state: &str, detail: String, sim: Option<(String, String)>) {
    let mut s = status.lock().unwrap();
    s.state = state.into();
    s.detail = detail;
    if let Some((name, version)) = sim {
        s.sim_name = Some(name);
        s.sim_version = Some(version);
    }
    if state == "disconnected" {
        s.sim_name = None;
        s.sim_version = None;
        s.aircraft = None;
    }
    let _ = app.emit("sim:status", s.clone());
}
