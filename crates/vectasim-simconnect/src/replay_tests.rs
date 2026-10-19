//! Replay tests: the checked-in mock fixture, the provider thread, size and mapping.

use super::*;
use crate::mockdump::{MockDumpSpec, mock_lines, write_dump};
use vectasim_core::{FlightEvent, FlightSession, MockFlight, MockVariant, Telemetry, TouchdownReport};
use vectasim_dump::{DumpRecorder, FileTarget, RingConfig};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../vectasim-core/tests/fixtures/mock-circuit.vsdump")
}

fn touchdowns(events: &[ProviderEvent]) -> Vec<TouchdownReport> {
    let mut session = FlightSession::new();
    let mut out = Vec::new();
    for e in events {
        let fe = match e {
            ProviderEvent::Telemetry(t) => session.update(t),
            ProviderEvent::Sim(s) => session.on_sim_event(s),
            _ => Vec::new(),
        };
        out.extend(fe.into_iter().filter_map(|e| match e {
            FlightEvent::Touchdown(r) => Some(r),
            _ => None,
        }));
    }
    out
}

fn last_telemetry(e: &[ProviderEvent]) -> Telemetry {
    e.iter()
        .rev()
        .find_map(|e| match e {
            ProviderEvent::Telemetry(t) => Some((**t).clone()),
            _ => None,
        })
        .expect("telemetry")
}

#[test]
fn the_fixture_is_what_the_generator_produces() {
    let (h, lines, err) = vectasim_dump::read_all(&fixture()).expect("fixture readable");
    assert!(err.is_none());
    let size = std::fs::metadata(fixture()).unwrap().len();
    assert!(size <= 300 * 1024, "fixture {size} bytes");
    let (gen_h, gen_lines) = mock_lines(&MockDumpSpec::final_and_landing());
    let hint = "regenerate: cargo run -p vectasim-simconnect --example mock-to-vsdump -- crates/vectasim-core/tests/fixtures/mock-circuit.vsdump";
    assert_eq!(h.defs, gen_h.defs, "definitions changed; {hint}");
    assert_eq!(lines.len(), gen_lines.len(), "{hint}");
    if let Some(i) = (0..lines.len()).find(|&i| lines[i] != gen_lines[i]) {
        panic!("fixture out of date at line {i}: {:?} vs {:?}; {hint}", lines[i], gen_lines[i]);
    }
    // full frames at 60 Hz, no thinning
    let fast = lines.iter().filter(|l| matches!(&l.body, Body::Data { req: 1, v, .. } if v.len() == 17)).count();
    assert!(fast >= 80 * 60, "{fast} FAST frames");
}

#[test]
fn fixture_replays_to_one_touchdown_with_the_rate_of_the_mock() {
    let (events, err) = replay_file(&fixture()).unwrap();
    assert!(err.is_none());
    assert!(!events.iter().any(|e| matches!(e, ProviderEvent::Error { .. })), "no decoder errors");
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Aircraft(a) if a.atc_id == "D-AVCT")));
    let tds = touchdowns(&events);
    assert_eq!(tds.len(), 1, "{tds:?}");

    // the same span fed straight from the mock flight
    let spec = MockDumpSpec::final_and_landing();
    let mut flight = MockFlight::with_variant(MockVariant::Standard);
    let frames = ((spec.to_s - spec.from_s) * spec.hz).round() as u64;
    let direct: Vec<ProviderEvent> = (0..=frames)
        .map(|i| {
            let t = 3 + (i as f64 * 1000.0 / spec.hz).round() as u64;
            ProviderEvent::Telemetry(Box::new(flight.sample(spec.from_s + i as f64 / spec.hz, spec.start_wall_ms + t)))
        })
        .collect();
    let expected = touchdowns(&direct);
    assert_eq!(expected.len(), 1);
    let (a, b) = (&tds[0], &expected[0]);
    assert!((a.landing_rate_fpm - b.landing_rate_fpm).abs() < 0.01, "{} vs {}", a.landing_rate_fpm, b.landing_rate_fpm);
    // the demo landing: about −230 fpm (mock.rs DEMO_TD_FPM)
    assert!((-245.0..=-215.0).contains(&a.landing_rate_fpm), "{}", a.landing_rate_fpm);
    assert_eq!(a.timestamp_ms, b.timestamp_ms, "simulated clock = recorded clock");
    assert_eq!(a.landing_rate_source, b.landing_rate_source);
}

