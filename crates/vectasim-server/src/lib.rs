//! Local HTTP/WebSocket server of VectaSim: OBS overlays (`/overlay/*`), a second screen in
//! the home network and a read-only JSON interface for VAs (`/api/v1/*`). Off by default;
//! the app starts and stops it (app/src-tauri/src/server.rs). Endpoints, fields and examples:
//! docs/overlay-api.md; access rules: [`auth`].
//!
//! The server runs on a thread of its own with a single-threaded tokio runtime, independent
//! of the app's runtime. It reads through a [`Source`] (the app's manager, store and settings)
//! on the blocking pool, polls it at 2 Hz for the WebSocket stream while at least one client is
//! connected and derives the events from consecutive snapshots ([`watch`]) – nothing hooks into
//! the live path.

pub mod api;
pub mod auth;
mod overlay;
mod routes;
pub mod watch;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use api::API_VERSION;

/// Default port (Einstellungen → Overlay & Schnittstelle).
pub const DEFAULT_PORT: u16 = 8095;
/// Most WebSocket clients at once (OBS scenes, a tablet, a VA tool …).
pub const MAX_WS_CLIENTS: usize = 16;
/// WebSocket telemetry interval (2 Hz).
pub const STREAM_INTERVAL: Duration = Duration::from_millis(500);
/// Most HTTP connections at once (WebSockets are counted by [`MAX_WS_CLIENTS`] once upgraded).
pub const MAX_CONNECTIONS: usize = 64;
/// Longest time a client may take for a request head – also the idle limit of a keep-alive
/// connection (hyper starts the timer when it waits for the next request).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Connection limits of the HTTP side (tests shorten them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_connections: usize,
    pub header_read_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_connections: MAX_CONNECTIONS, header_read_timeout: HEADER_READ_TIMEOUT }
    }
}

/// Where the server reads from. Calls run on tokio's blocking pool: they may lock and query
/// the store, but should not take long.
pub trait Source: Send + Sync + 'static {
    /// Connection, running flight and latest telemetry, unmasked.
    fn snapshot(&self) -> api::Snapshot;
    /// The last landing (running flight first, else the logbook), unmasked.
    fn landing(&self) -> Option<api::Landing>;
    /// The newest `limit` flights of the logbook, unmasked.
    fn logbook(&self, limit: usize) -> Vec<api::LogbookEntry>;
    /// Streamer-Modus on.
    fn privacy(&self) -> bool;
    /// Backend language: default of the overlay pages (`?lang=` overrides it), language of
    /// `bandLabel` and of the bind errors; `Status.lang`.
    fn lang(&self) -> vectasim_core::Lang {
        vectasim_core::Lang::De
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// 0 = any free port (tests).
    pub port: u16,
    /// Bind 0.0.0.0 and accept other devices with the token.
    pub lan: bool,
    /// Required from other devices while `lan` is on.
    pub token: String,
}

impl Config {
    fn bind_ip(&self) -> Ipv4Addr {
        if self.lan { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST }
    }

    /// The token requests from other devices must carry (`None` while LAN access is off).
    fn lan_token(&self) -> Option<&str> {
        (self.lan && !self.token.is_empty()).then_some(self.token.as_str())
    }
}

/// A running server; [`Server::stop`] (or drop) shuts it down.
pub struct Server {
    addr: SocketAddr,
    clients: Arc<AtomicUsize>,
    shutdown: tokio::sync::watch::Sender<bool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// Binds synchronously (a port in use fails here, with a message for the settings) and
    /// serves on a thread of its own.
    pub fn start(cfg: Config, source: Arc<dyn Source>) -> Result<Server, String> {
        Self::start_with_limits(cfg, source, Limits::default())
    }

    /// [`Server::start`] with other connection limits.
    pub fn start_with_limits(cfg: Config, source: Arc<dyn Source>, limits: Limits) -> Result<Server, String> {
        let listener = std::net::TcpListener::bind((cfg.bind_ip(), cfg.port)).map_err(|e| bind_error(&e, cfg.port, source.lang()))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        let clients = Arc::new(AtomicUsize::new(0));
        let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
        let state = routes::AppState::new(cfg, source, clients.clone(), shutdown_rx.clone());
        let thread = std::thread::Builder::new()
            .name("overlay-server".into())
            .spawn(move || {
                runtime.block_on(routes::serve(listener, state, limits, shutdown_rx));
                runtime.shutdown_timeout(Duration::from_secs(1));
            })
            .map_err(|e| e.to_string())?;
        log::info!("overlay server listening on {addr}");
        Ok(Server { addr, clients, shutdown, thread: Some(thread) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Connected WebSocket clients.
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    pub fn stop(mut self) {
        self.shut_down();
    }

    fn shut_down(&mut self) {
        let _ = self.shutdown.send(true);
        if let Some(t) = self.thread.take() {
            let deadline = Instant::now() + Duration::from_secs(4);
            while !t.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if t.is_finished() {
                let _ = t.join();
                log::info!("overlay server on {} stopped", self.addr);
            } else {
                log::warn!("overlay server thread did not stop in time; left to finish on its own");
            }
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shut_down();
    }
}

fn bind_error(e: &std::io::Error, port: u16, lang: vectasim_core::Lang) -> String {
    use vectasim_core::Lang::{De, En};
    match (e.kind(), lang) {
        (std::io::ErrorKind::AddrInUse, De) => format!("Port {port} ist schon belegt – anderen Port wählen."),
        (std::io::ErrorKind::AddrInUse, En) => format!("Port {port} is already in use – choose another port."),
        (std::io::ErrorKind::PermissionDenied, De) => {
            format!("Port {port} ist gesperrt (Windows reserviert ihn oder eine Firewall verbietet ihn) – anderen Port wählen.")
        }
        (std::io::ErrorKind::PermissionDenied, En) => {
            format!("Port {port} is blocked (reserved by Windows or forbidden by a firewall) – choose another port.")
        }
        _ => format!("Port {port}: {e}"),
    }
}
