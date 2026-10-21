//! After a crash: merging an interrupted flight with the one that followed, resume offers,
//! and the recorder continuing an interrupted flight.

use vectasim_core::flight::GeoPoint;
use vectasim_core::{
    FlightEvent, FlightPhase, FlightSession, FlightState, FlightSummary, LandingRateSource, MockFlight, MockVariant, PhaseTransition, Telemetry,
    TouchdownReport,
};
use vectasim_store::store::LandingFactCache;
use vectasim_store::{ApproachFactRow, FlightRecorder, RecorderContext, SCHEMA_VERSION, Store, StoreError};

const T0: u64 = 1_700_000_000_000;
const MIN: u64 = 60_000;
/// Degrees of latitude per nm.
const DEG_PER_NM: f64 = 1.0 / 60.0;

fn tele(ts: u64, lat: f64, lon: f64, alt: f64) -> Telemetry {
    Telemetry {
        timestamp_ms: ts,
        latitude: lat,
        longitude: lon,
        altitude_msl_ft: alt,
        altitude_agl_ft: alt - 364.0,
        ground_speed_kt: 120.0,
        ..Default::default()
    }
}

fn touchdown(ts: u64, lat: f64, lon: f64) -> TouchdownReport {
    TouchdownReport {
        timestamp_ms: ts,
        vs_fpm_measured: -150.0,
        vs_fpm_sim: -140.0,
        vs_fpm_hardest: -150.0,
        peak_g: 1.2,
        pitch_deg: 3.0,
        bank_deg: 0.0,
        ground_speed_kt: 130.0,
        heading_true_deg: 250.0,
        latitude: lat,
        longitude: lon,
        bounces: 0,
        touch_and_go: false,
        landing_rate_fpm: -140.0,
        landing_rate_source: LandingRateSource::Sim,
    }
}

struct Leg {
    provider: &'static str,
    start_ms: u64,
    lat0: f64,
    /// Northbound at 2 nm per minute.
    secs: u64,
    alt: f64,
    interrupted: bool,
    landing: bool,
}

/// Record one synthetic flight through the recorder (1 Hz, northbound, 2 nm/min); returns its id.
fn record(store: &Store, leg: &Leg) -> String {
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: leg.provider.into(), ..Default::default() });
    let lon = 8.57;
    let pos = |i: u64| leg.lat0 + i as f64 * 2.0 / 60.0 * DEG_PER_NM;
    let mut s = FlightSummary {
        state: FlightState::Active,
        phase: FlightPhase::Climb,
        off_block_ms: Some(leg.start_ms),
        takeoff_ms: Some(leg.start_ms + 60_000),
        departure: Some(GeoPoint { latitude: leg.lat0, longitude: lon }),
        max_altitude_msl_ft: leg.alt,
        fuel_start_kg: Some(5_000.0),
        ..Default::default()
    };
    s.integrity.max_sim_rate = 1.0;
    let first = tele(leg.start_ms, pos(0), lon, leg.alt);
    rec.on_telemetry(&first, &s, &[FlightEvent::FlightStarted { timestamp_ms: leg.start_ms }]).unwrap();
    let id = rec.current_flight_id().unwrap().to_owned();
    for i in 1..=leg.secs {
        let ts = leg.start_ms + i * 1000;
        s.distance_nm = i as f64 * 2.0 / 60.0;
        let t = tele(ts, pos(i), lon, leg.alt);
        let mut events = Vec::new();
        if i == 5 {
            events.push(FlightEvent::PhaseChanged(Box::new(PhaseTransition {
                from: FlightPhase::Climb,
                to: FlightPhase::Cruise,
                timestamp_ms: ts,
                telemetry: t.clone(),
            })));
        }
        if leg.landing && i == leg.secs - 10 {
            s.landing_ms = Some(ts);
            s.arrival = Some(GeoPoint { latitude: pos(i), longitude: lon });
            events.push(FlightEvent::Touchdown(touchdown(ts, pos(i), lon)));
        }
        rec.on_telemetry(&t, &s, &events).unwrap();
    }
    let end = leg.start_ms + leg.secs * 1000;
    if leg.interrupted {
        s.state = FlightState::Interrupted;
    } else {
        s.state = FlightState::Completed;
        s.on_block_ms = Some(end);
        s.fuel_end_kg = Some(4_200.0);
    }
    rec.on_events(&s, &[FlightEvent::FlightEnded { timestamp_ms: end, interrupted: leg.interrupted }], end).unwrap();
    id
}