#[test]
fn replayed_telemetry_matches_the_mock_samples() {
    let (events, _) = replay_file(&fixture()).unwrap();
    let tele: Vec<&Telemetry> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::Telemetry(t) => Some(&**t),
            _ => None,
        })
        .collect();
    let spec = MockDumpSpec::final_and_landing();
    let mut flight = MockFlight::with_variant(MockVariant::Standard);
    let t = 3 + (100.0 * 1000.0 / spec.hz).round() as u64;
    let m = flight.sample(spec.from_s + 100.0 / spec.hz, spec.start_wall_ms + t);
    let r = tele[100];
    assert_eq!((r.latitude, r.altitude_agl_ft, r.vertical_speed_fpm), (m.latitude, m.altitude_agl_ft, m.vertical_speed_fpm));
    assert_eq!(r.timestamp_ms, m.timestamp_ms);
    assert!((r.fuel_total_kg - m.fuel_total_kg).abs() < 1.0, "1 Hz SLOW, lb round trip");
    assert_eq!((r.num_engines, r.engines_running, r.transponder_code), (2, 2, 2000));
    assert_eq!(r.lights, m.lights);
    // track-v2 approach data (1 Hz definition: the value of the last full second)
    assert_eq!((r.wind_kt, r.wind_dir_true_deg, r.nav_gs_angle_deg, r.flap_positions), (m.wind_kt, m.wind_dir_true_deg, m.nav_gs_angle_deg, Some(5)));
    assert_eq!((r.nav_has_localizer, r.nav_has_glide_slope), (Some(true), Some(true)));
    assert!((r.nav_gs_error_deg.unwrap() - m.nav_gs_error_deg.unwrap()).abs() < 0.05, "{:?} vs {:?}", r.nav_gs_error_deg, m.nav_gs_error_deg);
    assert!(r.n1_pct.is_some() && r.alpha_deg.is_some() && r.autothrottle_active.is_some());
    assert_eq!(r.design_vs0_kt, Some(104.0));
}

#[test]
fn a_dump_from_before_the_approach_definition_still_replays() {
    let spec = MockDumpSpec { from_s: 500.0, to_s: 502.0, ..MockDumpSpec::final_and_landing() };
    let (mut h, lines) = mock_lines(&spec);
    h.defs.approach.clear();
    h.defs.design.clear();
    h.reqs.retain(|k, _| k != "approach" && k != "design");
    let lines: Vec<Line> = lines.into_iter().filter(|l| !matches!(&l.body, Body::Data { req: 4 | 5, .. })).collect();
    // as an older build wrote it: no `approach`/`design` keys in the header at all
    let json = serde_json::to_string(&h).unwrap();
    assert!(!json.contains("approach") && !json.contains("design"), "{json}");
    let h: vectasim_dump::Header = serde_json::from_str(&json).unwrap();
    let mut p = Player::new(&h, "Replay old".into(), RawDiag::shared("replay"));
    assert!(!p.definitions_differ(), "a definition the dump does not have is not a difference");
    let ev: Vec<ProviderEvent> = lines.iter().flat_map(|l| p.apply(l, l.w, l.w)).collect();
    let t = last_telemetry(&ev);
    assert!(t.latitude != 0.0);
    assert_eq!((t.wind_kt, t.nav_has_localizer, t.n1_pct, t.design_vs0_kt), (None, None, None, None), "not recorded = None");
}

#[test]
fn sixty_hz_fast_stays_below_10_mb_per_hour() {
    // 5 minutes of the circuit at 60 Hz through the live recorder (level and keyframes as live)
    let spec = MockDumpSpec { from_s: 100.0, to_s: 400.0, ..MockDumpSpec::final_and_landing() };
    let (h, lines) = mock_lines(&spec);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("size.vsdump");
    let rec = DumpRecorder::new("size", RingConfig::default());
    rec.set_target(FileTarget::Path(path.clone()));
    rec.begin_session(h);
    let t0 = Instant::now();
    for l in &lines {
        rec.record(t0 + Duration::from_millis(l.t), l.w, l.body.clone());
    }
    rec.flush_and_close();
    let secs = spec.to_s - spec.from_s;
    let bytes = std::fs::metadata(&path).unwrap().len() as f64;
    let per_hour_mb = bytes / secs * 3600.0 / 1e6;
    assert!(per_hour_mb < 10.0, "{per_hour_mb:.1} MB/h");
    let ring_30min_mb = rec.status().ring_bytes as f64 / secs * 1800.0 / 1e6;
    assert!(ring_30min_mb < 64.0, "ring for 30 min ≈ {ring_30min_mb:.1} MB");
    println!("raw dump at 60 Hz: {per_hour_mb:.1} MB/h on disk, RAM ring for 30 min ≈ {ring_30min_mb:.1} MB");
    let (_, back, err) = vectasim_dump::read_all(&path).unwrap();
    assert!(err.is_none());
    assert!(back.len() == lines.len() && back == lines, "lossless");
}

