//! Owns the active sim provider, runs the `FlightSession` and `FlightRecorder`
//! over its telemetry, forwards everything to the webview and keeps a snapshot
//! the frontend can query on startup.
//!
//! Events emitted: `sim:status` (StatusSnapshot), `sim:telemetry` (Telemetry,
//! throttled to 10 Hz), `sim:flight` (FlightSummary, with each telemetry emit
//! and on every flight event), `sim:flight-event` (FlightEvent, and the decided
//! `TouchdownOutcomeEvent` of a touchdown – `kind: "touchdownOutcome"`), `sim:aircraft`
//! (AircraftInfo), `sim:event` (SimEvent), `sim:stats` (Stats, 1 Hz: frame
//! count and measured provider rate), `logbook:changed` (a flight was created
//! or completed – the logbook view should refetch), `approach:facts` (flight id: the
//! approach facts of a just completed flight are cached), `diag:raw` (DiagSnapshot, 2 Hz,
//! while the Live-Rohdaten view is open or the Debug-Modus is on – see
//! [`ProviderManager::set_diag_stream`] / [`ProviderManager::set_diag_debug`]).
//!
//! Hidden window (`set_ui_visible(false)`: minimised, in the tray or the tab hidden): the
//! periodic streams drop to `sim:telemetry` (+ its `sim:flight`) 1 Hz and `sim:stats` 0.2 Hz,
//! `diag:raw` pauses. Event-driven emits (status, flight events, aircraft) and the
//! `FlightSession`/recorder run unchanged on the full stream.
//!
//! Sessions: every `start` is a new provider session with its own `FlightSession`,
//! recorder and live-track buffer. The previous session is stopped first: its
//! forwarder closes an open flight as interrupted, and both its threads are joined
//! (with a timeout) before the new session touches the shared status. Within a
//! session, sim events go to the `FlightSession` (reload, pause, menu – see
//! `vectasim_core::flight`), and a `Connected` after `Disconnected`/`Error` resets the
//! position context, so the first sample after a reconnect cannot be a landing.
//!
//! Resume after a crash: on the first evaluated sample after the session connected (without
//! an open flight) and after a flight ended as interrupted, the forwarder asks the store for an
//! interrupted flight the current position continues (`Store::resume_candidate`: last sample
//! at most 30 min old, within 5 nm and 3 000 ft) while the aircraft is airborne or not parked
//! (engines running / moving). If there is one it emits `flight:resumable` (ResumeCandidate);
//! the pilot's "Fortsetzen" comes back as [`ProviderManager::resume_flight`] (command
//! `resume_flight`), which the forwarder thread carries out: the session takes the old times
//! (`FlightSession::resume_from`), the recorder continues the old flight row and folds in
//! whatever it recorded since (`FlightRecorder::resume`); then `flight:resumed` (flight id).
//! Never for demo / replay sessions.

use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use vectasim_core::diag::{RawDiag, SharedRawDiag};
use vectasim_core::flight::{FlightDiscardedEvent, TouchdownOutcomeEvent};
use vectasim_core::touchdown::TouchdownOutcome;
use vectasim_core::{
    AircraftInfo, FlightDebug, FlightEvent, FlightPhase, FlightSession, FlightState, FlightSummary, MockProvider, ProviderEvent, SimProvider,
    Telemetry, now_ms,
};
use vectasim_dump::{DumpRecorder, DumpStatus, RingConfig};
use vectasim_simconnect::{ReplayConfig, ReplayProvider, SimConnectProvider};
use vectasim_xplane::{XPlaneConfig, XPlaneProvider};
use vectasim_store::{AirportResolver, FlightRecorder, LiveTrack, MetarSlot, PlannedSlot, RecorderContext, Store, TrackSample};

pub const PROVIDERS: &[&str] = &["simconnect", "xplane", "mock", "replay"];

const TELEMETRY_EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// `sim:telemetry` while the window is hidden.
const TELEMETRY_EMIT_INTERVAL_HIDDEN: Duration = Duration::from_secs(1);
const STATS_INTERVAL: Duration = Duration::from_secs(1);
/// `sim:stats` while the window is hidden.
const STATS_INTERVAL_HIDDEN: Duration = Duration::from_secs(5);
/// How often an idle forwarder looks at its stop flag.
const FORWARDER_POLL: Duration = Duration::from_millis(100);
/// Waiting for a stopped session's threads; past this they are left to finish on their own.
const FORWARDER_JOIN_TIMEOUT: Duration = Duration::from_secs(3);
const PROVIDER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
/// `diag:raw` while the Live-Rohdaten view is open.
const DIAG_EMIT_INTERVAL: Duration = Duration::from_millis(500);
/// How often the forwarder copies the engine internals for the Diagnose view.
const DEBUG_STATE_INTERVAL: Duration = Duration::from_millis(250);
/// A `flight:resumable` offer can be accepted this long (the toast closes after 60 s, hovering pauses it).
const RESUME_OFFER_TTL: Duration = Duration::from_secs(5 * 60);
/// How long `resume_flight` waits for the forwarder thread.
const RESUME_REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// Providers whose flights are throwaway: never offered for resuming.
const NO_RESUME_PROVIDERS: &[&str] = &["mock", "replay"];

/// Requests from commands to the session's forwarder thread (it owns session and recorder).
pub(crate) enum Control {
    Resume { flight_id: String, reply: mpsc::Sender<Result<(), String>> },
}

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

/// Everything Settings → Diagnostics → live raw values shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagSnapshot {
    pub at_ms: u64,
    pub provider: String,
    pub state: String,
    /// Raw definitions, event log and connection info; `None` for providers without raw data (mock).
    pub raw: Option<RawDiag>,
    /// Phase engine and touchdown detector internals of the running session.
    pub engine: Option<FlightDebug>,
    pub dump: DumpStatus,
}

/// Shared between the manager (commands) and the session's forwarder (2 Hz stream).
pub(crate) struct DiagHub {
    stream: AtomicBool,
    /// Debug-Modus: stream regardless of the view.
    debug: AtomicBool,
    engine: Mutex<Option<FlightDebug>>,
    raw: Mutex<Option<SharedRawDiag>>,
    dump: Arc<DumpRecorder>,
}

impl DiagHub {
    fn snapshot(&self, status: &Mutex<StatusSnapshot>) -> DiagSnapshot {
        let at_ms = now_ms();
        let (provider, state) = {
            let s = lock(status);
            (s.provider.clone(), s.state.clone())
        };
        let raw = lock(&self.raw).clone().map(|r| lock(&r).snapshot(at_ms));
        DiagSnapshot { at_ms, provider, state, raw, engine: lock(&self.engine).clone(), dump: self.dump.status() }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub frames: u64,
    pub rate_hz: f64,
}

/// Where the forwarder's output goes: the webview and the app's background jobs in the
/// app, a recording fake in tests.
pub(crate) trait Outbox: Send + 'static {
    fn emit_value(&self, event: &str, payload: serde_json::Value);
    /// A flight was closed (completed or interrupted): cache its approach facts.
    fn flight_closed(&self, store: &Store, flight_id: &str);
    /// Fetch the METAR for one end of a flight.
    fn capture_metar(&self, store: &Store, flight_id: &str, slot: MetarSlot, lat: f64, lon: f64, at_ms: u64);
    /// Windows notification (landing, flight saved, connection); the app decides whether it shows.
    fn notify(&self, _kind: crate::notify::Kind, _title: &str, _body: &str) {}
    /// Landing line inside the simulator (SimConnect only, see `simtext.rs`).
    fn landing_in_sim(&self, _store: &Store, _flight_id: Option<String>, _index: usize, _touch_and_go: bool) {}
}

impl Outbox for AppHandle {
    fn emit_value(&self, event: &str, payload: serde_json::Value) {
        let _ = self.emit(event, payload);
    }

    fn flight_closed(&self, store: &Store, flight_id: &str) {
        crate::approach::spawn_store_facts(self.clone(), store.clone(), flight_id.to_owned());
    }

    fn capture_metar(&self, store: &Store, flight_id: &str, slot: MetarSlot, lat: f64, lon: f64, at_ms: u64) {
        crate::online::capture_metar(self, store.clone(), flight_id.to_owned(), slot, lat, lon, at_ms);
    }