/// First leg: 20 min at FL300, interrupted.
fn first_leg() -> Leg {
    Leg { provider: "simconnect", start_ms: T0, lat0: 50.0, secs: 1_200, alt: 30_000.0, interrupted: true, landing: false }
}

/// Second leg continuing the first after `gap_ms`, `offset_nm` further north.
fn second_leg(gap_ms: u64, offset_nm: f64) -> Leg {
    let a = first_leg();
    let end_lat = a.lat0 + a.secs as f64 * 2.0 / 60.0 * DEG_PER_NM;
    Leg {
        start_ms: a.start_ms + a.secs * 1000 + gap_ms,
        lat0: end_lat + offset_nm * DEG_PER_NM,
        secs: 900,
        interrupted: false,
        landing: true,
        ..a
    }
}

fn fact() -> LandingFactCache {
    LandingFactCache {
        version: 1,
        matched: true,
        airport_icao: Some("EDDF".into()),
        runway_ident: Some("25C".into()),
        ..Default::default()
    }
}

#[test]
fn merge_joins_two_flights_and_trashes_the_second() {
    let store = Store::open_in_memory().unwrap();
    let a = record(&store, &first_leg());
    let b = record(&store, &second_leg(8 * MIN, 1.0));
    // cached facts of both are stale after the merge
    assert!(store.put_landing_fact(&b, 0, &fact()).unwrap());
    assert!(store.put_approach_facts(&a, 1, &[ApproachFactRow { outcome: "landed".into(), ..Default::default() }]).unwrap());
    let before_a = store.get_flight(&a).unwrap().unwrap();
    let before_b = store.get_flight(&b).unwrap().unwrap();
    let samples_a = store.get_track(&a).unwrap().unwrap().len();
    let samples_b = store.get_track(&b).unwrap().unwrap().len();

    let candidates = store.list_merge_candidates().unwrap();
    assert_eq!(candidates.len(), 1, "{candidates:?}");
    assert_eq!((candidates[0].first.id.as_str(), candidates[0].second.id.as_str()), (a.as_str(), b.as_str()));
    assert!((candidates[0].gap_ms as i64 - 8 * MIN as i64).abs() <= 1_000, "{}", candidates[0].gap_ms);
    assert!((candidates[0].distance_nm - 1.0).abs() < 0.1, "{}", candidates[0].distance_nm);

    let report = store.merge_flights_at(&a, &b, T0 + 3 * 3_600_000).unwrap();
    assert_eq!((report.flight_id.as_str(), report.removed_id.as_str()), (a.as_str(), b.as_str()));
    assert_eq!(report.sample_count, samples_a + samples_b);

    let m = store.get_flight(&a).unwrap().unwrap();
    let f = &m.flight;
    assert_eq!(f.state, "completed");
    assert_eq!(f.off_block_ms, before_a.flight.off_block_ms);
    assert_eq!(f.takeoff_ms, before_a.flight.takeoff_ms);
    assert_eq!((f.landing_ms, f.on_block_ms), (before_b.flight.landing_ms, before_b.flight.on_block_ms));
    assert_eq!((f.arr_lat, f.dep_lat), (before_b.flight.arr_lat, before_a.flight.dep_lat));
    assert!((f.distance_nm - (before_a.flight.distance_nm + before_b.flight.distance_nm)).abs() < 1e-9);
    assert_eq!((f.fuel_start_kg, f.fuel_end_kg), (Some(5_000.0), Some(4_200.0)));
    assert_eq!(f.integrity.gap_ms, report.gap_ms);
    assert!((report.gap_ms as i64 - 8 * MIN as i64).abs() <= 1_000);
    assert_eq!((f.landing_count, m.touchdowns.len()), (1, 1));
    assert_eq!(m.phases.len(), before_a.phases.len() + before_b.phases.len());
    let track = store.get_track(&a).unwrap().unwrap();
    assert_eq!(track.len(), samples_a + samples_b);
    assert!(track.windows(2).all(|w| w[0].t_ms <= w[1].t_ms));
    assert_eq!(store.get_track_preview(&a).unwrap().unwrap().last().map(|s| s.t_ms), track.last().map(|s| s.t_ms));

    // the second flight is in the Papierkorb, complete, and the merged one is all that is left
    let list = store.list_flights(10, 0).unwrap();
    assert_eq!(list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [a.as_str()]);
    let trash = store.list_deleted_flights().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!((trash[0].flight.id.as_str(), trash[0].flight.landing_count), (b.as_str(), 1));
    assert_eq!(store.get_track(&b).unwrap().unwrap().len(), samples_b);
    // facts dropped: recomputed lazily
    assert!(store.approach_facts_for_flight(&a).unwrap().is_empty());
    let landings = store.recent_landings(10, true).unwrap();
    assert_eq!(landings.len(), 1);
    assert_eq!((landings[0].flight.id.as_str(), landings[0].cached.as_ref()), (a.as_str(), None));
    // totals count the landing once
    assert_eq!(store.totals().unwrap().landings, 1);
    assert!(store.list_merge_candidates().unwrap().is_empty());
}

