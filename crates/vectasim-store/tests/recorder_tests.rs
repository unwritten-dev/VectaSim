//! Recorder across session discontinuities (provider switch, reload, teleport) and
//! failing writes.

use vectasim_core::{FlightEvent, FlightSession, MockFlight, MockVariant, ProviderEvent, Telemetry};
use vectasim_store::{FlightRecorder, RecorderContext, Store};

const T0: u64 = 1_700_000_000_000;

fn recorder(store: &Store) -> FlightRecorder {
    FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() })
}

/// One recorder tick; returns the events and the recorder's result.
fn tick(session: &mut FlightSession, rec: &mut FlightRecorder, t: &Telemetry) -> (Vec<FlightEvent>, bool) {
    let events = session.update(t);
    let ok = rec.on_telemetry(t, session.summary(), &events).is_ok();
    (events, ok)
}

#[test]
fn provider_switch_closes_the_open_flight_as_interrupted() {
    let store = Store::open_in_memory().unwrap();
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let mut last = 0;
    for i in 1..=(150 * 20) {
        let t_s = i as f64 / 20.0;
        last = T0 + (t_s * 1000.0) as u64;
        let t = flight.sample(t_s, last);
        assert!(tick(&mut session, &mut rec, &t).1);
    }
    let id = rec.current_flight_id().unwrap().to_owned();
    assert_eq!(store.active_flight_id().unwrap().as_deref(), Some(id.as_str()));

    // what the app's forwarder does when its provider is stopped
    let events = session.interrupt(last);
    assert!(matches!(events.as_slice(), [FlightEvent::FlightEnded { interrupted: true, .. }]), "{events:?}");
    rec.on_events(session.summary(), &events, last).unwrap();

    assert_eq!(rec.current_flight_id(), None);
    assert_eq!(store.active_flight_id().unwrap(), None, "nothing left 'active' for SimBrief to attach to");
    let f = store.get_flight(&id).unwrap().unwrap();
    assert_eq!(f.flight.state, "interrupted");
    assert!(f.flight.takeoff_ms.is_some());
    assert!(f.has_track);
    let track = store.get_track(&id).unwrap().unwrap();
    assert!(track.len() >= 120, "the whole track up to the stop is kept: {}", track.len());
}

