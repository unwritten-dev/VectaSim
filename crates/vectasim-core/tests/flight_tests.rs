//! Phase engine, touchdown detector and flight session against synthetic
//! telemetry and against the deterministic mock flight.

use vectasim_core::FlightPhase::*;
use vectasim_core::{FlightEvent, FlightPhase, FlightSession, FlightState, LandingRateSource, MockFlight, PhaseEngine, ProviderEvent, Telemetry, TouchdownDetector};

/// Builder for synthetic samples; time advances by `step_ms` per `at()` call.
struct Sim {
    t_ms: u64,
    step_ms: u64,
    base: Telemetry,
}

impl Sim {
    fn new(step_ms: u64) -> Self {
        let base = Telemetry {
            sim_rate: 1.0,
            on_ground: true,
            num_engines: 2,
            engines_running: 2,
            parking_brake: false,
            altitude_msl_ft: 400.0,
            fuel_total_kg: 5000.0,
            // a position at 0/0 is a sim placeholder, ignored by the session
            latitude: 50.0,
            longitude: 8.0,
            ..Default::default()
        };
        Self { t_ms: 1_000_000, step_ms, base }
    }

    /// Emit `secs` seconds of samples, each tweaked by `f`, feeding every one into `feed`.
    fn run(&mut self, secs: f64, mut f: impl FnMut(&mut Telemetry), mut feed: impl FnMut(&Telemetry)) {
        let n = (secs * 1000.0 / self.step_ms as f64).round() as u64;
        for _ in 0..n {
            self.t_ms += self.step_ms;
            let mut t = self.base.clone();
            t.timestamp_ms = self.t_ms;
            f(&mut t);
            feed(&t);
        }
    }
}

fn ground(gs: f64) -> impl FnMut(&mut Telemetry) {
    move |t| {
        t.on_ground = true;
        t.ground_speed_kt = gs;
        t.altitude_agl_ft = 0.0;
    }
}

fn air(agl: f64, vs: f64, gs: f64) -> impl FnMut(&mut Telemetry) {
    move |t| {
        t.on_ground = false;
        t.altitude_agl_ft = agl;
        t.altitude_msl_ft = 400.0 + agl;
        t.vertical_speed_fpm = vs;
        t.ground_speed_kt = gs;
    }
}

#[test]
fn full_flight_phase_sequence_at_1hz() {
    let mut engine = PhaseEngine::new();
    let mut seen = vec![engine.phase()];
    let mut sim = Sim::new(1000);
    let mut feed = |t: &Telemetry| {
        if let Some(tr) = engine.update(t) {
            seen.push(tr.to);
        }
    };
    sim.run(5.0, ground(0.0), &mut feed);
    sim.run(20.0, ground(12.0), &mut feed); // taxi out
    sim.run(5.0, ground(90.0), &mut feed); // roll
    sim.run(30.0, air(300.0, 1500.0, 150.0), &mut feed); // initial climb, below 1500 ft
    sim.run(30.0, air(3000.0, 1500.0, 200.0), &mut feed); // climb
    sim.run(90.0, air(8000.0, 0.0, 250.0), &mut feed); // cruise (60 s dwell)
    sim.run(60.0, air(6000.0, -1200.0, 240.0), &mut feed); // descent
    sim.run(20.0, air(3500.0, -800.0, 180.0), &mut feed); // approach
    sim.run(20.0, air(1000.0, -700.0, 140.0), &mut feed); // final
    sim.run(2.0, ground(120.0), &mut feed); // touchdown
    sim.run(10.0, ground(20.0), &mut feed); // rollout → taxi in
    sim.run(10.0, |t| { ground(0.0)(t); t.engines_running = 0; }, &mut feed); // shutdown
    assert_eq!(seen, vec![Preflight, TaxiOut, Takeoff, Climb, Cruise, Descent, Approach, Final, Landing, TaxiIn, Shutdown]);
}