    fn notify(&self, kind: crate::notify::Kind, title: &str, body: &str) {
        // focus check and toast go through the event loop: never hold up the forwarder for it
        let (app, title, body) = (self.clone(), title.to_owned(), body.to_owned());
        let _ = std::thread::Builder::new().name("notify".into()).spawn(move || {
            crate::notify::send(&app, kind, &title, &body);
        });
    }

    fn landing_in_sim(&self, store: &Store, flight_id: Option<String>, index: usize, touch_and_go: bool) {
        if !crate::simtext::enabled(store) {
            return;
        }
        // runway match needs the airport index and the stored touchdowns: off the forwarder thread
        let (app, store) = (self.clone(), store.clone());
        let _ = std::thread::Builder::new().name("sim-text".into()).spawn(move || {
            let Some(detail) = flight_id.and_then(|id| store.get_flight(&id).ok().flatten()) else { return };
            let Some(td) = detail.touchdowns.get(index) else { return };
            let fact = app
                .try_state::<Arc<vectasim_data::AirportIndex>>()
                .map(|a| crate::landing::compute_fact(&store, &a, &detail.flight, &detail.touchdowns, index));
            let rate = td.landing_rate_source.is_rated().then_some(td.landing_rate_fpm);
            let line = crate::simtext::landing_line(crate::lang::current(), rate, td.peak_g, td.bounces, touch_and_go, fact.as_ref());
            vectasim_simconnect::text::show_text(&line, crate::simtext::SECONDS);
        });
    }
}

/// Samples after the client's cursor `ts_ms` ([`ProviderManager::live_track_since`]). The
/// recorder appends in strictly increasing `t_ms` (it never writes a sample back in time, see
/// `vectasim_store::recorder`). Should the order still break (a buffer from an older build), the
/// cursor is the sample the client saw last (`t_ms == ts_ms`, the latest one with it) and
/// everything after it is new to the client – rather than nothing, which a binary search over
/// unsorted samples could return. Without that sample: from the first one newer than `ts_ms`.
fn samples_since(samples: &[TrackSample], ts_ms: u64) -> Vec<TrackSample> {
    let from = match samples.iter().rposition(|s| s.t_ms == ts_ms) {
        Some(i) => i + 1,
        None => samples.iter().position(|s| s.t_ms > ts_ms).unwrap_or(samples.len()),
    };
    samples[from..].to_vec()
}