#[test]
fn reload_mid_flight_records_an_interrupted_and_a_new_flight() {
    let store = Store::open_in_memory().unwrap();
    let mut flight = MockFlight::with_variant(MockVariant::Teleport);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let hz = 10.0;
    for i in 1..=((MockVariant::Teleport.loop_seconds() + 60.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        for pe in flight.step(t_s, T0 + (t_s * 1000.0) as u64) {
            match pe {
                ProviderEvent::Telemetry(t) => assert!(tick(&mut session, &mut rec, &t).1),
                ProviderEvent::Sim(e) => {
                    let events = session.on_sim_event(&e);
                    rec.on_events(session.summary(), &events, T0 + (t_s * 1000.0) as u64).unwrap();
                }
                _ => {}
            }
        }
    }
    let flights = store.list_flights(10, 0).unwrap();
    let states: Vec<_> = flights.iter().map(|f| f.state.as_str()).collect();
    assert_eq!(states, vec!["active", "interrupted"], "newest first");
    let old = store.get_flight(&flights[1].id).unwrap().unwrap();
    assert!(old.touchdowns.is_empty(), "no ghost landing: {:?}", old.touchdowns);
    assert_eq!(old.flight.landing_ms, None);
    assert!(old.flight.takeoff_ms.is_some());
}

#[test]
fn teleport_flag_is_stored() {
    let store = Store::open_in_memory().unwrap();
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let hz = 10.0;
    for i in 1..=((MockVariant::Circuit.loop_seconds() + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        let mut t = flight.sample(t_s, T0 + (t_s * 1000.0) as u64);
        if t_s > 200.0 {
            t.latitude += 0.5; // 30 nm sideways, in the air
        }
        assert!(tick(&mut session, &mut rec, &t).1);
    }
    let f = &store.list_flights(10, 0).unwrap()[0];
    assert_eq!(f.state, "completed", "the flight continued and landed");
    assert!(f.integrity.teleport_detected);
    assert_eq!(f.landing_count, 1);
    assert!(f.distance_nm < 25.0, "the jump is not flown distance: {}", f.distance_nm);
}

/// A trigger that makes inserts into `table` fail, set from a second connection.
fn fail_inserts(path: &std::path::Path, table: &str, on: bool) {
    let conn = rusqlite::Connection::open(path).unwrap();
    let sql = if on {
        format!("CREATE TRIGGER fail_{table} BEFORE INSERT ON {table} BEGIN SELECT RAISE(FAIL, 'disk full (test)'); END;")
    } else {
        format!("DROP TRIGGER fail_{table};")
    };
    conn.execute_batch(&sql).unwrap();
}

#[test]
fn failing_phase_writes_do_not_swallow_the_flight_end() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let store = Store::open(&path).unwrap();
    fail_inserts(&path, "phase_events", true);
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let mut failures = 0;
    let mut ended = false;
    for i in 1..=((MockVariant::Circuit.loop_seconds() + 10.0) * 10.0) as u64 {
        let t_s = i as f64 / 10.0;
        let t = flight.sample(t_s, T0 + (t_s * 1000.0) as u64);
        let (events, ok) = tick(&mut session, &mut rec, &t);
        failures += usize::from(!ok);
        ended |= events.iter().any(|e| matches!(e, FlightEvent::FlightEnded { .. }));
    }
    assert!(ended);
    assert!(failures >= 10, "every phase change reported its error: {failures}");
    let f = &store.list_flights(10, 0).unwrap()[0];
    assert_eq!(f.state, "completed", "FlightEnded after a failed phase write in the same sample still closes the flight");
    assert_eq!(f.landing_count, 1);
    let detail = store.get_flight(&f.id).unwrap().unwrap();
    assert!(detail.phases.is_empty());
    assert!(detail.has_track);
}

#[test]
fn failed_touchdown_insert_is_retried() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let store = Store::open(&path).unwrap();
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let mut failed_once = false;
    for i in 1..=((MockVariant::Circuit.loop_seconds() + 10.0) * 10.0) as u64 {
        let t_s = i as f64 / 10.0;
        let t = flight.sample(t_s, T0 + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        let touchdown = events.iter().any(|e| matches!(e, FlightEvent::Touchdown(_)));
        if touchdown {
            fail_inserts(&path, "touchdowns", true);
        }
        let r = rec.on_telemetry(&t, session.summary(), &events);
        if touchdown {
            assert!(r.is_err());
            failed_once = true;
            fail_inserts(&path, "touchdowns", false);
        } else {
            r.unwrap();
        }
    }
    assert!(failed_once);
    let f = &store.list_flights(10, 0).unwrap()[0];
    assert_eq!((f.state.as_str(), f.landing_count), ("completed", 1), "retried with the next sample");
}

#[test]
fn failed_flight_end_is_retried() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let store = Store::open(&path).unwrap();
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let mut blocked = false;
    for i in 1..=((MockVariant::Circuit.loop_seconds() + 10.0) * 10.0) as u64 {
        let t_s = i as f64 / 10.0;
        let t = flight.sample(t_s, T0 + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        let ends = events.iter().any(|e| matches!(e, FlightEvent::FlightEnded { .. }));
        if ends {
            // the track upsert of the final flush fails
            fail_inserts(&path, "tracks", true);
            assert!(rec.on_telemetry(&t, session.summary(), &events).is_err());
            assert!(rec.ending_flight_id().is_some(), "the end is kept for a retry");
            fail_inserts(&path, "tracks", false);
            blocked = true;
        } else {
            rec.on_telemetry(&t, session.summary(), &events).unwrap();
        }
    }
    assert!(blocked);
    assert_eq!(rec.ending_flight_id(), None);
    let f = &store.list_flights(10, 0).unwrap()[0];
    assert_eq!(f.state, "completed");
    assert!(store.get_flight(&f.id).unwrap().unwrap().has_track);
}

/// Synthetic 4 Hz flight for the touchdown-outcome path (moves north at its GS, so no
/// sample looks like a teleport); every sample goes through session, recorder and outcomes.
struct Synth {
    wall_ms: u64,
    sim_s: f64,
    lat: f64,
    session: FlightSession,
    outcomes: Vec<vectasim_core::flight::TouchdownOutcomeEvent>,
    /// Touchdown inserts fail while set (trigger on this database path).
    fail_path: Option<std::path::PathBuf>,
}

const SYNTH_STEP_MS: u64 = 250;

impl Synth {
    fn run(&mut self, rec: &mut FlightRecorder, secs: f64, f: impl Fn(&mut Telemetry)) {
        let n = (secs * 1000.0 / SYNTH_STEP_MS as f64).round() as u64;
        for _ in 0..n {
            self.step(rec, &f);
        }
    }

    fn step(&mut self, rec: &mut FlightRecorder, f: &dyn Fn(&mut Telemetry)) {
        self.wall_ms += SYNTH_STEP_MS;
        let dt = SYNTH_STEP_MS as f64 / 1000.0;
        self.sim_s += dt;
        let mut t = Telemetry {
            timestamp_ms: self.wall_ms,
            sim_zulu_time_s: self.sim_s,
            latitude: self.lat,
            longitude: 8.0,
            sim_rate: 1.0,
            num_engines: 2,
            engines_running: 2,
            fuel_total_kg: 5_000.0,
            on_ground: true,
            ..Default::default()
        };
        f(&mut t);
        self.lat += t.ground_speed_kt * dt / 3_600.0 / 60.0;
        let events = self.session.update(&t);
        let r = rec.on_telemetry(&t, self.session.summary(), &events);
        if self.fail_path.is_none() {
            r.unwrap();
        }
        let outs = self.session.take_touchdown_outcomes();
        if !outs.is_empty() {
            rec.on_touchdown_outcomes(&outs).unwrap();
            self.outcomes.extend(outs);
        }
    }

    fn climb(&mut self, rec: &mut FlightRecorder, from: f64, to: f64, fpm: f64, gs: f64) {
        let n = ((to - from).abs() / fpm.abs() * 60.0 * 1000.0 / SYNTH_STEP_MS as f64).round().max(1.0) as u64;
        let vs = if to > from { fpm.abs() } else { -fpm.abs() };
        for i in 1..=n {
            let agl = from + (to - from) * i as f64 / n as f64;
            self.step(rec, &air(agl, vs, gs));
        }
    }

    fn roll(&mut self, rec: &mut FlightRecorder, secs: f64, from_kt: f64, to_kt: f64, sim_fpm: f64) {
        let n = (secs * 1000.0 / SYNTH_STEP_MS as f64).round() as u64;
        for i in 1..=n {
            let gs = from_kt + (to_kt - from_kt) * i as f64 / n as f64;
            self.step(rec, &move |t: &mut Telemetry| {
                ground(gs)(t);
                t.touchdown_vs_fpm = sim_fpm;
            });
        }
    }

    fn short_final_from(&mut self, rec: &mut FlightRecorder, agl: f64) {
        self.climb(rec, agl, 20.0, 700.0, 120.0);
        self.run(rec, 1.0, air(5.0, -180.0, 115.0));
    }
}

fn ground(gs: f64) -> impl Fn(&mut Telemetry) {
    move |t| {
        t.on_ground = true;
        t.ground_speed_kt = gs;
        t.altitude_agl_ft = 0.0;
        t.altitude_msl_ft = 400.0;
    }
}

fn air(agl: f64, vs: f64, gs: f64) -> impl Fn(&mut Telemetry) {
    move |t| {
        t.on_ground = false;
        t.altitude_agl_ft = agl;
        t.altitude_msl_ft = 400.0 + agl;
        t.vertical_speed_fpm = vs;
        t.ground_speed_kt = gs;
    }
}

/// A 15 s roll touch-and-go is reported (and inserted) as `touch_and_go = false`; its
/// outcome corrects the row, so the flight's landing rate is the full stop's.
fn long_touch_and_go_then_full_stop(fail_touchdown_inserts: bool) {
    use vectasim_core::touchdown::TouchdownOutcome::{FullStop, TouchAndGo};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let store = Store::open(&path).unwrap();
    let mut rec = recorder(&store);
    let mut sim = Synth { wall_ms: T0, sim_s: 36_000.0, lat: 50.0, session: FlightSession::new(), outcomes: Vec::new(), fail_path: None };

    sim.run(&mut rec, 10.0, ground(12.0));
    sim.run(&mut rec, 5.0, ground(90.0));
    sim.climb(&mut rec, 10.0, 1_500.0, 1_500.0, 130.0);
    sim.run(&mut rec, 30.0, air(1_500.0, 0.0, 130.0));
    sim.short_final_from(&mut rec, 1_500.0);
    if fail_touchdown_inserts {
        fail_inserts(&path, "touchdowns", true);
        sim.fail_path = Some(path.clone());
    }
    sim.roll(&mut rec, 15.0, 80.0, 60.0, 190.0);
    sim.climb(&mut rec, 10.0, 1_000.0, 800.0, 90.0);
    assert_eq!(sim.outcomes.iter().map(|o| o.outcome).collect::<Vec<_>>(), vec![TouchAndGo]);
    if fail_touchdown_inserts {
        fail_inserts(&path, "touchdowns", false);
        sim.fail_path = None;
    }
    sim.run(&mut rec, 30.0, air(1_000.0, 0.0, 110.0));
    let id = rec.current_flight_id().unwrap().to_owned();
    let f = store.get_flight(&id).unwrap().unwrap();
    assert_eq!(f.touchdowns.len(), 1);
    assert!(f.touchdowns[0].touch_and_go);
    assert_eq!(f.flight.landing_vs_fpm, None, "a touch-and-go is not the flight's landing rate");
    sim.short_final_from(&mut rec, 1_000.0);
    sim.roll(&mut rec, 10.0, 80.0, 40.0, 120.0);
    sim.roll(&mut rec, 5.0, 40.0, 15.0, 120.0);
    assert_eq!(sim.outcomes.iter().map(|o| o.outcome).collect::<Vec<_>>(), vec![TouchAndGo, FullStop]);

    let conn = rusqlite::Connection::open(&path).unwrap();
    let rows: Vec<(i64, f64)> = conn
        .prepare("SELECT touch_and_go, landing_rate_fpm FROM touchdowns WHERE flight_id = ?1 ORDER BY timestamp_ms")
        .unwrap()
        .query_map([&id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows, vec![(1, -190.0), (0, -120.0)], "the touch-and-go row is corrected");
    let f = store.get_flight(&id).unwrap().unwrap();
    assert_eq!(f.flight.landing_vs_fpm, Some(-120.0), "flight landing rate from the full stop");
    assert_eq!(f.flight.landing_count, 2, "both contacts are touchdown rows");
}

#[test]
fn long_touch_and_go_row_is_corrected_by_its_outcome() {
    long_touch_and_go_then_full_stop(false);
}

#[test]
fn touch_and_go_outcome_corrects_a_touchdown_still_waiting_for_its_insert() {
    long_touch_and_go_then_full_stop(true);
}

/// The system clock set back by an hour mid-flight: 1 Hz samples and the 15 s flush go on
/// (the recorder paces on a monotonic clock, the samples keep the wall-clock time).
#[test]
fn clock_set_back_keeps_sampling_and_flushing() {
    let store = Store::open_in_memory().unwrap();
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let hz = 20.0;
    let wall = |t_s: f64, back_ms: u64| T0 + (t_s * 1000.0) as u64 - back_ms;
    for i in 1..=(150 * 20) {
        let t_s = i as f64 / hz;
        assert!(tick(&mut session, &mut rec, &flight.sample(t_s, wall(t_s, 0))).1);
    }
    let id = rec.current_flight_id().unwrap().to_owned();
    let before = rec.live_track().lock().unwrap().len();
    let stored_before = store.get_track(&id).unwrap().unwrap().len();
    // 60 s with the wall clock an hour behind
    for i in (150 * 20 + 1)..=(210 * 20) {
        let t_s = i as f64 / hz;
        assert!(tick(&mut session, &mut rec, &flight.sample(t_s, wall(t_s, 3_600_000))).1);
    }
    let after = rec.live_track().lock().unwrap().len();
    assert!((58..=61).contains(&(after - before)), "1 Hz samples go on: {before} → {after}");
    let stored = store.get_track(&id).unwrap().unwrap();
    assert!(stored.len() >= stored_before + 40, "flushes go on: {stored_before} → {}", stored.len());
    assert!(stored.last().unwrap().t_ms < T0, "samples keep the wall-clock time");
}

/// One sample of a ground session at `wall_ms` (engines on unless `engines` is 0).
fn ground_sample(wall_ms: u64, lat: f64, gs: f64, engines: u8) -> Telemetry {
    Telemetry {
        timestamp_ms: wall_ms,
        sim_zulu_time_s: 36_000.0 + (wall_ms - T0) as f64 / 1000.0,
        latitude: lat,
        longitude: 8.0,
        sim_rate: 1.0,
        num_engines: 2,
        engines_running: engines,
        fuel_total_kg: 5_000.0,
        on_ground: true,
        ground_speed_kt: gs,
        altitude_msl_ft: 400.0,
        ..Default::default()
    }
}

/// Taxi out and shut down again without a take-off: the core discards the recording, the
/// recorder stores it as `discarded` straight in the Papierkorb – not in the logbook.
#[test]
fn a_ground_session_goes_to_the_trash_as_discarded() {
    let store = Store::open_in_memory().unwrap();
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let (mut wall, mut lat) = (T0, 50.0);
    let mut discarded = Vec::new();
    let mut run = |secs: u64, gs: f64, engines: u8, rec: &mut FlightRecorder, session: &mut FlightSession| {
        for _ in 0..secs {
            wall += 1000;
            lat += gs / 3_600.0 / 60.0;
            let t = ground_sample(wall, lat, gs, engines);
            assert!(tick(session, rec, &t).1);
            let d = session.take_discarded_flights();
            if !d.is_empty() {
                discarded.extend(rec.on_discarded(&d, wall).unwrap());
            }
        }
    };
    run(20, 12.0, 2, &mut rec, &mut session);
    let id = rec.current_flight_id().expect("taxiing starts a recording").to_owned();
    run(20, 10.0, 2, &mut rec, &mut session);
    run(60, 0.0, 0, &mut rec, &mut session);
    assert_eq!(rec.current_flight_id(), None);
    assert_eq!(discarded, std::slice::from_ref(&id));
    assert!(store.list_flights(10, 0).unwrap().is_empty(), "not in the logbook");
    let trash = store.list_deleted_flights().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!((trash[0].flight.id.as_str(), trash[0].flight.state.as_str()), (id.as_str(), "discarded"));
    assert_eq!(store.totals().unwrap().flights, 0);
    // restorable, but still no flight for the statistics
    assert!(store.restore_flight(&id).unwrap());
    assert_eq!(store.list_flights(10, 0).unwrap().len(), 1);
    assert_eq!(store.totals().unwrap().flights, 0);
    assert!(!store.list_flights(10, 0).unwrap()[0].counts_in_stats());
}

/// Averages and rankings skip unrated touchdowns; counters skip discarded flights and old
/// recordings that never took off or touched down.
#[test]
fn statistics_ignore_unrated_landings_and_ground_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v.db");
    let store = Store::open(&path).unwrap();
    for k in 0..3u64 {
        let mut flight = MockFlight::with_variant(MockVariant::Circuit);
        let mut session = FlightSession::new();
        let mut rec = recorder(&store);
        let base = T0 + k * 10 * 3_600_000;
        for i in 1..=((MockVariant::Circuit.loop_seconds() + 10.0) * 5.0) as u64 {
            let t_s = i as f64 / 5.0;
            assert!(tick(&mut session, &mut rec, &flight.sample(t_s, base + (t_s * 1000.0) as u64)).1);
        }
    }
    let before = store.totals().unwrap();
    assert_eq!(before.flights, 3);
    let ids: Vec<String> = store.list_flights(10, 0).unwrap().into_iter().map(|f| f.id).collect();
    let rated = store.get_flight(&ids[1]).unwrap().unwrap().touchdowns.iter().find(|t| !t.touch_and_go).unwrap().landing_rate_fpm;
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        // flight 0: slewed down (unrated, ~0 fpm); flight 2: an old taxi-only recording
        c.execute("UPDATE touchdowns SET landing_rate_source = 'unrated', landing_rate_fpm = 0 WHERE flight_id = ?1", [&ids[0]]).unwrap();
        c.execute("DELETE FROM touchdowns WHERE flight_id = ?1", [&ids[2]]).unwrap();
        c.execute("UPDATE flights SET takeoff_ms = NULL, airframe_reg = NULL WHERE id = ?1", [&ids[2]]).unwrap();
    }
    let t = store.totals().unwrap();
    assert_eq!(t.flights, 2, "the taxi-only recording does not count");
    assert!((t.avg_landing_vs_fpm.unwrap() - rated).abs() < 1e-6, "{:?} vs {rated}", t.avg_landing_vs_fpm);
    let recent = store.recent_landings(10, true).unwrap();
    assert!(recent.iter().all(|l| l.flight.id != ids[0]), "no unrated landing in rankings/trends");
    let rows = store.list_flights(10, 0).unwrap();
    assert_eq!(rows.iter().find(|f| f.id == ids[0]).unwrap().landing_vs_fpm, None, "no rate shown for an unrated landing");
    assert!(!rows.iter().find(|f| f.id == ids[2]).unwrap().counts_in_stats());
}