#[test]
fn spurious_on_ground_at_altitude_does_not_land() {
    let mut engine = PhaseEngine::new();
    let mut seen = Vec::new();
    let mut sim = Sim::new(1000);
    let mut feed = |t: &Telemetry| {
        if let Some(tr) = engine.update(t) {
            seen.push(tr.to);
        }
    };
    sim.run(5.0, ground(12.0), &mut feed);
    sim.run(5.0, ground(90.0), &mut feed);
    sim.run(60.0, air(3000.0, 1500.0, 180.0), &mut feed);
    sim.run(90.0, air(8900.0, 0.0, 250.0), &mut feed); // cruise
    // MSFS can report "on ground" for single frames at altitude; AGL must corroborate it
    sim.run(3.0, |t| { air(8900.0, 0.0, 250.0)(t); t.on_ground = true; }, &mut feed);
    // without a usable AGL the ground speed decides: 250 kt is not a ground roll
    sim.run(3.0, |t| { air(8900.0, 0.0, 250.0)(t); t.on_ground = true; t.altitude_agl_ft = f64::NAN; }, &mut feed);
    sim.run(5.0, air(8900.0, 0.0, 250.0), &mut feed);
    drop(feed);
    assert_eq!(seen, vec![TaxiOut, Takeoff, Climb, Cruise]);
    assert!(engine.airborne_qualified(), "the airborne tracking was not reset either");
    // a corroborated contact still lands
    sim.run(2.0, |t| { ground(130.0)(t); t.altitude_agl_ft = 30.0; }, |t| { engine.update(t); });
    assert_eq!(engine.phase(), Landing);
}

#[test]
fn rejected_takeoff_returns_to_taxi() {
    let mut engine = PhaseEngine::new();
    let mut seen = Vec::new();
    let mut sim = Sim::new(500);
    let mut feed = |t: &Telemetry| {
        if let Some(tr) = engine.update(t) {
            seen.push(tr.to);
        }
    };
    sim.run(10.0, ground(10.0), &mut feed);
    sim.run(6.0, ground(80.0), &mut feed);
    sim.run(10.0, ground(20.0), &mut feed);
    assert_eq!(seen, vec![TaxiOut, Takeoff, TaxiOut]);
}

#[test]
fn pause_and_time_acceleration_are_ignored() {
    let mut engine = PhaseEngine::new();
    let mut sim = Sim::new(1000);
    // taxiing while paused must not leave Preflight
    sim.run(30.0, |t| { ground(12.0)(t); t.paused = true; }, |t| assert!(engine.update(t).is_none()));
    assert_eq!(engine.last_skip(), Some(vectasim_core::SkipReason::Paused));
    // 4x time acceleration: still ignored
    sim.run(30.0, |t| { ground(12.0)(t); t.sim_rate = 4.0; }, |t| assert!(engine.update(t).is_none()));
    assert_eq!(engine.phase(), Preflight);
    // normal again → TaxiOut after 2 s dwell
    sim.run(5.0, ground(12.0), |t| { engine.update(t); });
    assert_eq!(engine.phase(), TaxiOut);
}

#[test]
fn go_around_from_final_returns_to_climb() {
    let mut engine = PhaseEngine::new();
    let mut sim = Sim::new(1000);
    let mut feed = |t: &Telemetry| {
        engine.update(t);
    };
    sim.run(5.0, ground(10.0), &mut feed);
    sim.run(5.0, ground(90.0), &mut feed);
    sim.run(60.0, air(3000.0, 1500.0, 180.0), &mut feed);
    sim.run(5.0, air(6000.0, 1500.0, 180.0), &mut feed); // reach max altitude
    sim.run(40.0, air(5000.0, -1000.0, 200.0), &mut feed); // ≥300 ft below max and descending
    sim.run(20.0, air(3000.0, -800.0, 180.0), &mut feed);
    sim.run(20.0, air(800.0, -700.0, 140.0), &mut feed);
    drop(feed);
    assert_eq!(engine.phase(), Final);
    sim.run(15.0, air(600.0, 1800.0, 150.0), |t| { engine.update(t); });
    assert_eq!(engine.phase(), Climb);
}

