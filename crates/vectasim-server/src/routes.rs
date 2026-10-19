//! Router, access guard, JSON endpoints and the WebSocket stream.

use crate::api::{self, Snapshot};
use crate::auth::{self, RequestInfo};
use crate::watch::{Change, Tracker};
use crate::{Config, Limits, MAX_WS_CLIENTS, STREAM_INTERVAL, Source, overlay};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::sync::{Semaphore, broadcast, watch};
use tower::ServiceExt as _;
use vectasim_core::{Lang, now_ms};

/// Logbook rows per request: default and upper limit.
const LOGBOOK_DEFAULT: usize = 10;
const LOGBOOK_MAX: usize = 50;
/// Messages a slow client may fall behind before it skips some.
const CLIENT_BACKLOG: usize = 64;
/// Longest wait for open connections after the stop signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub(crate) struct AppState {
    cfg: Arc<Config>,
    source: Arc<dyn Source>,
    clients: Arc<AtomicUsize>,
    events: broadcast::Sender<Utf8Bytes>,
    shutdown: watch::Receiver<bool>,
}

impl AppState {
    pub(crate) fn new(cfg: Config, source: Arc<dyn Source>, clients: Arc<AtomicUsize>, shutdown: watch::Receiver<bool>) -> Self {
        let (events, _) = broadcast::channel(CLIENT_BACKLOG);
        Self { cfg: Arc::new(cfg), source, clients, events, shutdown }
    }
}

pub(crate) fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(page_index))
        .route("/overlay/hud", get(page_hud))
        .route("/overlay/landing", get(page_landing))
        .route("/overlay/route", get(page_route))
        .route("/overlay/overlay.css", get(asset_css))
        .route("/overlay/overlay.js", get(asset_js))
        .route("/api/v1/status", get(api_status))
        .route("/api/v1/flight", get(api_flight))
        .route("/api/v1/telemetry", get(api_telemetry))
        .route("/api/v1/landing", get(api_landing))
        .route("/api/v1/logbook", get(api_logbook))
        .route("/api/v1/ws", get(api_ws))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// The accept loop. Not `axum::serve`: that builds hyper without a timer, so hyper's
/// header-read timeout never fires, and it has no connection limit (slowloris in LAN mode).
/// Here every connection gets [`Limits::header_read_timeout`] (also the keep-alive idle
/// limit) and at most [`Limits::max_connections`] are served at once; further ones wait in
/// the OS backlog until a slot is free.
pub(crate) async fn serve(listener: std::net::TcpListener, state: AppState, limits: Limits, mut shutdown: watch::Receiver<bool>) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => {
            log::error!("overlay server: {e}");
            return;
        }
    };
    tokio::spawn(pump(state.clone()));
    let app = router(state);
    let max = limits.max_connections.max(1);
    let slots = Arc::new(Semaphore::new(max));
    loop {
        let permit = tokio::select! {
            p = slots.clone().acquire_owned() => match p { Ok(p) => p, Err(_) => break },
            _ = stopped(&mut shutdown) => break,
        };
        let (stream, peer) = tokio::select! {
            r = listener.accept() => match r {
                Ok(c) => c,
                Err(e) => {
                    // e.g. too many open files: back off instead of spinning
                    log::debug!("overlay server: accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
            _ = stopped(&mut shutdown) => break,
        };
        let _ = stream.set_nodelay(true);
        let svc = app.clone().map_request(move |mut req: axum::http::Request<Incoming>| {
            req.extensions_mut().insert(ConnectInfo(peer));
            req.map(Body::new)
        });
        let mut stop = shutdown.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(limits.header_read_timeout)
                .serve_connection(TokioIo::new(stream), TowerToHyperService::new(svc))
                .with_upgrades();
            let mut conn = std::pin::pin!(conn);
            tokio::select! {
                r = conn.as_mut() => if let Err(e) = r { log::debug!("overlay server: connection from {peer}: {e}") },
                _ = stopped(&mut stop) => {
                    conn.as_mut().graceful_shutdown();
                    let _ = conn.await;
                }
            }
        });
    }
    // let open requests finish (WebSockets close themselves on the stop signal)
    match tokio::time::timeout(SHUTDOWN_GRACE, slots.acquire_many(max as u32)).await {
        Ok(_) => {}
        Err(_) => log::info!("overlay server: connections still open after {SHUTDOWN_GRACE:?}, closing them"),
    }
}

