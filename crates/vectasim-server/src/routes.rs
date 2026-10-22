//! Router, access guard, JSON endpoints and the WebSocket stream.

use crate::api::{self, Snapshot};
use crate::auth::{self, RequestInfo};
use crate::watch::{Change, Tracker};
use crate::{Config, Limits, STREAM_INTERVAL, Source, overlay};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Extension, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, broadcast, watch};
use tower::ServiceExt as _;
use vectasim_core::{Lang, now_ms};

/// Logbook rows per request: default and upper limit.
const LOGBOOK_DEFAULT: usize = 10;
const LOGBOOK_MAX: usize = 50;
/// Messages a slow client may fall behind before it skips some.
const CLIENT_BACKLOG: usize = 64;
/// Longest wait for open connections after the stop signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
/// How long a loopback connection asked to give its slot away ([`Pools::evict_idle`]) may take
/// to close on its own before it is dropped (no request in flight).
const KICK_GRACE: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(crate) struct AppState {
    cfg: Arc<Config>,
    /// Name of the token cookie (with the port, [`auth::cookie_name`]).
    cookie: Arc<str>,
    source: Arc<dyn Source>,
    clients: Arc<WsQuota>,
    events: broadcast::Sender<Utf8Bytes>,
    shutdown: watch::Receiver<bool>,
}

