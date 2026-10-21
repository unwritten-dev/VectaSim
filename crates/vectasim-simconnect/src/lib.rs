//! SimConnect provider: connects to MSFS 2020/2024 (P3D/FSX share the API),
//! registers five data definitions (fast / slow / static / approach 1 Hz / design
//! speeds once), subscribes to the
//! system events a tracker cares about, and pushes `ProviderEvent`s.
//!
//! Runs on a dedicated thread because SimConnect clients are not thread-safe.
//! Reconnects with exponential back-off when the sim is not running, quits,
//! crashes (broken pipe) or stops answering (watchdog).
//!
//! Robustness rules:
//! * Only `E_FAIL` from `GetNextDispatch` means "no message"; any other error ends the session.
//! * An empty queue blocks on a Win32 event SimConnect signals (`SimConnect_Open` `hEventHandle`)
//!   for at most `MAX_WAIT` (100 ms), so an idle connection costs ~10 wake-ups/s instead of a 2-ms poll;
//!   without the event it falls back to polling (`api::POLL_INTERVAL`).
//! * A silent connection is probed with `RequestSystemState("Sim")` (see [`watchdog`]).
//! * Every send is checked; its SendID is remembered so a `SIMCONNECT_RECV_EXCEPTION`
//!   names the call (and the SimVar) that caused it.
//! * A SimVar the sim rejects is dropped from its definition, the definition is rebuilt
//!   and the field reads as NaN (→ previous/default value) instead of losing the whole
//!   definition.
//!
//! Interpretation (units, events → `ProviderEvent`) lives in [`decoder`], shared with the
//! [`replay`] provider. Every message can be recorded raw into a [`DumpRecorder`]
//! (`.vsdump`) *before* it is interpreted.

pub mod api;
pub mod decode;
pub mod decoder;
pub mod ffi;
pub mod mockdump;
pub mod replay;
pub mod text;
pub mod watchdog;

use api::{LiveApi, SimApi};
use decode::{DispatchKind, raw_f64, raw_str256};
use decoder::{DefKind, EVT_AIRCRAFT_LOADED, IDX_DESIGN, IDX_STATIC, REQ_STATE_SIM, SYSTEM_EVENTS, def_key, event_name};
pub use decoder::{APPROACH_VARS, DESIGN_VARS, Decoder, FAST_VARS, SLOW_VARS, STATIC_VARS};
use ffi::{SimConnectLib, datatype, recv_id};
pub use replay::{ReplayConfig, ReplayProvider};
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use vectasim_core::diag::{RawDiag, SharedRawDiag};
use vectasim_core::{ProviderEvent, SimEvent, SimProvider, now_ms, sleep_interruptible};
use vectasim_dump::{Body, DumpRecorder, Header};
pub use watchdog::WatchdogConfig;
use watchdog::{WatchAction, Watchdog};

pub struct SimConnectProvider {
    pub client_name: String,
    /// Index into SimConnect.cfg ([SimConnect.N]) for remote-PC setups; 0 = default/local.
    pub config_index: u32,
    /// Set by the consumer while a flight is being recorded. Without one the reconnect
    /// backoff stays short (≤ 10 s) so VectaSim picks up a freshly started sim quickly.
    pub flight_active: Arc<AtomicBool>,
    /// Dead-connection detection thresholds.
    pub watchdog: WatchdogConfig,
    /// Raw recorder (session files / RAM ring); `None` records nothing.
    pub dump: Option<Arc<DumpRecorder>>,
    /// Raw-value diagnostics (Settings → Diagnostics → Live raw data).
    pub diag: SharedRawDiag,
}

impl Default for SimConnectProvider {
    fn default() -> Self {
        Self {
            client_name: "VectaSim".into(),
            config_index: 0,
            flight_active: Arc::new(AtomicBool::new(false)),
            watchdog: WatchdogConfig::default(),
            dump: None,
            diag: RawDiag::shared("simconnect"),
        }
    }
}

/// Longest block in `wait_for_dispatch` before the stop flag and watchdog are checked again.
const MAX_WAIT: Duration = Duration::from_millis(100);
/// Client event id of our in-sim messages (SimConnect_Text); not a system event.
const EVT_TEXT: u32 = 0x5654;
const INITIAL_BACKOFF: Duration = Duration::from_secs(2);
/// Longest wait between connection attempts while no flight is open.
const MAX_BACKOFF_IDLE: Duration = Duration::from_secs(10);
/// Longest wait while a flight is open (the sim was closed mid-flight; no hurry).
const MAX_BACKOFF_FLIGHT: Duration = Duration::from_secs(30);