/// Resolves once the stop signal is set (the watch guard is not held across awaits).
async fn stopped(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

// ---- access guard -----------------------------------------------------------------------

fn header_str(h: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": message, "status": status.as_u16() }))).into_response()
}

/// Every request: access rules ([`auth::check`]), CORS for allowed origins, and the headers
/// that keep answers out of caches, referrers and MIME sniffing.
async fn guard(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let h = req.headers();
    let origin = header_str(h, header::ORIGIN).map(str::to_owned);
    let host = header_str(h, header::HOST).map(str::to_owned);
    let token = auth::request_token(req.uri().query(), header_str(h, header::AUTHORIZATION), h.get("x-vectasim-token").and_then(|v| v.to_str().ok()))
        .map(str::to_owned);
    let info = RequestInfo { method: req.method().as_str(), host: host.as_deref(), origin: origin.as_deref(), token: token.as_deref() };
    if let Err(d) = auth::check(&info, peer, st.cfg.lan_token()) {
        log::debug!("overlay server: {} {} from {peer} refused: {d:?}", req.method(), req.uri().path());
        let mut r = error(StatusCode::from_u16(d.status()).unwrap_or(StatusCode::FORBIDDEN), d.message());
        if d == auth::Denied::Method {
            r.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD, OPTIONS"));
        }
        return r;
    }
    let preflight = req.method() == Method::OPTIONS;
    let mut res = if preflight { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let hs = res.headers_mut();
    hs.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    hs.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    hs.entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static("no-store"));
    if let Some(v) = origin.as_deref().and_then(|o| HeaderValue::from_str(o).ok()) {
        hs.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        hs.insert(header::VARY, HeaderValue::from_static("Origin"));
        if preflight {
            hs.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, HEAD, OPTIONS"));
            hs.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Authorization, X-VectaSim-Token"));
            hs.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
        }
    }
    res
}

async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "Unbekannter Pfad – Übersicht unter /")
}

// ---- pages ------------------------------------------------------------------------------

/// `Host` as it may appear in the CSP (anything else falls back to `'self'` alone).
fn csp_host(h: &HeaderMap) -> Option<&str> {
    header_str(h, header::HOST).filter(|v| !v.is_empty() && v.len() < 300 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b)))
}

#[derive(Deserialize)]
struct PageQuery {
    lang: Option<String>,
}

/// Page language: `?lang=de|en`, else the backend language.
fn page_lang(st: &AppState, q: &PageQuery) -> Lang {
    q.lang.as_deref().and_then(Lang::parse).unwrap_or_else(|| st.source.lang())
}

/// The page with its `<html lang>` set; `overlay.js` picks its texts from that attribute.
pub(crate) fn localized(body: &'static str, lang: Lang) -> String {
    body.replacen("<html lang=\"de\">", &format!("<html lang=\"{}\">", lang.code()), 1)
}

fn page(h: &HeaderMap, body: &'static str, lang: Lang) -> Response {
    // `connect-src 'self'` covers ws: in CSP 3; the explicit ws:// entry is for older engines
    let ws = csp_host(h).map(|host| format!(" ws://{host}")).unwrap_or_default();
    let csp = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'{ws}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    let mut r = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], localized(body, lang)).into_response();
    if let Ok(v) = HeaderValue::from_str(&csp) {
        r.headers_mut().insert(header::CONTENT_SECURITY_POLICY, v);
    }
    r
}

async fn page_index(State(st): State<AppState>, Query(q): Query<PageQuery>, h: HeaderMap) -> Response {
    page(&h, overlay::INDEX_HTML, page_lang(&st, &q))
}
async fn page_hud(State(st): State<AppState>, Query(q): Query<PageQuery>, h: HeaderMap) -> Response {
    page(&h, overlay::HUD_HTML, page_lang(&st, &q))
}
async fn page_landing(State(st): State<AppState>, Query(q): Query<PageQuery>, h: HeaderMap) -> Response {
    page(&h, overlay::LANDING_HTML, page_lang(&st, &q))
}
async fn page_route(State(st): State<AppState>, Query(q): Query<PageQuery>, h: HeaderMap) -> Response {
    page(&h, overlay::ROUTE_HTML, page_lang(&st, &q))
}
async fn asset_css() -> Response {
    ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], overlay::OVERLAY_CSS).into_response()
}
async fn asset_js() -> Response {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], overlay::OVERLAY_JS).into_response()
}

// ---- JSON -------------------------------------------------------------------------------

/// Reads off the runtime thread; a panicking source gives `None` (a 500), not a dead server.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| log::warn!("overlay server: source failed: {e}")).ok()
}

fn unavailable() -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, "Daten nicht verfügbar")
}

fn read_snapshot(source: &Arc<dyn Source>) -> Snapshot {
    let privacy = source.privacy();
    let mut s = source.snapshot().masked(privacy);
    s.status.api_version = api::API_VERSION;
    s.status.server_time_ms = now_ms();
    s.status.lang = source.lang();
    if s.status.app.is_empty() {
        s.status.app = "VectaSim".into();
    }
    s
}