impl AppState {
    pub(crate) fn new(cfg: Config, source: Arc<dyn Source>, clients: Arc<WsQuota>, shutdown: watch::Receiver<bool>) -> Self {
        let (events, _) = broadcast::channel(CLIENT_BACKLOG);
        let cookie = auth::cookie_name(cfg.port).into();
        Self { cfg: Arc::new(cfg), cookie, source, clients, events, shutdown }
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

/// Connection slots: one pool for this PC (loopback), one for other devices with a cap per
/// address. A LAN client without a token (or many idle connections from one device) can then
/// never starve the local OBS overlays.
pub(crate) struct Pools {
    local: Arc<Semaphore>,
    lan: Arc<Semaphore>,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    per_ip_max: usize,
    max: usize,
    /// The open loopback connections, oldest first (for [`Pools::evict_idle`]).
    local_conns: Arc<Mutex<Vec<Arc<LocalConn>>>>,
}

/// One served loopback connection: whether a request is in flight, and the signal that asks
/// it to close (graceful: an answer in progress is finished first).
#[derive(Default)]
pub(crate) struct LocalConn {
    busy: AtomicUsize,
    kicked: AtomicBool,
    kick: Notify,
}

/// Marks a request in flight on its connection.
struct Busy(Arc<LocalConn>);

impl Busy {
    fn new(c: &Arc<LocalConn>) -> Self {
        c.busy.fetch_add(1, Ordering::AcqRel);
        Self(c.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.busy.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A loopback connection's slot: the pool permit and its entry in the list of open connections.
pub(crate) struct LocalSlot {
    _permit: OwnedSemaphorePermit,
    conn: Arc<LocalConn>,
    list: Arc<Mutex<Vec<Arc<LocalConn>>>>,
}

impl Drop for LocalSlot {
    fn drop(&mut self) {
        self.list.lock().unwrap_or_else(|e| e.into_inner()).retain(|c| !Arc::ptr_eq(c, &self.conn));
    }
}

/// A LAN connection's slot: the pool permit and its count for the address, both given back on drop.
pub(crate) struct LanSlot {
    _permit: OwnedSemaphorePermit,
    ip: IpAddr,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

impl Drop for LanSlot {
    fn drop(&mut self) {
        let mut m = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = m.get_mut(&self.ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(&self.ip);
            }
        }
    }
}

impl Pools {
    pub(crate) fn new(limits: &Limits) -> Self {
        let max = limits.max_connections.max(1);
        Self {
            local: Arc::new(Semaphore::new(max)),
            lan: Arc::new(Semaphore::new(max)),
            per_ip: Arc::default(),
            per_ip_max: limits.max_connections_per_ip.max(1),
            max,
            local_conns: Arc::default(),
        }
    }

    /// A slot for a LAN peer now, or `None` (pool or the address's share full: close it).
    /// Nothing is recorded for a refused address.
    pub(crate) fn try_lan(&self, ip: IpAddr) -> Option<LanSlot> {
        let mut m = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if m.get(&ip).is_some_and(|&n| n >= self.per_ip_max) {
            return None;
        }
        let permit = self.lan.clone().try_acquire_owned().ok()?;
        *m.entry(ip).or_insert(0) += 1;
        Some(LanSlot { _permit: permit, ip, per_ip: self.per_ip.clone() })
    }

    fn local_slot(&self, permit: OwnedSemaphorePermit) -> LocalSlot {
        let conn = Arc::new(LocalConn::default());
        self.local_conns.lock().unwrap_or_else(|e| e.into_inner()).push(conn.clone());
        LocalSlot { _permit: permit, conn, list: self.local_conns.clone() }
    }

    /// A slot for a loopback connection: free right away, else the oldest idle loopback
    /// connection (keep-alive, or never sent a request) is asked to close and its slot taken;
    /// `None` after `wait` without a slot (every connection busy).
    pub(crate) async fn local(&self, wait: Duration) -> Option<LocalSlot> {
        if let Ok(p) = self.local.clone().try_acquire_owned() {
            return Some(self.local_slot(p));
        }
        self.evict_idle();
        let p = tokio::time::timeout(wait, self.local.clone().acquire_owned()).await.ok()?.ok()?;
        Some(self.local_slot(p))
    }

    /// Asks the oldest idle loopback connection not asked yet to close; `false` if there is none.
    fn evict_idle(&self) -> bool {
        let list = self.local_conns.lock().unwrap_or_else(|e| e.into_inner());
        let Some(c) = list.iter().find(|c| c.busy.load(Ordering::Acquire) == 0 && !c.kicked.load(Ordering::Acquire)) else {
            return false;
        };
        c.kicked.store(true, Ordering::Release);
        c.kick.notify_one();
        true
    }

    /// Waits for every slot of both pools (shutdown).
    async fn drain(&self) {
        let n = self.max as u32;
        let _ = tokio::join!(self.local.acquire_many(n), self.lan.acquire_many(n));
    }
}

/// The accept loop. Not `axum::serve`: that builds hyper without a timer, so hyper's
/// header-read timeout never fires, and it has no connection limit (slowloris in LAN mode).
/// Here every connection gets a header-read timeout (also the keep-alive idle limit; shorter
/// for LAN peers) and a slot from [`Pools`]: at most [`Limits::max_connections`] loopback
/// connections are served at once (a new one closes the oldest idle one, or waits at most
/// [`Limits::local_slot_wait`] and then gets a 503 with `Connection: close`), LAN connections
/// beyond their pool or [`Limits::max_connections_per_ip`] are closed right away.
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
    let pools = Arc::new(Pools::new(&limits));
    loop {
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
        let local = auth::is_loopback_peer(peer.ip());
        let lan_slot = if local {
            None
        } else {
            match pools.try_lan(peer.ip()) {
                Some(s) => Some(s),
                None => {
                    log::debug!("overlay server: connection from {peer} refused (LAN connection limit)");
                    drop(stream);
                    continue;
                }
            }
        };
        let _ = stream.set_nodelay(true);
        let mut stop = shutdown.clone();
        let pools = pools.clone();
        let app = app.clone();
        let header_timeout = if local { limits.header_read_timeout } else { limits.lan_header_read_timeout };
        let wait = limits.local_slot_wait;
        tokio::spawn(async move {
            // loopback: a free slot, the slot of an idle connection, or a bounded wait
            let local_slot = if lan_slot.is_none() {
                tokio::select! {
                    s = pools.local(wait) => match s {
                        Some(s) => Some(s),
                        None => {
                            log::debug!("overlay server: connection from {peer} refused (local connection limit)");
                            refuse_busy(stream).await;
                            return;
                        }
                    },
                    _ = stopped(&mut stop) => return,
                }
            } else {
                None
            };
            let _lan_slot = lan_slot;
            let conn_state = local_slot.as_ref().map(|s| s.conn.clone());
            let busy_state = conn_state.clone();
            let svc = tower::service_fn(move |mut req: axum::http::Request<Incoming>| {
                let app = app.clone();
                let busy = busy_state.as_ref().map(Busy::new);
                req.extensions_mut().insert(ConnectInfo(peer));
                async move {
                    let res = app.oneshot(req.map(Body::new)).await;
                    drop(busy);
                    res
                }
            });
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(header_timeout)
                .serve_connection(TokioIo::new(stream), TowerToHyperService::new(svc))
                .with_upgrades();
            let mut conn = std::pin::pin!(conn);
            tokio::select! {
                r = conn.as_mut() => if let Err(e) = r { log::debug!("overlay server: connection from {peer}: {e}") },
                _ = stopped(&mut stop) => {
                    conn.as_mut().graceful_shutdown();
                    let _ = conn.await;
                }
                _ = kicked(conn_state.as_deref()) => {
                    // a newer loopback connection needs the slot: an idle keep-alive closes at once;
                    // one that sent only part of a request head (graceful shutdown would wait for
                    // it until the header timeout) is dropped after a short grace, unless a request
                    // got under way in the meantime – that one is answered first
                    conn.as_mut().graceful_shutdown();
                    loop {
                        if tokio::time::timeout(KICK_GRACE, conn.as_mut()).await.is_ok() {
                            break;
                        }
                        if conn_state.as_ref().is_none_or(|c| c.busy.load(Ordering::Acquire) == 0) {
                            log::debug!("overlay server: idle connection from {peer} closed for a new one");
                            break;
                        }
                    }
                }
            }
            drop(local_slot);
        });
    }
    // let open requests finish (WebSockets close themselves on the stop signal)
    if tokio::time::timeout(SHUTDOWN_GRACE, pools.drain()).await.is_err() {
        log::info!("overlay server: connections still open after {SHUTDOWN_GRACE:?}, closing them");
    }
}

/// Resolves once [`Pools::evict_idle`] picked this loopback connection; never for LAN ones.
async fn kicked(conn: Option<&LocalConn>) {
    match conn {
        Some(c) => c.kick.notified().await,
        None => std::future::pending().await,
    }
}

/// The answer for a loopback connection that found no slot: 503 with `Connection: close`,
/// written straight to the socket (no slot, no hyper). Whatever the client sent is read and
/// dropped until it closes (at most half a second), so the unread request does not turn the
/// close into a reset that would swallow the answer.
async fn refuse_busy(stream: tokio::net::TcpStream) {
    const BODY: &str = r#"{"error":"Server ausgelastet / server busy","status":503}"#;
    let reply = format!(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nRetry-After: 1\r\nConnection: close\r\n\r\n{BODY}",
        BODY.len()
    );
    let _ = tokio::time::timeout(Duration::from_millis(500), async {
        let bytes = reply.as_bytes();
        let mut sent = 0;
        while sent < bytes.len() {
            stream.writable().await?;
            match stream.try_write(&bytes[sent..]) {
                Ok(n) => sent += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e),
            }
        }
        let mut buf = [0u8; 2048];
        loop {
            stream.readable().await?;
            match stream.try_read(&mut buf) {
                Ok(0) => return Ok(()),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e),
            }
        }
    })
    .await;
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
async fn guard(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request, next: Next) -> Response {
    let h = req.headers();
    let origin = header_str(h, header::ORIGIN).map(str::to_owned);
    let host = header_str(h, header::HOST).map(str::to_owned);
    let query = req.uri().query();
    let cookie = header_str(h, header::COOKIE);
    let token = auth::request_token(
        query,
        header_str(h, header::AUTHORIZATION),
        h.get("x-vectasim-token").and_then(|v| v.to_str().ok()),
        cookie,
        &st.cookie,
    )
    .map(str::to_owned);
    // a LAN device that came in with `?token=` gets it as a cookie, so the URL can drop it (auth module doc)
    let set_cookie = !auth::is_local(peer, host.as_deref())
        && token.as_deref().is_some_and(|t| Some(t) == auth::query_token(query) && st.cfg.lan_token().is_some_and(|e| auth::token_eq(t, e)));
    // a cookie whose token no longer works (Regenerate, LAN off) and the port-less one of older versions
    let mut stale = auth::stale_cookies(cookie, &st.cookie, st.cfg.lan_token());
    if set_cookie {
        stale.retain(|n| *n != *st.cookie);
    }
    let info = RequestInfo { method: req.method().as_str(), host: host.as_deref(), origin: origin.as_deref(), token: token.as_deref() };
    if let Err(d) = auth::check(&info, peer, st.cfg.lan_token()) {
        log::debug!("overlay server: {} {} from {peer} refused: {d:?}", req.method(), req.uri().path());
        let mut r = error(StatusCode::from_u16(d.status()).unwrap_or(StatusCode::FORBIDDEN), d.message());
        if d == auth::Denied::Method {
            r.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD, OPTIONS"));
        }
        // a refused client does not keep its connection (and slot) open – loopback too, so a
        // page rebinding its name to 127.0.0.1 cannot park keep-alive connections here
        r.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
        clear_cookies(r.headers_mut(), &stale);
        return r;
    }
    // the request itself carried the valid LAN token (query, header or cookie): only then may the
    // start page hand it back ([`with_token`]) – a token-free loopback request does not get it
    if token.as_deref().is_some_and(|t| st.cfg.lan_token().is_some_and(|e| auth::token_eq(t, e))) {
        req.extensions_mut().insert(TokenPresented);
    }
    let preflight = req.method() == Method::OPTIONS;
    let mut res = if preflight { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let hs = res.headers_mut();
    hs.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    hs.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    hs.entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static("no-store"));
    if set_cookie && let Some(v) = token.as_deref().filter(|t| auth::valid_token(t)).and_then(|t| HeaderValue::from_str(&auth::token_cookie(&st.cookie, t)).ok()) {
        hs.append(header::SET_COOKIE, v);
    }
    clear_cookies(hs, &stale);
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

/// `Set-Cookie: <name>=; Max-Age=0` for each name.
fn clear_cookies(hs: &mut HeaderMap, names: &[String]) {
    for n in names {
        if let Ok(v) = HeaderValue::from_str(&auth::clear_cookie(n)) {
            hs.append(header::SET_COOKIE, v);
        }
    }
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

/// Marks a request that carried the valid LAN token itself (set by [`guard`]).
#[derive(Clone, Copy)]
struct TokenPresented;

/// The empty token element of the start page ([`with_token`]).
const TOKEN_META: &str = r#"<meta name="vectasim-token" content="">"#;

/// The start page with the LAN token in its `<meta name="vectasim-token">`:
/// only for a request that sent the valid token itself (query, header or cookie –
/// [`TokenPresented`]), so it hands back nothing the reader did not have, and the copy URLs for
/// OBS on another PC carry the token even after a bookmark load through the cookie. A loopback
/// request without a token (this PC needs none) gets the empty element: the token is not
/// readable by every local process with a plain `GET /`; the app shows the LAN URLs itself.
/// `overlay.js` reads the element and removes it. Only tokens of the URL-safe alphabet.
pub(crate) fn with_token(page: String, token: Option<&str>) -> String {
    match token.filter(|t| auth::valid_token(t)) {
        Some(t) => page.replacen(TOKEN_META, &format!(r#"<meta name="vectasim-token" content="{t}">"#), 1),
        None => page,
    }
}

fn page(h: &HeaderMap, body: &'static str, lang: Lang) -> Response {
    page_with(h, localized(body, lang))
}

fn page_with(h: &HeaderMap, html: String) -> Response {
    // `connect-src 'self'` covers ws: in CSP 3; the explicit ws:// entry is for older engines
    let ws = csp_host(h).map(|host| format!(" ws://{host}")).unwrap_or_default();
    let csp = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'{ws}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    let mut r = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response();
    if let Ok(v) = HeaderValue::from_str(&csp) {
        r.headers_mut().insert(header::CONTENT_SECURITY_POLICY, v);
    }
    r
}

async fn page_index(
    State(st): State<AppState>,
    Query(q): Query<PageQuery>,
    presented: Option<Extension<TokenPresented>>,
    h: HeaderMap,
) -> Response {
    let token = presented.and(st.cfg.lan_token());
    page_with(&h, with_token(localized(overlay::INDEX_HTML, page_lang(&st, &q)), token))
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
    l.band_label = api::rate_band_label_in(l.band, source.lang()).to_string();
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

async fn api_ws(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, ws: WebSocketUpgrade) -> Response {
    // the slot is taken before the upgrade, so parallel handshakes cannot exceed the limit;
    // a failed upgrade drops the closure and with it the slot
    let Some(slot) = st.clients.try_take(peer.ip()) else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Zu viele verbundene Overlays");
    };
    // clients only listen: small frames are plenty
    ws.max_message_size(4096).max_frame_size(4096).on_upgrade(move |socket| client(socket, st, slot))
}

/// WebSocket quotas: one for this PC (loopback), one for other devices with a cap per address,
/// so LAN clients can never take the stream away from the local OBS overlays.
pub(crate) struct WsQuota {
    counts: Mutex<WsCounts>,
    local_max: usize,
    lan_max: usize,
    per_ip_max: usize,
}

#[derive(Default)]
struct WsCounts {
    local: usize,
    lan: usize,
    per_ip: HashMap<IpAddr, usize>,
}

impl WsQuota {
    pub(crate) fn new(local_max: usize, lan_max: usize, per_ip_max: usize) -> Self {
        Self { counts: Mutex::default(), local_max, lan_max, per_ip_max }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WsCounts> {
        self.counts.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Open sockets, both quotas.
    pub(crate) fn total(&self) -> usize {
        let c = self.lock();
        c.local + c.lan
    }

    /// A socket slot for `ip`, or `None` when its quota (or the address's share) is full.
    fn try_take(self: &Arc<Self>, ip: IpAddr) -> Option<ClientSlot> {
        let mut c = self.lock();
        if auth::is_loopback_peer(ip) {
            if c.local >= self.local_max {
                return None;
            }
            c.local += 1;
            return Some(ClientSlot { quota: self.clone(), lan_ip: None });
        }
        if c.lan >= self.lan_max || c.per_ip.get(&ip).is_some_and(|&n| n >= self.per_ip_max) {
            return None;
        }
        c.lan += 1;
        *c.per_ip.entry(ip).or_insert(0) += 1;
        Some(ClientSlot { quota: self.clone(), lan_ip: Some(ip) })
    }
}

/// Holds a socket's place in its quota while it is open.
struct ClientSlot {
    quota: Arc<WsQuota>,
    lan_ip: Option<IpAddr>,
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        let mut c = self.quota.lock();
        match self.lan_ip {
            None => c.local = c.local.saturating_sub(1),
            Some(ip) => {
                c.lan = c.lan.saturating_sub(1);
                if let Some(n) = c.per_ip.get_mut(&ip) {
                    *n = n.saturating_sub(1);
                    if *n == 0 {
                        c.per_ip.remove(&ip);
                    }
                }
            }
        }
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

    use crate::{MAX_LAN_WS_CLIENTS, MAX_WS_CLIENTS, MAX_WS_PER_IP};

    #[test]
    fn ws_slots_never_exceed_the_limit() {
        let q = Arc::new(WsQuota::new(3, 3, 3));
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let slots: Vec<ClientSlot> = (0..5).filter_map(|_| q.try_take(lo)).collect();
        assert_eq!((slots.len(), q.total()), (3, 3));
        drop(slots);
        assert_eq!(q.total(), 0);
        // many threads racing for the last slots
        let q = Arc::new(WsQuota::new(MAX_WS_CLIENTS, MAX_LAN_WS_CLIENTS, MAX_WS_PER_IP));
        let taken: usize = std::thread::scope(|s| {
            let hs: Vec<_> = (0..32)
                .map(|_| {
                    let q = q.clone();
                    s.spawn(move || q.try_take(lo).map(std::mem::forget).is_some() as usize)
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).sum()
        });
        assert_eq!((taken, q.total()), (MAX_WS_CLIENTS, MAX_WS_CLIENTS));
    }

    #[test]
    fn lan_websockets_cannot_take_the_local_quota() {
        let q = Arc::new(WsQuota::new(MAX_WS_CLIENTS, MAX_LAN_WS_CLIENTS, MAX_WS_PER_IP));
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        // one tablet: four sockets, the fifth is refused
        let tablet: IpAddr = "192.168.1.20".parse().unwrap();
        let t: Vec<ClientSlot> = (0..6).filter_map(|_| q.try_take(tablet)).collect();
        assert_eq!(t.len(), MAX_WS_PER_IP);
        // many devices fill the LAN quota (16), the 17th LAN socket is refused …
        let mut lan: Vec<ClientSlot> = Vec::new();
        for i in 21..40u8 {
            let ip = IpAddr::from([192, 168, 1, i]);
            lan.extend((0..MAX_WS_PER_IP).filter_map(|_| q.try_take(ip)));
        }
        assert_eq!(t.len() + lan.len(), MAX_LAN_WS_CLIENTS);
        assert!(q.try_take(IpAddr::from([192, 168, 1, 99])).is_none());
        // … and this PC still has all its sockets
        let local: Vec<ClientSlot> = (0..MAX_WS_CLIENTS + 2).filter_map(|_| q.try_take(lo)).collect();
        assert_eq!(local.len(), MAX_WS_CLIENTS);
        assert!(q.try_take("::1".parse().unwrap()).is_none(), "the local quota is full now");
        assert_eq!(q.total(), MAX_WS_CLIENTS + MAX_LAN_WS_CLIENTS);
        // closing gives the place back, nothing stays behind for the address
        drop(t);
        assert!(q.try_take(tablet).is_some());
        drop(lan);
        drop(local);
        assert_eq!(q.total(), 0);
        assert!(q.lock().per_ip.is_empty());
    }

    #[test]
    fn the_start_page_carries_the_token() {
        let page = localized(overlay::INDEX_HTML, Lang::En);
        assert!(page.contains(TOKEN_META), "index.html has the token element");
        let tok = "TestTokenTestTokenTest24";
        assert!(with_token(page.clone(), Some(tok)).contains(&format!(r#"<meta name="vectasim-token" content="{tok}">"#)));
        // LAN off or a hand-edited token with markup: the element stays empty
        assert!(with_token(page.clone(), None).contains(TOKEN_META));
        assert!(with_token(page, Some("\"><script>x</script>")).contains(TOKEN_META));
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

#[cfg(test)]
mod pool_tests {
    use super::*;

    #[test]
    fn lan_peers_cannot_take_the_local_slots() {
        let limits = Limits { max_connections: 4, max_connections_per_ip: 2, ..Limits::default() };
        let pools = Pools::new(&limits);
        let a: IpAddr = "192.168.1.20".parse().unwrap();
        let b: IpAddr = "192.168.1.21".parse().unwrap();
        let c: IpAddr = "192.168.1.22".parse().unwrap();
        // two per address, four in the LAN pool
        let a1 = pools.try_lan(a).unwrap();
        let _a2 = pools.try_lan(a).unwrap();
        assert!(pools.try_lan(a).is_none(), "per-address cap");
        let _b1 = pools.try_lan(b).unwrap();
        let _b2 = pools.try_lan(b).unwrap();
        assert!(pools.try_lan(c).is_none(), "LAN pool full");
        // the loopback pool is untouched
        assert_eq!(pools.local.available_permits(), 4);
        // a closed connection gives its slot back
        drop(a1);
        let _c1 = pools.try_lan(c).expect("slot given back");
        assert!(pools.try_lan(a).is_none(), "pool full again");
    }

    #[test]
    fn refused_lan_peers_leave_no_entry() {
        let limits = Limits { max_connections: 2, max_connections_per_ip: 2, ..Limits::default() };
        let pools = Pools::new(&limits);
        let _a = pools.try_lan("192.168.1.20".parse().unwrap()).unwrap();
        let _b = pools.try_lan("192.168.1.21".parse().unwrap()).unwrap();
        // pool full: a hundred refused addresses add nothing to the per-address map
        for i in 0..100u8 {
            assert!(pools.try_lan(IpAddr::from([10, 0, 0, i])).is_none());
        }
        assert_eq!(pools.per_ip.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_new_local_connection_takes_the_slot_of_an_idle_one() {
        let limits = Limits { max_connections: 2, ..Limits::default() };
        let pools = Pools::new(&limits);
        let a = pools.local(Duration::from_millis(50)).await.unwrap();
        let b = pools.local(Duration::from_millis(50)).await.unwrap();
        // b is busy, a idle: the newcomer asks a (the oldest idle one) to close
        let busy_b = Busy::new(&b.conn);
        let waiting = pools.local(Duration::from_secs(5));
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("slot without anyone closing"),
            _ = a.conn.kick.notified() => {}
        }
        assert!(a.conn.kicked.load(Ordering::Acquire) && !b.conn.kicked.load(Ordering::Acquire));
        drop(a);
        let c = waiting.await.expect("slot of the idle connection");
        // every connection busy: no slot within the wait
        let _busy_c = Busy::new(&c.conn);
        assert!(pools.local(Duration::from_millis(50)).await.is_none());
        assert_eq!(pools.local_conns.lock().unwrap().len(), 2);
        drop(busy_b);
    }
}