fn emit<T: Serialize + ?Sized>(out: &impl Outbox, event: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(v) => out.emit_value(event, v),
        Err(e) => log::warn!("{event}: payload not serialisable: {e}"),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Active {
    stop: Arc<AtomicBool>,
    provider: JoinHandle<()>,
    forwarder: JoinHandle<()>,
    control: mpsc::Sender<Control>,
}

impl Active {
    /// Stop both threads and wait for them; the forwarder closes an open flight on its way out.
    fn shut_down(self) {
        self.stop.store(true, Ordering::Relaxed);
        if !join_timeout(self.forwarder, FORWARDER_JOIN_TIMEOUT) {
            log::warn!("provider forwarder did not finish within {FORWARDER_JOIN_TIMEOUT:?}; continuing without it");
        }
        if !join_timeout(self.provider, PROVIDER_JOIN_TIMEOUT) {
            log::warn!("sim provider thread did not finish within {PROVIDER_JOIN_TIMEOUT:?}; continuing without it");
        }
    }
}

/// Join `h` unless it takes longer than `timeout` (then it is detached). True when joined.
fn join_timeout(h: JoinHandle<()>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !h.is_finished() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if h.join().is_err() {
        log::error!("a provider session thread panicked");
    }
    true
}

pub struct ProviderManager {
    active: Mutex<Option<Active>>,
    status: Arc<Mutex<StatusSnapshot>>,
    /// 1 Hz samples of the flight being recorded by the current session (a fresh buffer per session).
    live: Mutex<LiveTrack>,
    /// Dispatch plan to attach to the next flight that starts.
    pub planned: PlannedSlot,
    /// True while a flight is open; the SimConnect provider keeps its reconnect backoff short otherwise.
    flight_active: Arc<AtomicBool>,
    /// Logbook id of the flight the current session is recording.
    current_flight: Arc<Mutex<Option<String>>>,
    diag: Arc<DiagHub>,
    /// What `select_provider("replay")` plays (initialised from `VECTASIM_REPLAY*`).
    replay: Mutex<ReplayConfig>,
    /// The window is visible (frontend `set_ui_visible`); false throttles the periodic emits.
    ui_visible: Arc<AtomicBool>,
    /// Where `select_provider("xplane")` connects (env `VECTASIM_XPLANE_HOST/PORT`, then the setting).
    xplane: Mutex<XPlaneConfig>,
    /// The configured simulator (`auto` | `simconnect` | `xplane`) that `start("sim")` runs.
    sim_mode: Mutex<String>,
    /// Bumped by every `start`; the automatic-choice supervisor of an older generation quits.
    pub(crate) auto_gen: std::sync::atomic::AtomicU64,
}

impl ProviderManager {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(None),
            status: Arc::new(Mutex::new(StatusSnapshot { state: "idle".into(), ..Default::default() })),
            live: Mutex::new(LiveTrack::default()),
            planned: PlannedSlot::default(),
            flight_active: Arc::new(AtomicBool::new(false)),
            current_flight: Arc::default(),
            diag: Arc::new(DiagHub {
                stream: AtomicBool::new(false),
                debug: AtomicBool::new(false),
                engine: Mutex::new(None),
                raw: Mutex::new(None),
                dump: Arc::new(DumpRecorder::new(env!("CARGO_PKG_VERSION"), RingConfig::default())),
            }),
            replay: Mutex::new(ReplayConfig::from_env()),
            ui_visible: Arc::new(AtomicBool::new(true)),
            xplane: Mutex::new(XPlaneConfig::from_env()),
            sim_mode: Mutex::new(crate::simselect::MODE_AUTO.into()),
            auto_gen: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn xplane_config(&self) -> XPlaneConfig {
        lock(&self.xplane).clone()
    }

    pub fn set_xplane_config(&self, cfg: XPlaneConfig) {
        *lock(&self.xplane) = cfg;
    }

    pub fn sim_mode(&self) -> String {
        lock(&self.sim_mode).clone()
    }

    pub fn set_sim_mode(&self, mode: &str) {
        *lock(&self.sim_mode) = mode.to_owned();
    }

    /// A flight is open in the running session.
    pub fn flight_open(&self) -> bool {
        self.flight_active.load(Ordering::Relaxed)
    }

    /// The frontend reports whether the window is visible (`visibilitychange`, minimise, tray).
    /// Hidden: `sim:telemetry` 1 Hz, `sim:stats` 0.2 Hz, no `diag:raw`; recording is unaffected.
    pub fn set_ui_visible(&self, visible: bool) {
        if self.ui_visible.swap(visible, Ordering::Relaxed) != visible {
            log::info!("ui {}: live emits {}", if visible { "visible" } else { "hidden" }, if visible { "at full rate" } else { "throttled" });
        }
    }

    /// The raw recorder (RAM ring of the last 30 min, session files while switched on).
    pub fn dump(&self) -> &Arc<DumpRecorder> {
        &self.diag.dump
    }

    pub fn diagnostics(&self) -> DiagSnapshot {
        self.diag.snapshot(&self.status)
    }

    /// The Live-Rohdaten view is open: the forwarder emits `diag:raw` at 2 Hz.
    pub fn set_diag_stream(&self, on: bool) {
        self.diag.stream.store(on, Ordering::Relaxed);
    }

    /// Debug-Modus: `diag:raw` streams at 2 Hz whether or not the view is open.
    pub fn set_diag_debug(&self, on: bool) {
        self.diag.debug.store(on, Ordering::Relaxed);
    }

    pub fn replay_config(&self) -> ReplayConfig {
        lock(&self.replay).clone()
    }

    pub fn set_replay_config(&self, cfg: ReplayConfig) {
        *lock(&self.replay) = cfg;
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        lock(&self.status).clone()
    }

    pub fn live_track(&self) -> Vec<TrackSample> {
        let live = lock(&self.live).clone();
        lock(&live).clone()
    }

    /// Live-track samples strictly after `ts_ms` (`TrackSample::t_ms`), for incremental reloads.
    /// The buffer is replaced per provider session and cleared when a new flight starts, so a
    /// client that saw a newer `t_ms` than the buffer's last sample should reseed with `live_track`.
    pub fn live_track_since(&self, ts_ms: u64) -> Vec<TrackSample> {
        let live = lock(&self.live).clone();
        let samples = lock(&live);
        samples_since(&samples, ts_ms)
    }

    /// The flight this provider session is recording, if any – never one left over from
    /// an earlier session (use this, not `Store::active_flight_id`, to attach things to
    /// "the running flight").
    pub fn current_flight_id(&self) -> Option<String> {
        lock(&self.current_flight).clone()
    }

    /// "Fortsetzen" on a `flight:resumable` offer: the running session continues that flight.
    /// Blocks until the forwarder thread did it (or failed); call off the main thread.
    pub fn resume_flight(&self, flight_id: &str) -> Result<(), String> {
        let control = lock(&self.active).as_ref().map(|a| a.control.clone()).ok_or(crate::lang::tr("Kein Simulator verbunden.", "No simulator connected."))?;
        let (reply, rx) = mpsc::channel();
        control
            .send(Control::Resume { flight_id: flight_id.to_owned(), reply })
            .map_err(|_| crate::lang::tr("Die Aufzeichnung läuft nicht mehr.", "The recording is no longer running.").to_string())?;
        rx.recv_timeout(RESUME_REPLY_TIMEOUT).map_err(|_| crate::lang::tr("Die Aufzeichnung hat nicht geantwortet.", "The recording did not answer.").to_string())?
    }

    fn make_provider(&self, kind: &str) -> Result<Box<dyn SimProvider>, String> {
        match kind {
            "mock" => Ok(Box::new(MockProvider::default())),
            "simconnect" => Ok(Box::new(SimConnectProvider {
                flight_active: self.flight_active.clone(),
                dump: Some(self.diag.dump.clone()),
                ..Default::default()
            })),
            "xplane" => Ok(Box::new(XPlaneProvider {
                config: self.xplane_config(),
                dump: Some(self.diag.dump.clone()),
                diag: RawDiag::shared("xplane"),
            })),
            "replay" => Ok(Box::new(self.replay_config().provider(crate::lang::current())?)),
            // `VECTASIM_PROVIDER=replay:<file>`
            other if other.starts_with("replay:") => {
                let cfg = self.replay_config();
                Ok(Box::new(ReplayProvider::new(other["replay:".len()..].trim(), cfg.speed, cfg.loop_).with_lang(crate::lang::current())))
            }
            other => Err(format!("unknown provider '{other}'")),
        }
    }

    /// Stop whatever is running and start `kind`. A new provider gets a fresh flight session and recorder.
    /// `sim` = the configured simulator ([`Self::sim_mode`]); `auto` = SimConnect first, X-Plane
    /// when MSFS does not come up (see [`crate::simselect`]).
    pub fn start(&self, app: AppHandle, store: Store, resolver: Arc<dyn AirportResolver>, kind: &str) -> Result<(), String> {
        let kind = if kind == "sim" { self.sim_mode() } else { kind.to_owned() };
        let generation = self.auto_gen.fetch_add(1, Ordering::SeqCst) + 1;
        if kind == crate::simselect::MODE_AUTO {
            return crate::simselect::start_auto(self, app, store, resolver, generation);
        }
        self.start_kind(app, store, resolver, &kind)
    }

    /// Start `kind` without touching the automatic choice (its supervisor switches with this).
    pub(crate) fn start_kind(&self, app: AppHandle, store: Store, resolver: Arc<dyn AirportResolver>, kind: &str) -> Result<(), String> {
        let provider = self.make_provider(kind)?;
        self.start_with(app, store, resolver, provider)
    }

    pub(crate) fn start_with<O: Outbox + Clone>(
        &self,
        out: O,
        store: Store,
        resolver: Arc<dyn AirportResolver>,
        provider: Box<dyn SimProvider>,
    ) -> Result<(), String> {
        let mut active = lock(&self.active);
        if let Some(old) = active.take() {
            // closes the old session's flight as interrupted before anything is shared with the new one
            old.shut_down();
        }
        self.flight_active.store(false, Ordering::Relaxed);
        *lock(&self.current_flight) = None;
        let live = LiveTrack::default();
        *lock(&self.live) = live.clone();

        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<ProviderEvent>();
        let provider_name = provider.name().to_string();
        *lock(&self.diag.raw) = provider.raw_diag();
        *lock(&self.diag.engine) = None;
        {
            let mut s = lock(&self.status);
            *s = StatusSnapshot { provider: provider_name.clone(), state: "connecting".into(), ..Default::default() };
            emit(&out, "sim:status", &*s);
        }
        let resume_allowed = !NO_RESUME_PROVIDERS.contains(&provider_name.as_str());
        let provider_name_is_simconnect = provider_name == "simconnect";
        let recorder = FlightRecorder::new(store.clone(), RecorderContext { provider: provider_name, ..Default::default() })
            .with_live_track(live)
            .with_resolver(resolver)
            .with_planned(self.planned.clone());
        let fwd = Forwarder::new(
            out,
            self.status.clone(),
            stop.clone(),
            recorder,
            store,
            self.flight_active.clone(),
            self.current_flight.clone(),
        )
        .with_diag(self.diag.clone())
        .with_ui_visible(self.ui_visible.clone())
        .with_resume(resume_allowed)
        .with_sim_text(provider_name_is_simconnect);
        let (control, control_rx) = mpsc::channel();
        let forwarder = std::thread::Builder::new()
            .name("provider-forwarder".into())
            .spawn(move || fwd.run(rx, control_rx))
            .map_err(|e| e.to_string())?;
        let provider = provider.start(tx, stop.clone());
        *active = Some(Active { stop, provider, forwarder, control });
        Ok(())
    }
}

struct Forwarder<O: Outbox> {
    out: O,
    status: Arc<Mutex<StatusSnapshot>>,
    stop: Arc<AtomicBool>,
    recorder: FlightRecorder,
    store: Store,
    flight_active: Arc<AtomicBool>,
    current_flight: Arc<Mutex<Option<String>>>,
    session: FlightSession,
    last_emit: Instant,
    last_stats: Instant,
    frames_since_stats: u64,
    /// `Disconnected`/`Error` seen since the last `Connected`.
    link_lost: bool,
    last_ts: Option<u64>,
    diag: Option<Arc<DiagHub>>,
    last_debug: Instant,
    last_diag_emit: Instant,
    /// Shared with the manager; false = window hidden, periodic emits throttled.
    ui_visible: Arc<AtomicBool>,
    /// Resume offers are possible in this session (not demo / replay).
    resume_allowed: bool,
    /// Look for a resumable flight with the next evaluated sample.
    resume_check: bool,
    /// The flight offered by `flight:resumable` and when.
    resume_offer: Option<(String, Instant)>,
    /// Flights offered in this session (each once).
    resume_offered: HashSet<String>,
    /// Landing lines go into the sim (SimConnect provider only).
    sim_text: bool,
}

impl<O: Outbox> Forwarder<O> {
    fn new(
        out: O,
        status: Arc<Mutex<StatusSnapshot>>,
        stop: Arc<AtomicBool>,
        recorder: FlightRecorder,
        store: Store,
        flight_active: Arc<AtomicBool>,
        current_flight: Arc<Mutex<Option<String>>>,
    ) -> Self {
        Self {
            out,
            status,
            stop,
            recorder,
            store,
            flight_active,
            current_flight,
            session: FlightSession::new(),
            // the first sample is emitted at once, visible or not
            last_emit: Instant::now().checked_sub(TELEMETRY_EMIT_INTERVAL_HIDDEN).unwrap_or_else(Instant::now),
            last_stats: Instant::now(),
            frames_since_stats: 0,
            link_lost: false,
            last_ts: None,
            diag: None,
            last_debug: Instant::now() - DEBUG_STATE_INTERVAL,
            last_diag_emit: Instant::now() - DIAG_EMIT_INTERVAL,
            ui_visible: Arc::new(AtomicBool::new(true)),
            resume_allowed: false,
            resume_check: false,
            resume_offer: None,
            resume_offered: HashSet::new(),
            sim_text: false,
        }
    }

    fn with_resume(mut self, allowed: bool) -> Self {
        self.resume_allowed = allowed;
        self
    }

    fn with_sim_text(mut self, on: bool) -> Self {
        self.sim_text = on;
        self
    }

    fn with_ui_visible(mut self, visible: Arc<AtomicBool>) -> Self {
        self.ui_visible = visible;
        self
    }

    fn visible(&self) -> bool {
        self.ui_visible.load(Ordering::Relaxed)
    }

    /// Keep the Diagnose view's engine internals and `diag:raw` stream up to date.
    fn with_diag(mut self, diag: Arc<DiagHub>) -> Self {
        self.diag = Some(diag);
        self
    }

    fn superseded(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn run(mut self, rx: mpsc::Receiver<ProviderEvent>, control: mpsc::Receiver<Control>) {
        loop {
            match rx.recv_timeout(FORWARDER_POLL) {
                // a superseded provider may still flush a few events after being told to stop
                Ok(_) | Err(RecvTimeoutError::Timeout) if self.superseded() => break,
                Ok(ev) => self.handle(ev),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            while let Ok(c) = control.try_recv() {
                self.control(c);
            }
            self.diag_tick();
        }
        // a request that came too late still gets an answer
        while let Ok(Control::Resume { reply, .. }) = control.try_recv() {
            let _ = reply.send(Err(crate::lang::tr("Die Aufzeichnung wurde beendet.", "The recording was stopped.").into()));
        }
        self.close();
    }

    fn control(&mut self, c: Control) {
        match c {
            Control::Resume { flight_id, reply } => {
                let r = self.resume(&flight_id);
                if let Err(e) = &r {
                    log::warn!("resume of flight {flight_id} refused: {e}");
                }
                let _ = reply.send(r);
            }
        }
    }

    /// First evaluated sample after connecting / after an interrupted flight: is there an
    /// interrupted flight this position continues? Emits `flight:resumable` once per flight.
    fn check_resumable(&mut self, t: &Telemetry) {
        if !self.resume_check || !self.resume_allowed || t.paused || self.session.debug_state().sim_stopped {
            return;
        }
        self.resume_check = false;
        if !resume_position_plausible(t) {
            return;
        }
        let found = match self.store.resume_candidate(t.latitude, t.longitude, t.altitude_msl_ft, t.timestamp_ms) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("resume check failed: {e}");
                return;
            }
        };
        let Some(c) = found.filter(|c| !self.resume_offered.contains(&c.flight_id)) else { return };
        log::info!(
            "flight {} looks resumable ({:.1} nm, {:+.0} ft, {} s since its last sample)",
            c.flight_id,
            c.distance_nm,
            c.alt_diff_ft,
            t.timestamp_ms.saturating_sub(c.last_ms) / 1000
        );
        self.resume_offered.insert(c.flight_id.clone());
        self.resume_offer = Some((c.flight_id.clone(), Instant::now()));
        emit(&self.out, "flight:resumable", &c);
    }

    /// Carry out an accepted offer (see the module doc).
    fn resume(&mut self, flight_id: &str) -> Result<(), String> {
        match &self.resume_offer {
            Some((id, at)) if id == flight_id && at.elapsed() <= RESUME_OFFER_TTL => {}
            _ => return Err(crate::lang::tr("Dieser Flug kann nicht mehr fortgesetzt werden.", "This flight can no longer be resumed.").into()),
        }
        let t = lock(&self.status).last_telemetry.clone().ok_or(crate::lang::tr("Noch keine Daten vom Simulator.", "No data from the simulator yet."))?;
        let prev = self.store.flight_summary(flight_id).map_err(crate::lang::ui_error)?.ok_or(crate::lang::tr("Flug nicht gefunden", "Flight not found"))?;
        let last_old = self.store.get_track_preview(flight_id).map_err(|e| e.to_string())?.and_then(|p| p.last().map(|s| s.t_ms));
        // first sample of what follows: the flight recorded since the restart, else now
        let first_new = match self.recorder.current_flight_id() {
            Some(_) => lock(&self.recorder.live_track()).first().map_or(t.timestamp_ms, |s| s.t_ms),
            None => t.timestamp_ms,
        };
        let gap_ms = last_old.map_or(0, |last| first_new.saturating_sub(last));
        let resumed = self.session.preview_resume(&prev, gap_ms);
        self.recorder.resume(flight_id, &resumed, t.timestamp_ms).map_err(|e| e.to_string())?;
        self.session.resume_from(&prev, gap_ms);
        self.resume_offer = None;
        log::info!("flight {flight_id} resumed after a gap of {} s", gap_ms / 1000);
        let summary = self.session.summary().clone();
        self.flight_active.store(true, Ordering::Relaxed);
        *lock(&self.current_flight) = Some(flight_id.to_owned());
        lock(&self.status).flight = Some(summary.clone());
        emit(&self.out, "sim:flight", &summary);
        emit(&self.out, "flight:resumed", flight_id);
        emit(&self.out, "logbook:changed", &());
        Ok(())
    }

    /// Engine internals for the Diagnose view (cheap; at most 4×/s), and the 2 Hz
    /// `diag:raw` stream while the view is open.
    fn diag_tick(&mut self) {
        let Some(diag) = self.diag.as_ref().filter(|_| !self.superseded()) else { return };
        if self.last_debug.elapsed() >= DEBUG_STATE_INTERVAL {
            self.last_debug = Instant::now();
            *lock(&diag.engine) = Some(self.session.debug_state());
        }
        // nobody can look at the raw view while the window is hidden
        let streaming = self.visible() && (diag.stream.load(Ordering::Relaxed) || diag.debug.load(Ordering::Relaxed));
        if streaming && self.last_diag_emit.elapsed() >= DIAG_EMIT_INTERVAL {
            self.last_diag_emit = Instant::now();
            emit(&self.out, "diag:raw", &diag.snapshot(&self.status));
        }
    }

    fn handle(&mut self, ev: ProviderEvent) {
        match ev {
            ProviderEvent::Telemetry(t) => self.on_telemetry(*t),
            ProviderEvent::Aircraft(info) => {
                if let Err(e) = self.recorder.set_aircraft(info.clone()) {
                    log::error!("logbook aircraft update failed: {e}");
                }
                lock(&self.status).aircraft = Some(info.clone());
                emit(&self.out, "sim:aircraft", &info);
                if self.recorder.current_flight_id().is_some() {
                    // the ATC ID may just have booked the running flight onto an airframe
                    emit(&self.out, "airframes:changed", info.atc_id.as_str());
                }
            }
            ProviderEvent::Sim(e) => {
                log::info!("sim event: {e:?}");
                let events = self.session.on_sim_event(&e);
                self.flight_events(events);
                emit(&self.out, "sim:event", &e);
            }
            ProviderEvent::Connecting => self.set_state("connecting", String::new(), None),
            ProviderEvent::Connected { sim_name, sim_version } => {
                self.recorder.set_sim_name(Some(sim_name.clone()));
                // a flight this session keeps recording is no candidate for a resume offer
                if !self.session.has_open_flight() {
                    self.resume_check = true;
                }
                if std::mem::take(&mut self.link_lost) {
                    if self.session.has_open_flight() && !self.superseded() {
                        let l = crate::lang::current();
                        self.out.notify(
                            crate::notify::Kind::Connection,
                            l.tr("Simulator wieder da", "Simulator is back"),
                            l.tr("Die Aufzeichnung läuft weiter.", "The recording continues."),
                        );
                    }
                    log::info!("reconnected: position context reset");
                    let events = self.session.reset_position_context();
                    self.flight_events(events);
                }
                self.set_state("connected", format!("{sim_name} {sim_version}"), Some((sim_name, sim_version)))
            }
            ProviderEvent::Disconnected { reason } => {
                self.link_lost_notice();
                self.set_state("disconnected", reason, None)
            }
            ProviderEvent::Error { message } => {
                self.link_lost_notice();
                self.set_state("error", message, None)
            }
        }
    }

    /// Link to the sim gone: once per loss, and a notification while a flight is open.
    fn link_lost_notice(&mut self) {
        let was_connected = lock(&self.status).state == "connected";
        self.link_lost = true;
        if was_connected && self.session.has_open_flight() && !self.superseded() {
            let l = crate::lang::current();
            self.out.notify(
                crate::notify::Kind::Connection,
                l.tr("Verbindung zum Simulator verloren", "Connection to the simulator lost"),
                l.tr(
                    "Dein Flug ist gesichert und läuft weiter, sobald der Simulator zurück ist.",
                    "Your flight is saved and continues as soon as the simulator is back.",
                ),
            );
        }
    }

    fn on_telemetry(&mut self, t: Telemetry) {
        self.last_ts = Some(t.timestamp_ms);
        let events = self.session.update(&t);
        // the recorder forgets the id when the flight ends
        let closing = self.recorder.current_flight_id().map(str::to_owned);
        if let Err(e) = self.recorder.on_telemetry(&t, self.session.summary(), &events) {
            log::error!("logbook write failed: {e}");
        }
        let outcomes = self.record_outcomes();
        let discarded = self.record_discarded(t.timestamp_ms);
        self.announce(&events, closing, &discarded);
        self.announce_outcomes(&outcomes);
        self.announce_discarded(&discarded);
        self.check_resumable(&t);

        self.frames_since_stats += 1;
        let mut s = lock(&self.status);
        s.frames += 1;
        let frames = s.frames;
        s.last_telemetry = Some(t.clone());
        if !events.is_empty() {
            s.flight = Some(self.session.summary().clone());
        }
        if s.state != "connected" {
            s.state = "connected".into();
            emit(&self.out, "sim:status", &*s);
        }
        drop(s);
        if !events.is_empty() {
            emit(&self.out, "sim:flight", self.session.summary());
        }
        let visible = self.visible();
        let (emit_every, stats_every) =
            if visible { (TELEMETRY_EMIT_INTERVAL, STATS_INTERVAL) } else { (TELEMETRY_EMIT_INTERVAL_HIDDEN, STATS_INTERVAL_HIDDEN) };
        if self.last_emit.elapsed() >= emit_every {
            self.last_emit = Instant::now();
            emit(&self.out, "sim:telemetry", &t);
            if events.is_empty() {
                emit(&self.out, "sim:flight", self.session.summary());
            }
        }
        let since_stats = self.last_stats.elapsed();
        if since_stats >= stats_every {
            let rate_hz = self.frames_since_stats as f64 / since_stats.as_secs_f64();
            emit(&self.out, "sim:stats", &Stats { frames, rate_hz });
            self.last_stats = Instant::now();
            self.frames_since_stats = 0;
        }
    }

    /// Flight events that came without a sample (sim event, reconnect, provider stop).
    /// A reset or reload can settle a pending touchdown (`Unknown`) without any flight event.
    fn flight_events(&mut self, events: Vec<FlightEvent>) {
        let ts = self.last_ts.unwrap_or_else(now_ms);
        if events.is_empty() {
            let outcomes = self.record_outcomes();
            let discarded = self.record_discarded(ts);
            self.announce_outcomes(&outcomes);
            self.announce_discarded(&discarded);
            return;
        }
        let closing = self.recorder.current_flight_id().map(str::to_owned);
        if let Err(e) = self.recorder.on_events(self.session.summary(), &events, ts) {
            log::error!("logbook write failed: {e}");
        }
        let outcomes = self.record_outcomes();
        let discarded = self.record_discarded(ts);
        self.announce(&events, closing, &discarded);
        self.announce_outcomes(&outcomes);
        self.announce_discarded(&discarded);
        if !self.superseded() {
            lock(&self.status).flight = Some(self.session.summary().clone());
            emit(&self.out, "sim:flight", self.session.summary());
        }
    }

    /// Tell the UI and the background jobs about flight events the recorder has handled.
    /// `closing`: the flight the recorder had open before these events.
    /// `discarded`: ground sessions that ended in these events (no „Flug gespeichert“ for them).
    fn announce(&mut self, events: &[FlightEvent], closing: Option<String>, discarded: &[FlightDiscardedEvent]) {
        for fe in events {
            log::info!("flight event: {fe:?}");
            self.capture_metar(fe);
            emit(&self.out, "sim:flight-event", fe);
            if matches!(fe, FlightEvent::FlightStarted { .. } | FlightEvent::FlightEnded { .. }) {
                emit(&self.out, "logbook:changed", &());
            }
            // track is flushed and the flight closed by now: cache its approach facts
            if let (FlightEvent::FlightEnded { .. }, Some(id)) = (fe, &closing) {
                self.out.flight_closed(&self.store, id);
            }
            let was_discarded = matches!(fe, FlightEvent::FlightEnded { timestamp_ms, .. } if discarded.iter().any(|d| d.timestamp_ms == *timestamp_ms));
            if !was_discarded {
                self.notify_event(fe, closing.as_deref());
            }
        }
        // a flight cut off in this session (reload at the same spot) may be continued
        if events.iter().any(|e| matches!(e, FlightEvent::FlightEnded { interrupted: true, .. })) {
            self.resume_check = true;
        }
        if !events.is_empty() && !self.superseded() {
            self.flight_active.store(self.session.summary().state == FlightState::Active, Ordering::Relaxed);
            *lock(&self.current_flight) = self.recorder.current_flight_id().map(str::to_owned);
        }
    }

    /// Drain the session's decided touchdown outcomes into the recorder (a touch-and-go
    /// corrects its stored row). Called after the recorder saw the sample's events.
    fn record_outcomes(&mut self) -> Vec<TouchdownOutcomeEvent> {
        let outcomes = self.session.take_touchdown_outcomes();
        if !outcomes.is_empty()
            && let Err(e) = self.recorder.on_touchdown_outcomes(&outcomes)
        {
            log::error!("logbook touchdown outcome failed: {e}");
        }
        outcomes
    }

    /// Drain the session's discarded ground sessions into the recorder (state `discarded`, into
    /// the Papierkorb). Called after the recorder saw the events of the same call.
    fn record_discarded(&mut self, now: u64) -> Vec<FlightDiscardedEvent> {
        let discarded = self.session.take_discarded_flights();
        if !discarded.is_empty()
            && let Err(e) = self.recorder.on_discarded(&discarded, now)
        {
            log::error!("logbook discard failed: {e}");
        }
        discarded
    }

    /// `sim:flight-event` `flightDiscarded` and a notification per discarded ground session.
    fn announce_discarded(&self, discarded: &[FlightDiscardedEvent]) {
        if discarded.is_empty() {
            return;
        }
        for d in discarded {
            log::info!("flight discarded: {d:?}");
            emit(&self.out, "sim:flight-event", d);
            if !self.superseded() {
                let (title, body) = discarded_text(crate::lang::current());
                self.out.notify(crate::notify::Kind::Saved, title, body);
            }
        }
        emit(&self.out, "logbook:changed", &());
    }

    /// Outcomes go out after the sample's flight events, so the UI always has the touchdown
    /// before its outcome (a short-roll outcome comes in the same sample as its report).
    fn announce_outcomes(&self, outcomes: &[TouchdownOutcomeEvent]) {
        if outcomes.is_empty() {
            return;
        }
        for o in outcomes {
            log::info!("touchdown outcome: {o:?}");
            emit(&self.out, "sim:flight-event", o);
            self.notify_outcome(o);
        }
        if !self.superseded() {
            lock(&self.status).flight = Some(self.session.summary().clone());
            emit(&self.out, "sim:flight", self.session.summary());
        }
    }

    /// The landing notification waits for the outcome: "Gelandet" on a full stop,
    /// "Touch-and-go" on a touch-and-go, nothing when the stream broke off (`Unknown`).
    fn notify_outcome(&self, o: &TouchdownOutcomeEvent) {
        if self.superseded() {
            return;
        }
        let touch_and_go = match o.outcome {
            TouchdownOutcome::FullStop => false,
            TouchdownOutcome::TouchAndGo => true,
            TouchdownOutcome::Unknown | TouchdownOutcome::Pending => return,
        };
        let Some(td) = self.session.summary().touchdowns.get(o.index) else { return };
        // an unrated touchdown has no rate to announce (never "0 fpm")
        let rate = td.landing_rate_source.is_rated().then_some(td.landing_rate_fpm);
        let (title, body) = crate::notify::landing_text(crate::lang::current(), rate, td.peak_g, td.bounces, touch_and_go);
        self.out.notify(crate::notify::Kind::Landing, &title, &body);
        if self.sim_text {
            self.out.landing_in_sim(&self.store, self.recorder.current_flight_id().map(str::to_owned), o.index, touch_and_go);
        }
    }

    /// Notification for a saved (completed) flight (the landing one: [`Self::notify_outcome`]).
    fn notify_event(&self, fe: &FlightEvent, closing: Option<&str>) {
        if self.superseded() || !matches!(fe, FlightEvent::FlightEnded { interrupted: false, .. }) {
            return;
        }
        let row = closing.and_then(|id| self.store.get_flight(id).ok().flatten()).map(|d| d.flight);
        let route = row
            .as_ref()
            .map(|f| format!("{} → {}", f.dep_icao.as_deref().unwrap_or("····"), f.arr_icao.as_deref().unwrap_or("····")))
            .unwrap_or_default();
        let l = crate::lang::current();
        let body = match (route.is_empty(), l) {
            (true, _) => l.tr("Der Flug steht im Logbuch.", "The flight is in the logbook.").to_owned(),
            (false, crate::lang::Lang::De) => format!("{route} · steht im Logbuch."),
            (false, crate::lang::Lang::En) => format!("{route} · in the logbook."),
        };
        self.out.notify(crate::notify::Kind::Saved, l.tr("Flug gespeichert", "Flight saved"), &body);
    }

    /// Provider gone (switched, or its thread ended): an open flight cannot go on.
    fn close(&mut self) {
        let ts = self.last_ts.unwrap_or_else(now_ms);
        let events = self.session.interrupt(ts);
        self.flight_events(events);
        // a flight end that could not be written yet gets a last try
        if let Err(e) = self.recorder.checkpoint(self.session.summary(), ts) {
            log::error!("logbook checkpoint failed: {e}");
        }
        if !self.superseded() {
            self.flight_active.store(false, Ordering::Relaxed);
            *lock(&self.current_flight) = None;
        }
        log::info!("provider forwarder finished");
    }

    /// Weather at off-block and at the landing is kept with the flight (the debrief shows
    /// the wind of the landing, not today's).
    fn capture_metar(&self, ev: &FlightEvent) {
        let Some(id) = self.recorder.current_flight_id() else { return };
        let summary = self.session.summary();
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
        self.out.capture_metar(&self.store, id, slot, lat, lon, at_ms);
    }

    fn set_state(&self, state: &str, detail: String, sim: Option<(String, String)>) {
        let mut s = lock(&self.status);
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
        emit(&self.out, "sim:status", &*s);
    }
}

/// The aircraft is in a state a crashed flight can be continued from: airborne, or on the
/// ground but not parked (engines running or moving). Parked and cold = a new flight.
pub(crate) fn resume_position_plausible(t: &Telemetry) -> bool {
    !t.on_ground || t.engines_running > 0 || t.ground_speed_kt > 1.0
}

/// Frontend → `invoke("set_ui_visible", { visible })` on `visibilitychange` / minimise / tray.
#[tauri::command]
pub(crate) fn set_ui_visible(visible: bool, manager: tauri::State<'_, ProviderManager>) {
    manager.set_ui_visible(visible);
}

/// Frontend → `invoke("get_live_track_since", { tsMs })`: samples with `t_ms > tsMs`.
/// Off the main thread: the copy of a long live buffer (up to ~36 000 samples) is not free, and
/// the recorder's flush takes the same lock for its own copy (it encodes outside the lock).
#[tauri::command(async)]
pub(crate) fn get_live_track_since(ts_ms: u64, manager: tauri::State<'_, ProviderManager>) -> Vec<TrackSample> {
    manager.live_track_since(ts_ms)
}

/// Notification for a discarded ground session (title, body).
pub(crate) fn discarded_text(l: crate::lang::Lang) -> (&'static str, &'static str) {
    (
        l.tr("Bodensitzung verworfen", "Ground session discarded"),
        l.tr("Ohne Start kein Flug (im Papierkorb).", "No take-off, no flight (in the trash)."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use vectasim_core::{MockFlight, MockVariant, sleep_interruptible};

    #[test]
    fn samples_since_tolerates_a_buffer_out_of_order() {
        let at = |t_ms| TrackSample { t_ms, ..Default::default() };
        let sorted: Vec<_> = [10, 20, 30, 40].into_iter().map(at).collect();
        assert_eq!(samples_since(&sorted, 20).iter().map(|s| s.t_ms).collect::<Vec<_>>(), [30, 40]);
        assert!(samples_since(&sorted, 40).is_empty());
        assert_eq!(samples_since(&sorted, 0).len(), 4);
        // a clock step back in an old buffer: the client saw 40, the samples after it are new
        let stepped: Vec<_> = [10, 20, 40, 15, 16, 17].into_iter().map(at).collect();
        assert_eq!(samples_since(&stepped, 40).iter().map(|s| s.t_ms).collect::<Vec<_>>(), [15, 16, 17]);
    }

    /// `landing_in_sim` arguments: flight id, touchdown index, touch-and-go.
    type InSimCall = (Option<String>, usize, bool);

    #[derive(Clone, Default)]
    struct FakeOutbox {
        emitted: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
        closed: Arc<Mutex<Vec<String>>>,
        notified: Arc<Mutex<Vec<(crate::notify::Kind, String)>>>,
        in_sim: Arc<Mutex<Vec<InSimCall>>>,
    }

    impl Outbox for FakeOutbox {
        fn emit_value(&self, event: &str, payload: serde_json::Value) {
            lock(&self.emitted).push((event.to_owned(), payload));
        }
        fn flight_closed(&self, _store: &Store, flight_id: &str) {
            lock(&self.closed).push(flight_id.to_owned());
        }
        fn capture_metar(&self, _: &Store, _: &str, _: MetarSlot, _: f64, _: f64, _: u64) {}
        fn notify(&self, kind: crate::notify::Kind, title: &str, _body: &str) {
            lock(&self.notified).push((kind, title.to_owned()));
        }
        fn landing_in_sim(&self, _store: &Store, flight_id: Option<String>, index: usize, touch_and_go: bool) {
            lock(&self.in_sim).push((flight_id, index, touch_and_go));
        }
    }

    struct NoAirports;
    impl AirportResolver for NoAirports {
        fn nearest_ident(&self, _: f64, _: f64, _: f64) -> Option<String> {
            None
        }
    }

    /// Plays `from_s..secs` of a mock variant as fast as possible (simulated 10 Hz), then idles.
    /// `ts_offset_ms` shifts the timestamps (a restart later), `lat_shift` the positions.
    struct FakeProvider {
        name: &'static str,
        variant: MockVariant,
        from_s: f64,
        secs: f64,
        ts_offset_ms: u64,
        lat_shift: f64,
        sent: Arc<AtomicUsize>,
    }

    impl SimProvider for FakeProvider {
        fn name(&self) -> &'static str {
            self.name
        }
        fn start(self: Box<Self>, tx: mpsc::Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
            std::thread::spawn(move || {
                let _ = tx.send(ProviderEvent::Connected { sim_name: "Fake".into(), sim_version: "1".into() });
                let mut flight = MockFlight::with_variant(self.variant);
                for i in (self.from_s * 10.0) as u64 + 1..=(self.secs * 10.0) as u64 {
                    let t_s = i as f64 / 10.0;
                    for mut ev in flight.step(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64 + self.ts_offset_ms) {
                        if let ProviderEvent::Telemetry(t) = &mut ev {
                            t.latitude += self.lat_shift;
                        }
                        if stop.load(Ordering::Relaxed) || tx.send(ev).is_err() {
                            return;
                        }
                    }
                }
                self.sent.store(1, Ordering::Relaxed);
                while sleep_interruptible(Duration::from_millis(50), &stop) {}
            })
        }
    }

    fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !f() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn fake(variant: MockVariant, secs: f64) -> (Box<dyn SimProvider>, Arc<AtomicUsize>) {
        fake_from("fake", variant, 0.0, secs, 0, 0.0)
    }

    fn fake_from(name: &'static str, variant: MockVariant, from_s: f64, secs: f64, ts_offset_ms: u64, lat_shift: f64) -> (Box<dyn SimProvider>, Arc<AtomicUsize>) {
        let sent = Arc::new(AtomicUsize::new(0));
        (Box::new(FakeProvider { name, variant, from_s, secs, ts_offset_ms, lat_shift, sent: sent.clone() }), sent)
    }

    /// Wait until the provider sent everything and the forwarder processed it.
    fn settle(m: &ProviderManager, sent: &AtomicUsize, frames: u64) {
        wait_for("provider", || sent.load(Ordering::Relaxed) == 1);
        wait_for("forwarder", || m.snapshot().frames >= frames);
    }

    #[test]
    fn provider_switch_interrupts_the_open_flight_and_starts_clean() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        let (p, sent) = fake(MockVariant::Standard, 150.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 1500);
        let id = m.current_flight_id().expect("flight open after 150 s");
        assert!(m.flight_active.load(Ordering::Relaxed));
        assert!(m.live_track().len() > 100);

        let (p, _) = fake(MockVariant::Standard, 0.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        // start_with returns after the old session was shut down
        let f = store.get_flight(&id).unwrap().unwrap();
        assert_eq!(f.flight.state, "interrupted");
        assert_eq!(store.active_flight_id().unwrap(), None);
        assert_eq!(m.current_flight_id(), None);
        assert!(!m.flight_active.load(Ordering::Relaxed));
        assert!(m.live_track().is_empty(), "the new session has its own live track");
        assert_eq!(m.snapshot().provider, "fake");
        assert_eq!(m.snapshot().flight, None);
        assert_eq!(lock(&out.closed).as_slice(), [id]);
        let ended = lock(&out.emitted).iter().any(|(e, v)| e == "sim:flight-event" && v["kind"] == "flightEnded" && v["interrupted"] == true);
        assert!(ended, "the UI heard about the interrupted flight");
    }

    #[test]
    fn a_ground_session_cut_off_by_a_provider_switch_is_discarded_into_the_trash() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        // the mock taxis first: stop it before the take-off
        let (p, sent) = fake(MockVariant::Circuit, 60.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 600);
        let id = m.current_flight_id().expect("the taxi started a recording");
        let (p, _) = fake(MockVariant::Standard, 0.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        let trash = store.list_deleted_flights().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!((trash[0].flight.id.as_str(), trash[0].flight.state.as_str()), (id.as_str(), "discarded"));
        assert!(store.list_flights(10, 0).unwrap().is_empty());
        let discarded = lock(&out.emitted).iter().any(|(e, v)| e == "sim:flight-event" && v["kind"] == "flightDiscarded" && v["shutDown"] == false);
        assert!(discarded, "the UI heard about the discard");
        let titles: Vec<String> = lock(&out.notified).iter().map(|(_, t)| t.clone()).collect();
        // a superseded session notifies nothing; never „Flug gespeichert“ for a discard
        assert!(!titles.iter().any(|t| t == "Flug gespeichert"), "{titles:?}");
        assert_eq!(discarded_text(crate::lang::Lang::De), ("Bodensitzung verworfen", "Ohne Start kein Flug (im Papierkorb)."));
        assert_eq!(discarded_text(crate::lang::Lang::En).0, "Ground session discarded");
    }

    #[test]
    fn landing_notification_waits_for_the_full_stop_outcome() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        let secs = MockFlight::loop_seconds() + 10.0;
        let (p, sent) = fake(MockVariant::Standard, secs);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, (secs * 10.0) as u64);
        wait_for("flight end", || lock(&out.emitted).iter().any(|(e, v)| e == "sim:flight-event" && v["kind"] == "flightEnded"));
        let events: Vec<serde_json::Value> =
            lock(&out.emitted).iter().filter(|(e, _)| e == "sim:flight-event").map(|(_, v)| v.clone()).collect();
        let td = events.iter().position(|v| v["kind"] == "touchdown").expect("touchdown");
        let outcome = events.iter().position(|v| v["kind"] == "touchdownOutcome").expect("outcome");
        assert!(td < outcome, "the UI gets the touchdown before its outcome");
        assert_eq!(events[outcome]["outcome"], "fullStop");
        assert_eq!(events[outcome]["index"], 0);
        assert_eq!(events[outcome]["touchdownMs"], events[td]["timestampMs"]);
        // a summary goes out with the outcome (landing rate / time are set by it)
        let summary = {
            let em = lock(&out.emitted);
            let at = em.iter().position(|(e, v)| e == "sim:flight-event" && v["kind"] == "touchdownOutcome").unwrap();
            em[at..].iter().find(|(e, _)| e == "sim:flight").map(|(_, v)| v.clone())
        };
        assert!(summary.as_ref().is_some_and(|s| s["landingRateFpm"].is_number()), "{summary:?}");
        let landings: Vec<String> =
            lock(&out.notified).iter().filter(|(k, _)| *k == crate::notify::Kind::Landing).map(|(_, t)| t.clone()).collect();
        assert_eq!(landings.len(), 1, "{landings:?}");
        assert!(landings[0].starts_with("Gelandet · −"), "{landings:?}");
        // not the SimConnect provider: no line for the sim
        assert!(lock(&out.in_sim).is_empty());
    }

    #[test]
    fn simconnect_gets_the_landing_line_with_the_outcome() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        let secs = MockFlight::loop_seconds() + 10.0;
        let (p, sent) = fake_from("simconnect", MockVariant::Standard, 0.0, secs, 0, 0.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, (secs * 10.0) as u64);
        wait_for("flight end", || lock(&out.emitted).iter().any(|(e, v)| e == "sim:flight-event" && v["kind"] == "flightEnded"));
        let calls = lock(&out.in_sim).clone();
        assert_eq!(calls.len(), 1, "{calls:?}");
        let (id, index, tng) = &calls[0];
        assert_eq!((*index, *tng), (0, false));
        let id = id.as_deref().expect("the open flight's id");
        // the touchdown the line is built from is in the store by then
        assert_eq!(store.get_flight(id).unwrap().expect("flight").touchdowns.len(), 1);
    }

    #[test]
    fn replay_of_the_mock_fixture_records_one_landing() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/vectasim-core/tests/fixtures/mock-circuit.vsdump");
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        m.set_diag_stream(true);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), Box::new(ReplayProvider::new(fixture, 0.0, false))).unwrap();
        wait_for("end of replay", || m.snapshot().state == "disconnected" && m.snapshot().frames > 4_000);
        let touchdowns: Vec<serde_json::Value> = lock(&out.emitted)
            .iter()
            .filter(|(e, v)| e == "sim:flight-event" && v["kind"] == "touchdown")
            .map(|(_, v)| v.clone())
            .collect();
        assert_eq!(touchdowns.len(), 1, "{touchdowns:?}");
        let rate = touchdowns[0]["landingRateFpm"].as_f64().unwrap();
        // the demo landing: about −230 fpm (mock.rs DEMO_TD_FPM)
        assert!((-245.0..=-215.0).contains(&rate), "{rate}");
        // the fixture ends 20 s into the rollout, still fast: the outcome (and with it the
        // "Gelandet" notification) is not decided yet
        let landings: Vec<String> =
            lock(&out.notified).iter().filter(|(k, _)| *k == crate::notify::Kind::Landing).map(|(_, t)| t.clone()).collect();
        assert!(landings.is_empty(), "{landings:?}");
        assert!(!lock(&out.emitted).iter().any(|(e, v)| e == "sim:flight-event" && v["kind"] == "touchdownOutcome"));
        let snap = m.snapshot();
        assert_eq!(snap.provider, "replay");
        assert!(snap.detail.starts_with("Replay beendet"), "{}", snap.detail);

        // diagnostics: raw definitions from the replay, engine internals from the forwarder
        let d = m.diagnostics();
        let raw = d.raw.expect("replay has raw definitions");
        assert_eq!(raw.source, "replay");
        // FAST, SLOW, STATIC, APPROACH (1 Hz, track v2), DESIGN (once)
        assert_eq!(raw.defs.len(), 5);
        assert!(raw.defs[3].vars.iter().any(|v| v.name == "AMBIENT WIND VELOCITY" && v.value == Some(8.0)));
        assert_eq!(raw.defs[0].vars[0].name, "PLANE LATITUDE");
        assert!(raw.defs[0].vars[0].raw.is_some());
        wait_for("engine state", || m.diagnostics().engine.is_some_and(|e| e.touchdowns == 1));
        assert!(lock(&out.emitted).iter().any(|(e, _)| e == "diag:raw"), "2 Hz stream while the view is open");
        drop(m);
    }

    #[test]
    fn mock_has_no_raw_diagnostics() {
        let store = Store::open_in_memory().unwrap();
        let m = ProviderManager::new();
        let (p, sent) = fake(MockVariant::Standard, 5.0);
        m.start_with(FakeOutbox::default(), store, Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 50);
        let d = m.diagnostics();
        assert!(d.raw.is_none());
        assert_eq!(d.provider, "fake");
        let v = serde_json::to_value(&d).unwrap();
        assert!(v["raw"].is_null() && v["dump"]["ringLines"] == 0, "{v}");
    }

    #[test]
    fn replay_needs_a_file() {
        let m = ProviderManager::new();
        m.set_replay_config(ReplayConfig::default());
        assert!(m.make_provider("replay").is_err());
        assert!(m.make_provider("replay:C:/x.vsdump").is_ok());
        assert!(PROVIDERS.contains(&"replay"));
    }

    #[test]
    fn reconnect_mid_approach_lands_once() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        let secs = MockVariant::Reconnect.loop_seconds() + 10.0;
        let (p, sent) = fake(MockVariant::Reconnect, secs);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        // the link is down for 10 s of the loop: 100 fewer samples
        settle(&m, &sent, (secs * 10.0) as u64 - 100);
        let flights = store.list_flights(10, 0).unwrap();
        assert_eq!(flights.len(), 1);
        assert_eq!((flights[0].state.as_str(), flights[0].landing_count), ("completed", 1));
        assert!(flights[0].landing_vs_fpm.unwrap() < -100.0, "{:?}", flights[0].landing_vs_fpm);
        let states: Vec<String> = lock(&out.emitted)
            .iter()
            .filter(|(e, _)| e == "sim:status")
            .map(|(_, v)| v["state"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert!(states.windows(2).any(|w| w == ["disconnected", "connected"]), "{states:?}");
        drop(m); // threads stop with the process
    }

    /// The app (here: the provider session) died 250 s into the circuit; the next session
    /// comes back 2 min later in the air. Offered only where the position fits and never for
    /// demo flights; accepting continues the old flight.
    #[test]
    fn restart_near_the_interrupted_flight_offers_to_resume_it() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        let offers = |out: &FakeOutbox| -> Vec<serde_json::Value> {
            lock(&out.emitted).iter().filter(|(e, _)| e == "flight:resumable").map(|(_, v)| v.clone()).collect()
        };
        let (p, sent) = fake(MockVariant::Standard, 250.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 2_500);
        let a = m.current_flight_id().expect("flight open after 250 s");

        // 0.2° further north (12 nm): no offer (the session interrupts flight a on start)
        let (p, sent) = fake_from("fake", MockVariant::Standard, 250.0, 255.0, 120_000, 0.2);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 50);
        assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.state, "interrupted");
        assert!(offers(&out).is_empty(), "too far: {:?}", offers(&out));

        // right position, but a demo session: no offer either
        let (p, sent) = fake_from("mock", MockVariant::Standard, 250.0, 255.0, 120_000, 0.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 50);
        assert!(offers(&out).is_empty(), "demo: {:?}", offers(&out));

        // right position, 2 min later: offered
        let (p, sent) = fake_from("fake", MockVariant::Standard, 250.0, 260.0, 120_000, 0.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 100);
        let offer = offers(&out);
        assert_eq!(offer.len(), 1, "{offer:?}");
        assert_eq!(offer[0]["flightId"], a.as_str());
        assert!(offer[0]["distanceNm"].as_f64().unwrap() < 0.5, "{offer:?}");
        assert!(offer[0]["lastMs"].as_u64().is_some() && offer[0]["offBlockMs"].as_u64().is_some());
        let interim = m.current_flight_id().expect("the aircraft flew on: a new flight started");
        assert_ne!(interim, a);

        assert!(m.resume_flight("some-other-id").is_err());
        m.resume_flight(&a).unwrap();
        assert_eq!(m.current_flight_id().as_deref(), Some(a.as_str()));
        let f = store.get_flight(&a).unwrap().unwrap().flight;
        assert_eq!(f.state, "active");
        assert!(f.integrity.gap_ms >= 120_000, "{}", f.integrity.gap_ms);
        assert!(store.list_deleted_flights().unwrap().iter().any(|d| d.flight.id == interim), "interim flight in the Papierkorb");
        assert!(lock(&out.emitted).iter().any(|(e, v)| e == "flight:resumed" && v == a.as_str()));
        // an offer is accepted once
        assert!(m.resume_flight(&a).is_err());
        drop(m);
    }

    #[test]
    fn resume_needs_a_parked_or_airborne_aircraft() {
        let mut t = Telemetry { on_ground: true, ..Default::default() };
        assert!(!resume_position_plausible(&t), "parked and cold");
        t.engines_running = 2;
        assert!(resume_position_plausible(&t));
        t.engines_running = 0;
        t.ground_speed_kt = 12.0;
        assert!(resume_position_plausible(&t));
        let t = Telemetry { on_ground: false, ..Default::default() };
        assert!(resume_position_plausible(&t));
    }

    #[test]
    fn hidden_window_throttles_live_emits_but_records_everything() {
        let store = Store::open_in_memory().unwrap();
        let out = FakeOutbox::default();
        let m = ProviderManager::new();
        m.set_diag_stream(true);
        m.set_ui_visible(false);
        assert!(!m.ui_visible.load(Ordering::Relaxed));
        let started = Instant::now();
        let (p, sent) = fake(MockVariant::Standard, 150.0);
        m.start_with(out.clone(), store.clone(), Arc::new(NoAirports), p).unwrap();
        settle(&m, &sent, 1500);
        let wall_s = started.elapsed().as_secs_f64();
        let count = |name: &str| lock(&out.emitted).iter().filter(|(e, _)| e == name).count();
        // 1500 samples arrive within `wall_s`: hidden = at most one telemetry emit per second
        let telemetry = count("sim:telemetry");
        assert!(telemetry >= 1 && telemetry as f64 <= wall_s + 1.0, "{telemetry} emits in {wall_s:.2} s");
        assert!(count("sim:stats") as f64 <= wall_s / 5.0 + 1.0, "stats at 0.2 Hz");
        assert_eq!(count("diag:raw"), 0, "no raw stream while hidden");
        // recording is not throttled
        assert!(m.current_flight_id().is_some());
        assert!(m.live_track().len() > 100);
        assert!(lock(&out.emitted).iter().any(|(e, v)| e == "sim:flight-event" && v["kind"] == "flightStarted"));

        // incremental live track
        let all = m.live_track();
        let mid = all[all.len() / 2].t_ms;
        let tail = m.live_track_since(mid);
        assert_eq!(tail.len(), all.len() - all.len() / 2 - 1);
        assert!(tail.iter().all(|s| s.t_ms > mid));
        assert_eq!(tail.first().map(|s| s.t_ms), all.get(all.len() / 2 + 1).map(|s| s.t_ms));
        assert_eq!(m.live_track_since(0).len(), all.len());
        assert!(m.live_track_since(u64::MAX).is_empty());

        // visible again: full rate resumes with the next samples
        m.set_ui_visible(true);
        let before = count("sim:telemetry");
        let (p, sent) = fake(MockVariant::Standard, 3.0);
        m.start_with(out.clone(), store, Arc::new(NoAirports), p).unwrap();
        wait_for("provider", || sent.load(Ordering::Relaxed) == 1);
        wait_for("visible telemetry", || count("sim:telemetry") > before);
    }
}
