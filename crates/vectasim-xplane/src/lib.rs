//! X-Plane 12 provider over the built-in Web API (X-Plane 12.1.1+, REST + WebSocket on
//! `localhost:8086`, no plugin needed).
//!
//! Session: `GET /api/capabilities` (X-Plane version, API version – v2 preferred) →
//! `GET /api/vN/datarefs?filter[name]=…` (numeric ids of the datarefs in [`datarefs`]) →
//! WebSocket `ws://host:port/api/vN`, one `dataref_subscribe_values` per dataref (a failed
//! subscription fails all datarefs of its request) → `dataref_update_values` pushes at
//! 10 Hz (the Web API's fixed rate), the first complete, later ones with only the changed
//! values. Every push is one telemetry sample.
//!
//! * X-Plane not running (connection refused): `Disconnected { "sim not reachable …; retry in 5s" }`,
//!   polled every 5 s – the same wording the SimConnect provider uses, so the UI shows "Warte auf Simulator".
//! * WebSocket closed / reset: `Disconnected`, reconnect after 5 s.
//! * No push for [`XPlaneConfig::probe_after`] (a paused sim changes nothing): the REST
//!   capabilities endpoint is probed; no answer ends the session as unresponsive.
//! * A dataref this X-Plane (or aircraft) does not have is logged once, its fields stay
//!   `None`/unchanged – never a disconnect.
//! * Host/port: `VECTASIM_XPLANE_HOST` / `VECTASIM_XPLANE_PORT` (default `localhost:8086`;
//!   X-Plane's port is set with `--web_server_port=`). The Web API listens on localhost only.
//!
//! Raw recording: every push goes into the `.vsdump` ([`DumpRecorder`]) as a `data` line
//! *before* interpretation (`source: "xplane"`, see [`datarefs`] for the layout); the
//! replay provider plays it back through the same [`XpDecoder`] ([`replay::XpPlayer`]).

pub mod api;
pub mod datarefs;
pub mod decoder;
pub mod http;
pub mod replay;

pub use decoder::XpDecoder;
pub use replay::XpPlayer;

use api::{WsMsg, parse_ws};
use datarefs::{KEY_NUM, KEY_STR, N_SLOTS, NUMERIC, REQ_NUM, REQ_STR, STRINGS, offset};
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};
use vectasim_core::diag::{RawDiag, SharedRawDiag};
use vectasim_core::{ProviderEvent, SimProvider, now_ms, sleep_interruptible};
use vectasim_dump::{Body, DumpRecorder, Header};

pub const ENV_HOST: &str = "VECTASIM_XPLANE_HOST";
pub const ENV_PORT: &str = "VECTASIM_XPLANE_PORT";
pub const DEFAULT_HOST: &str = "localhost";
pub const DEFAULT_PORT: u16 = 8086;
/// `source` of the dump header of an X-Plane session.
pub const DUMP_SOURCE: &str = "xplane";
pub const SIM_NAME: &str = "X-Plane 12";

/// Where and how to reach X-Plane.
#[derive(Clone, Debug, PartialEq)]
pub struct XPlaneConfig {
    pub host: String,
    pub port: u16,
    /// Wait between connection attempts.
    pub poll: Duration,
    /// Silence after which the REST endpoint is probed.
    pub probe_after: Duration,
    /// Connect / request timeout.
    pub timeout: Duration,
}

impl Default for XPlaneConfig {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST.into(),
            port: DEFAULT_PORT,
            poll: Duration::from_secs(5),
            probe_after: Duration::from_secs(10),
            timeout: Duration::from_secs(2),
        }
    }
}

impl XPlaneConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Host and port from `env` (environment or settings); a host [`check_host`] refuses
    /// (bad syntax, a public IP address) is ignored with a warning and localhost is used.
    pub fn from_lookup(env: impl Fn(&str) -> Option<String>) -> Self {
        let mut c = Self::default();
        if let Some(h) = env(ENV_HOST).map(|h| h.trim().to_owned()).filter(|h| !h.is_empty()) {
            match check_host(&h) {
                Ok(_) => c.host = h,
                Err(e) => log::warn!("X-Plane host {h:?} ignored ({e}), using {DEFAULT_HOST}"),
            }
        }
        if let Some(p) = env(ENV_PORT).and_then(|p| p.trim().parse::<u16>().ok()).filter(|p| *p > 0) {
            c.port = p;
        }
        c
    }

    /// `X-Plane Web API localhost:8086` (Settings → Diagnostics → Source).
    pub fn source_label(&self) -> String {
        format!("X-Plane Web API {}:{}", self.host, self.port)
    }
}