#[test]
fn resumed_summary_leaves_an_unrated_landing_out() {
    // the summary for resuming a flight took the last full stop's 0 fpm even when it was
    // unrated (slewed / fast-forwarded down): live view, overlay and Discord showed "0 fpm"
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "simconnect".into(), ..Default::default() });
    let s = FlightSummary { state: FlightState::Active, phase: FlightPhase::Final, off_block_ms: Some(T0), ..Default::default() };
    let t = tele(T0, 50.0, 8.0, 400.0);
    rec.on_telemetry(&t, &s, &[FlightEvent::FlightStarted { timestamp_ms: T0 }]).unwrap();
    let id = rec.current_flight_id().unwrap().to_owned();
    let unrated = TouchdownReport { landing_rate_fpm: 0.0, landing_rate_source: LandingRateSource::Unrated, ..touchdown(T0 + 5_000, 50.0, 8.0) };
    rec.on_telemetry(&tele(T0 + 5_000, 50.0, 8.0, 364.0), &s, &[FlightEvent::Touchdown(unrated)]).unwrap();
    let end = T0 + 10_000;
    rec.on_events(&FlightSummary { state: FlightState::Interrupted, ..s.clone() }, &[FlightEvent::FlightEnded { timestamp_ms: end, interrupted: true }], end)
        .unwrap();
    let sum = store.flight_summary(&id).unwrap().unwrap();
    assert_eq!(sum.touchdowns.len(), 1);
    assert_eq!(sum.landing_rate_fpm, None, "an unrated touchdown is no landing rate");
}

#[test]
fn merge_refuses_what_is_not_one_flight() {
    let store = Store::open_in_memory().unwrap();
    let a = record(&store, &first_leg());
    let far = record(&store, &second_leg(5 * MIN, 8.0));
    let err = store.merge_flights(&a, &far).unwrap_err();
    assert!(matches!(&err, StoreError::Invalid(m) if m.to_string().contains("nm auseinander")), "{err}");
    assert!(store.list_merge_candidates().unwrap().is_empty());

    let store = Store::open_in_memory().unwrap();
    let a = record(&store, &first_leg());
    let late = record(&store, &second_leg(75 * MIN, 0.5));
    let err = store.merge_flights(&a, &late).unwrap_err();
    assert!(matches!(&err, StoreError::Invalid(m) if m.to_string().contains("60 min")), "{err}");
    // the wrong way round: the first flight must be the interrupted one
    let err = store.merge_flights(&late, &a).unwrap_err();
    assert!(matches!(&err, StoreError::Invalid(m) if m.to_string().contains("unterbrochen")), "{err}");
    assert!(store.merge_flights(&a, &a).is_err());
    assert!(store.merge_flights(&a, "nope").is_err());
    // nothing changed
    assert_eq!(store.list_flights(10, 0).unwrap().len(), 2);
    assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.integrity.gap_ms, 0);
}