/// The discard can arrive after its `FlightEnded` was written as interrupted (the summary
/// already described the next flight): `on_discarded` finds the flight by its off-block.
#[test]
fn a_late_discard_finds_the_closed_flight_by_off_block() {
    let store = Store::open_in_memory().unwrap();
    let mut session = FlightSession::new();
    let mut rec = recorder(&store);
    let mut wall = T0;
    for _ in 0..20 {
        wall += 1000;
        assert!(tick(&mut session, &mut rec, &ground_sample(wall, 50.0, 12.0, 2)).1);
    }
    let id = rec.current_flight_id().unwrap().to_owned();
    let off_block = store.get_flight(&id).unwrap().unwrap().flight.off_block_ms;
    // closed as an ordinary interruption first
    rec.on_events(session.summary(), &[FlightEvent::FlightEnded { timestamp_ms: wall, interrupted: true }], wall).unwrap();
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.state, "interrupted");
    let ev = vectasim_core::flight::FlightDiscardedEvent { timestamp_ms: wall, off_block_ms: off_block, shut_down: false };
    // an unknown off-block matches nothing
    let other = vectasim_core::flight::FlightDiscardedEvent { off_block_ms: Some(1), ..ev.clone() };
    assert!(rec.on_discarded(&[other], wall).unwrap().is_empty());
    assert_eq!(rec.on_discarded(&[ev], wall).unwrap(), std::slice::from_ref(&id));
    let trash = store.list_deleted_flights().unwrap();
    assert_eq!((trash.len(), trash[0].flight.state.as_str()), (1, "discarded"));
}