/// Where an accepted X-Plane host points ([`check_host`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostScope {
    /// This PC (`localhost`, 127.0.0.0/8, `::1`).
    Loopback,
    /// An address of the local network: private (RFC 1918), link-local, shared/CGNAT
    /// (100.64.0.0/10, e.g. Tailscale), IPv6 unique-local or link-local.
    Local,
    /// A host name (`simpc`, `simpc.local`); where it points is only known when it resolves –
    /// [`http::connect`] checks every resolved address with [`ip_scope`] on each connect.
    Name,
}

/// Why [`check_host`] refused a host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostError {
    /// Not an IP address and not a valid host name (spaces, `/`, `:` with a port, `_`, …).
    Syntax,
    /// An IP address outside this PC and the local network: the Web API is plain HTTP without
    /// a password, so it is never spoken across the internet.
    Public,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            HostError::Syntax => "not an IP address or host name",
            HostError::Public => "public address – the X-Plane Web API is unencrypted, only this PC or the local network",
        })
    }
}

/// Where an IP address points: this PC, the local network, or `Err(Public)` (also `0.0.0.0`,
/// `::`, NAT64 and IPv4-mapped public addresses).
pub fn ip_scope(ip: std::net::IpAddr) -> Result<HostScope, HostError> {
    use std::net::{IpAddr, Ipv4Addr};
    let v4_scope = |a: Ipv4Addr| {
        let [o1, o2, ..] = a.octets();
        if a.is_loopback() {
            Ok(HostScope::Loopback)
        } else if a.is_private() || a.is_link_local() || (o1 == 100 && (64..128).contains(&o2)) {
            Ok(HostScope::Local)
        } else {
            Err(HostError::Public)
        }
    };
    match ip {
        IpAddr::V4(a) => v4_scope(a),
        IpAddr::V6(a) => {
            let seg0 = a.segments()[0];
            if a.is_loopback() {
                Ok(HostScope::Loopback)
            } else if let Some(v4) = a.to_ipv4_mapped() {
                v4_scope(v4)
            } else if (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80 {
                Ok(HostScope::Local)
            } else {
                Err(HostError::Public)
            }
        }
    }
}

/// Checks an X-Plane host setting: an IPv4/IPv6 address of this PC or the local network, or a
/// host name (RFC 1123 labels, not all-numeric). The X-Plane Web API is plain HTTP without
/// authentication, so public IP addresses are refused. A name is accepted here; where it points
/// is checked on every connect ([`http::connect`]: only loopback/LAN addresses are dialled, a
/// name that resolves to public addresses only is refused).
pub fn check_host(host: &str) -> Result<HostScope, HostError> {
    let h = host.trim();
    if h.is_empty() || h.len() > 253 {
        return Err(HostError::Syntax);
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        return ip_scope(ip);
    }
    let name = h.strip_suffix('.').unwrap_or(h);
    let labels: Vec<&str> = name.split('.').collect();
    let label_ok = |l: &&str| {
        (1..=63).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !l.starts_with('-') && !l.ends_with('-')
    };
    if !labels.iter().all(label_ok) || labels.last().is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit())) {
        return Err(HostError::Syntax);
    }
    if name.eq_ignore_ascii_case("localhost") {
        Ok(HostScope::Loopback)
    } else {
        Ok(HostScope::Name)
    }
}