#[test]
fn resume_candidate_needs_a_recent_close_position() {
    let store = Store::open_in_memory().unwrap();
    let a = record(&store, &first_leg());
    let last = store.get_track(&a).unwrap().unwrap().last().cloned().unwrap();
    let at = |dt_ms: u64, dnm: f64, dalt: f64| {
        store.resume_candidate(last.latitude + dnm * DEG_PER_NM, last.longitude, last.altitude_msl_ft + dalt, last.t_ms + dt_ms).unwrap()
    };

    let c = at(10 * MIN, 2.0, 500.0).expect("10 min, 2 nm, +500 ft");
    assert_eq!(c.flight_id, a);
    assert!((c.distance_nm - 2.0).abs() < 0.05 && (c.alt_diff_ft - 500.0).abs() < 1.0, "{c:?}");
    assert_eq!(c.last_ms, last.t_ms);
    assert!(at(29 * MIN, 4.9, -2_900.0).is_some());
    assert!(at(31 * MIN, 0.0, 0.0).is_none(), "too old");
    assert!(at(MIN, 5.5, 0.0).is_none(), "too far");
    assert!(at(MIN, 0.0, 3_500.0).is_none(), "too high");

    // a demo flight is never offered
    let store = Store::open_in_memory().unwrap();
    let demo = record(&store, &Leg { provider: "mock", ..first_leg() });
    assert!(!demo.is_empty());
    assert!(store.resume_candidate(last.latitude, last.longitude, last.altitude_msl_ft, last.t_ms + MIN).unwrap().is_none());
}

#[test]
fn migration_v13_adds_gap_ms_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    const { assert!(SCHEMA_VERSION >= 13) };
    let a = {
        let store = Store::open(&path).unwrap();
        record(&store, &first_leg())
    };
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("ALTER TABLE flights DROP COLUMN gap_ms; UPDATE schema_version SET version = 12;").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.integrity.gap_ms, 0);
    }
    // column there, version number rolled back: migrates again without touching it
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE flights SET gap_ms = 42", []).unwrap();
    conn.execute("UPDATE schema_version SET version = 12", []).unwrap();
    drop(conn);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.integrity.gap_ms, 42);
}

/// What the app's forwarder does on "Fortsetzen".
fn resume(store: &Store, session: &mut FlightSession, rec: &mut FlightRecorder, id: &str, now_ms: u64) -> u64 {
    let prev = store.flight_summary(id).unwrap().unwrap();
    let last_old = store.get_track_preview(id).unwrap().unwrap().last().unwrap().t_ms;
    let first_new = match rec.current_flight_id() {
        Some(_) => rec.live_track().lock().unwrap().first().map_or(now_ms, |s| s.t_ms),
        None => now_ms,
    };
    let gap = first_new - last_old;
    let resumed = session.preview_resume(&prev, gap);
    rec.resume(id, &resumed, now_ms).unwrap();
    session.resume_from(&prev, gap);
    gap
}

fn mock_recorder(store: &Store) -> FlightRecorder {
    FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "simconnect".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    )
}

