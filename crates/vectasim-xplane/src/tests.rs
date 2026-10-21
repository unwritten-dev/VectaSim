//! End-to-end tests against a fake X-Plane Web API (REST + WebSocket on 127.0.0.1) fed
//! from the fixture `tests/fixtures/webapi-session.json`.

use super::*;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver};
use vectasim_core::{AircraftInfo, SimEvent, Telemetry};

const FIXTURE: &str = include_str!("../tests/fixtures/webapi-session.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn id_of(fx: &Value, name: &str) -> u64 {
    fx["datarefs"].as_array().unwrap().iter().find(|d| d["name"] == name).unwrap()["id"].as_u64().unwrap()
}

#[derive(Default)]
struct FakeState {
    /// Answer HTTP and WebSocket at all (false = accept and drop, like a sim that is not up).
    online: bool,
    datarefs: Vec<Value>,
    capabilities: Value,
    /// Subscription requests of these ids fail.
    reject: HashSet<u64>,
    subscribed: Vec<u64>,
    http_paths: Vec<String>,
    ws_paths: Vec<String>,
    ws_connections: u32,
    /// Messages to push on the current WebSocket.
    outbox: Vec<String>,
    /// Close the current WebSocket.
    kick: bool,
}

struct Fake {
    port: u16,
    state: Arc<Mutex<FakeState>>,
    stop: Arc<AtomicBool>,
}

impl Fake {
    fn start(datarefs: Vec<Value>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(FakeState { online: true, datarefs, capabilities: fixture()["capabilities"].clone(), ..Default::default() }));
        let stop = Arc::new(AtomicBool::new(false));
        let (st, sp) = (state.clone(), stop.clone());
        std::thread::spawn(move || {
            while !sp.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((s, _)) => {
                        let (st, sp) = (st.clone(), sp.clone());
                        std::thread::spawn(move || serve(s, st, sp));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        });
        Fake { port, state, stop }
    }

    fn with_fixture() -> Self {
        Self::start(fixture()["datarefs"].as_array().unwrap().clone())
    }