fn read_landing(source: &Arc<dyn Source>) -> Option<api::Landing> {
    let privacy = source.privacy();
    let mut l = source.landing()?;
    if privacy {
        l.mask();
    }
    l.band_label = api::band_label_in(l.band, source.lang()).to_string();
    Some(l)
}

async fn snapshot_of(st: &AppState) -> Option<Snapshot> {
    let src = st.source.clone();
    blocking(move || read_snapshot(&src)).await
}

fn json<T: Serialize>(v: &T) -> Response {
    axum::Json(v).into_response()
}

async fn api_status(State(st): State<AppState>) -> Response {
    snapshot_of(&st).await.map_or_else(unavailable, |s| json(&s.status))
}

async fn api_flight(State(st): State<AppState>) -> Response {
    snapshot_of(&st).await.map_or_else(unavailable, |s| json(&s.flight))
}

async fn api_telemetry(State(st): State<AppState>) -> Response {
    snapshot_of(&st).await.map_or_else(unavailable, |s| json(&s.telemetry))
}

async fn api_landing(State(st): State<AppState>) -> Response {
    let src = st.source.clone();
    blocking(move || read_landing(&src)).await.map_or_else(unavailable, |l| json(&l))
}

#[derive(Deserialize)]
struct LogbookQuery {
    limit: Option<String>,
}

/// `?limit=` → 1…[`LOGBOOK_MAX`], default [`LOGBOOK_DEFAULT`]; garbage is a 400.
fn logbook_limit(raw: Option<&str>) -> Result<usize, String> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(LOGBOOK_DEFAULT),
        Some(s) => s.parse::<usize>().map(|n| n.clamp(1, LOGBOOK_MAX)).map_err(|_| format!("limit muss eine Zahl 1–{LOGBOOK_MAX} sein")),
    }
}

async fn api_logbook(State(st): State<AppState>, Query(q): Query<LogbookQuery>) -> Response {
    let limit = match logbook_limit(q.limit.as_deref()) {
        Ok(n) => n,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let src = st.source.clone();
    let rows = blocking(move || {
        let privacy = src.privacy();
        let mut rows = src.logbook(limit);
        rows.truncate(limit);
        if privacy {
            rows.iter_mut().for_each(api::LogbookEntry::mask);
        }
        rows
    })
    .await;
    rows.map_or_else(unavailable, |flights| json(&api::Logbook { flights }))
}

// ---- WebSocket ----------------------------------------------------------------------------

async fn api_ws(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    // the slot is taken before the upgrade, so parallel handshakes cannot exceed the limit;
    // a failed upgrade drops the closure and with it the slot
    let Some(slot) = ClientSlot::try_take(&st.clients, MAX_WS_CLIENTS) else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Zu viele verbundene Overlays");
    };
    // clients only listen: small frames are plenty
    ws.max_message_size(4096).max_frame_size(4096).on_upgrade(move |socket| client(socket, st, slot))
}

/// Holds the client count while a socket is open.
struct ClientSlot(Arc<AtomicUsize>);

impl ClientSlot {
    /// One more client unless `max` are connected already (atomic check and increment).
    fn try_take(c: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        c.try_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < max).then_some(n + 1)).ok()?;
        Some(Self(c.clone()))
    }
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

fn text(v: &Value) -> Utf8Bytes {
    Utf8Bytes::from(v.to_string())
}

/// First message of every connection: the whole current picture.
pub(crate) fn hello(s: &Snapshot, landing: Option<&api::Landing>) -> Value {
    json!({
        "type": "hello",
        "apiVersion": api::API_VERSION,
        "status": s.status,
        "flight": s.flight,
        "telemetry": s.telemetry,
        "landing": landing,
    })
}

async fn client(mut socket: WebSocket, st: AppState, _slot: ClientSlot) {
    let mut rx = st.events.subscribe();
    let src = st.source.clone();
    let Some((snap, landing)) = blocking(move || (read_snapshot(&src), read_landing(&src))).await else { return };
    if socket.send(Message::Text(text(&hello(&snap, landing.as_ref())))).await.is_err() {
        return;
    }
    let mut shutdown = st.shutdown.clone();
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(msg) => if socket.send(Message::Text(msg)).await.is_err() { break },
                // a slow client skips what it missed; the next telemetry message catches it up
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                // the library queues the close reply; the next read flushes it and then ends the stream
                Some(Ok(Message::Close(_))) => continue,
                // pings are answered by the library; anything else a client sends is ignored
                Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = stopped(&mut shutdown) => {
                let _ = socket.send(Message::Close(None)).await;
                break;
            }
        }
    }
}