/// The app died 200 s into the mock circuit (downwind); 2 min later it is back, the aircraft flew on
/// (a new flight started with the first sample), the pilot resumes: one flight, one landing.
#[test]
fn resume_after_restart_appends_to_the_interrupted_flight() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    const HZ: f64 = 4.0;
    const CUT_S: f64 = 200.0;
    const GAP_MS: u64 = 120_000;
    let (a, samples_a) = {
        let store = Store::open(&path).unwrap();
        let (mut flight, mut session, mut rec) = (MockFlight::with_variant(MockVariant::Circuit), FlightSession::new(), mock_recorder(&store));
        for i in 1..=(CUT_S * HZ) as u64 {
            let t_s = i as f64 / HZ;
            let t = flight.sample(t_s, T0 + (t_s * 1000.0) as u64);
            let ev = session.update(&t);
            rec.on_telemetry(&t, session.summary(), &ev).unwrap();
        }
        let id = rec.current_flight_id().unwrap().to_owned();
        // a hard close: only the 15 s flushes made it, the row stays 'active'
        let n = store.get_track(&id).unwrap().unwrap().len();
        (id, n)
    };
    // restart: the open flight is marked interrupted
    let store = Store::open(&path).unwrap();
    assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.state, "interrupted");
    let before = store.get_flight(&a).unwrap().unwrap().flight;

    let (mut flight, mut session, mut rec) = (MockFlight::with_variant(MockVariant::Circuit), FlightSession::new(), mock_recorder(&store));
    let ts = |t_s: f64| T0 + (t_s * 1000.0) as u64 + GAP_MS;
    let mut t_s = CUT_S;
    let mut step = |session: &mut FlightSession, rec: &mut FlightRecorder, t_s: f64| {
        let t = flight.sample(t_s, ts(t_s));
        let ev = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &ev).unwrap();
        t
    };
    // the first samples after the restart: airborne, so a new flight starts at once
    let mut first = None;
    for _ in 0..20 {
        t_s += 1.0 / HZ;
        let t = step(&mut session, &mut rec, t_s);
        first.get_or_insert(t);
    }
    let first = first.unwrap();
    let interim = rec.current_flight_id().expect("new flight after the restart").to_owned();
    let offer = store.resume_candidate(first.latitude, first.longitude, first.altitude_msl_ft, first.timestamp_ms).unwrap().expect("offer");
    assert_eq!(offer.flight_id, a);

    let gap = resume(&store, &mut session, &mut rec, &a, ts(t_s));
    // the track only has what the 15 s flushes wrote before the hard close: that tail counts as gap
    assert!((GAP_MS..=GAP_MS + 16_000).contains(&gap), "{gap}");
    assert_eq!(rec.current_flight_id(), Some(a.as_str()));
    assert_eq!(session.summary().off_block_ms, before.off_block_ms);
    assert_eq!(session.summary().takeoff_ms, before.takeoff_ms);
    assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.state, "active");

    // fly the rest of the circuit
    let end = MockVariant::Circuit.loop_seconds() + 10.0;
    while t_s < end {
        t_s += 1.0 / HZ;
        step(&mut session, &mut rec, t_s);
    }
    let list = store.list_flights(10, 0).unwrap();
    assert_eq!(list.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), [a.as_str()], "one flight");
    let f = &list[0];
    assert_eq!((f.state.as_str(), f.landing_count), ("completed", 1));
    assert_eq!(f.off_block_ms, before.off_block_ms);
    assert_eq!(f.takeoff_ms, before.takeoff_ms);
    assert!(f.landing_ms.is_some() && f.on_block_ms.is_some());
    assert_eq!(f.integrity.gap_ms, gap);
    assert!(f.distance_nm > before.distance_nm + 3.0, "{} vs {}", f.distance_nm, before.distance_nm);
    let track = store.get_track(&a).unwrap().unwrap();
    assert!(track.len() > samples_a + 250, "{} samples", track.len());
    assert!(track.windows(2).all(|w| w[0].t_ms <= w[1].t_ms));
    // the flight started after the restart went to the Papierkorb
    let trash = store.list_deleted_flights().unwrap();
    assert_eq!(trash.iter().map(|d| d.flight.id.as_str()).collect::<Vec<_>>(), [interim.as_str()]);
}