fn max_backoff(flight_active: bool) -> Duration {
    if flight_active { MAX_BACKOFF_FLIGHT } else { MAX_BACKOFF_IDLE }
}

/// Doubling backoff, capped by whether a flight is open.
fn next_backoff(current: Duration, flight_active: bool) -> Duration {
    (current * 2).min(max_backoff(flight_active))
}

impl SimProvider for SimConnectProvider {
    fn name(&self) -> &'static str {
        "simconnect"
    }

    fn start(self: Box<Self>, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
        std::thread::Builder::new()
            .name("simconnect-provider".into())
            .spawn(move || run(*self, tx, stop))
            .expect("spawn simconnect provider")
    }

    fn raw_diag(&self) -> Option<SharedRawDiag> {
        Some(self.diag.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionEnd {
    Quit,
    Stopped,
    ChannelClosed,
    /// `GetNextDispatch` failed with something other than `E_FAIL` (crash / broken pipe).
    ConnectionLost(ffi::HRESULT),
    /// No message for this long and the watchdog probes went unanswered.
    Unresponsive(Duration),
}

impl SessionEnd {
    fn reason(self) -> String {
        match self {
            SessionEnd::Quit => "simulator quit".into(),
            SessionEnd::Stopped => "stopped".into(),
            SessionEnd::ChannelClosed => "consumer gone".into(),
            SessionEnd::ConnectionLost(hr) => format!("connection to the simulator lost (GetNextDispatch hr=0x{hr:08X})"),
            SessionEnd::Unresponsive(d) => {
                format!("simulator not responding (no SimConnect message for {} s, probes unanswered)", d.as_secs())
            }
        }
    }
}

fn run(cfg: SimConnectProvider, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) {
    let mut backoff = INITIAL_BACKOFF;

    while !stop.load(Ordering::Relaxed) {
        let _ = tx.send(ProviderEvent::Connecting);

        // loaded once per process and kept; a failed load is retried next round
        let lib = match SimConnectLib::shared() {
            Ok(l) => l,
            Err(e) => {
                log::warn!("{e}");
                let _ = tx.send(ProviderEvent::Error { message: e.to_string() });
                if !sleep_interruptible(max_backoff(cfg.flight_active.load(Ordering::Relaxed)), &stop) {
                    break;
                }
                continue;
            }
        };

        match LiveApi::open(lib, &cfg.client_name, cfg.config_index) {
            Err(hr) => {
                // a flight may have ended since the last attempt: never wait longer than the cap
                backoff = backoff.min(max_backoff(cfg.flight_active.load(Ordering::Relaxed)));
                let _ = tx.send(ProviderEvent::Disconnected {
                    reason: format!("sim not reachable (SimConnect_Open hr=0x{hr:08X}); retry in {}s", backoff.as_secs()),
                });
                if !sleep_interruptible(backoff, &stop) {
                    break;
                }
                backoff = next_backoff(backoff, cfg.flight_active.load(Ordering::Relaxed));
            }
            Ok(api) => {
                backoff = INITIAL_BACKOFF;
                let mut session = Session::new(api, cfg.watchdog, Instant::now()).with_diag(cfg.diag.clone());
                if let Some(rec) = &cfg.dump {
                    session = session.with_recorder(rec.clone());
                }
                session.register();
                let end = session.pump(&tx, &stop);
                session.finish(end);
                drop(session); // SimConnect_Close before announcing the disconnect
                log::info!("SimConnect session ended: {}", end.reason());
                let _ = tx.send(ProviderEvent::Disconnected { reason: end.reason() });
                match end {
                    SessionEnd::Stopped | SessionEnd::ChannelClosed => break,
                    SessionEnd::Quit => {}
                    // a crashed/hung sim: don't hammer Open; the regular backoff takes over from here
                    SessionEnd::ConnectionLost(_) | SessionEnd::Unresponsive(_) => {
                        if !sleep_interruptible(INITIAL_BACKOFF, &stop) {
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// A packet we sent, remembered by SendID so exceptions can be attributed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SentCall {
    AddDef { def: usize, var: usize },
    ClearDef { def: usize },
    RequestData { def: usize },
    Subscribe { event: &'static str },
    SystemState,
    Text,
}

/// Bounded SendID → call map (registration is ~45 packets; probes add a few per minute at most).
#[derive(Debug, Default)]
struct SentLog {
    entries: VecDeque<(u32, SentCall)>,
}

impl SentLog {
    const CAP: usize = 512;

    fn push(&mut self, id: u32, call: SentCall) {
        if self.entries.len() == Self::CAP {
            self.entries.pop_front();
        }
        self.entries.push_back((id, call));
    }

    fn find(&self, id: u32) -> Option<SentCall> {
        self.entries.iter().rev().find(|(i, _)| *i == id).map(|(_, c)| *c)
    }
}

/// Dump header of a session of this provider (definitions, request ids, loaded DLL).
pub fn dump_header() -> Header {
    let mut h = Header::new("", "simconnect", decoder::dump_defs(), decoder::dump_reqs());
    h.dll = SimConnectLib::loaded_path().map(|p| p.display().to_string());
    h
}

struct Session<A: SimApi> {
    api: A,
    decoder: Decoder,
    sent: SentLog,
    /// Last known "Sim" state (event `Sim` or `RequestSystemState("Sim")`): selects the watchdog threshold.
    sim_running: bool,
    watchdog: Watchdog,
    /// Problems found outside `handle_message` (registration), forwarded on the next step.
    notices: Vec<String>,
    buf: Vec<u8>,
    rec: Option<Arc<DumpRecorder>>,
    /// Session start: source time of the decoder's rate meters.
    epoch: Instant,
    /// In-sim messages queued by the app ([`text::show_text`]).
    texts: text::TextQueue,
}

impl<A: SimApi> Session<A> {
    fn new(api: A, watchdog: WatchdogConfig, now: Instant) -> Self {
        Self {
            api,
            decoder: Decoder::new(RawDiag::shared("simconnect")),
            sent: SentLog::default(),
            sim_running: false,
            watchdog: Watchdog::new(watchdog, now),
            notices: Vec::new(),
            buf: Vec::with_capacity(1024),
            rec: None,
            epoch: now,
            texts: text::global().clone(),
        }
    }

    /// Keep the raw-value diagnostics in `diag` (shared across sessions).
    fn with_diag(mut self, diag: SharedRawDiag) -> Self {
        self.decoder = Decoder::new(diag);
        self
    }

    /// Record every message raw into `rec` (starts a new dump session).
    fn with_recorder(mut self, rec: Arc<DumpRecorder>) -> Self {
        rec.begin_session(dump_header());
        self.rec = Some(rec);
        self
    }

    fn record(&self, now: Instant, w: u64, body: Body) {
        if let Some(r) = &self.rec {
            r.record(now, w, body);
        }
    }

    fn src_ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.epoch).as_millis() as u64
    }

    /// The session is over: note it in the dump and the diagnostics.
    fn finish(&mut self, end: SessionEnd) {
        let (now, w) = (Instant::now(), now_ms());
        let reason = end.reason();
        self.record(now, w, Body::End { reason: reason.clone() });
        self.decoder.on_end(&reason, w);
        if let Some(r) = &self.rec {
            r.end_session();
        }
    }

    fn describe(&self, call: SentCall) -> String {
        let defs = &self.decoder.defs;
        match call {
            SentCall::AddDef { def, var } => {
                let d = &defs[def];
                format!("AddToDataDefinition({}, \"{}\")", d.label, d.vars[var].0)
            }
            SentCall::ClearDef { def } => format!("ClearDataDefinition({})", defs[def].label),
            SentCall::RequestData { def } => format!("RequestDataOnSimObject({})", defs[def].label),
            SentCall::Subscribe { event } => format!("SubscribeToSystemEvent(\"{event}\")"),
            SentCall::SystemState => "RequestSystemState(\"Sim\")".into(),
            SentCall::Text => "Text".into(),
        }
    }

    /// Remember the SendID of the call just made and log/collect a failed HRESULT.
    fn sent_call(&mut self, call: SentCall, hr: ffi::HRESULT) {
        if let Some(id) = self.api.last_sent_packet_id() {
            self.sent.push(id, call);
        }
        if hr < 0 {
            let what = self.describe(call);
            let msg = decoder::hr_failed_message(&what, hr);
            log::warn!("{msg}");
            let w = now_ms();
            self.record(Instant::now(), w, Body::Hr { func: what.clone(), hr: vectasim_dump::hr_hex(hr) });
            self.decoder.on_hr(&what, hr, w);
            self.notices.push(msg);
        }
    }

    /// (Re-)add all still-active variables of a definition and start its request.
    fn register_def(&mut self, idx: usize) {
        let ty = match self.decoder.defs[idx].kind {
            DefKind::F64 => datatype::FLOAT64,
            DefKind::Str256 => datatype::STRING256,
        };
        for var in 0..self.decoder.defs[idx].vars.len() {
            if !self.decoder.defs[idx].active[var] {
                continue;
            }
            let (id, (name, unit)) = (self.decoder.defs[idx].id, self.decoder.defs[idx].vars[var]);
            let hr = self.api.add_to_data_definition(id, name, unit, ty);
            self.sent_call(SentCall::AddDef { def: idx, var }, hr);
        }
        self.request_def(idx);
    }

    fn request_def(&mut self, idx: usize) {
        let d = &self.decoder.defs[idx];
        if !d.active.iter().any(|a| *a) {
            log::warn!("SimConnect definition {} has no usable variables left; not requested", d.label);
            return;
        }
        let (req, id, per) = (d.req, d.id, d.period);
        let hr = self.api.request_data_on_sim_object(req, id, per);
        self.sent_call(SentCall::RequestData { def: idx }, hr);
    }

    fn register(&mut self) {
        for idx in 0..self.decoder.defs.len() {
            self.register_def(idx);
        }
        for &(id, name) in SYSTEM_EVENTS {
            let hr = self.api.subscribe_to_system_event(id, name);
            self.sent_call(SentCall::Subscribe { event: name }, hr);
        }
        // learn whether a flight is running (selects the watchdog threshold)
        self.send_state_probe();
    }

    /// Queued in-sim messages out (a rejected one is only logged: never a recording error).
    fn send_texts(&mut self, now: Instant) {
        for m in self.texts.take(now) {
            let hr = self.api.text(ffi::text_type::PRINT_WHITE, m.seconds, EVT_TEXT, &m.text);
            if let Some(id) = self.api.last_sent_packet_id() {
                self.sent.push(id, SentCall::Text);
            }
            if hr < 0 {
                log::info!("SimConnect_Text not available or rejected (hr=0x{hr:08X}); in-sim message dropped");
                self.texts.report(text::TextOutcome::Rejected(hr), now);
            } else {
                log::debug!("in-sim message sent: {}", m.text);
                self.texts.report(text::TextOutcome::Sent, now);
            }
        }
    }

    fn send_state_probe(&mut self) {
        let hr = self.api.request_system_state(REQ_STATE_SIM, "Sim");
        self.sent_call(SentCall::SystemState, hr);
    }

    /// Drop the rejected variable from its definition and register the definition anew.
    fn rebuild_def(&mut self, idx: usize) {
        let id = self.decoder.defs[idx].id;
        let hr = self.api.clear_data_definition(id);
        self.sent_call(SentCall::ClearDef { def: idx }, hr);
        self.register_def(idx);
    }

    /// Poll GetNextDispatch until the sim quits/crashes/hangs, we are stopped, or the consumer is gone.
    fn pump(&mut self, tx: &Sender<ProviderEvent>, stop: &AtomicBool) -> SessionEnd {
        loop {
            if stop.load(Ordering::Relaxed) {
                return SessionEnd::Stopped;
            }
            match self.step(Instant::now(), tx) {
                Ok(true) => {}
                // queue empty: sleep until SimConnect signals (or poll); the cap keeps the stop
                // flag and the watchdog (second-scale thresholds) responsive
                Ok(false) => self.api.wait_for_dispatch(MAX_WAIT),
                Err(end) => return end,
            }
        }
    }

    /// One pump iteration at time `now`. `Ok(true)` = a message was handled,
    /// `Ok(false)` = queue empty, `Err` = the session is over.
    fn step(&mut self, now: Instant, tx: &Sender<ProviderEvent>) -> Result<bool, SessionEnd> {
        for message in std::mem::take(&mut self.notices) {
            tx.send(ProviderEvent::Error { message }).map_err(|_| SessionEnd::ChannelClosed)?;
        }
        self.send_texts(now);
        let mut buf = std::mem::take(&mut self.buf);
        let kind = self.api.next_dispatch(&mut buf);
        let result = match kind {
            DispatchKind::Message => {
                self.watchdog.on_message(now);
                match self.handle_message(&buf, now, tx) {
                    Ok(true) => Err(SessionEnd::Quit),
                    Ok(false) => Ok(true),
                    Err(()) => Err(SessionEnd::ChannelClosed),
                }
            }
            DispatchKind::Fatal(hr) => {
                log::warn!("SimConnect_GetNextDispatch failed hr=0x{hr:08X}: treating the connection as lost");
                let w = now_ms();
                self.record(now, w, Body::Hr { func: "GetNextDispatch".into(), hr: vectasim_dump::hr_hex(hr) });
                self.decoder.on_hr("GetNextDispatch", hr, w);
                Err(SessionEnd::ConnectionLost(hr))
            }
            DispatchKind::Empty => match self.watchdog.poll(now, self.sim_running) {
                WatchAction::Idle => Ok(false),
                WatchAction::SendProbe => {
                    log::info!(
                        "no SimConnect message for {} ms (missed probes: {}); probing with RequestSystemState(\"Sim\")",
                        self.watchdog.silence(now).as_millis(),
                        self.watchdog.missed()
                    );
                    self.send_state_probe();
                    Ok(false)
                }
                WatchAction::Dead => Err(SessionEnd::Unresponsive(self.watchdog.silence(now))),
            },
        };
        self.buf = buf;
        result
    }

    fn on_exception(&mut self, code: u32, send_id: u32, index: u32, now: Instant, w: u64) -> Vec<ProviderEvent> {
        let call = self.sent.find(send_id);
        // an in-sim message the sim does not support: logged, never an error for the recording
        if call == Some(SentCall::Text) {
            log::info!("SimConnect_Text rejected with exception {} ({code}); in-sim message not shown", ffi::exception_name(code));
            self.texts.report(text::TextOutcome::Exception(code), now);
            return Vec::new();
        }
        let what = call.map(|c| self.describe(c));
        let added = match call {
            Some(SentCall::AddDef { def, var }) => Some((def, var)),
            _ => None,
        };
        let (events, dropped) = self.decoder.on_exception(code, send_id, index, what.as_deref(), added, w);
        self.record(
            now,
            w,
            Body::Exception {
                code,
                send_id,
                index,
                call: what,
                def: added.map(|(d, _)| def_key(d).to_owned()),
                var: added.map(|(d, v)| self.decoder.defs[d].vars[v].0.to_owned()),
                dropped,
            },
        );
        if dropped && let Some((def, var)) = added {
            if let Some(r) = &self.rec {
                r.update_header(|h| h.inactive.entry(def_key(def).to_owned()).or_default().push(var));
            }
            self.rebuild_def(def);
        }
        events
    }

    /// Returns Ok(true) when the sim announced QUIT, Err(()) when the channel is closed.
    fn handle_message(&mut self, bytes: &[u8], now: Instant, tx: &Sender<ProviderEvent>) -> Result<bool, ()> {
        if bytes.len() < std::mem::size_of::<ffi::SIMCONNECT_RECV>() {
            return Ok(false);
        }
        // SAFETY: length checked; packed struct read unaligned.
        let header = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV) };
        let send_all = |events: Vec<ProviderEvent>| events.into_iter().try_for_each(|e| tx.send(e).map_err(|_| ()));
        let w = now_ms();
        match header.dw_id {
            recv_id::OPEN => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_OPEN>() {
                    // SAFETY: length checked; packed struct read unaligned.
                    let open = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_OPEN) };
                    let app = format!(
                        "{}.{}.{}.{}",
                        { open.dw_application_version_major },
                        { open.dw_application_version_minor },
                        { open.dw_application_build_major },
                        { open.dw_application_build_minor }
                    );
                    let sc = format!(
                        "{}.{}.{}.{}",
                        { open.dw_simconnect_version_major },
                        { open.dw_simconnect_version_minor },
                        { open.dw_simconnect_build_major },
                        { open.dw_simconnect_build_minor }
                    );
                    let sim_name = ffi::cstr_buf(&open.sz_application_name);
                    let dll = SimConnectLib::loaded_path().map(|p| p.display().to_string());
                    log::info!("SimConnect open: {sim_name} {app}, SimConnect {sc}, dll={}", dll.as_deref().unwrap_or_default());
                    if let Some(r) = &self.rec {
                        // before the line: a session file waiting for OPEN starts with this header
                        r.update_header(|h| {
                            h.sim = Some(sim_name.clone());
                            h.sim_version = Some(app.clone());
                            h.simconnect = Some(sc.clone());
                        });
                    }
                    self.record(now, w, Body::Open { sim: sim_name.clone(), sim_version: app.clone(), simconnect: sc.clone() });
                    let ev = self.decoder.on_open(sim_name, app, sc, dll, w);
                    send_all(vec![ev])?;
                }
                Ok(false)
            }
            recv_id::QUIT => {
                self.record(now, w, Body::Quit);
                self.decoder.on_quit(w);
                Ok(true)
            }
            recv_id::EXCEPTION => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_EXCEPTION>() {
                    // SAFETY: length checked.
                    let ex = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_EXCEPTION) };
                    let (code, send_id, index) = (ex.dw_exception, ex.dw_send_id, ex.dw_index);
                    let events = self.on_exception(code, send_id, index, now, w);
                    send_all(events)?;
                }
                Ok(false)
            }
            recv_id::SYSTEM_STATE => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_SYSTEM_STATE>() - 260 {
                    // read the fixed part only; the string is not needed for "Sim"
                    let req = u32::from_le_bytes(bytes[12..16].try_into().unwrap_or_default());
                    let int = u32::from_le_bytes(bytes[16..20].try_into().unwrap_or_default());
                    self.record(now, w, Body::SystemState { req, int });
                    self.decoder.on_system_state(req, int, w);
                    if req == REQ_STATE_SIM {
                        if self.sim_running != (int != 0) {
                            log::debug!("SimConnect system state Sim={int}");
                        }
                        self.sim_running = int != 0;
                    }
                }
                Ok(false)
            }
            recv_id::EVENT => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_EVENT>() {
                    // SAFETY: length checked.
                    let ev = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_EVENT) };
                    let (eid, data) = (ev.u_event_id, ev.dw_data);
                    let id = event_name(eid).map_or_else(|| format!("#{eid}"), str::to_owned);
                    self.record(now, w, Body::Event { id, data });
                    let events = self.decoder.on_event(eid, data, w);
                    for e in &events {
                        if let ProviderEvent::Sim(SimEvent::SimRunning { running }) = e {
                            self.sim_running = *running;
                        }
                    }
                    send_all(events)?;
                }
                Ok(false)
            }
            recv_id::EVENT_FILENAME => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_EVENT_FILENAME>() {
                    // SAFETY: length checked.
                    let ev = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_EVENT_FILENAME) };
                    let path = ffi::cstr_buf(&ev.sz_file_name);
                    let eid = ev.event.u_event_id;
                    let id = event_name(eid).map_or_else(|| format!("#{eid}"), str::to_owned);
                    self.record(now, w, Body::Filename { id, path: path.clone() });
                    if eid == EVT_AIRCRAFT_LOADED {
                        self.request_def(IDX_STATIC);
                        self.request_def(IDX_DESIGN);
                    }
                    let events = self.decoder.on_filename(eid, path, w);
                    send_all(events)?;
                }
                Ok(false)
            }
            recv_id::SIMOBJECT_DATA => {
                if bytes.len() < ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET {
                    return Ok(false);
                }
                // `dw_data` itself may be missing for an empty payload, so read the request id by offset.
                let req = u32::from_le_bytes(bytes[12..16].try_into().unwrap_or_default());
                let payload = &bytes[ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET..];
                let is_str = self.decoder.def_by_req(req).is_some_and(|i| self.decoder.defs[i].kind == DefKind::Str256);
                let src = self.src_ms(now);
                let events = if is_str {
                    let s = raw_str256(payload);
                    let partial = (!payload.len().is_multiple_of(decode::STRING256_LEN)).then_some(payload.len() as u32);
                    self.record(now, w, Body::data_str(req, s.clone(), partial));
                    self.decoder.on_data_str(req, &s, payload.len(), src, w)
                } else {
                    let v = raw_f64(payload);
                    let partial = (!payload.len().is_multiple_of(8)).then_some(payload.len() as u32);
                    self.record(now, w, Body::data_f64(req, &v, partial));
                    self.decoder.on_data_f64(req, &v, payload.len(), w, src, w)
                };
                send_all(events)?;
                Ok(false)
            }
            _ => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests;
