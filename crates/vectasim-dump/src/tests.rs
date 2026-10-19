use super::*;
use std::time::{Duration, Instant};

fn header() -> Header {
    let defs = Defs {
        fast: vec![("PLANE LATITUDE".into(), "degrees".into()), ("SIM ON GROUND".into(), "bool".into())],
        slow: vec![("TOTAL WEIGHT".into(), "pounds".into())],
        statics: vec!["TITLE".into()],
        ..Default::default()
    };
    let reqs = [("fast".to_string(), 1), ("slow".to_string(), 2), ("static".to_string(), 3)].into_iter().collect();
    Header::new("", "simconnect", defs, reqs)
}

fn data(v: &[f64]) -> Body {
    Body::data_f64(1, v, None)
}

#[test]
fn lines_round_trip_including_nan() {
    let lines = [
        Line { t: 1, w: 2, body: data(&[50.0451, f64::NAN, -0.5]) },
        Line { t: 3, w: 4, body: Body::data_str(3, vec!["A320".into()], Some(260)) },
        Line { t: 5, w: 6, body: Body::Event { id: "Pause".into(), data: 1 } },
        Line { t: 7, w: 8, body: Body::Filename { id: "FlightLoaded".into(), path: "C:\\a.FLT".into() } },
        Line {
            t: 9,
            w: 10,
            body: Body::Exception {
                code: 7,
                send_id: 12,
                index: 1,
                call: Some("AddToDataDefinition(SLOW, \"LIGHT TAXI\")".into()),
                def: Some("slow".into()),
                var: Some("LIGHT TAXI".into()),
                dropped: true,
            },
        },
        Line { t: 11, w: 12, body: Body::Open { sim: "KittyHawk".into(), sim_version: "11.0.1.2".into(), simconnect: "11.0.3.4".into() } },
        Line { t: 13, w: 14, body: Body::Quit },
        Line { t: 15, w: 16, body: Body::Hr { func: "GetNextDispatch".into(), hr: hr_hex(0xC000_014B_u32 as i32) } },
        Line { t: 17, w: 18, body: Body::SystemState { req: 100, int: 1 } },
        Line { t: 19, w: 20, body: Body::End { reason: "simulator quit".into() } },
    ];
    for l in &lines {
        let s = serde_json::to_string(l).unwrap();
        let back: Line = serde_json::from_str(&s).unwrap();
        assert_eq!(&back, l, "{s}");
    }
    let s = serde_json::to_string(&Line { t: 1, w: 2, body: data(&[50.0451, f64::NAN, f64::INFINITY]) }).unwrap();
    assert_eq!(s, r#"{"t":1,"w":2,"k":"data","req":1,"v":[50.0451,null,null]}"#);
    let back: Line = serde_json::from_str(&s).unwrap();
    assert_eq!(back.body, data(&[50.0451, f64::NAN, f64::NAN]), "inf is not representable: reads back as NaN");
    assert!(serde_json::to_string(&lines[4]).unwrap().contains(r#""sendId":12"#));
    assert!(serde_json::to_string(&lines[7]).unwrap().contains(r#""fn":"GetNextDispatch","hr":"0xC000014B""#));
    assert!(serde_json::to_string(&lines[8]).unwrap().contains(r#""k":"systemState""#));
    assert_eq!(parse_hr("0xC000014B"), Some(0xC000_014B_u32 as i32));
    assert_eq!(parse_hr("-2147467259"), Some(0x8000_4005_u32 as i32));
}

#[test]
fn header_uses_documented_field_names() {
    let mut h = header();
    h.inactive.insert("fast".into(), vec![1]);
    let s = serde_json::to_string(&h).unwrap();
    for key in [r#""type":"header""#, r#""format":1"#, r#""static":["TITLE"]"#, r#""startedWallMs""#, r#""inactive":{"fast":[1]}"#] {
        assert!(s.contains(key), "{key} in {s}");
    }
    assert_eq!(serde_json::from_str::<Header>(&s).unwrap(), h);
}

#[test]
fn session_file_is_written_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let rec = DumpRecorder::new("9.9.9", RingConfig::default());
    rec.set_target(FileTarget::Dir(dir.path().to_path_buf()));
    rec.begin_session(header());
    let t0 = Instant::now();
    rec.record(t0, 1_760_000_000_000, Body::Open { sim: "KittyHawk".into(), sim_version: "11".into(), simconnect: "11".into() });
    for i in 0..100u64 {
        rec.record(t0 + Duration::from_millis(16 * i), 1_760_000_000_000 + 16 * i, data(&[i as f64, 1.0]));
    }
    let st = rec.status();
    assert!(st.enabled);
    let file = std::path::PathBuf::from(st.file.expect("file open"));
    assert!(file.file_name().unwrap().to_string_lossy().ends_with("Z.vsdump"), "{file:?}");
    rec.record(t0 + Duration::from_secs(2), 1_760_000_002_000, Body::End { reason: "simulator quit".into() });
    rec.end_session();
    assert_eq!(rec.status().file, None, "per-session file closed with the session");

    let (h, lines, err) = read_all(&file).unwrap();
    assert!(err.is_none());
    assert_eq!(h.app, "9.9.9");
    assert_eq!(h.defs, header().defs);
    assert_eq!(lines.len(), 102);
    assert!(matches!(lines[0].body, Body::Open { .. }));
    assert_eq!(lines[50].body, data(&[49.0, 1.0]));
    assert!(lines.windows(2).all(|w| w[0].t <= w[1].t));
}

#[test]
fn switching_off_closes_and_next_session_gets_a_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let rec = DumpRecorder::new("1", RingConfig::default());
    rec.begin_session(header());
    let now = Instant::now();
    rec.record(now, 1_000, data(&[1.0, 0.0]));
    assert_eq!(rec.status().file, None, "off by default");
    rec.set_target(FileTarget::Dir(dir.path().to_path_buf()));
    rec.record(now, 1_000, data(&[2.0, 0.0]));
    assert_eq!(rec.status().file, None, "waits for OPEN so the header can name the sim");
    rec.update_header(|h| h.sim = Some("KittyHawk".into()));
    rec.record(now, 1_000, Body::Open { sim: "KittyHawk".into(), sim_version: "11".into(), simconnect: "11".into() });
    let first = rec.status().file.unwrap();
    rec.set_target(FileTarget::Off);
    assert_eq!(rec.status().file, None);
    let (h, lines, _) = read_all(std::path::Path::new(&first)).unwrap();
    assert_eq!(h.sim.as_deref(), Some("KittyHawk"));
    assert_eq!(lines.len(), 2, "only what was recorded while on (held back until OPEN)");
    assert_eq!(lines[0].body, data(&[2.0, 0.0]));
}

#[test]
fn truncated_file_yields_lines_up_to_the_cut() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cut.vsdump");
    let rec = DumpRecorder::new("1", RingConfig::default());
    rec.set_target(FileTarget::Path(path.clone()));
    rec.begin_session(header());
    let now = Instant::now();
    for i in 0..2_000u64 {
        rec.record(now, i, data(&[i as f64 * 0.001, 0.0]));
        if i % 100 == 99 {
            rec.flush(); // as the 1-s flush does while flying
        }
    }
    rec.flush_and_close();
    let full = std::fs::read(&path).unwrap();
    std::fs::write(&path, &full[..full.len() * 2 / 3]).unwrap();
    let (_, lines, err) = read_all(&path).unwrap();
    assert!(err.is_some(), "the cut is reported");
    assert!(lines.len() > 100 && lines.len() < 2_000, "{}", lines.len());
    assert!(lines.iter().enumerate().all(|(i, l)| l.w == i as u64));
}

#[test]
fn ring_keeps_the_last_30_minutes_and_dumps_as_one_file() {
    let cfg = RingConfig { max_age_ms: 30 * 60_000, max_bytes: 64 * 1024 * 1024, chunk_ms: 60_000 };
    let rec = DumpRecorder::new("1", cfg);
    let mut h = header();
    h.inactive.insert("fast".into(), vec![1]);
    rec.begin_session(h);
    let t0 = Instant::now();
    // 40 minutes at 2 Hz
    for i in 0..(40 * 60 * 2u64) {
        rec.record(t0 + Duration::from_millis(500 * i), 10_000 + 500 * i, data(&[i as f64]));
    }
    let st = rec.status();
    assert!((29.0 * 60.0..=31.0 * 60.0).contains(&st.ring_seconds), "{}", st.ring_seconds);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ring.vsdump");
    let n = rec.dump_ring(&path).unwrap();
    let (h, lines, err) = read_all(&path).unwrap();
    assert!(err.is_none());
    assert_eq!(lines.len() as u64, n);
    assert_eq!(h.inactive.get("fast"), Some(&vec![1]), "header of the oldest retained chunk");
    let last = lines.last().unwrap();
    assert_eq!(last.body, data(&[(40 * 60 * 2 - 1) as f64]));
    assert!(lines.windows(2).all(|w| w[1].t == w[0].t + 500), "contiguous");
}

#[test]
fn ring_respects_the_byte_cap() {
    let cfg = RingConfig { max_age_ms: u64::MAX / 4, max_bytes: 200_000, chunk_ms: 10_000 };
    let rec = DumpRecorder::new("1", cfg);
    rec.begin_session(header());
    let t0 = Instant::now();
    let mut x = 0.123_456_789_f64;
    for i in 0..200_000u64 {
        x = (x * 3.999 * (1.0 - x)).clamp(0.0, 1.0); // incompressible-ish values
        rec.record(t0 + Duration::from_millis(16 * i), i, data(&[x, x * 7.0]));
    }
    let st = rec.status();
    assert!(st.ring_bytes <= 200_000, "{}", st.ring_bytes);
    assert!(st.ring_seconds > 10.0);
}

#[test]
fn dump_ring_without_data_is_an_error() {
    let rec = DumpRecorder::new("1", RingConfig::default());
    let dir = tempfile::tempdir().unwrap();
    assert!(rec.dump_ring(&dir.path().join("x.vsdump")).is_err());
}

#[test]
fn plain_ndjson_is_accepted() {
    let text = format!("{}\n{}\n", serde_json::to_string(&header()).unwrap(), r#"{"t":0,"w":5,"k":"quit"}"#);
    let r = DumpReader::from_reader(std::io::Cursor::new(text.into_bytes())).unwrap();
    let lines: Vec<Line> = r.map(Result::unwrap).collect();
    assert_eq!(lines, vec![Line { t: 0, w: 5, body: Body::Quit }]);
}

#[test]
fn file_stamp_is_utc() {
    assert_eq!(file_stamp(0), "19700101-000000Z");
    assert_eq!(file_stamp(1_760_745_802_000), "20251018-000322Z");
    assert_eq!(file_stamp(951_782_400_000), "20000229-000000Z");
}

#[test]
fn delta_lines_restore_exact_values_and_keyframe_every_second() {
    use crate::delta::{DeltaDecoder, DeltaEncoder, KEYFRAME_MS};
    let mut enc = DeltaEncoder::default();
    let mut dec = DeltaDecoder::default();
    let mut keyframes = 0;
    for i in 0..300u64 {
        let x = 50.0 + i as f64 * 3.3e-6 + (i as f64).sin() * 1e-9;
        let odd = if i % 50 == 7 { f64::INFINITY } else { -0.0 };
        let line = Line { t: i * 16, w: i, body: data(&[x, odd, f64::NAN, 1e-300 * i as f64]) };
        let wire = enc.encode(&line);
        let text = serde_json::to_string(&wire).unwrap();
        if let Body::Data { v, dv, .. } = &wire.body {
            assert!(v.is_empty() != dv.is_empty());
            keyframes += usize::from(!v.is_empty());
        }
        let back = dec.decode(serde_json::from_str(&text).unwrap()).unwrap();
        let Body::Data { v, .. } = &back.body else { panic!() };
        assert_eq!(v[0].0.to_bits(), x.to_bits(), "exact bits");
        assert!(if odd.is_finite() { v[1].0.to_bits() == odd.to_bits() } else { v[1].0.is_nan() });
        assert!(v[2].0.is_nan());
    }
    let expected = (300 * 16) as u64 / KEYFRAME_MS + 1;
    assert_eq!(keyframes as u64, expected);
    // a delta without a keyframe is an error, not garbage
    let mut fresh = DeltaDecoder::default();
    let orphan = Line { t: 0, w: 0, body: Body::Data { req: 1, v: vec![], dv: vec![1, 2], s: vec![], bytes: None } };
    assert!(fresh.decode(orphan).is_err());
}