/// Crash while taxiing in after the landing: after the restart the aircraft rolls on before the
/// engine left Preflight; resuming must not start a second flight when it does. (A crash while
/// taxiing *out* leaves a ground session: discarded on the next open, nothing to resume – see
/// `store_tests::crash_during_a_ground_session_is_discarded_on_open`.)
#[test]
fn resume_before_the_engine_left_the_blocks_keeps_one_flight() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.db");
    let store = Store::open(&path).unwrap();
    const HZ: f64 = 4.0;
    let (mut flight, mut session, mut rec) = (MockFlight::with_variant(MockVariant::Circuit), FlightSession::new(), mock_recorder(&store));
    let mut cut = None;
    for i in 1..=(MockVariant::Circuit.loop_seconds() * HZ) as u64 {
        let t_s = i as f64 / HZ;
        let t = flight.sample(t_s, T0 + (t_s * 1000.0) as u64);
        let ev = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &ev).unwrap();
        if rec.current_flight_id().is_some() && t.ground_speed_kt > 5.0 && t.on_ground && session.summary().landing_ms.is_some() {
            cut = Some(t_s);
            break;
        }
    }
    let cut = cut.expect("taxiing in with the flight open");
    let a = rec.current_flight_id().unwrap().to_owned();
    // the app crashes: what was flushed stays, the row is still `active` and becomes
    // `interrupted` on the next open
    rec.checkpoint(session.summary(), T0 + (cut * 1000.0) as u64).unwrap();
    drop((rec, store));
    let store = Store::open(&path).unwrap();
    assert_eq!(store.get_flight(&a).unwrap().unwrap().flight.state, "interrupted");

    // new session: one sample, still Preflight (dwell not reached), then resume
    let (mut flight, mut session, mut rec) = (MockFlight::with_variant(MockVariant::Circuit), FlightSession::new(), mock_recorder(&store));
    let ts = |t_s: f64| T0 + (t_s * 1000.0) as u64 + 30_000;
    let mut t_s = cut + 0.25;
    let t = flight.sample(t_s, ts(t_s));
    let ev = session.update(&t);
    rec.on_telemetry(&t, session.summary(), &ev).unwrap();
    assert!(rec.current_flight_id().is_none());
    resume(&store, &mut session, &mut rec, &a, ts(t_s));
    let mut started = 0;
    while t_s < MockVariant::Circuit.loop_seconds() + 10.0 {
        t_s += 1.0 / HZ;
        let t = flight.sample(t_s, ts(t_s));
        let ev = session.update(&t);
        started += ev.iter().filter(|e| matches!(e, FlightEvent::FlightStarted { .. })).count();
        rec.on_telemetry(&t, session.summary(), &ev).unwrap();
    }
    assert_eq!(started, 0, "the resumed flight rolls on");
    let list = store.list_flights(10, 0).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].id.as_str(), list[0].state.as_str(), list[0].landing_count), (a.as_str(), "completed", 1));
    assert!(list[0].integrity.gap_ms >= 30_000, "{}", list[0].integrity.gap_ms);
}

/// `VECTASIM_MOCK=teleport`: the reload at the stand interrupts the flight, the next loop starts
/// a new one there: the logbook offers to merge them (the manual test path for the UI).
#[test]
fn mock_teleport_pair_and_merge_candidate() {
    use vectasim_core::ProviderEvent;
    let store = Store::open_in_memory().unwrap();
    let (mut flight, mut session, mut rec) = (MockFlight::with_variant(MockVariant::Teleport), FlightSession::new(), mock_recorder(&store));
    let loop_s = MockVariant::Teleport.loop_seconds();
    let mut t_s = 0.0;
    while t_s < loop_s * 1.6 {
        t_s += 0.25;
        for ev in flight.step(t_s, T0 + (t_s * 1000.0) as u64) {
            match ev {
                ProviderEvent::Telemetry(t) => {
                    let e = session.update(&t);
                    rec.on_telemetry(&t, session.summary(), &e).unwrap();
                }
                ProviderEvent::Sim(e) => {
                    let e = session.on_sim_event(&e);
                    rec.on_events(session.summary(), &e, T0 + (t_s * 1000.0) as u64).unwrap();
                }
                _ => {}
            }
        }
    }
    let states: Vec<String> = store.list_flights(10, 0).unwrap().into_iter().map(|f| f.state).collect();
    assert_eq!(states, ["active", "interrupted"]);
    // downwind -> stand: about 4 nm, and the stand time is not recorded (no flight open)
    let c = store.list_merge_candidates().unwrap();
    assert_eq!(c.len(), 1, "{c:?}");
    assert!(c[0].gap_ms < 5 * MIN && c[0].distance_nm < 5.0, "{} ms, {} nm", c[0].gap_ms, c[0].distance_nm);
    // the app hides a pair whose second flight is the running one; the store merges it anyway
    store.merge_flights(&c[0].first.id, &c[0].second.id).unwrap();
    assert_eq!(store.list_flights(10, 0).unwrap().len(), 1);
}