    fn st(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    fn push(&self, msg: &Value) {
        self.st().outbox.push(msg.to_string());
    }

    fn config(&self) -> XPlaneConfig {
        XPlaneConfig {
            host: "127.0.0.1".into(),
            port: self.port,
            poll: Duration::from_millis(100),
            probe_after: Duration::from_secs(30),
            timeout: Duration::from_millis(500),
        }
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn serve(mut s: TcpStream, st: Arc<Mutex<FakeState>>, stop: Arc<AtomicBool>) {
    s.set_nonblocking(false).unwrap();
    if !st.lock().unwrap().online {
        return; // dropped: the client sees a closed connection
    }
    // peek the request head to tell HTTP from a WebSocket upgrade
    let mut head = vec![0u8; 8192];
    let started = Instant::now();
    let n = loop {
        let n = s.peek(&mut head).unwrap_or(0);
        if head[..n].windows(4).any(|w| w == b"\r\n\r\n") || started.elapsed() > Duration::from_secs(2) {
            break n;
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    let text = String::from_utf8_lossy(&head[..n]).to_string();
    let path = text.split_whitespace().nth(1).unwrap_or_default().to_owned();
    if text.to_ascii_lowercase().contains("upgrade: websocket") {
        let Ok(mut ws) = tungstenite::accept(s) else { return };
        {
            let mut g = st.lock().unwrap();
            g.ws_paths.push(path);
            g.ws_connections += 1;
            g.outbox.clear();
            g.kick = false;
        }
        ws.get_ref().set_read_timeout(Some(Duration::from_millis(10))).unwrap();
        while !stop.load(Ordering::Relaxed) {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    assert_eq!(v["type"], "dataref_subscribe_values");
                    let req_id = v["req_id"].as_u64().unwrap();
                    let ids: Vec<u64> = v["params"]["datarefs"].as_array().unwrap().iter().map(|d| d["id"].as_u64().unwrap()).collect();
                    let mut g = st.lock().unwrap();
                    let reply = if ids.iter().any(|i| g.reject.contains(i)) {
                        json!({"req_id": req_id, "type": "result", "success": false,
                               "error_code": "invalid_dataref_id", "error_message": format!("Dataref {} doesn't exist", ids[0])})
                    } else {
                        g.subscribed.extend(ids);
                        json!({"req_id": req_id, "type": "result", "success": true})
                    };
                    drop(g);
                    if ws.send(Message::text(reply.to_string())).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => return,
            }
            let (out, kick) = {
                let mut g = st.lock().unwrap();
                (std::mem::take(&mut g.outbox), std::mem::take(&mut g.kick))
            };
            for m in out {
                if ws.send(Message::text(m)).is_err() {
                    return;
                }
            }
            if kick {
                let _ = ws.close(None);
                let _ = ws.flush();
                return;
            }
        }
        return;
    }
    // plain HTTP: consume the head, answer, close
    let mut consumed = vec![0u8; text.find("\r\n\r\n").map_or(n, |i| i + 4)];
    let _ = s.read_exact(&mut consumed);
    let (status, body) = {
        let mut g = st.lock().unwrap();
        g.http_paths.push(path.clone());
        if path == "/api/capabilities" {
            (200, g.capabilities.to_string())
        } else if let Some(q) = path.strip_prefix("/api/v2/datarefs?") {
            let wanted: HashSet<&str> = q.split('&').filter_map(|p| p.strip_prefix("filter[name]=")).collect();
            let data: Vec<Value> = g.datarefs.iter().filter(|d| wanted.contains(d["name"].as_str().unwrap())).cloned().collect();
            (200, json!({ "data": data }).to_string())
        } else {
            (404, json!({"error_code": "not_found", "error_message": "nope"}).to_string())
        }
    };
    // chunked, to exercise that path of the client
    let resp = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(resp.as_bytes());
}

struct Running {
    rx: Receiver<ProviderEvent>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    seen: Vec<ProviderEvent>,
}

impl Running {
    fn start(p: XPlaneProvider) -> Self {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let handle = Box::new(p).start(tx, stop.clone());
        Running { rx, stop, handle: Some(handle), seen: Vec::new() }
    }

    /// Wait for an event matching `f` (5 s), keeping everything seen.
    fn wait(&mut self, what: &str, f: impl Fn(&ProviderEvent) -> bool) -> ProviderEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(e) = self.rx.recv_timeout(Duration::from_millis(20)) {
                self.seen.push(e.clone());
                if f(&e) {
                    return e;
                }
            }
        }
        panic!("timed out waiting for {what}; seen: {:#?}", self.seen.iter().rev().take(5).collect::<Vec<_>>());
    }

    fn telemetry(&mut self, what: &str, f: impl Fn(&Telemetry) -> bool) -> Telemetry {
        match self.wait(what, |e| matches!(e, ProviderEvent::Telemetry(t) if f(t))) {
            ProviderEvent::Telemetry(t) => *t,
            _ => unreachable!(),
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn provider(c: XPlaneConfig) -> XPlaneProvider {
    XPlaneProvider { config: c, dump: None, diag: RawDiag::shared(DUMP_SOURCE) }
}

fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn connected(e: &ProviderEvent) -> bool {
    matches!(e, ProviderEvent::Connected { .. })
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn resolves_subscribes_and_converts_the_fixture() {
    let fx = fixture();
    let fake = Fake::with_fixture();
    let mut run = Running::start(provider(fake.config()));
    let ev = run.wait("connected", connected);
    let ProviderEvent::Connected { sim_name, sim_version } = ev else { unreachable!() };
    assert_eq!((sim_name.as_str(), sim_version.as_str()), ("X-Plane 12", "12.1.4"));

    // one lookup with every name, then one subscription per dataref on /api/v2
    let n = NUMERIC.len() + STRINGS.len();
    wait_until("all subscriptions", || fake.st().subscribed.len() == n);
    {
        let g = fake.st();
        let lookup = g.http_paths.iter().find(|p| p.contains("/datarefs?")).unwrap();
        assert!(lookup.starts_with("/api/v2/datarefs?filter[name]=sim/flightmodel/position/latitude&"), "{lookup}");
        assert_eq!(lookup.matches("filter[name]=").count(), n);
        assert_eq!(g.ws_paths, vec!["/api/v2".to_string()]);
    }

    let updates = fx["updates"].as_array().unwrap();
    fake.push(&updates[0]);
    let t = run.telemetry("first sample", |_| true);
    assert!(close(t.latitude, 50.03791234567) && close(t.longitude, 8.56221234567), "doubles keep their precision");
    assert!((t.altitude_msl_ft - 111.25 * 3.280_839_895).abs() < 1e-6);
    assert!((t.altitude_agl_ft - 3.018).abs() < 0.01, "{}", t.altitude_agl_ft);
    assert!(t.on_ground);
    assert_eq!((t.heading_mag_deg, t.heading_true_deg, t.pitch_deg, t.bank_deg), (248.4, 251.2, 2.1, -0.3));
    assert_eq!(t.gear_pct, 100.0);
    assert_eq!((t.flaps_index, t.flap_positions), (0, Some(4)));
    assert!(t.parking_brake);
    assert_eq!((t.fuel_total_kg, t.total_weight_kg), (144.5, 1043.2));
    assert_eq!((t.num_engines, t.engines_running), (1, 1), "16-element array, one engine running");
    assert_eq!(t.transponder_code, 1200);
    assert_eq!((t.sim_zulu_time_s, t.sim_rate, t.paused), (43200.5, 1.0, false));
    assert_eq!(t.lights, vectasim_core::Lights { beacon: true, nav: true, strobe: false, landing: false, taxi: true });
    assert!((t.wind_kt.unwrap() - 10.0).abs() < 0.01);
    assert_eq!(t.wind_dir_true_deg, Some(270.0));
    assert_eq!((t.design_vs0_kt, t.design_vs1_kt), (Some(40.0), Some(48.0)));
    assert_eq!(t.touchdown_vs_fpm, 0.0, "X-Plane has no touchdown value: the core's V/S fallback applies");
    let ac = run.wait("aircraft", |e| matches!(e, ProviderEvent::Aircraft(_)));
    let ProviderEvent::Aircraft(ac) = ac else { unreachable!() };
    assert_eq!(
        ac,
        AircraftInfo { title: "Cessna 172 SP".into(), atc_model: "C172".into(), atc_id: "N172SP".into(), ..Default::default() }
    );

    // delta: only ground speed, time and parking brake – everything else is kept
    fake.push(&updates[1]);
    let t = run.telemetry("delta", |t| t.ground_speed_kt > 0.0);
    assert!((t.ground_speed_kt - 5.0 * 1.943_844_492).abs() < 1e-6);
    assert!(!t.parking_brake);
    assert!(close(t.latitude, 50.03791234567) && t.on_ground && t.gear_pct == 100.0 && t.transponder_code == 1200);

    // airborne, flaps 2 of 3, spoilers armed, paused
    fake.push(&updates[2]);
    run.wait("pause event", |e| matches!(e, ProviderEvent::Sim(SimEvent::Paused { paused: true })));
    let t = run.seen.iter().rev().find_map(|e| if let ProviderEvent::Telemetry(t) = e { Some(t.clone()) } else { None }).unwrap();
    assert!(!t.on_ground && (t.altitude_agl_ft - 1000.0).abs() < 0.01);
    assert_eq!(t.vertical_speed_fpm, -650.5);
    assert_eq!(t.flaps_index, 2);
    assert_eq!((t.spoilers_armed, t.spoilers_handle_pct), (Some(true), Some(0.0)));
    assert_eq!((t.n1_pct, t.throttle_lever_pct), (Some(55.0), Some(42.0)));
    assert!((t.tas_kt - 38.0 * 1.943_844_492).abs() < 1e-6 && t.ias_kt == 72.0);
    fake.push(&updates[3]);
    run.wait("unpause", |e| matches!(e, ProviderEvent::Sim(SimEvent::Paused { paused: false })));
    assert!(!run.seen.iter().any(|e| matches!(e, ProviderEvent::Disconnected { .. } | ProviderEvent::Error { .. })));
    assert_eq!(id_of(&fx, NUMERIC[datarefs::LAT].name), 100_000);
}

#[test]
fn unknown_and_rejected_datarefs_stay_unset_without_disconnecting() {
    let fx = fixture();
    let without_wind: Vec<Value> =
        fx["datarefs"].as_array().unwrap().iter().filter(|d| !d["name"].as_str().unwrap().starts_with("sim/weather/")).cloned().collect();
    let fake = Fake::start(without_wind);
    let alpha = id_of(&fx, NUMERIC[datarefs::ALPHA].name);
    fake.st().reject.insert(alpha);
    let p = provider(fake.config());
    let diag = p.diag.clone();
    let mut run = Running::start(p);
    run.wait("connected", connected);
    wait_until("subscriptions", || fake.st().subscribed.len() == NUMERIC.len() + STRINGS.len() - 3);
    // a full update including (stale) values of the rejected id: ignored
    let mut first = fx["updates"][0].clone();
    first["data"][alpha.to_string()] = json!(4.5);
    fake.push(&first);
    let t = run.telemetry("sample", |_| true);
    assert_eq!((t.wind_kt, t.wind_dir_true_deg, t.alpha_deg), (None, None, None));
    assert!(t.on_ground && t.gear_pct == 100.0);
    let d = diag.lock().unwrap().snapshot(now_ms());
    let vars = &d.defs[0].vars;
    let var = |name: &str| vars.iter().find(|v| v.name == name).unwrap();
    assert!(!var("sim/weather/aircraft/wind_speed_msc").active);
    assert!(!var("sim/flightmodel/position/alpha").active);
    assert!(var("sim/flightmodel/position/latitude").active);
    assert_eq!(d.connection.dll.as_deref(), Some(format!("X-Plane Web API 127.0.0.1:{}", fake.port).as_str()));
    assert_eq!(d.connection.simconnect_version.as_deref(), Some("Web API v2"));
    assert!(!run.seen.iter().any(|e| matches!(e, ProviderEvent::Disconnected { .. })));
}

#[test]
fn waits_for_xplane_then_reconnects_after_it_quits() {
    let fx = fixture();
    let fake = Fake::with_fixture();
    fake.st().online = false;
    let mut run = Running::start(provider(fake.config()));
    let e = run.wait("not reachable", |e| matches!(e, ProviderEvent::Disconnected { .. }));
    let ProviderEvent::Disconnected { reason } = e else { unreachable!() };
    assert!(reason.starts_with("sim not reachable (X-Plane Web API 127.0.0.1:") && reason.ends_with("retry in 1s"), "{reason}");
    // polled again
    run.wait("second attempt", |e| matches!(e, ProviderEvent::Connecting));
    run.wait("still not reachable", |e| matches!(e, ProviderEvent::Disconnected { .. }));

    fake.st().online = true;
    run.wait("connected", connected);
    wait_until("subscribed", || !fake.st().subscribed.is_empty());
    fake.push(&fx["updates"][0]);
    run.telemetry("sample", |_| true);

    // X-Plane quits: the WebSocket closes
    fake.st().kick = true;
    let e = run.wait("disconnected", |e| matches!(e, ProviderEvent::Disconnected { .. }));
    let ProviderEvent::Disconnected { reason } = e else { unreachable!() };
    assert!(reason.contains("simulator quit"), "{reason}");
    run.wait("reconnected", connected);
    wait_until("second WebSocket", || fake.st().ws_connections == 2);
}

#[test]
fn a_silent_connection_is_probed_and_dropped_when_xplane_hangs() {
    let fx = fixture();
    let fake = Fake::with_fixture();
    let mut c = fake.config();
    c.probe_after = Duration::from_millis(300);
    let mut run = Running::start(provider(c));
    run.wait("connected", connected);
    wait_until("subscribed", || !fake.st().subscribed.is_empty());
    fake.push(&fx["updates"][0]);
    run.telemetry("sample", |_| true);
    // silent but the REST endpoint answers (a paused sim): stays connected
    std::thread::sleep(Duration::from_millis(800));
    assert!(!run.rx.try_iter().any(|e| matches!(e, ProviderEvent::Disconnected { .. })));
    // the server stops answering
    fake.st().online = false;
    let e = run.wait("unresponsive", |e| matches!(e, ProviderEvent::Disconnected { .. }));
    let ProviderEvent::Disconnected { reason } = e else { unreachable!() };
    assert!(reason.contains("not responding"), "{reason}");
}

#[test]
fn aircraft_change_is_reported() {
    let fx = fixture();
    let fake = Fake::with_fixture();
    let mut run = Running::start(provider(fake.config()));
    run.wait("connected", connected);
    wait_until("subscribed", || fake.st().subscribed.len() == NUMERIC.len() + STRINGS.len());
    fake.push(&fx["updates"][0]);
    run.wait("aircraft", |e| matches!(e, ProviderEvent::Aircraft(_)));
    // same strings again (X-Plane re-sends after a reload of the same aircraft): nothing new
    let data = |name: &str, v: &str, len: usize| (id_of(&fx, name).to_string(), json!(api::encode_data(v, len)));
    let msg = |pairs: Vec<(String, Value)>| json!({"type": "dataref_update_values", "data": pairs.into_iter().collect::<serde_json::Map<_, _>>()});
    fake.push(&msg(vec![data(STRINGS[datarefs::S_TAILNUM], "N172SP", 40)]));
    fake.push(&msg(vec![
        data(STRINGS[datarefs::S_ICAO], "A333", 40),
        data(STRINGS[datarefs::S_TAILNUM], "D-AXPL", 40),
        data(STRINGS[datarefs::S_UI_NAME], "Airbus A330-300", 260),
        data(STRINGS[datarefs::S_PATH], "Aircraft/Laminar Research/Airbus A330-300/A330.acf", 512),
    ]));
    let e = run.wait("aircraft loaded", |e| matches!(e, ProviderEvent::Sim(SimEvent::AircraftLoaded { .. })));
    assert_eq!(e_path(&e), "Aircraft/Laminar Research/Airbus A330-300/A330.acf");
    let e = run.wait("new aircraft", |e| matches!(e, ProviderEvent::Aircraft(_)));
    let ProviderEvent::Aircraft(ac) = e else { unreachable!() };
    assert_eq!((ac.title.as_str(), ac.atc_model.as_str(), ac.atc_id.as_str()), ("Airbus A330-300", "A333", "D-AXPL"));
    let loads = run.seen.iter().filter(|e| matches!(e, ProviderEvent::Sim(SimEvent::AircraftLoaded { .. }))).count();
    let infos = run.seen.iter().filter(|e| matches!(e, ProviderEvent::Aircraft(_))).count();
    assert_eq!((loads, infos), (1, 2));
}

fn e_path(e: &ProviderEvent) -> &str {
    match e {
        ProviderEvent::Sim(SimEvent::AircraftLoaded { path }) => path,
        _ => "",
    }
}

#[test]
fn session_is_dumped_and_replays_identically() {
    let fx = fixture();
    let fake = Fake::with_fixture();
    let rec = Arc::new(DumpRecorder::new("test", vectasim_dump::RingConfig::default()));
    let mut p = provider(fake.config());
    p.dump = Some(rec.clone());
    let mut run = Running::start(p);
    run.wait("connected", connected);
    wait_until("subscribed", || fake.st().subscribed.len() == NUMERIC.len() + STRINGS.len());
    for u in fx["updates"].as_array().unwrap() {
        fake.push(u);
    }
    run.wait("unpause", |e| matches!(e, ProviderEvent::Sim(SimEvent::Paused { paused: false })));
    drop(run); // stops the session: `end` line
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("xp.vsdump");
    rec.dump_ring(&path).unwrap();

    let (header, lines, err) = vectasim_dump::read_all(&path).unwrap();
    assert!(err.is_none());
    assert_eq!(header.source, "xplane");
    assert_eq!(header.sim.as_deref(), Some("X-Plane 12"));
    assert_eq!(header.sim_version.as_deref(), Some("12.1.4"));
    assert_eq!(header.defs.fast.len(), N_SLOTS);
    // raw: the delta line holds exactly the three values of the second push
    let data: Vec<&vectasim_dump::Line> = lines.iter().filter(|l| matches!(&l.body, Body::Data { req, .. } if *req == REQ_NUM)).collect();
    assert_eq!(data.len(), 4);
    let Body::Data { v, .. } = &data[1].body else { unreachable!() };
    assert_eq!(v.iter().filter(|x| x.0.is_finite()).count(), 3);
    assert!(matches!(lines.last().unwrap().body, Body::End { .. }));

    // replay through the player: same telemetry as live
    let mut player = XpPlayer::new(&header, "Replay xp".into(), RawDiag::shared("replay"));
    assert!(!player.definitions_differ());
    let events: Vec<ProviderEvent> = lines.iter().flat_map(|l| player.apply(l, l.w, l.w)).collect();
    let tele = |evs: &[ProviderEvent]| -> Vec<Telemetry> {
        evs.iter()
            .filter_map(|e| if let ProviderEvent::Telemetry(t) = e { Some(Telemetry { timestamp_ms: 0, ..(**t).clone() }) } else { None })
            .collect()
    };
    let replayed = tele(&events);
    assert_eq!(replayed.len(), 4);
    assert!(close(replayed[0].latitude, 50.03791234567));
    assert_eq!(replayed[2].flaps_index, 2);
    assert_eq!(replayed[3].latitude, 50.04);
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Connected { sim_name, .. } if sim_name == "Replay xp")));
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Aircraft(a) if a.atc_id == "N172SP")));
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Sim(SimEvent::Paused { paused: true }))));
    assert!(matches!(events.last(), Some(ProviderEvent::Disconnected { .. })));
    assert!(player.decoder().telemetry().latitude == 50.04);
}