#[test]
fn dumps_with_other_definitions_are_mapped_by_name() {
    let spec = MockDumpSpec { from_s: 500.0, to_s: 502.0, ..MockDumpSpec::final_and_landing() };
    let (h2, l2) = mock_lines(&spec);
    let mut p2 = Player::new(&h2, "x".into(), RawDiag::shared("replay"));
    let direct: Vec<ProviderEvent> = l2.iter().flat_map(|l| p2.apply(l, l.w, l.w)).collect();
    assert!(!p2.definitions_differ());

    let (mut h, lines) = mock_lines(&spec);
    // an older build: no IS SLEW ACTIVE, an extra variable in front
    h.defs.fast.retain(|(n, _)| n != "IS SLEW ACTIVE");
    h.defs.fast.insert(0, ("AMBIENT TEMPERATURE".into(), "celsius".into()));
    let lines: Vec<Line> = lines
        .into_iter()
        .map(|mut l| {
            if let Body::Data { req: 1, v, .. } = &mut l.body {
                v.pop();
                v.insert(0, vectasim_dump::Raw(15.0));
            }
            l
        })
        .collect();
    let mut p = Player::new(&h, "Replay old".into(), RawDiag::shared("replay"));
    assert!(p.definitions_differ());
    let ev: Vec<ProviderEvent> = lines.iter().flat_map(|l| p.apply(l, l.w, l.w)).collect();
    assert_eq!(last_telemetry(&ev), last_telemetry(&direct));
}

#[test]
fn provider_plays_the_fixture_as_fast_as_possible() {
    let (tx, rx) = std::sync::mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let p = Box::new(ReplayProvider::new(fixture(), 0.0, false));
    let diag = p.raw_diag().unwrap();
    let h = p.start(tx, stop.clone());
    let mut events = Vec::new();
    loop {
        let e = rx.recv_timeout(Duration::from_secs(30)).expect("replay ends");
        let end = matches!(&e, ProviderEvent::Disconnected { reason } if reason.starts_with("Replay beendet"));
        events.push(e);
        if end {
            break;
        }
    }
    stop.store(true, Ordering::Relaxed);
    h.join().unwrap();
    assert!(matches!(&events[1], ProviderEvent::Connected { sim_name, .. } if sim_name == "Replay mock-circuit.vsdump"));
    assert_eq!(touchdowns(&events).len(), 1);
    let d = diag.lock().unwrap().snapshot(now_ms());
    assert_eq!(d.source, "replay");
    assert!(d.defs[0].updates > 4_000);
    assert!((d.defs[0].rate_hz - 60.0).abs() < 1.0, "rate from recorded time: {}", d.defs[0].rate_hz);
}

#[test]
fn looping_keeps_the_clock_running() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("short.vsdump");
    let spec = MockDumpSpec { from_s: 10.0, to_s: 12.0, hz: 10.0, ..MockDumpSpec::final_and_landing() };
    let (h, lines) = mock_lines(&spec);
    write_dump(&path, &h, &lines, 3).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let handle = Box::new(ReplayProvider::new(&path, 0.0, true)).start(tx, stop.clone());
    let mut stamps = Vec::new();
    while stamps.len() < 60 {
        if let ProviderEvent::Telemetry(t) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            stamps.push(t.timestamp_ms);
        }
    }
    stop.store(true, Ordering::Relaxed);
    handle.join().unwrap();
    assert!(stamps.windows(2).all(|w| w[1] > w[0]), "monotonic across passes");
}

#[test]
fn config_from_env() {
    fn env(pairs: Vec<(&str, &str)>) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| pairs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
    }
    let c = ReplayConfig::from_lookup(env(vec![(ENV_REPLAY, "\"C:\\dumps\\a.vsdump\""), (ENV_REPLAY_SPEED, "10x"), (ENV_REPLAY_LOOP, "1")]));
    assert_eq!(c, ReplayConfig { path: Some(PathBuf::from("C:\\dumps\\a.vsdump")), speed: 10.0, loop_: true });
    let c = ReplayConfig::from_lookup(env(vec![(ENV_REPLAY_SPEED, "-3")]));
    assert_eq!(c, ReplayConfig::default());
    assert!(c.provider(vectasim_core::Lang::De).is_err(), "no file");
    assert_eq!(parse_speed("0"), Some(0.0));
    assert_eq!(parse_speed("0,5"), Some(0.5));
    assert_eq!(parse_speed("fast"), None);
}