/// The 2 Hz poll behind the stream: telemetry with the flight (for the HUD), plus events.
async fn pump(st: AppState) {
    let mut tracker = Tracker::default();
    let mut tick = tokio::time::interval(STREAM_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut shutdown = st.shutdown.clone();
    let mut last_ts = None;
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = stopped(&mut shutdown) => return,
        }
        if st.events.receiver_count() == 0 {
            tracker.reset();
            last_ts = None;
            continue;
        }
        let src = st.source.clone();
        let Some(snap) = blocking(move || read_snapshot(&src)).await else { continue };
        for msg in messages(&mut tracker, &snap) {
            let msg = match msg {
                Pending::Ready(v) => v,
                Pending::Landing => {
                    let src = st.source.clone();
                    match blocking(move || read_landing(&src)).await {
                        Some(Some(mut l)) => {
                            l.live = true;
                            json!({ "type": "landing", "landing": l })
                        }
                        _ => continue,
                    }
                }
            };
            let _ = st.events.send(text(&msg));
        }
        let ts = snap.telemetry.as_ref().map(|t| t.timestamp_ms);
        if ts.is_some() && ts != last_ts {
            last_ts = ts;
            let _ = st.events.send(text(&json!({ "type": "telemetry", "telemetry": snap.telemetry, "flight": snap.flight })));
        }
    }
}

pub(crate) enum Pending {
    Ready(Value),
    /// A landing message: needs the landing read from the source first.
    Landing,
}

/// The event messages for one snapshot.
pub(crate) fn messages(tracker: &mut Tracker, snap: &Snapshot) -> Vec<Pending> {
    let at = snap.status.server_time_ms;
    tracker
        .step(snap)
        .into_iter()
        .map(|c| match c {
            Change::Status => Pending::Ready(json!({ "type": "status", "status": snap.status })),
            Change::Phase { from, to } => Pending::Ready(json!({ "type": "phase", "from": from, "to": to, "atMs": at })),
            Change::Touchdown { .. } => Pending::Landing,
            Change::FlightSaved { flight_id, state } => Pending::Ready(json!({ "type": "flightSaved", "flightId": flight_id, "state": state, "atMs": at })),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Flight, Status};
    use vectasim_core::{FlightPhase, FlightState};

    #[test]
    fn ws_slots_never_exceed_the_limit() {
        let c = Arc::new(AtomicUsize::new(0));
        let slots: Vec<ClientSlot> = (0..5).filter_map(|_| ClientSlot::try_take(&c, 3)).collect();
        assert_eq!((slots.len(), c.load(Ordering::Relaxed)), (3, 3));
        drop(slots);
        assert_eq!(c.load(Ordering::Relaxed), 0);
        // many threads racing for the last slots
        let c = Arc::new(AtomicUsize::new(0));
        let taken: usize = std::thread::scope(|s| {
            let hs: Vec<_> = (0..32)
                .map(|_| {
                    let c = c.clone();
                    s.spawn(move || ClientSlot::try_take(&c, MAX_WS_CLIENTS).map(std::mem::forget).is_some() as usize)
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).sum()
        });
        assert_eq!((taken, c.load(Ordering::Relaxed)), (MAX_WS_CLIENTS, MAX_WS_CLIENTS));
    }

    #[test]
    fn limit_parsing() {
        assert_eq!(logbook_limit(None), Ok(10));
        assert_eq!(logbook_limit(Some("")), Ok(10));
        assert_eq!(logbook_limit(Some("3")), Ok(3));
        assert_eq!(logbook_limit(Some("0")), Ok(1));
        assert_eq!(logbook_limit(Some("999")), Ok(50));
        assert!(logbook_limit(Some("-1")).is_err());
        assert!(logbook_limit(Some("zehn")).is_err());
    }

    #[test]
    fn event_messages() {
        let mut t = Tracker::default();
        let mk = |phase, state, touchdowns| Snapshot {
            status: Status { connection: "connected".into(), server_time_ms: 42, ..Default::default() },
            flight: Some(Flight { id: Some("f".into()), phase, state, touchdowns, ..Default::default() }),
            telemetry: None,
        };
        assert!(messages(&mut t, &mk(FlightPhase::Final, FlightState::Active, 0)).is_empty());
        let m = messages(&mut t, &mk(FlightPhase::Landing, FlightState::Active, 1));
        assert!(matches!(&m[0], Pending::Ready(v) if v == &json!({ "type": "phase", "from": "final", "to": "landing", "atMs": 42 })));
        assert!(matches!(m[1], Pending::Landing));
        let m = messages(&mut t, &mk(FlightPhase::Landing, FlightState::Completed, 1));
        assert!(matches!(&m[0], Pending::Ready(v) if v == &json!({ "type": "flightSaved", "flightId": "f", "state": "completed", "atMs": 42 })));
    }

    #[test]
    fn hello_has_the_whole_picture() {
        let v = hello(&Snapshot::default(), None);
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["apiVersion", "flight", "landing", "status", "telemetry", "type"]);
        assert_eq!(v["type"], "hello");
    }
}
