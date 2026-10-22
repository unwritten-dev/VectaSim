//! The real server on a free port against a fake source: routing, access rules, Streamer-Modus
//! and the WebSocket handshake, over plain TCP (no HTTP client dependency).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use vectasim_core::{FlightPhase, FlightState, LandingRateSource, TouchdownReport};
use vectasim_server::api::{Aircraft, Flight, Landing, LogbookEntry, Snapshot, Status, Telemetry};
use vectasim_server::{Config, Limits, Server, Source};

const TOKEN: &str = "TestTokenTestTokenTest24";

#[derive(Default)]
struct Fake {
    privacy: AtomicBool,
    /// Every snapshot read takes this long (a busy server).
    delay_ms: AtomicU64,
}

fn aircraft() -> Aircraft {
    Aircraft {
        title: Some("Airbus A320neo Lufthansa D-AINA".into()),
        icao_type: Some("A20N".into()),
        registration: Some("D-AINA".into()),
        airline: Some("Lufthansa".into()),
    }
}

impl Source for Fake {
    fn snapshot(&self) -> Snapshot {
        std::thread::sleep(Duration::from_millis(self.delay_ms.load(Ordering::Relaxed)));
        Snapshot {
            status: Status { version: "0.3.0".into(), provider: "mock".into(), connection: "connected".into(), ..Default::default() },
            flight: Some(Flight {
                id: Some("f-1".into()),
                state: FlightState::Active,
                phase: FlightPhase::Cruise,
                departure: Some("EDDF".into()),
                destination: Some("EGLL".into()),
                callsign: Some("DLH4YA".into()),
                aircraft: aircraft(),
                ..Default::default()
            }),
            telemetry: Some(Telemetry { timestamp_ms: 1, altitude_msl_ft: 36_000.0, ..Default::default() }),
        }
    }

    fn landing(&self) -> Option<Landing> {
        let td = TouchdownReport {
            timestamp_ms: 1_700_000_000_000,
            vs_fpm_measured: -150.0,
            vs_fpm_sim: -142.0,
            vs_fpm_hardest: -150.0,
            peak_g: 1.18,
            pitch_deg: 3.0,
            bank_deg: 0.0,
            ground_speed_kt: 130.0,
            heading_true_deg: 250.0,
            latitude: 50.0,
            longitude: 8.5,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: -142.0,
            landing_rate_source: LandingRateSource::Sim,
        };
        let mut l = Landing::from_report(&td, 0);
        l.aircraft = aircraft();
        l.runway = Some("25C".into());
        Some(l)
    }

    fn logbook(&self, limit: usize) -> Vec<LogbookEntry> {
        (0..100).take(limit).map(|i| LogbookEntry { id: format!("f-{i}"), state: "completed".into(), aircraft: aircraft(), ..Default::default() }).collect()
    }

    fn privacy(&self) -> bool {
        self.privacy.load(Ordering::Relaxed)
    }
}

fn start(lan: bool) -> (Server, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    let server = Server::start(Config { port: 0, lan, token: TOKEN.into() }, fake.clone()).expect("server starts");
    (server, fake)
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

/// One HTTP/1.1 request on a fresh connection (`Connection: close`).
fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)]) -> Reply {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        req.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").map(|(h, b)| (h.to_string(), b.to_string())).unwrap_or((text.clone(), String::new()));
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    Reply { status, head, body }
}

fn get(port: u16, path: &str) -> Reply {
    request(port, "GET", path, &[])
}

fn json_of(r: &Reply) -> serde_json::Value {
    serde_json::from_str(&r.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", r.body))
}

fn header<'a>(r: &'a Reply, name: &str) -> Option<&'a str> {
    r.head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim()))
}