/// Is an X-Plane Web API answering at `host:port`? Returns the X-Plane version (or `"?"`).
/// Used by the app's automatic simulator choice. Any other HTTP service on the port (port
/// 8086 is also InfluxDB's default) is not taken for X-Plane: `/api/capabilities` must be
/// a capabilities document with an API version list, or – on 404, X-Plane 12.1.1 has no
/// such endpoint – `/api/v1/datarefs/count` must answer `{"data":<number>}`.
pub fn probe(host: &str, port: u16, timeout: Duration) -> Option<String> {
    let r = http::get(host, port, "/api/capabilities", timeout).ok()?;
    match r.status {
        200 => {
            let caps = api::parse_capabilities(&r.body).filter(|c| !c.versions.is_empty())?;
            Some(caps.xplane_version.unwrap_or_else(|| "?".into()))
        }
        404 => {
            let c = http::get(host, port, "/api/v1/datarefs/count", timeout).ok()?;
            (c.status == 200 && api::is_dataref_count(&c.body)).then(|| "?".into())
        }
        _ => None,
    }
}

/// Size limits of the X-Plane WebSocket (tungstenite defaults: 64 MiB / 16 MiB); an
/// update message of all subscribed datarefs is a few KiB.
const WS_MAX_MESSAGE: usize = 4 * 1024 * 1024;
const WS_MAX_FRAME: usize = 4 * 1024 * 1024;

fn ws_config() -> tungstenite::protocol::WebSocketConfig {
    tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(WS_MAX_MESSAGE)).max_frame_size(Some(WS_MAX_FRAME))
}

pub struct XPlaneProvider {
    pub config: XPlaneConfig,
    /// Raw recorder (session files / RAM ring); `None` records nothing.
    pub dump: Option<Arc<DumpRecorder>>,
    /// Raw-value diagnostics (Settings → Diagnostics → Live raw data).
    pub diag: SharedRawDiag,
}

impl Default for XPlaneProvider {
    fn default() -> Self {
        Self { config: XPlaneConfig::from_env(), dump: None, diag: RawDiag::shared(DUMP_SOURCE) }
    }
}