#[test]
fn probe_reports_the_version() {
    let fake = Fake::with_fixture();
    assert_eq!(probe("127.0.0.1", fake.port, Duration::from_millis(500)).as_deref(), Some("12.1.4"));
    fake.st().online = false;
    assert_eq!(probe("127.0.0.1", fake.port, Duration::from_millis(500)), None);
}

/// One-shot HTTP server answering each request by path (`answer` → status and body).
fn raw_http(answer: fn(&str) -> (u16, &'static str)) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(mut s) = s else { return };
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && s.read(&mut b).unwrap_or(0) == 1 {
                head.push(b[0]);
            }
            let text = String::from_utf8_lossy(&head).to_string();
            let (status, body) = answer(text.split_whitespace().nth(1).unwrap_or_default());
            let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    port
}

#[test]
fn probe_does_not_take_another_service_for_xplane() {
    let t = Duration::from_millis(500);
    // InfluxDB-like: 404 everywhere
    let influx = raw_http(|_| (404, "{\"code\":\"not found\",\"message\":\"path not found\"}"));
    assert_eq!(probe("127.0.0.1", influx, t), None);
    // 200 with JSON that is no capabilities document
    let other = raw_http(|_| (200, "{\"status\":\"pass\"}"));
    assert_eq!(probe("127.0.0.1", other, t), None);
    let html = raw_http(|_| (200, "<html>hello</html>"));
    assert_eq!(probe("127.0.0.1", html, t), None);
    // X-Plane 12.1.1: no capabilities endpoint, but the dataref count answers
    let xp1211 = raw_http(|p| if p == "/api/v1/datarefs/count" { (200, "{\"data\":4711}") } else { (404, "") });
    assert_eq!(probe("127.0.0.1", xp1211, t).as_deref(), Some("?"));
    // capabilities without an X-Plane version but with an API list
    let noversion = raw_http(|_| (200, "{\"api\":{\"versions\":[\"v1\",\"v2\"]}}"));
    assert_eq!(probe("127.0.0.1", noversion, t).as_deref(), Some("?"));
}

#[test]
fn ws_limits_are_set() {
    let c = ws_config();
    assert_eq!((c.max_message_size, c.max_frame_size), (Some(WS_MAX_MESSAGE), Some(WS_MAX_FRAME)));
}

#[test]
fn config_from_env() {
    let c = XPlaneConfig::from_lookup(|k| match k {
        ENV_HOST => Some(" 192.168.1.20 ".into()),
        ENV_PORT => Some("8088".into()),
        _ => None,
    });
    assert_eq!((c.host.as_str(), c.port), ("192.168.1.20", 8088));
    assert_eq!(c.source_label(), "X-Plane Web API 192.168.1.20:8088");
    let d = XPlaneConfig::from_lookup(|k| (k == ENV_PORT).then(|| "x".into()));
    assert_eq!((d.host.as_str(), d.port), ("localhost", 8086));
}

#[test]
fn host_setting_is_this_pc_the_lan_or_a_name() {
    use crate::{HostError, HostScope, check_host};
    for h in ["localhost", "LocalHost", "127.0.0.1", "127.1.2.3", "::1"] {
        assert_eq!(check_host(h), Ok(HostScope::Loopback), "{h}");
    }
    for h in ["192.168.1.20", " 10.0.0.5 ", "172.16.4.1", "169.254.10.1", "100.101.102.103", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.2"] {
        assert_eq!(check_host(h), Ok(HostScope::Local), "{h}");
    }
    for h in ["simpc", "simpc.local", "sim-pc.fritz.box", "simpc."] {
        assert_eq!(check_host(h), Ok(HostScope::Name), "{h}");
    }
    for h in ["8.8.8.8", "100.128.0.1", "2001:db8::1", "0.0.0.0", "255.255.255.255", "224.0.0.1"] {
        assert_eq!(check_host(h), Err(HostError::Public), "{h}");
    }
    for h in ["", " ", "sim pc", "sim/pc", "simpc:8086", "[::1]", "sim_pc", "-simpc", "simpc-", "a..b", "999.1.1.1", "1.2.3", "sim\r\npc"] {
        assert_eq!(check_host(h), Err(HostError::Syntax), "{h:?}");
    }
    // a refused host in the settings or environment falls back to localhost
    let c = XPlaneConfig::from_lookup(|k| (k == ENV_HOST).then(|| "8.8.8.8".into()));
    assert_eq!(c.host, DEFAULT_HOST);
    assert_eq!(crate::http::authority("fe80::1", 8086), "[fe80::1]:8086");
    assert_eq!(crate::http::authority("simpc", 8086), "simpc:8086");
}

#[test]
fn a_host_name_must_resolve_to_this_pc_or_the_lan() {
    use crate::http::connect_with;
    use std::net::{SocketAddr, TcpListener};
    let t = Duration::from_millis(500);
    // a name pointing at the internet is refused before anything is dialled
    let public: SocketAddr = "93.184.216.34:8086".parse().unwrap();
    let e = connect_with("example.com", 8086, t, |_, _| Ok(vec![public])).unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied, "{e}");
    assert!(e.to_string().contains("93.184.216.34"), "{e}");
    // IPv6 and IPv4-mapped public addresses alike
    let v6: Vec<SocketAddr> = vec!["[2001:4860::8888]:8086".parse().unwrap(), "[::ffff:8.8.8.8]:8086".parse().unwrap()];
    assert_eq!(connect_with("foo.duckdns.org", 8086, t, |_, _| Ok(v6)).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    // a name with a public and a loopback address: only the loopback one is dialled
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let local = l.local_addr().unwrap();
    let s = connect_with("simpc", local.port(), t, |_, _| Ok(vec![public, local])).expect("loopback address dialled");
    assert_eq!(s.peer_addr().unwrap(), local);
    // the resolver runs on every connect: a name that later points elsewhere is caught
    let calls = std::cell::Cell::new(0);
    for answer in [local, public] {
        let r = connect_with("simpc", local.port(), t, |_, _| {
            calls.set(calls.get() + 1);
            Ok(vec![answer])
        });
        assert_eq!(r.is_ok(), answer == local);
    }
    assert_eq!(calls.get(), 2);
    // nothing resolved: an error, no panic
    assert!(connect_with("simpc", 8086, t, |_, _| Ok(vec![])).is_err());
    // the same scope as the host setting
    assert_eq!(crate::ip_scope("192.168.1.20".parse().unwrap()), Ok(crate::HostScope::Local));
    assert_eq!(crate::ip_scope("8.8.8.8".parse().unwrap()), Err(crate::HostError::Public));
}