#[test]
fn touchdown_detector_reports_bounce_and_measured_vs() {
    let mut det = TouchdownDetector::new();
    let mut sim = Sim::new(50); // 20 Hz
    let mut reports = Vec::new();
    let mut feed = |t: &Telemetry| {
        if let Some(r) = det.update(t) {
            reports.push(r);
        }
    };
    sim.run(5.0, air(1000.0, -700.0, 140.0), &mut feed);
    sim.run(2.0, air(20.0, -420.0, 130.0), &mut feed);
    sim.run(0.5, |t| { ground(125.0)(t); t.g_force = 1.6; }, &mut feed); // first contact
    sim.run(0.6, air(5.0, -250.0, 120.0), &mut feed); // bounce
    sim.run(0.3, |t| { ground(115.0)(t); t.g_force = 1.3; }, &mut feed); // second contact
    sim.run(6.0, ground(80.0), &mut feed); // window closes
    assert_eq!(reports.len(), 1, "exactly one report, got {reports:?}");
    let r = &reports[0];
    assert_eq!(r.bounces, 1);
    assert!((r.vs_fpm_measured + 420.0).abs() < 1e-6);
    assert!((r.vs_fpm_hardest + 420.0).abs() < 1e-6);
    assert!((r.peak_g - 1.6).abs() < 1e-6);
    assert!(!r.touch_and_go);
}

#[test]
fn touchdown_detector_ignores_hop_without_real_flight() {
    let mut det = TouchdownDetector::new();
    let mut sim = Sim::new(100);
    let mut count = 0;
    let mut feed = |t: &Telemetry| {
        if det.update(t).is_some() {
            count += 1;
        }
    };
    sim.run(2.0, air(30.0, -200.0, 60.0), &mut feed); // reload on runway / brief hop
    sim.run(5.0, ground(0.0), &mut feed);
    assert_eq!(count, 0);
}