/// An X-Plane dump (`source: "xplane"`, 10 Hz, deltas) goes through the X-Plane decoder; the
/// landing is found with the measured V/S (X-Plane has no touchdown value).
#[test]
fn xplane_dump_replays_through_the_xplane_decoder() {
    use vectasim_core::LandingRateSource;
    use vectasim_xplane::datarefs::{self as xp, N_SLOTS, REQ_NUM, offset};
    let mut header = vectasim_xplane::dump_header("X-Plane Web API localhost:8086");
    header.app = "test".into();
    header.sim = Some("X-Plane 12".into());
    header.sim_version = Some("12.1.4".into());
    let w0 = 1_760_000_000_000u64;
    let mut lines = vec![Line { t: 0, w: w0, body: Body::Open { sim: "X-Plane 12".into(), sim_version: "12.1.4".into(), simconnect: "Web API v2".into() } }];
    let mut first = vec![f64::NAN; N_SLOTS];
    for (var, x) in [
        (xp::NUM_ENGINES, 1.0),
        (xp::G, 1.0),
        (xp::SIM_SPEED, 1.0),
        (xp::PAUSED, 0.0),
        (xp::FLAP_DETENTS, 3.0),
        (xp::FLAP_HANDLE, 1.0),
        (xp::GEAR, 1.0),
        (xp::ENG_RUNNING, 1.0),
        (xp::FUEL, 100.0),
        (xp::WEIGHT, 1000.0),
    ] {
        first[offset(var)] = x;
    }
    // 60 s final at −600 fpm from 600 ft AGL, then 25 s rollout; 10 Hz
    for i in 0..850u64 {
        let s = i as f64 / 10.0;
        let mut v = if i == 0 { first.clone() } else { vec![f64::NAN; N_SLOTS] };
        let air = s < 60.0;
        let agl_ft = if air { 600.0 - s * 10.0 } else { 0.0 };
        let gs_kt = if air { 65.0 } else { (65.0 - (s - 60.0) * 3.0).max(0.0) };
        v[offset(xp::LAT)] = 50.0 + s * 0.0003;
        v[offset(xp::LON)] = 8.5;
        v[offset(xp::ELEV)] = (100.0 + agl_ft) / 3.280_839_895;
        v[offset(xp::AGL)] = agl_ft / 3.280_839_895;
        v[offset(xp::IAS)] = gs_kt;
        v[offset(xp::GS)] = gs_kt / 1.943_844_492;
        v[offset(xp::VS)] = if air { -600.0 } else { 0.0 };
        v[offset(xp::ON_GROUND)] = if air { 0.0 } else { 1.0 };
        v[offset(xp::ZULU)] = 40_000.0 + s;
        lines.push(Line { t: 100 * i + 1, w: w0 + 100 * i + 1, body: Body::data_f64(REQ_NUM, &v, None) });
    }
    lines.push(Line { t: 90_000, w: w0 + 90_000, body: Body::End { reason: "stopped".into() } });
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("xp.vsdump");
    let mut text = serde_json::to_string(&header).unwrap() + "\n";
    for l in &lines {
        text += &(serde_json::to_string(l).unwrap() + "\n");
    }
    std::fs::write(&path, text).unwrap();

    let (events, err) = replay_file(&path).unwrap();
    assert!(err.is_none());
    assert!(matches!(&events[0], ProviderEvent::Connected { sim_version, .. } if sim_version == "12.1.4"));
    let tele: Vec<&Telemetry> = events.iter().filter_map(|e| if let ProviderEvent::Telemetry(t) = e { Some(&**t) } else { None }).collect();
    assert_eq!(tele.len(), 850);
    assert!(tele.iter().all(|t| t.num_engines == 1 && t.flaps_index == 3 && t.gear_pct == 100.0), "deltas keep the first values");
    let tds = touchdowns(&events);
    assert_eq!(tds.len(), 1, "{tds:?}");
    assert_eq!(tds[0].landing_rate_source, LandingRateSource::Measured);
    assert!((tds[0].landing_rate_fpm + 600.0).abs() < 1.0, "{}", tds[0].landing_rate_fpm);
}

#[test]
fn end_of_replay_in_the_chosen_language() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("short.vsdump");
    let spec = MockDumpSpec { from_s: 10.0, to_s: 11.0, hz: 10.0, ..MockDumpSpec::final_and_landing() };
    let (h, lines) = mock_lines(&spec);
    write_dump(&path, &h, &lines, 3).unwrap();
    let cfg = ReplayConfig { path: Some(path), speed: 0.0, loop_: false };
    let (tx, rx) = std::sync::mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let handle = Box::new(cfg.provider(Lang::En).unwrap()).start(tx, stop.clone());
    let reason = loop {
        // the dump's own end line comes first ("mock: end of dump")
        if let ProviderEvent::Disconnected { reason } = rx.recv_timeout(Duration::from_secs(10)).unwrap()
            && reason.starts_with("Replay")
        {
            break reason;
        }
    };
    stop.store(true, Ordering::Relaxed);
    handle.join().unwrap();
    assert!(reason.starts_with("Replay finished (short.vsdump, "), "{reason}");
    assert!(reason.ends_with(" records)"), "{reason}");
    assert_eq!(ReplayConfig::default().provider(Lang::En).err().as_deref(), Some("Replay: no file chosen (set VECTASIM_REPLAY)"));
}