#[test]
fn routes_answer() {
    let (server, _) = start(false);
    let port = server.local_addr().port();
    assert!(server.local_addr().ip().is_loopback());

    let status = get(port, "/api/v1/status");
    assert_eq!(status.status, 200, "{}", status.head);
    let v = json_of(&status);
    assert_eq!(v["apiVersion"], 1);
    assert_eq!(v["app"], "VectaSim");
    assert_eq!(v["connection"], "connected");
    assert!(v["serverTimeMs"].as_u64().unwrap() > 1_600_000_000_000);
    assert_eq!(header(&status, "cache-control"), Some("no-store"));
    assert_eq!(header(&status, "x-content-type-options"), Some("nosniff"));

    assert_eq!(json_of(&get(port, "/api/v1/flight"))["phase"], "cruise");
    assert_eq!(json_of(&get(port, "/api/v1/telemetry"))["altitudeMslFt"], 36000.0);
    let landing = json_of(&get(port, "/api/v1/landing"));
    assert_eq!((landing["landingRateFpm"].as_f64(), landing["band"].as_str(), landing["runway"].as_str()), (Some(-142.0), Some("smooth"), Some("25C")));
    assert_eq!(json_of(&get(port, "/api/v1/logbook?limit=3"))["flights"].as_array().unwrap().len(), 3);
    assert_eq!(json_of(&get(port, "/api/v1/logbook"))["flights"].as_array().unwrap().len(), 10);
    assert_eq!(json_of(&get(port, "/api/v1/logbook?limit=500"))["flights"].as_array().unwrap().len(), 50);
    assert_eq!(get(port, "/api/v1/logbook?limit=abc").status, 400);

    for page in ["/", "/overlay/hud", "/overlay/landing", "/overlay/route"] {
        let r = get(port, page);
        assert_eq!(r.status, 200, "{page}");
        assert!(header(&r, "content-type").unwrap().starts_with("text/html"), "{page}");
        let csp = header(&r, "content-security-policy").unwrap();
        assert!(csp.contains("script-src 'self'") && csp.contains(&format!("ws://127.0.0.1:{port}")), "{csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
        assert!(r.body.contains("/overlay/overlay.js"), "{page}");
    }
    assert!(get(port, "/overlay/overlay.js").body.contains("new WebSocket"));
    assert!(header(&get(port, "/overlay/overlay.css"), "content-type").unwrap().starts_with("text/css"));

    let missing = get(port, "/api/v2/status");
    assert_eq!(missing.status, 404);
    assert_eq!(json_of(&missing)["status"], 404);
    let post = request(port, "POST", "/api/v1/status", &[("Content-Length", "0")]);
    assert_eq!(post.status, 405);
    server.stop();
}

#[test]
fn foreign_hosts_and_origins_are_refused() {
    let (server, _) = start(false);
    let port = server.local_addr().port();
    // DNS rebinding: the attacker's name pointing at 127.0.0.1
    assert_eq!(request(port, "GET", "/api/v1/status", &[("Host", "evil.example")]).status, 403);
    assert_eq!(request(port, "GET", "/api/v1/status", &[("Origin", "https://evil.example")]).status, 403);
    // allowed origin: CORS header echoed
    let ok = request(port, "GET", "/api/v1/status", &[("Origin", "http://localhost:3000")]);
    assert_eq!(ok.status, 200);
    assert_eq!(header(&ok, "access-control-allow-origin"), Some("http://localhost:3000"));
    let pre = request(port, "OPTIONS", "/api/v1/status", &[("Origin", "http://absolute"), ("Access-Control-Request-Method", "GET")]);
    assert_eq!(pre.status, 204);
    assert_eq!(header(&pre, "access-control-allow-origin"), Some("http://absolute"));
    // no Origin: no CORS header at all
    assert_eq!(header(&get(port, "/api/v1/status"), "access-control-allow-origin"), None);
    server.stop();
}

#[test]
fn lan_mode_needs_the_token() {
    let (server, _) = start(true);
    let port = server.local_addr().port();
    assert!(server.local_addr().ip().is_unspecified());
    let lan_host = format!("192.168.1.5:{port}");
    let host = [("Host", lan_host.as_str())];
    assert_eq!(request(port, "GET", "/api/v1/status", &host).status, 401);
    assert_eq!(request(port, "GET", "/api/v1/status?token=wrong", &host).status, 401);
    assert_eq!(request(port, "GET", &format!("/api/v1/status?token={TOKEN}"), &host).status, 200);
    let bearer = format!("Bearer {TOKEN}");
    assert_eq!(request(port, "GET", "/api/v1/status", &[("Host", lan_host.as_str()), ("Authorization", bearer.as_str())]).status, 200);
    assert_eq!(request(port, "GET", "/overlay/hud", &[("Host", lan_host.as_str()), ("X-VectaSim-Token", TOKEN)]).status, 200);
    // this PC itself stays token-free
    assert_eq!(get(port, "/api/v1/status").status, 200);
    server.stop();
}

#[test]
fn first_load_with_the_token_hands_out_a_cookie() {
    let (server, _) = start(true);
    let port = server.local_addr().port();
    let lan_host = format!("192.168.1.5:{port}");
    let host = [("Host", lan_host.as_str())];
    // ?token= on the first load: the answer carries it as an HttpOnly, SameSite=Strict cookie
    let first = request(port, "GET", &format!("/overlay/hud?token={TOKEN}"), &host);
    assert_eq!(first.status, 200);
    let cookie = header(&first, "set-cookie").expect("cookie").to_string();
    // the cookie name carries the port
    assert!(cookie.starts_with(&format!("vectasim_token_{port}={TOKEN};")), "{cookie}");
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict") && cookie.contains("Path=/"), "{cookie}");
    // the bookmark without the token works through the cookie, and no new cookie is handed out
    let jar = format!("vectasim_token_{port}={TOKEN}");
    let again = request(port, "GET", "/api/v1/status", &[("Host", lan_host.as_str()), ("Cookie", jar.as_str())]);
    assert_eq!(again.status, 200);
    assert_eq!(header(&again, "set-cookie"), None);
    // a stale cookie (Regenerate) is refused and deleted, with the connection closed
    let stale_jar = format!("vectasim_token_{port}=wrongwrongwrongwrong");
    let stale = request(port, "GET", "/api/v1/status", &[("Host", lan_host.as_str()), ("Cookie", stale_jar.as_str())]);
    assert_eq!(stale.status, 401);
    let cleared = format!("vectasim_token_{port}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
    assert_eq!(header(&stale, "set-cookie"), Some(cleared.as_str()));
    assert_eq!(header(&stale, "connection"), Some("close"));
    // the cookie of another port is not ours
    let other = format!("vectasim_token_{}={TOKEN}", port.wrapping_add(1));
    assert_eq!(request(port, "GET", "/api/v1/status", &[("Host", lan_host.as_str()), ("Cookie", other.as_str())]).status, 401);
    // a wrong ?token= gets no cookie
    let wrong = request(port, "GET", "/api/v1/status?token=wrongwrongwrongwrong", &host);
    assert_eq!((wrong.status, header(&wrong, "set-cookie")), (401, None));
    // the port-less cookie of older versions is deleted (a new one is handed out alongside)
    let legacy = request(port, "GET", &format!("/overlay/hud?token={TOKEN}"), &[("Host", lan_host.as_str()), ("Cookie", "vectasim_token=old")]);
    let cookies: Vec<&str> = legacy.head.lines().filter(|l| l.to_ascii_lowercase().starts_with("set-cookie:")).collect();
    assert_eq!(cookies.len(), 2, "{cookies:?}");
    assert!(cookies.iter().any(|c| c.contains("vectasim_token=; Path=/; Max-Age=0")), "{cookies:?}");
    // header auth and this PC: no cookie
    assert_eq!(header(&request(port, "GET", "/overlay/hud", &[("Host", lan_host.as_str()), ("X-VectaSim-Token", TOKEN)]), "set-cookie"), None);
    assert_eq!(header(&get(port, &format!("/overlay/hud?token={TOKEN}")), "set-cookie"), None);
    server.stop();
}

#[test]
fn lan_off_clears_the_cookie() {
    // LAN switched off after a device got its cookie: the answers delete it
    let (server, _) = start(false);
    let port = server.local_addr().port();
    let jar = format!("vectasim_token_{port}={TOKEN}");
    let r = request(port, "GET", "/api/v1/status", &[("Cookie", jar.as_str())]);
    assert_eq!(r.status, 200);
    assert!(header(&r, "set-cookie").is_some_and(|c| c.contains("Max-Age=0")), "{}", r.head);
    server.stop();
}

#[test]
fn the_start_page_carries_the_token_for_obs_links() {
    let (server, _) = start(true);
    let port = server.local_addr().port();
    let meta = format!(r#"<meta name="vectasim-token" content="{TOKEN}">"#);
    // opened from a bookmark on the tablet: authorised by the cookie alone
    let lan_host = format!("192.168.1.5:{port}");
    let jar = format!("vectasim_token_{port}={TOKEN}");
    let page = request(port, "GET", "/", &[("Host", lan_host.as_str()), ("Cookie", jar.as_str())]);
    assert_eq!(page.status, 200);
    assert!(page.body.contains(&meta), "token for the copy URLs");
    // the same with the token in the URL or a header
    let with_query = format!("/?token={TOKEN}");
    assert!(request(port, "GET", &with_query, &[("Host", lan_host.as_str())]).body.contains(&meta));
    assert!(request(port, "GET", "/", &[("X-VectaSim-Token", TOKEN)]).body.contains(&meta));
    // this PC without a token: served, but the token is not handed out to every local process
    let local = get(port, "/");
    assert_eq!(local.status, 200);
    assert!(!local.body.contains(TOKEN), "no token for a token-free loopback request");
    assert!(local.body.contains(r#"<meta name="vectasim-token" content="">"#));
    // a wrong token from this PC: still served (it needs none), but without the real one
    let wrong = request(port, "GET", "/", &[("X-VectaSim-Token", "WrongTokenWrongTokenWron")]);
    assert_eq!(wrong.status, 200);
    assert!(!wrong.body.contains(TOKEN));
    // no token, no page; the overlays themselves never carry it
    assert!(!request(port, "GET", "/", &[("Host", lan_host.as_str())]).body.contains(TOKEN));
    assert!(!get(port, "/overlay/hud").body.contains(TOKEN));
    assert!(get(port, "/overlay/overlay.js").body.contains("vectasim-token"));
    server.stop();
    // LAN off: the element stays empty
    let (server, _) = start(false);
    let port = server.local_addr().port();
    assert!(get(port, "/").body.contains(r#"<meta name="vectasim-token" content="">"#));
    server.stop();
}

#[test]
fn refused_loopback_requests_close_the_connection() {
    let (server, _) = start(false);
    let port = server.local_addr().port();
    // a page rebinding its name to 127.0.0.1 cannot park keep-alive connections
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    s.write_all(b"GET /api/v1/status HTTP/1.1\r\nHost: evil.example\r\n\r\n").unwrap();
    let started = std::time::Instant::now();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    assert!(text.starts_with("HTTP/1.1 403"), "{text}");
    assert!(text.to_ascii_lowercase().contains("connection: close"), "{text}");
    assert!(started.elapsed() < Duration::from_secs(2), "connection kept open");
    server.stop();
}

#[test]
fn streamer_mode_masks_every_answer() {
    let (server, fake) = start(false);
    let port = server.local_addr().port();
    assert!(get(port, "/api/v1/flight").body.contains("D-AINA"));
    fake.privacy.store(true, Ordering::Relaxed);
    for path in ["/api/v1/flight", "/api/v1/landing", "/api/v1/logbook?limit=2"] {
        let body = get(port, path).body;
        for secret in ["D-AINA", "DLH4YA", "Lufthansa"] {
            assert!(!body.contains(secret), "{path} leaks {secret}: {body}");
        }
        assert!(body.contains("D-••••"), "{path}: {body}");
    }
    assert_eq!(json_of(&get(port, "/api/v1/status"))["streamerMode"], true);
    server.stop();
}

/// Reads one unmasked server frame; returns (opcode, payload).
fn read_frame(s: &mut TcpStream) -> (u8, Vec<u8>) {
    let mut h = [0u8; 2];
    s.read_exact(&mut h).unwrap();
    let mut len = (h[1] & 0x7f) as usize;
    if len == 126 {
        let mut b = [0u8; 2];
        s.read_exact(&mut b).unwrap();
        len = u16::from_be_bytes(b) as usize;
    } else if len == 127 {
        let mut b = [0u8; 8];
        s.read_exact(&mut b).unwrap();
        len = u64::from_be_bytes(b) as usize;
    }
    let mut payload = vec![0u8; len];
    s.read_exact(&mut payload).unwrap();
    (h[0] & 0x0f, payload)
}

fn ws_handshake(port: u16, extra: &str) -> (TcpStream, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let req = format!(
        "GET /api/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{extra}\r\n"
    );
    s.write_all(req.as_bytes()).unwrap();
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut b).unwrap() == 0 {
            break;
        }
        head.push(b[0]);
    }
    (s, String::from_utf8_lossy(&head).to_string())
}

#[test]
fn websocket_handshake_hello_and_stream() {
    let (server, _) = start(false);
    let port = server.local_addr().port();
    let (mut s, head) = ws_handshake(port, "Origin: http://127.0.0.1\r\n");
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    // RFC 6455 sample key → accept value
    assert!(head.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "{head}");
    let (op, hello) = read_frame(&mut s);
    assert_eq!(op, 1, "text frame");
    let v: serde_json::Value = serde_json::from_slice(&hello).unwrap();
    assert_eq!(v["type"], "hello");
    assert_eq!(v["flight"]["phase"], "cruise");
    assert_eq!(v["landing"]["band"], "smooth");
    // the 2 Hz stream: a telemetry message follows within a second
    let (op, msg) = read_frame(&mut s);
    assert_eq!(op, 1);
    let v: serde_json::Value = serde_json::from_slice(&msg).unwrap();
    assert_eq!(v["type"], "telemetry");
    assert_eq!(v["telemetry"]["altitudeMslFt"], 36000.0);
    assert_eq!(server.clients(), 1);
    drop(s);

    // a cross-site page may not open the stream
    let (_s, head) = ws_handshake(port, "Origin: https://evil.example\r\n");
    assert!(head.starts_with("HTTP/1.1 403"), "{head}");
    server.stop();
}

#[test]
fn a_silent_connection_is_closed_after_the_header_timeout() {
    let limits = Limits { header_read_timeout: Duration::from_millis(300), ..Limits::default() };
    let server = Server::start_with_limits(Config { port: 0, lan: false, token: String::new() }, Arc::new(Fake::default()), limits).unwrap();
    let port = server.local_addr().port();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    // half a request head, then nothing (slowloris)
    s.write_all(b"GET /api/v1/status HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap();
    let started = std::time::Instant::now();
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    assert!(started.elapsed() < Duration::from_secs(3), "closed after {:?}", started.elapsed());
    // the server is still fine
    assert_eq!(get(port, "/api/v1/status").status, 200);
    server.stop();
}

#[test]
fn idle_local_connections_give_way_to_a_new_request() {
    // 70 idle loopback connections (pool: 64) – a local GET still answers at once
    let server = Server::start(Config { port: 0, lan: false, token: String::new() }, Arc::new(Fake::default())).unwrap();
    let port = server.local_addr().port();
    let idle: Vec<TcpStream> = (0..70).map(|_| TcpStream::connect(("127.0.0.1", port)).unwrap()).collect();
    std::thread::sleep(Duration::from_millis(300));
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let r = get(port, "/api/v1/status");
        assert_eq!(r.status, 200, "{}", r.head);
        assert!(started.elapsed() < Duration::from_secs(1), "answered after {:?}", started.elapsed());
    }
    drop(idle);
    server.stop();
}

#[test]
fn half_sent_request_heads_give_way_to_a_new_request() {
    // a local program fills the pool with connections that send only part of a request head
    // (the header timeout is still 10 s); a local GET must not wait for that timeout
    let limits = Limits { max_connections: 4, local_slot_wait: Duration::from_secs(2), ..Limits::default() };
    let server =
        Server::start_with_limits(Config { port: 0, lan: false, token: String::new() }, Arc::new(Fake::default()), limits).unwrap();
    let port = server.local_addr().port();
    let half: Vec<TcpStream> = (0..8)
        .map(|_| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /api/v1/status HTTP/1.1\r\nHost: 127.0.0.1\r\n").unwrap();
            s
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300));
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let r = get(port, "/api/v1/status");
        assert_eq!(r.status, 200, "{}", r.head);
        assert!(started.elapsed() < Duration::from_millis(1500), "answered after {:?}", started.elapsed());
    }
    drop(half);
    server.stop();
}

#[test]
fn a_busy_pool_answers_503_after_a_bounded_wait() {
    let limits = Limits { max_connections: 2, local_slot_wait: Duration::from_millis(300), ..Limits::default() };
    let fake = Arc::new(Fake::default());
    let server = Server::start_with_limits(Config { port: 0, lan: false, token: String::new() }, fake.clone(), limits).unwrap();
    let port = server.local_addr().port();
    fake.delay_ms.store(2000, Ordering::Relaxed);
    // two requests in flight hold both slots (nothing idle to close)
    let busy: Vec<_> = (0..2).map(|_| std::thread::spawn(move || get(port, "/api/v1/status").status)).collect();
    std::thread::sleep(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let r = get(port, "/api/v1/status");
    assert_eq!(r.status, 503, "{}", r.head);
    assert_eq!(header(&r, "connection"), Some("close"));
    assert!(started.elapsed() < Duration::from_millis(1500), "refused after {:?}", started.elapsed());
    fake.delay_ms.store(0, Ordering::Relaxed);
    for b in busy {
        assert_eq!(b.join().unwrap(), 200);
    }
    // slots free again
    assert_eq!(get(port, "/api/v1/status").status, 200);
    server.stop();
}

#[test]
fn port_in_use_is_reported() {
    let (server, _) = start(false);
    let port = server.local_addr().port();
    let second = Server::start(Config { port, lan: false, token: String::new() }, Arc::new(Fake::default()));
    let err = second.err().expect("second bind fails");
    assert!(err.contains(&port.to_string()), "{err}");
    server.stop();
    // stopped: the port is free again
    let again = Server::start(Config { port, lan: false, token: String::new() }, Arc::new(Fake::default()));
    assert!(again.is_ok(), "{:?}", again.err());
}

#[test]
fn overlay_language_from_query_or_backend() {
    let (server, _) = start(false);
    let port = server.local_addr().port();
    // the fake source keeps the default backend language (de)
    assert!(get(port, "/overlay/hud").body.contains("<html lang=\"de\">"));
    assert!(get(port, "/overlay/hud?lang=en").body.contains("<html lang=\"en\">"));
    assert!(get(port, "/?lang=EN").body.contains("<html lang=\"en\">"));
    assert!(get(port, "/overlay/route?lang=fr").body.contains("<html lang=\"de\">"), "unknown language falls back");
    let v = json_of(&get(port, "/api/v1/status"));
    assert_eq!(v["lang"], "de");
    assert_eq!(json_of(&get(port, "/api/v1/landing"))["bandLabel"], "sanft");
    let js = get(port, "/overlay/overlay.js").body;
    assert!(js.contains("\"band.firm\": \"firm\"") && js.contains("\"band.firm\": \"fest\""));
    server.stop();
}