#[test]
fn mock_flight_drives_one_complete_flight() {
    // the demo flight starts in the air on the downwind and ends parked; the next loop is a
    // new flight, loaded in the air again (`FlightLoaded`), never a teleport in the old one
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut phases: Vec<FlightPhase> = vec![session.phase()];
    let mut touchdowns = 0;
    let mut started = Vec::new();
    let mut ended = Vec::new();
    let hz = 20.0;
    let loop_s = MockFlight::loop_seconds();
    let mut first: Option<vectasim_core::FlightSummary> = None;
    let mut outcomes = Vec::new();
    for i in 1..=((loop_s + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        if t_s >= loop_s && first.is_none() {
            first = Some(session.summary().clone());
            outcomes = session.take_touchdown_outcomes().into_iter().map(|o| (o.index, o.outcome)).collect();
        }
        let mut evs = Vec::new();
        for pe in flight.step(t_s, 1_000_000 + (t_s * 1000.0) as u64) {
            match pe {
                ProviderEvent::Telemetry(t) => evs.extend(session.update(&t)),
                ProviderEvent::Sim(e) => evs.extend(session.on_sim_event(&e)),
                _ => {}
            }
        }
        for ev in evs {
            match ev {
                FlightEvent::PhaseChanged(tr) => phases.push(tr.to),
                FlightEvent::Touchdown(r) => {
                    touchdowns += 1;
                    assert_eq!(r.bounces, 0, "{r:?}");
                    assert!(r.vs_fpm_measured < 0.0, "{r:?}");
                    // the mock reports a sim touchdown value, so that is the headline rate
                    assert_eq!(r.landing_rate_source, LandingRateSource::Sim, "{r:?}");
                    assert_eq!(r.landing_rate_fpm, -r.vs_fpm_sim.abs().round(), "{r:?}");
                }
                FlightEvent::FlightStarted { timestamp_ms } => started.push(timestamp_ms),
                FlightEvent::FlightEnded { interrupted, .. } => ended.push(interrupted),
            }
        }
    }
    // straight into the air phase the first sample shows, no take-off; then the next loop
    assert_eq!(phases, vec![Preflight, Cruise, Descent, Approach, Final, Landing, TaxiIn, Shutdown, Cruise]);
    assert_eq!((started.len(), ended.as_slice(), touchdowns), (2, [false].as_slice(), 1));
    assert_eq!(outcomes, vec![(0, vectasim_core::touchdown::TouchdownOutcome::FullStop)]);
    let s = first.unwrap();
    assert_eq!(s.state, FlightState::Completed);
    assert_eq!(s.landing_rate_fpm, Some(s.touchdowns[0].landing_rate_fpm));
    assert_eq!(s.landing_ms, Some(s.touchdowns[0].timestamp_ms), "the full stop's first contact");
    // recorded from the first sample: block time from there, no lift-off seen (no flight time)
    assert_eq!(s.off_block_ms, Some(started[0]));
    assert_eq!(s.off_block_ms, Some(1_000_050));
    assert_eq!(s.takeoff_ms, None);
    assert_eq!(s.flight_time_ms(), None);
    let block = s.block_time_ms().unwrap();
    assert!((250_000..=300_000).contains(&block), "block {block} ms");
    assert!(s.departure.is_some() && s.arrival.is_some());
    assert!(s.distance_nm > 5.0, "distance {}", s.distance_nm);
    assert!(s.max_altitude_msl_ft > 2_700.0, "max alt {}", s.max_altitude_msl_ft);
    assert!(s.fuel_used_kg().unwrap() > 0.0);
    assert!(!s.integrity.slew_detected && !s.integrity.time_acceleration_detected && !s.integrity.teleport_detected);
    // the next loop: a new flight, started in the air again, nothing carried over
    let n = session.summary();
    assert_eq!((n.state, n.phase, n.takeoff_ms), (FlightState::Active, Cruise, None));
    assert!(n.touchdowns.is_empty() && !n.integrity.teleport_detected);
}

#[test]
fn flight_landing_rate_is_the_last_full_stop_not_a_touch_and_go() {
    let mut session = FlightSession::new();
    let mut sim = Sim::new(50);
    let mut feed = |t: &Telemetry| {
        session.update(t);
    };
    let sim_value = |v: f64, mut f: Box<dyn FnMut(&mut Telemetry)>| move |t: &mut Telemetry| {
        f(t);
        t.touchdown_vs_fpm = v;
        // the scripted AGL steps would be altitude jumps (teleports) on MSL
        t.altitude_msl_ft = 400.0;
    };
    sim.run(70.0, sim_value(0.0, Box::new(air(1500.0, -700.0, 140.0))), &mut feed);
    sim.run(2.0, sim_value(0.0, Box::new(air(10.0, -450.0, 130.0))), &mut feed);
    sim.run(1.0, sim_value(460.0, Box::new(ground(120.0))), &mut feed); // hard touch-and-go …
    sim.run(60.0, sim_value(460.0, Box::new(air(1000.0, 800.0, 140.0))), &mut feed);
    sim.run(30.0, sim_value(460.0, Box::new(air(800.0, -600.0, 130.0))), &mut feed);
    sim.run(2.0, sim_value(460.0, Box::new(air(10.0, -120.0, 120.0))), &mut feed);
    sim.run(10.0, sim_value(118.0, Box::new(ground(90.0))), &mut feed); // … then a soft full stop
    sim.run(10.0, sim_value(118.0, Box::new(ground(20.0))), &mut feed);
    drop(feed);
    let s = session.summary();
    assert_eq!(s.touchdowns.len(), 2, "{:?}", s.touchdowns);
    assert!(s.touchdowns[0].touch_and_go);
    assert_eq!(s.touchdowns[0].landing_rate_fpm, -460.0);
    assert_eq!((s.touchdowns[1].landing_rate_fpm, s.touchdowns[1].landing_rate_source), (-118.0, LandingRateSource::Sim));
    assert_eq!(s.landing_rate_fpm, Some(-118.0));
}