impl SimProvider for XPlaneProvider {
    fn name(&self) -> &'static str {
        "xplane"
    }

    fn start(self: Box<Self>, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
        std::thread::Builder::new()
            .name("xplane-provider".into())
            .spawn(move || run(*self, tx, stop))
            .expect("spawn xplane provider")
    }

    fn raw_diag(&self) -> Option<SharedRawDiag> {
        Some(self.diag.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionEnd {
    Stopped,
    ChannelClosed,
    Closed,
    Lost(String),
    Unresponsive(Duration),
}

impl SessionEnd {
    fn reason(&self) -> String {
        match self {
            SessionEnd::Stopped => "stopped".into(),
            SessionEnd::ChannelClosed => "consumer gone".into(),
            SessionEnd::Closed => "simulator quit (X-Plane closed the Web API connection)".into(),
            SessionEnd::Lost(e) => format!("connection to X-Plane lost ({e})"),
            SessionEnd::Unresponsive(d) => format!("X-Plane not responding (no Web API message for {} s, probe unanswered)", d.as_secs()),
        }
    }
}

fn run(cfg: XPlaneProvider, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) {
    let c = &cfg.config;
    log::info!("X-Plane provider: {}", c.source_label());
    while !stop.load(Ordering::Relaxed) {
        if tx.send(ProviderEvent::Connecting).is_err() {
            return;
        }
        match connect(c) {
            Err(e) => {
                log::debug!("X-Plane not reachable at {}:{}: {e}", c.host, c.port);
                let reason = format!("sim not reachable ({}: {e}); retry in {}s", c.source_label(), c.poll.as_secs().max(1));
                if tx.send(ProviderEvent::Disconnected { reason }).is_err() {
                    return;
                }
            }
            Ok(conn) => {
                let mut session = Session::new(conn, c.clone(), cfg.diag.clone(), cfg.dump.clone());
                let end = session.run(&tx, &stop);
                log::info!("X-Plane session ended: {}", end.reason());
                let _ = tx.send(ProviderEvent::Disconnected { reason: end.reason() });
                if matches!(end, SessionEnd::Stopped | SessionEnd::ChannelClosed) {
                    return;
                }
            }
        }
        if !sleep_interruptible(c.poll, &stop) {
            return;
        }
    }
}

/// Where an update value goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    Num(usize),
    Str(usize),
}

struct Conn {
    ws: WebSocket<TcpStream>,
    api: String,
    xplane_version: String,
    /// Resolved dataref ids by target.
    ids: Vec<(Target, u64)>,
    unresolved: Vec<&'static str>,
}

fn connect(c: &XPlaneConfig) -> Result<Conn, String> {
    let caps = http::get(&c.host, c.port, "/api/capabilities", c.timeout).map_err(|e| e.to_string())?;
    let caps = match caps.status {
        200 => api::parse_capabilities(&caps.body).unwrap_or_default(),
        404 => api::Capabilities::default(),
        403 => return Err("Web API refused (HTTP 403) – in X-Plane Settings → Network turn off \"Disable Incoming Traffic\"".into()),
        s => return Err(format!("unexpected HTTP {s} from /api/capabilities")),
    };
    let api = api::pick_version(&caps);
    let names: Vec<&str> = datarefs::all_names().collect();
    let r = http::get(&c.host, c.port, &api::datarefs_query(&api, &names), c.timeout.max(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    if r.status != 200 {
        let detail = serde_json::from_str(&r.body).ok().and_then(|v| api::api_error(&v)).unwrap_or_default();
        return Err(format!("dataref lookup failed (HTTP {} {detail})", r.status));
    }
    let found = api::parse_datarefs(&r.body)?;
    let mut ids = Vec::new();
    let mut unresolved = Vec::new();
    for (i, v) in NUMERIC.iter().enumerate() {
        match found.get(v.name) {
            Some(d) => ids.push((Target::Num(i), d.id)),
            None => unresolved.push(v.name),
        }
    }
    for (i, n) in STRINGS.iter().enumerate() {
        match found.get(*n) {
            Some(d) => ids.push((Target::Str(i), d.id)),
            None => unresolved.push(*n),
        }
    }
    if ids.is_empty() {
        return Err("no dataref could be resolved (is X-Plane still loading?)".into());
    }
    let stream = http::connect(&c.host, c.port, c.timeout).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(c.timeout.max(Duration::from_secs(2)))).map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    let url = format!("ws://{}/api/{api}", http::authority(&c.host, c.port));
    let (ws, _) = tungstenite::client::client_with_config(url.as_str(), stream, Some(ws_config())).map_err(|e| format!("WebSocket {url}: {e}"))?;
    ws.get_ref().set_read_timeout(Some(READ_SLICE)).map_err(|e| e.to_string())?;
    Ok(Conn { ws, api, xplane_version: caps.xplane_version.unwrap_or_else(|| "12".into()), ids, unresolved })
}

/// Longest blocking read before the stop flag and the watchdog are checked.
const READ_SLICE: Duration = Duration::from_millis(100);

/// Dump header of an X-Plane session.
pub fn dump_header(source: &str) -> Header {
    let mut h = Header::new("", DUMP_SOURCE, datarefs::dump_defs(), datarefs::dump_reqs());
    h.dll = Some(source.to_owned());
    h
}

struct Session {
    conn: Conn,
    cfg: XPlaneConfig,
    decoder: XpDecoder,
    rec: Option<Arc<DumpRecorder>>,
    by_id: HashMap<u64, Target>,
    by_req: HashMap<u64, Target>,
    epoch: Instant,
}

impl Session {
    fn new(conn: Conn, cfg: XPlaneConfig, diag: SharedRawDiag, rec: Option<Arc<DumpRecorder>>) -> Self {
        let by_id = conn.ids.iter().map(|(t, id)| (*id, *t)).collect();
        Self { conn, cfg, decoder: XpDecoder::new(diag), rec, by_id, by_req: HashMap::new(), epoch: Instant::now() }
    }

    fn record(&self, now: Instant, w: u64, body: Body) {
        if let Some(r) = &self.rec {
            r.record(now, w, body);
        }
    }

    fn src_ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.epoch).as_millis() as u64
    }

    fn inactive_slots(&self) -> Vec<usize> {
        (0..NUMERIC.len()).filter(|v| !self.decoder.active[*v]).flat_map(|v| offset(v)..offset(v) + NUMERIC[v].n).collect()
    }

    fn start(&mut self, tx: &Sender<ProviderEvent>) -> Result<(), SessionEnd> {
        let (now, w) = (Instant::now(), now_ms());
        let source = self.cfg.source_label();
        for name in self.conn.unresolved.clone() {
            log::warn!("X-Plane dataref {name} not found; its value stays unset");
            self.decoder.note(w, "warning", name, "Dataref unbekannt – Feld bleibt leer".into());
            if let Some(i) = NUMERIC.iter().position(|v| v.name == name) {
                self.decoder.mark_inactive(i);
            } else if let Some(i) = STRINGS.iter().position(|s| *s == name) {
                self.decoder.mark_str_inactive(i);
            }
        }
        let api_label = format!("Web API {}", self.conn.api);
        if let Some(r) = &self.rec {
            let mut h = dump_header(&source);
            h.sim = Some(SIM_NAME.into());
            h.sim_version = Some(self.conn.xplane_version.clone());
            h.simconnect = Some(api_label.clone());
            let inactive = self.inactive_slots();
            if !inactive.is_empty() {
                h.inactive.insert(KEY_NUM.into(), inactive);
            }
            let s_inactive: Vec<usize> = (0..STRINGS.len()).filter(|i| !self.decoder.str_active[*i]).collect();
            if !s_inactive.is_empty() {
                h.inactive.insert(KEY_STR.into(), s_inactive);
            }
            r.begin_session(h);
        }
        log::info!(
            "X-Plane connected: {SIM_NAME} {} via {source} ({api_label}), {} of {} datarefs resolved",
            self.conn.xplane_version,
            self.conn.ids.len(),
            NUMERIC.len() + STRINGS.len()
        );
        self.record(now, w, Body::Open { sim: SIM_NAME.into(), sim_version: self.conn.xplane_version.clone(), simconnect: api_label.clone() });
        let ev = self.decoder.on_open(SIM_NAME.into(), self.conn.xplane_version.clone(), api_label, Some(source), w);
        tx.send(ev).map_err(|_| SessionEnd::ChannelClosed)?;
        for (n, (target, id)) in self.conn.ids.clone().into_iter().enumerate() {
            let req_id = n as u64 + 1;
            self.by_req.insert(req_id, target);
            self.conn
                .ws
                .send(Message::text(api::subscribe_msg(req_id, id)))
                .map_err(|e| SessionEnd::Lost(format!("subscribe: {e}")))?;
        }
        Ok(())
    }

    fn run(&mut self, tx: &Sender<ProviderEvent>, stop: &AtomicBool) -> SessionEnd {
        let end = match self.start(tx) {
            Ok(()) => self.pump(tx, stop),
            Err(e) => e,
        };
        let (now, w) = (Instant::now(), now_ms());
        let reason = end.reason();
        self.record(now, w, Body::End { reason: reason.clone() });
        self.decoder.on_end(&reason, w);
        if let Some(r) = &self.rec {
            r.end_session();
        }
        if !matches!(end, SessionEnd::Closed | SessionEnd::Lost(_)) {
            let _ = self.conn.ws.close(None);
            let _ = self.conn.ws.flush();
        }
        end
    }

    fn pump(&mut self, tx: &Sender<ProviderEvent>, stop: &AtomicBool) -> SessionEnd {
        let mut last_msg = Instant::now();
        loop {
            if stop.load(Ordering::Relaxed) {
                return SessionEnd::Stopped;
            }
            match self.conn.ws.read() {
                Ok(Message::Text(t)) => {
                    last_msg = Instant::now();
                    if let Err(e) = self.handle_text(t.as_str(), last_msg, tx) {
                        return e;
                    }
                }
                Ok(Message::Close(_)) => return SessionEnd::Closed,
                Ok(_) => last_msg = Instant::now(),
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    let silence = last_msg.elapsed();
                    if silence >= self.cfg.probe_after {
                        if probe(&self.cfg.host, self.cfg.port, self.cfg.timeout).is_some() {
                            log::debug!("no X-Plane push for {} ms; REST probe answered", silence.as_millis());
                            last_msg = Instant::now();
                        } else {
                            return SessionEnd::Unresponsive(silence);
                        }
                    }
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return SessionEnd::Closed,
                Err(e) => return SessionEnd::Lost(e.to_string()),
            }
        }
    }

    fn handle_text(&mut self, text: &str, now: Instant, tx: &Sender<ProviderEvent>) -> Result<(), SessionEnd> {
        let w = now_ms();
        let send_all = |evs: Vec<ProviderEvent>| evs.into_iter().try_for_each(|e| tx.send(e).map_err(|_| SessionEnd::ChannelClosed));
        match parse_ws(text) {
            Some(WsMsg::Update(values)) => {
                let (slots, strs) = self.split(&values);
                let src = self.src_ms(now);
                if slots.iter().any(|x| x.is_finite()) {
                    self.record(now, w, Body::data_f64(REQ_NUM, &slots, None));
                    let evs = self.decoder.on_slots(&slots, w, src, w);
                    send_all(evs)?;
                }
                if strs.iter().any(Option::is_some) {
                    let evs = self.decoder.on_strings(&strs, src, w);
                    // the merged strings, so a replay starting at this line knows the aircraft
                    let merged = self.decoder.strs.iter().map(|s| s.clone().unwrap_or_default()).collect();
                    self.record(now, w, Body::data_str(REQ_STR, merged, None));
                    send_all(evs)?;
                }
            }
            Some(WsMsg::Result { req_id, success: false, error }) => {
                let error = error.unwrap_or_else(|| "subscription failed".into());
                let Some(target) = self.by_req.get(&req_id).copied() else {
                    log::warn!("X-Plane Web API request {req_id} failed: {error}");
                    return Ok(());
                };
                let (key, name) = match target {
                    Target::Num(i) => (KEY_NUM, NUMERIC[i].name),
                    Target::Str(i) => (KEY_STR, STRINGS[i]),
                };
                log::warn!("X-Plane rejected the subscription of {name}: {error}; its value stays unset");
                match target {
                    Target::Num(i) => self.decoder.mark_inactive(i),
                    Target::Str(i) => self.decoder.mark_str_inactive(i),
                }
                self.decoder.note(w, "exception", name, error.clone());
                self.record(
                    now,
                    w,
                    Body::Exception {
                        code: 0,
                        send_id: req_id as u32,
                        index: 0,
                        call: Some(format!("dataref_subscribe_values({name}): {error}")),
                        def: Some(key.into()),
                        var: Some(name.into()),
                        dropped: true,
                    },
                );
                if let Some(r) = &self.rec {
                    let slots = self.inactive_slots();
                    let strs: Vec<usize> = (0..STRINGS.len()).filter(|i| !self.decoder.str_active[*i]).collect();
                    r.update_header(|h| {
                        for (key, list) in [(KEY_NUM, slots), (KEY_STR, strs)] {
                            if !list.is_empty() {
                                h.inactive.insert(key.into(), list);
                            }
                        }
                    });
                }
            }
            Some(WsMsg::Result { .. }) => {}
            Some(WsMsg::Other(ty)) => log::debug!("X-Plane Web API message of type {ty} ignored"),
            None => log::debug!("X-Plane Web API: unparsable message ({} bytes)", text.len()),
        }
        Ok(())
    }

    /// An update's values in slot order (NaN = not in this message) and its strings.
    fn split(&self, values: &[(u64, serde_json::Value)]) -> (Vec<f64>, Vec<Option<String>>) {
        let mut slots = vec![f64::NAN; N_SLOTS];
        let mut strs = vec![None; STRINGS.len()];
        for (id, v) in values {
            match self.by_id.get(id) {
                Some(Target::Num(i)) => {
                    let o = offset(*i);
                    for (k, x) in api::numbers(v).into_iter().take(NUMERIC[*i].n).enumerate() {
                        slots[o + k] = x;
                    }
                }
                Some(Target::Str(i)) => strs[*i] = api::decode_data(v),
                None => {}
            }
        }
        (slots, strs)
    }
}

#[cfg(test)]
mod tests;
