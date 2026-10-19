//! Session behaviour across discontinuities of the data stream: reconnects, reloads,
//! teleports, pauses without telemetry, plus lift-off time and block-on rules.

use vectasim_core::FlightPhase::*;
use vectasim_core::flight::{GeoPoint, haversine_nm};
use vectasim_core::{FlightEvent, FlightSession, FlightState, MockFlight, MockVariant, ProviderEvent, SimEvent, Telemetry};

/// Synthetic flight with a consistent position: moves north at the sample's ground speed.
struct Sim {
    wall_ms: u64,
    sim_s: f64,
    lat: f64,
    step_ms: u64,
    events: Vec<FlightEvent>,
    session: FlightSession,
}

impl Sim {
    fn new(step_ms: u64) -> Self {
        Self { wall_ms: 1_000_000, sim_s: 36_000.0, lat: 50.0, step_ms, events: Vec::new(), session: FlightSession::new() }
    }

    fn sample(&mut self, f: &impl Fn(&mut Telemetry)) -> Telemetry {
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
        t
    }

    fn run(&mut self, secs: f64, f: impl Fn(&mut Telemetry)) {
        let n = (secs * 1000.0 / self.step_ms as f64).round() as u64;
        for _ in 0..n {
            self.wall_ms += self.step_ms;
            let dt = self.step_ms as f64 / 1000.0;
            self.sim_s += dt;
            let t = self.sample(&f);
            self.lat += t.ground_speed_kt * dt / 3_600.0 / 60.0;
            let ev = self.session.update(&t);
            self.events.extend(ev);
        }
    }

    /// Wall time passes without telemetry; the sim clock only runs if `sim_runs`.
    fn gap(&mut self, secs: f64, sim_runs: bool) {
        self.wall_ms += (secs * 1000.0) as u64;
        if sim_runs {
            self.sim_s += secs;
        }
    }

    fn sim_event(&mut self, e: SimEvent) {
        let ev = self.session.on_sim_event(&e);
        self.events.extend(ev);
    }

    fn reconnect(&mut self) {
        let ev = self.session.reset_position_context();
        self.events.extend(ev);
    }

    fn phases(&self) -> Vec<vectasim_core::FlightPhase> {
        self.events.iter().filter_map(|e| if let FlightEvent::PhaseChanged(tr) = e { Some(tr.to) } else { None }).collect()
    }

    fn touchdowns(&self) -> usize {
        self.events.iter().filter(|e| matches!(e, FlightEvent::Touchdown(_))).count()
    }

    fn ended(&self) -> Vec<bool> {
        self.events.iter().filter_map(|e| if let FlightEvent::FlightEnded { interrupted, .. } = e { Some(*interrupted) } else { None }).collect()
    }

    /// Taxi, take off and climb to a cruise at 8 000 ft.
    fn fly_to_cruise(&mut self) {
        self.run(10.0, ground(12.0));
        self.run(5.0, ground(90.0));
        self.climb(400.0, 8_000.0, 2_000.0, 220.0);
        self.run(90.0, air(8_000.0, 0.0, 250.0));
        assert_eq!(self.session.phase(), Cruise, "{:?}", self.phases());
    }

    /// Climb continuously (no MSL jumps) from `from` to `to` ft AGL.
    fn climb(&mut self, from: f64, to: f64, fpm: f64, gs: f64) {
        let secs = ((to - from).abs() / fpm.abs() * 60.0).round();
        let step = self.step_ms;
        let n = (secs * 1000.0 / step as f64) as u64;
        let vs = if to > from { fpm.abs() } else { -fpm.abs() };
        for i in 1..=n {
            let agl = from + (to - from) * i as f64 / n as f64;
            self.run(step as f64 / 1000.0, air(agl, vs, gs));
        }
    }

    /// Descend from cruise, fly the approach and land with ~ -150 fpm at the end.
    fn approach_and_land(&mut self) {
        self.climb(8_000.0, 3_000.0, 1_500.0, 240.0);
        self.climb(3_000.0, 20.0, 800.0, 150.0);
        self.run(2.0, |t| {
            air(10.0, -150.0, 140.0)(t);
        });
        self.run(10.0, |t| {
            ground(100.0)(t);
            t.touchdown_vs_fpm = 150.0;
        });
        self.run(15.0, |t| {
            ground(15.0)(t);
            t.touchdown_vs_fpm = 150.0;
        });
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

#[test]
fn reconnect_on_the_ground_is_not_a_landing() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    // link lost in cruise; the sim comes back with the aircraft on the ground (restart)
    sim.gap(120.0, true);
    sim.reconnect();
    // same place and MSL altitude (no teleport to hide behind): only the reset prevents the landing
    sim.run(30.0, |t| {
        ground(0.0)(t);
        t.altitude_msl_ft = 8_400.0;
    });
    assert!(!sim.session.summary().integrity.teleport_detected);
    assert_eq!(sim.touchdowns(), 0, "no touchdown from the first ground sample");
    assert!(!sim.phases().contains(&Landing), "{:?}", sim.phases());
    assert_eq!(sim.ended(), vec![true], "the flight cannot continue: interrupted");
    assert_eq!(sim.session.summary().state, FlightState::Interrupted);
    assert_eq!(sim.session.summary().landing_ms, None);
    // the next taxi is a new flight
    sim.run(5.0, ground(12.0));
    assert_eq!(sim.session.summary().state, FlightState::Active);
}

#[test]
fn reconnect_in_the_air_continues_the_flight() {
    let mut sim = Sim::new(250);
    sim.fly_to_cruise();
    sim.gap(10.0, true);
    sim.reconnect();
    sim.approach_and_land();
    assert_eq!(sim.touchdowns(), 1);
    let s = sim.session.summary();
    assert_eq!(s.state, FlightState::Active, "still open, taxiing in");
    assert_eq!(s.landing_rate_fpm, Some(-150.0));
    assert!(!s.integrity.teleport_detected);
}

#[test]
fn reconnect_in_a_ground_phase_keeps_the_flight() {
    let mut sim = Sim::new(1000);
    sim.run(10.0, ground(12.0));
    assert_eq!(sim.session.phase(), TaxiOut);
    sim.gap(15.0, true);
    sim.reconnect();
    sim.run(10.0, ground(12.0));
    assert_eq!(sim.session.summary().state, FlightState::Active);
    assert!(sim.ended().is_empty());
}

#[test]
fn flight_loaded_in_the_air_interrupts_without_touchdown() {
    let mut sim = Sim::new(500);
    sim.fly_to_cruise();
    sim.sim_event(SimEvent::FlightLoaded { path: "x.FLT".into() });
    assert_eq!(sim.ended(), vec![true]);
    let s = sim.session.summary().clone();
    assert_eq!(s.state, FlightState::Interrupted);
    assert_eq!(s.phase, Cruise, "keeps the phase it ended in");
    assert_eq!(sim.session.phase(), Preflight);
    // parked at another stand
    sim.lat = 51.0;
    sim.run(30.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
        t.parking_brake = true;
    });
    assert_eq!(sim.touchdowns(), 0);
    assert_eq!(sim.session.summary().state, FlightState::Interrupted);
    sim.run(5.0, ground(10.0));
    assert!(matches!(sim.events.iter().filter(|e| matches!(e, FlightEvent::FlightStarted { .. })).count(), 2));
}

#[test]
fn aircraft_loaded_and_sim_stop_only_reset() {
    let mut sim = Sim::new(500);
    sim.fly_to_cruise();
    sim.sim_event(SimEvent::AircraftLoaded { path: "a".into() });
    sim.sim_event(SimEvent::SimRunning { running: false });
    // main menu: whatever comes in is ignored
    sim.run(20.0, ground(0.0));
    assert!(sim.ended().is_empty());
    sim.sim_event(SimEvent::SimRunning { running: true });
    sim.run(30.0, air(8_000.0, 0.0, 250.0));
    assert_eq!(sim.session.summary().state, FlightState::Active);
    assert_eq!(sim.session.phase(), Cruise);
    sim.approach_and_land();
    assert_eq!(sim.touchdowns(), 1);
}

#[test]
fn teleport_in_the_air_flags_and_skips_the_distance() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    let before = sim.session.summary().distance_nm;
    let here = GeoPoint { latitude: sim.lat, longitude: 8.0 };
    sim.lat += 2.0; // 120 nm in one second
    sim.run(1.0, air(8_000.0, 0.0, 250.0));
    let s = sim.session.summary();
    assert!(s.integrity.teleport_detected);
    assert!(s.distance_nm - before < 0.2, "no distance over the jump: {} → {}", before, s.distance_nm);
    assert!(haversine_nm(here, GeoPoint { latitude: sim.lat, longitude: 8.0 }) > 100.0);
    assert_eq!(s.state, FlightState::Active, "the flight goes on");
    sim.run(60.0, air(8_000.0, 0.0, 250.0));
    let d = sim.session.summary().distance_nm - before;
    assert!((d - 250.0 * 61.0 / 3600.0).abs() < 0.3, "flown distance only: {d}");
    sim.approach_and_land();
    assert_eq!(sim.touchdowns(), 1);
}

#[test]
fn teleport_onto_the_ground_interrupts_without_touchdown() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.lat += 1.0;
    sim.run(20.0, ground(0.0));
    assert_eq!(sim.touchdowns(), 0);
    assert!(!sim.phases().contains(&Landing));
    assert_eq!(sim.ended(), vec![true]);
    assert!(sim.session.summary().integrity.teleport_detected);
}

#[test]
fn altitude_jump_is_a_teleport() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.run(1.0, air(30_000.0, 0.0, 250.0));
    assert!(sim.session.summary().integrity.teleport_detected);
}

#[test]
fn pause_without_telemetry_is_counted_and_cut_out_of_the_timers() {
    let mut sim = Sim::new(1000);
    sim.run(10.0, ground(12.0));
    sim.run(5.0, ground(90.0));
    sim.climb(400.0, 3_000.0, 2_000.0, 200.0);
    assert_eq!(sim.session.phase(), Climb);
    sim.run(30.0, air(3_000.0, 0.0, 200.0)); // half of the 60 s cruise dwell
    sim.gap(120.0, false); // paused, no samples, sim clock stands still
    sim.run(10.0, air(3_000.0, 0.0, 200.0));
    assert_eq!(sim.session.phase(), Climb, "the pause does not count towards the dwell");
    let i = &sim.session.summary().integrity;
    assert_eq!(i.pause_count, 1);
    assert!((120_000..=121_000).contains(&i.paused_ms), "{}", i.paused_ms);
    sim.run(25.0, air(3_000.0, 0.0, 200.0));
    assert_eq!(sim.session.phase(), Cruise);

    // a data gap with the sim clock running is not a pause
    sim.gap(8.0, true);
    sim.run(2.0, air(3_000.0, 0.0, 200.0));
    assert_eq!(sim.session.summary().integrity.pause_count, 1);
}

#[test]
fn pause_event_without_telemetry_is_a_pause() {
    let mut sim = Sim::new(1000);
    sim.run(10.0, ground(12.0));
    sim.sim_event(SimEvent::Paused { paused: true });
    // the provider's samples may not carry the flag: the event wins
    sim.run(20.0, ground(12.0));
    sim.gap(40.0, false);
    sim.sim_event(SimEvent::Paused { paused: false });
    sim.run(2.0, ground(12.0));
    let i = &sim.session.summary().integrity;
    assert_eq!(i.pause_count, 1);
    assert!((60_000..=62_000).contains(&i.paused_ms), "{}", i.paused_ms);
}

#[test]
fn takeoff_time_is_the_lift_off() {
    let mut sim = Sim::new(1000);
    sim.run(10.0, ground(12.0));
    sim.run(5.0, ground(100.0));
    let lift_off = sim.wall_ms + 1000;
    // slow initial climb: Climb only after 45 s airborne
    sim.climb(10.0, 1_400.0, 1_500.0, 160.0);
    sim.run(10.0, air(1_400.0, 0.0, 160.0));
    assert!(sim.phases().contains(&Climb));
    assert_eq!(sim.session.summary().takeoff_ms, Some(lift_off));
}

#[test]
fn parked_with_engines_running_is_not_on_block() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.approach_and_land();
    assert_eq!(sim.session.phase(), TaxiIn);
    // waiting for the stand with the parking brake set, engines running
    sim.run(300.0, |t| {
        ground(0.0)(t);
        t.parking_brake = true;
    });
    assert_eq!(sim.session.phase(), TaxiIn);
    assert!(sim.ended().is_empty());
    sim.run(30.0, ground(10.0));
    sim.run(10.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    assert_eq!(sim.session.phase(), Shutdown);
    assert_eq!(sim.ended(), vec![false]);
    assert_eq!(sim.session.summary().state, FlightState::Completed);
}

#[test]
fn parking_brake_for_ten_minutes_is_on_block() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.approach_and_land();
    sim.run(590.0, |t| {
        ground(0.0)(t);
        t.parking_brake = true;
    });
    assert_eq!(sim.session.phase(), TaxiIn);
    sim.run(15.0, |t| {
        ground(0.0)(t);
        t.parking_brake = true;
    });
    assert_eq!(sim.session.phase(), Shutdown);
    assert_eq!(sim.ended(), vec![false]);
}

/// Feed a mock variant's provider events like the app's forwarder does.
fn drive_mock(variant: MockVariant, secs: f64, hz: f64) -> (FlightSession, Vec<FlightEvent>) {
    let mut flight = MockFlight::with_variant(variant);
    let mut session = FlightSession::new();
    let mut events = Vec::new();
    let mut lost = false;
    for i in 1..=(secs * hz) as u64 {
        let t_s = i as f64 / hz;
        for pe in flight.step(t_s, 1_000_000 + (t_s * 1000.0) as u64) {
            match pe {
                ProviderEvent::Telemetry(t) => events.extend(session.update(&t)),
                ProviderEvent::Sim(e) => events.extend(session.on_sim_event(&e)),
                ProviderEvent::Disconnected { .. } => lost = true,
                ProviderEvent::Connected { .. } if std::mem::take(&mut lost) => events.extend(session.reset_position_context()),
                _ => {}
            }
        }
    }
    (session, events)
}

#[test]
fn mock_teleport_variant_interrupts_and_starts_over() {
    let flight = MockFlight::with_variant(MockVariant::Teleport);
    let tp = flight.teleport_seconds();
    let (session, events) = drive_mock(MockVariant::Teleport, MockVariant::Teleport.loop_seconds() + 60.0, 20.0);
    let phases: Vec<_> = events.iter().filter_map(|e| if let FlightEvent::PhaseChanged(tr) = e { Some(tr.to) } else { None }).collect();
    assert!(phases.contains(&Cruise) || phases.contains(&Climb), "airborne before the reload at {tp:.0} s: {phases:?}");
    assert!(!events.iter().any(|e| matches!(e, FlightEvent::Touchdown(_))), "no touchdown");
    let ended: Vec<_> = events.iter().filter_map(|e| if let FlightEvent::FlightEnded { interrupted, .. } = e { Some(*interrupted) } else { None }).collect();
    assert_eq!(ended, vec![true]);
    let started = events.iter().filter(|e| matches!(e, FlightEvent::FlightStarted { .. })).count();
    assert_eq!(started, 2, "the next loop is a new flight");
    assert_eq!(session.summary().state, FlightState::Active);
}

#[test]
fn mock_reconnect_variant_lands_once() {
    let (session, events) = drive_mock(MockVariant::Reconnect, MockVariant::Reconnect.loop_seconds() + 10.0, 20.0);
    let tds: Vec<_> = events.iter().filter_map(|e| if let FlightEvent::Touchdown(r) = e { Some(r.clone()) } else { None }).collect();
    assert_eq!(tds.len(), 1, "{tds:?}");
    assert!(tds[0].landing_rate_fpm < -100.0, "a real rate, not a reconnect artefact: {:?}", tds[0]);
    let s = session.summary();
    assert_eq!(s.state, FlightState::Completed);
    assert!(!s.integrity.teleport_detected);
    assert_eq!(s.integrity.pause_count, 0, "a link loss with the sim clock running is no pause");
}

// ---- start in the air ----------------------------------------------

#[test]
fn start_in_the_air_records_a_flight_from_there() {
    // connected mid-flight: the first sample is in the cruise
    let mut sim = Sim::new(500);
    sim.run(90.0, air(8_000.0, 0.0, 250.0));
    assert_eq!(sim.phases(), vec![Cruise], "straight into the phase the sample shows, no take-off");
    let started: Vec<u64> = sim.events.iter().filter_map(|e| if let FlightEvent::FlightStarted { timestamp_ms } = e { Some(*timestamp_ms) } else { None }).collect();
    assert_eq!(started, vec![1_000_500]);
    let s = sim.session.summary().clone();
    assert_eq!(s.state, FlightState::Active);
    assert_eq!(s.off_block_ms, Some(1_000_500), "block time from the start of the recording");
    assert_eq!(s.takeoff_ms, None, "no lift-off seen");
    assert!(s.departure.is_some());
    sim.approach_and_land();
    assert_eq!(sim.phases(), vec![Cruise, Descent, Approach, Final, Landing, TaxiIn]);
    assert_eq!(sim.touchdowns(), 1);
    sim.run(10.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    let s = sim.session.summary();
    assert_eq!(s.state, FlightState::Completed);
    assert!(s.landing_ms.is_some() && s.on_block_ms.is_some() && s.landing_rate_fpm.is_some());
    assert_eq!((s.takeoff_ms, s.flight_time_ms()), (None, None));
    assert!(s.block_time_ms().is_some());
    assert!(!s.integrity.teleport_detected);
}

#[test]
fn start_in_the_air_picks_the_phase_from_the_first_sample() {
    for (agl, vs, phase) in [(9_000.0, 1_500.0, Climb), (9_000.0, -1_500.0, Descent), (2_500.0, 0.0, Cruise), (2_500.0, -800.0, Approach), (900.0, -700.0, Final)] {
        let mut sim = Sim::new(500);
        sim.run(1.0, air(agl, vs, 200.0));
        assert_eq!(sim.phases(), vec![phase], "{agl} ft, {vs} fpm");
        assert_eq!(sim.session.summary().state, FlightState::Active);
    }
}

#[test]
fn start_on_short_final_lands_after_a_short_stretch_of_air_time() {
    // loaded at 600 ft on the final: below the 500 ft / 60 s qualification of a normal flight
    // only after the descent, so the short requalification of a start in the air applies
    let mut sim = Sim::new(500);
    sim.climb(600.0, 20.0, 700.0, 140.0);
    sim.run(2.0, air(10.0, -150.0, 140.0));
    sim.run(10.0, |t| {
        ground(100.0)(t);
        t.touchdown_vs_fpm = 150.0;
    });
    sim.run(15.0, |t| {
        ground(15.0)(t);
        t.touchdown_vs_fpm = 150.0;
    });
    assert_eq!(sim.phases(), vec![Final, Landing, TaxiIn]);
    assert_eq!(sim.touchdowns(), 1);
}

#[test]
fn airborne_in_preflight_after_ground_contact_is_a_take_off() {
    // the start-in-the-air rule needs the very first samples in the air
    let mut sim = Sim::new(500);
    sim.run(5.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    // (a continuous climb: ground to 3 000 ft from one sample to the next is a reposition)
    sim.climb(10.0, 3_000.0, 3_000.0, 200.0);
    assert_eq!(sim.phases(), vec![Takeoff, Climb]);
    assert!(sim.session.summary().takeoff_ms.is_some());
}

#[test]
fn mock_demo_loops_are_one_flight_each() {
    // every demo loop starts in the air after a `FlightLoaded`: one completed flight with one
    // landing per loop, never interrupted, never a teleport
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let (hz, loops) = (20.0, 3);
    let mut done = Vec::new();
    let mut started = 0;
    for i in 1..=((loops as f64 * MockFlight::loop_seconds() + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        for pe in flight.step(t_s, 1_000_000 + (t_s * 1000.0) as u64) {
            let evs = match pe {
                ProviderEvent::Telemetry(t) => session.update(&t),
                ProviderEvent::Sim(e) => session.on_sim_event(&e),
                _ => Vec::new(),
            };
            for e in evs {
                match e {
                    FlightEvent::FlightStarted { .. } => started += 1,
                    FlightEvent::FlightEnded { interrupted, .. } => done.push((interrupted, session.summary().clone())),
                    _ => {}
                }
            }
        }
    }
    assert_eq!(started, loops + 1);
    assert_eq!(done.len(), loops);
    for (interrupted, s) in &done {
        assert!(!interrupted);
        assert_eq!(s.state, FlightState::Completed);
        assert_eq!(s.touchdowns.len(), 1);
        assert!(s.landing_ms.is_some() && s.on_block_ms.is_some() && s.takeoff_ms.is_none());
        assert!(!s.integrity.teleport_detected);
    }
    assert_eq!((session.summary().state, session.phase()), (FlightState::Active, Cruise));
}

// ---- time base ------------------------------------------------------

/// Final approach down to 10 ft AGL from the cruise of `fly_to_cruise`.
fn to_short_final(sim: &mut Sim) {
    sim.climb(8_000.0, 3_000.0, 1_500.0, 240.0);
    sim.climb(3_000.0, 20.0, 800.0, 150.0);
    sim.run(2.0, air(10.0, -150.0, 140.0));
}

fn touchdown_reports(sim: &Sim) -> Vec<vectasim_core::TouchdownReport> {
    sim.events.iter().filter_map(|e| if let FlightEvent::Touchdown(r) = e { Some(r.clone()) } else { None }).collect()
}

#[test]
fn clock_stepping_back_an_hour_does_not_stall_the_flight() {
    let mut sim = Sim::new(1000);
    sim.wall_ms = 1_792_137_600_000; // a real epoch time, so stepping back an hour stays positive
    sim.fly_to_cruise();
    let before = sim.session.summary().distance_nm;
    sim.wall_ms -= 3_600_000; // NTP or manual correction of the system clock
    sim.run(60.0, air(8_000.0, 0.0, 250.0));
    let d = sim.session.debug_state();
    assert_eq!(d.clock_jumps, 1);
    assert_eq!(d.last_skip, None, "samples are evaluated right after the step");
    let flown = sim.session.summary().distance_nm - before;
    assert!((flown - 250.0 * 60.0 / 3600.0).abs() < 0.3, "distance keeps integrating: {flown}");
    sim.approach_and_land();
    assert_eq!(sim.touchdowns(), 1);
    assert!(sim.phases().ends_with(&[Descent, Approach, Final, Landing, TaxiIn]), "{:?}", sim.phases());
    let s = sim.session.summary();
    assert_eq!(s.landing_rate_fpm, Some(-150.0));
    assert!(!s.integrity.teleport_detected);
    assert_eq!(s.integrity.pause_count, 0, "a clock step is no pause");
    // timestamps stay wall clock, on the corrected scale
    let landing = s.landing_ms.unwrap();
    assert!(landing <= sim.wall_ms && landing > sim.wall_ms - 60_000, "{landing} vs {}", sim.wall_ms);
}

#[test]
fn clock_step_inside_the_bounce_window_still_settles_the_touchdown() {
    let mut sim = Sim::new(250);
    sim.fly_to_cruise();
    to_short_final(&mut sim);
    sim.run(1.0, |t| {
        ground(120.0)(t);
        t.touchdown_vs_fpm = 150.0;
    });
    let contact_wall = sim.wall_ms - 750;
    sim.wall_ms -= 600_000; // ten minutes back, right after the first contact
    sim.run(10.0, |t| {
        ground(100.0)(t);
        t.touchdown_vs_fpm = 150.0;
    });
    sim.run(15.0, |t| {
        ground(15.0)(t);
        t.touchdown_vs_fpm = 150.0;
    });
    let tds = touchdown_reports(&sim);
    assert_eq!(tds.len(), 1, "confirmed and reported without waiting ten minutes");
    assert_eq!((tds[0].landing_rate_fpm, tds[0].bounces), (-150.0, 0));
    assert_eq!(tds[0].timestamp_ms, contact_wall, "first contact keeps its wall-clock time");
    assert_eq!(sim.session.phase(), TaxiIn);
}

#[test]
fn pause_right_after_the_first_contact_keeps_the_bounce_in_the_same_event() {
    let mut sim = Sim::new(250);
    sim.fly_to_cruise();
    to_short_final(&mut sim);
    sim.run(0.5, |t| {
        ground(125.0)(t);
        t.touchdown_vs_fpm = 320.0;
    });
    // paused for 10 s, i.e. twice the bounce window, while the gear is on the runway
    sim.run(10.0, |t| {
        ground(125.0)(t);
        t.touchdown_vs_fpm = 320.0;
        t.paused = true;
    });
    // … and after the pause the aircraft bounces once
    sim.run(1.0, |t| {
        air(4.0, 150.0, 122.0)(t);
        t.touchdown_vs_fpm = 320.0;
    });
    sim.run(10.0, |t| {
        ground(100.0)(t);
        t.touchdown_vs_fpm = 180.0;
    });
    sim.run(15.0, |t| {
        ground(15.0)(t);
        t.touchdown_vs_fpm = 180.0;
    });
    let tds = touchdown_reports(&sim);
    assert_eq!(tds.len(), 1, "{tds:?}");
    assert_eq!(tds[0].bounces, 1, "the bounce after the pause belongs to the same landing");
    assert_eq!(tds[0].landing_rate_fpm, -320.0, "worst contact of the event");
    assert_eq!(sim.session.summary().integrity.pause_count, 1);
}

#[test]
fn time_acceleration_is_skipped_by_phase_engine_and_detector_alike() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.climb(8_000.0, 3_000.0, 1_500.0, 240.0);
    // fast-forward through final and touchdown
    sim.climb(3_000.0, 20.0, 800.0, 150.0);
    sim.run(20.0, |t| {
        ground(110.0)(t);
        t.touchdown_vs_fpm = 260.0;
        t.sim_rate = 4.0;
    });
    assert_eq!(sim.touchdowns(), 0, "no report from fast-forwarded samples");
    assert!(!sim.phases().contains(&Landing), "{:?}", sim.phases());
    assert!(sim.session.summary().integrity.time_acceleration_detected);
    assert!((sim.session.summary().integrity.max_sim_rate - 4.0).abs() < 1e-9);
    // back to 1× on the runway: both see the landing at the first real-time sample
    sim.run(6.0, |t| {
        ground(80.0)(t);
        t.touchdown_vs_fpm = 260.0;
    });
    sim.run(10.0, |t| {
        ground(15.0)(t);
        t.touchdown_vs_fpm = 260.0;
    });
    assert!(sim.phases().ends_with(&[Landing, TaxiIn]), "{:?}", sim.phases());
    let tds = touchdown_reports(&sim);
    assert_eq!(tds.len(), 1);
    assert_eq!(tds[0].landing_rate_fpm, -260.0, "the sim's own touchdown value");
    assert_eq!(tds[0].vs_fpm_measured, 0.0, "no V/S from before the skipped stretch");
}

// ---- ground and pattern scenarios --------------------------------------------------------

#[test]
fn pushback_starts_the_flight_and_hands_over_to_taxi() {
    let mut sim = Sim::new(500);
    let parked = |t: &mut Telemetry| {
        ground(0.0)(t);
        t.engines_running = 0;
        t.parking_brake = true;
    };
    sim.run(10.0, parked);
    assert_eq!(sim.session.summary().state, FlightState::Idle);
    let push_start = sim.wall_ms;
    sim.run(30.0, |t| {
        ground(3.0)(t); // pushed backwards by the tug, brake released, engines off
        t.engines_running = 0;
    });
    sim.run(20.0, |t| {
        ground(0.0)(t); // engine start on the push line
        t.engines_running = 1;
    });
    sim.run(20.0, ground(12.0));
    assert_eq!(sim.phases(), vec![Pushback, TaxiOut]);
    let s = sim.session.summary();
    assert_eq!(s.state, FlightState::Active);
    let off_block = s.off_block_ms.unwrap();
    assert!(off_block > push_start && off_block <= push_start + 2_500, "off-block is the start of the push: {off_block}");
    assert_eq!(sim.events.iter().filter(|e| matches!(e, FlightEvent::FlightStarted { .. })).count(), 1);
}

#[test]
fn rejected_takeoff_keeps_the_flight_open_without_a_takeoff_time() {
    let mut sim = Sim::new(500);
    sim.run(10.0, ground(12.0));
    sim.run(6.0, ground(80.0));
    sim.run(10.0, ground(20.0)); // abort, back below 40 kt without having flown
    assert_eq!(sim.phases(), vec![TaxiOut, Takeoff, TaxiOut]);
    let s = sim.session.summary();
    assert_eq!((s.state, s.takeoff_ms, s.touchdowns.len()), (FlightState::Active, None, 0));
    assert!(sim.ended().is_empty());
    // the second attempt flies; still one flight
    sim.run(5.0, ground(100.0));
    let lift_off = sim.wall_ms + 500;
    sim.climb(10.0, 2_000.0, 2_000.0, 160.0);
    assert!(sim.phases().ends_with(&[TaxiOut, Takeoff, Climb]), "{:?}", sim.phases());
    assert_eq!(sim.session.summary().takeoff_ms, Some(lift_off));
    assert_eq!(sim.events.iter().filter(|e| matches!(e, FlightEvent::FlightStarted { .. })).count(), 1);
}

#[test]
fn touch_and_go_series_then_full_stop() {
    let mut sim = Sim::new(500);
    sim.run(10.0, ground(12.0));
    sim.run(5.0, ground(90.0));
    let lift_off = sim.wall_ms + 500;
    sim.climb(10.0, 1_000.0, 1_000.0, 110.0);
    let circuit = |sim: &mut Sim, roll_s: f64, sim_fpm: f64| {
        sim.run(40.0, air(1_000.0, 0.0, 110.0));
        sim.climb(1_000.0, 20.0, 700.0, 90.0);
        sim.run(1.0, air(5.0, -200.0, 80.0));
        sim.run(roll_s, |t| {
            ground(75.0)(t);
            t.touchdown_vs_fpm = sim_fpm;
        });
    };
    // Outcome after rollout: this test used to keep every roll inside the detector's 5 s bounce
    // window, because a longer roll was reported as a full stop when the window closed. The
    // outcome is now decided after the rollout, so the series has realistic 12 s and 18 s
    // rolls next to a short 3 s one.
    for (roll_s, fpm) in [(3.0, 210.0), (12.0, 340.0), (18.0, 180.0)] {
        circuit(&mut sim, roll_s, fpm);
        // power up and climb out again, the sim keeps showing this contact's value
        sim.climb(20.0, 1_000.0, 1_000.0, 90.0);
    }
    circuit(&mut sim, 10.0, 150.0);
    sim.run(15.0, |t| {
        ground(15.0)(t);
        t.touchdown_vs_fpm = 150.0;
    });

    // the summary carries the decided outcome of every touchdown …
    let s = sim.session.summary();
    let got: Vec<(f64, bool)> = s.touchdowns.iter().map(|r| (r.landing_rate_fpm, r.touch_and_go)).collect();
    assert_eq!(got, vec![(-210.0, true), (-340.0, true), (-180.0, true), (-150.0, false)]);
    // … the event only where it was decided before the report went out (the short roll
    // climbed away inside the window); the long rolls are corrected by their outcome
    let tds = touchdown_reports(&sim);
    assert_eq!(tds.iter().map(|r| r.touch_and_go).collect::<Vec<_>>(), vec![true, false, false, false]);
    assert_eq!(sim.session.pending_touchdown(), None);
    assert_eq!(sim.phases().iter().filter(|p| **p == Landing).count(), 4, "{:?}", sim.phases());
    let s = sim.session.summary();
    assert_eq!(s.landing_rate_fpm, Some(-150.0), "the full stop, not the hardest touch-and-go");
    assert_eq!(s.takeoff_ms, Some(lift_off), "the first lift-off stays the take-off");
    assert_eq!((s.state, sim.session.phase()), (FlightState::Active, TaxiIn));
}

// ---- audit 0.5.0 fix wave (H1, H2, M1, M2, M5, N1, N2) ------------------------------------

fn flicker(gs: f64) -> impl Fn(&mut Telemetry) {
    move |t| {
        ground(gs)(t);
        t.on_ground = false;
        t.altitude_agl_ft = 1.0;
    }
}

fn parked(t: &mut Telemetry) {
    ground(0.0)(t);
    t.engines_running = 0;
    t.parking_brake = true;
}

fn flight_starts(sim: &Sim) -> usize {
    sim.events.iter().filter(|e| matches!(e, FlightEvent::FlightStarted { .. })).count()
}

fn phases_after_landing(sim: &Sim) -> Vec<vectasim_core::FlightPhase> {
    let p = sim.phases();
    let i = p.iter().rposition(|x| *x == Landing).expect("landed");
    p[i + 1..].to_vec()
}

#[test]
fn not_on_ground_flicker_in_taxi_in_is_no_take_off() {
    // H1: one uncorroborated sample (1 Hz) or two frames (X-Plane at 10 Hz) used to fire
    // TaxiIn → Takeoff → TaxiOut, and the flight never reached Shutdown
    for (step, secs) in [(1000, 1.0), (100, 0.2)] {
        let mut sim = Sim::new(step);
        sim.fly_to_cruise();
        sim.approach_and_land();
        assert_eq!(sim.session.phase(), TaxiIn);
        sim.run(5.0, ground(12.0));
        sim.run(secs, flicker(12.0));
        sim.run(20.0, ground(12.0));
        sim.run(10.0, |t| {
            ground(0.0)(t);
            t.engines_running = 0;
        });
        assert_eq!(phases_after_landing(&sim), vec![TaxiIn, Shutdown], "{step} ms");
        assert_eq!(sim.ended(), vec![false]);
        assert_eq!(sim.session.summary().state, FlightState::Completed);
    }
}

#[test]
fn not_on_ground_flicker_on_the_stand_starts_no_ghost_flight() {
    // H2: after on-block (and in Preflight once the ground was seen) one sample started a flight
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.approach_and_land();
    sim.run(10.0, parked);
    assert_eq!((sim.session.phase(), sim.ended()), (Shutdown, vec![false]));
    sim.run(1.0, |t| {
        parked(t);
        flicker(0.0)(t);
    });
    sim.run(30.0, parked);
    assert_eq!(flight_starts(&sim), 1, "{:?}", sim.phases());
    assert_eq!((sim.session.phase(), sim.session.summary().state), (Shutdown, FlightState::Completed));

    let mut sim = Sim::new(1000);
    sim.run(10.0, parked);
    sim.run(1.0, |t| {
        parked(t);
        flicker(0.0)(t);
    });
    sim.run(30.0, parked);
    assert!(sim.phases().is_empty(), "{:?}", sim.phases());
    assert_eq!(sim.session.summary().state, FlightState::Idle);
}

#[test]
fn taxi_out_back_to_the_stand_with_engines_off_closes_the_flight() {
    let mut sim = Sim::new(1000);
    sim.run(20.0, ground(12.0));
    assert_eq!(sim.session.phase(), TaxiOut);
    // holding short for 20 min with the brake set and the engines running: no on-block
    sim.run(1_200.0, |t| {
        ground(0.0)(t);
        t.parking_brake = true;
    });
    assert_eq!(sim.session.phase(), TaxiOut);
    assert!(sim.ended().is_empty());
    // back to the stand, engines off
    sim.run(20.0, ground(10.0));
    sim.run(25.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    assert_eq!(sim.session.phase(), TaxiOut, "30 s dwell");
    sim.run(10.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    assert_eq!(sim.session.phase(), Shutdown);
    assert_eq!(sim.ended(), vec![false]);
    let s = sim.session.summary().clone();
    // never flew: a ground session, discarded rather than completed
    assert_eq!((s.state, s.takeoff_ms), (FlightState::Discarded, None));
    let d = sim.session.take_discarded_flights();
    assert_eq!(d.len(), 1);
    assert!(d[0].shut_down && d[0].off_block_ms == s.off_block_ms && Some(d[0].timestamp_ms) == s.on_block_ms);
}

#[test]
fn fast_taxi_after_landing_returns_to_taxi_in() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.approach_and_land();
    sim.run(4.0, ground(45.0)); // backtracking fast: looks like a take-off roll
    sim.run(10.0, ground(15.0));
    assert_eq!(sim.session.phase(), TaxiIn, "{:?}", sim.phases());
    sim.run(10.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    assert_eq!(phases_after_landing(&sim), vec![TaxiIn, Takeoff, TaxiIn, Shutdown]);
    assert_eq!(sim.session.summary().state, FlightState::Completed);
}

#[test]
fn lift_off_without_a_take_off_roll_keeps_its_time() {
    // engines off, below 40 kt (glider on a winch, STOL): Takeoff once above 50 ft, the
    // take-off time is still the first airborne sample
    let mut sim = Sim::new(500);
    sim.run(5.0, |t| {
        ground(0.0)(t);
        t.engines_running = 0;
    });
    sim.run(5.0, |t| {
        ground(30.0)(t);
        t.engines_running = 0;
    });
    let lift_off = sim.wall_ms + 500;
    for i in 1..=120 {
        let agl = 2.0 + i as f64 * 5.0;
        sim.run(0.5, move |t| {
            air(agl, 600.0, 35.0)(t);
            t.engines_running = 0;
        });
    }
    assert_eq!(sim.phases(), vec![Takeoff, Climb]);
    assert_eq!(sim.session.summary().takeoff_ms, Some(lift_off));
}

/// Down from the cruise to `agl` ft on the final.
fn to_final(sim: &mut Sim, agl: f64) {
    sim.climb(8_000.0, 3_000.0, 1_500.0, 240.0);
    sim.climb(3_000.0, agl, 700.0, 140.0);
}

fn land_from(sim: &mut Sim, agl: f64) {
    sim.climb(agl, 10.0, 700.0, 140.0);
    sim.run(10.0, |t| {
        ground(100.0)(t);
        t.touchdown_vs_fpm = 180.0;
    });
    sim.run(15.0, |t| {
        ground(15.0)(t);
        t.touchdown_vs_fpm = 180.0;
    });
}

#[test]
fn reset_on_short_final_with_a_continuous_position_keeps_the_landing() {
    // M1: a reconnect, an aircraft reload or the ESC menu at 80 ft used to end the flight as
    // interrupted, lose the landing and start a ghost flight from the rollout
    for kind in ["reconnect", "aircraftLoaded", "simStopped"] {
        let mut sim = Sim::new(250);
        sim.fly_to_cruise();
        to_final(&mut sim, 80.0);
        match kind {
            "reconnect" => {
                sim.gap(2.0, true);
                sim.reconnect();
            }
            "aircraftLoaded" => sim.sim_event(SimEvent::AircraftLoaded { path: "a".into() }),
            _ => {
                sim.sim_event(SimEvent::SimRunning { running: false });
                sim.run(1.0, air(78.0, -700.0, 140.0)); // ignored
                sim.sim_event(SimEvent::SimRunning { running: true });
            }
        }
        land_from(&mut sim, 75.0);
        assert!(sim.ended().is_empty(), "{kind}: {:?}", sim.phases());
        assert_eq!(flight_starts(&sim), 1, "{kind}");
        assert_eq!(sim.touchdowns(), 1, "{kind}");
        assert!(sim.phases().ends_with(&[Final, Landing, TaxiIn]), "{kind}: {:?}", sim.phases());
        let s = sim.session.summary();
        assert_eq!((s.state, s.landing_rate_fpm), (FlightState::Active, Some(-180.0)), "{kind}");
        assert!(s.landing_ms.is_some());
    }
}

#[test]
fn slew_or_fast_forward_down_to_the_ground_is_an_unrated_touchdown() {
    // M2: slewed / fast-forwarded down without a sim value – the 0 fpm of the ground sample
    // used to become the flight's landing rate
    for mode in ["slew", "rate"] {
        let mut sim = Sim::new(1000);
        sim.fly_to_cruise();
        sim.climb(8_000.0, 3_000.0, 1_500.0, 240.0);
        let skipped = move |t: &mut Telemetry| {
            if mode == "slew" {
                t.slew = true;
            } else {
                t.sim_rate = 4.0;
            }
        };
        for agl in [2_500.0, 2_000.0, 1_500.0, 1_000.0, 500.0, 50.0] {
            sim.run(1.0, move |t| {
                air(agl, -3_000.0, 0.0)(t);
                skipped(t);
            });
        }
        sim.run(5.0, move |t| {
            ground(0.0)(t);
            skipped(t);
        });
        sim.run(10.0, ground(0.0));
        let tds = touchdown_reports(&sim);
        assert_eq!(tds.len(), 1, "{mode}: the touchdown is recorded");
        assert_eq!(tds[0].landing_rate_source, vectasim_core::LandingRateSource::Unrated, "{mode}: {:?}", tds[0]);
        let s = sim.session.summary();
        assert_eq!(s.landing_rate_fpm, None, "{mode}: not the flight's landing rate");
        assert!(s.landing_ms.is_some(), "{mode}");
        assert!(s.integrity.slew_detected || s.integrity.time_acceleration_detected, "{mode}");
    }
}

#[test]
fn first_sample_just_off_the_ground_at_the_gate_is_no_start_in_the_air() {
    // M5: 1 ft AGL, 0 kt, "not on ground" while the aircraft settles at the stand
    let mut sim = Sim::new(500);
    sim.run(1.0, |t| {
        parked(t);
        flicker(0.0)(t);
    });
    sim.run(10.0, parked);
    assert!(sim.phases().is_empty(), "{:?}", sim.phases());
    assert_eq!(sim.session.summary().state, FlightState::Idle);
    sim.run(20.0, ground(12.0));
    sim.run(5.0, ground(100.0));
    sim.climb(10.0, 2_000.0, 2_000.0, 160.0);
    assert_eq!(sim.phases(), vec![TaxiOut, Takeoff, Climb]);
    assert!(sim.session.summary().takeoff_ms.is_some());
}

#[test]
fn go_around_circuit_is_no_cruise() {
    // N1: the downwind after the go-around was "Cruise"
    let (_, events) = drive_mock(MockVariant::GoAround, MockVariant::GoAround.loop_seconds(), 20.0);
    let phases: Vec<_> = events.iter().filter_map(|e| if let FlightEvent::PhaseChanged(tr) = e { Some(tr.to) } else { None }).collect();
    let ga = phases.windows(2).position(|w| w == [Final, Climb]).expect("go-around") + 1;
    let landing = phases.iter().position(|p| *p == Landing).expect("landing");
    assert_eq!(&phases[ga..=landing], &[Climb, Descent, Approach, Final, Landing], "{phases:?}");
}

#[test]
fn pause_right_after_lift_off_keeps_the_take_off_time() {
    // N2: a pause in the 45 s before Climb moved the take-off time by its length
    let mut sim = Sim::new(1000);
    sim.run(10.0, ground(12.0));
    sim.run(5.0, ground(100.0));
    let lift_off = sim.wall_ms + 1000;
    sim.climb(10.0, 400.0, 1_000.0, 140.0);
    sim.run(120.0, |t| {
        air(400.0, 0.0, 0.0)(t);
        t.paused = true;
    });
    sim.climb(400.0, 1_000.0, 1_000.0, 140.0);
    assert!(sim.phases().contains(&Climb), "{:?}", sim.phases());
    assert_eq!(sim.session.summary().takeoff_ms, Some(lift_off));
    assert_eq!(sim.session.summary().integrity.pause_count, 1);
}

// ---- ground sessions and the "scenery test" (discarded, not a flight) --------------------

fn flight_ended_states(sim: &Sim) -> Vec<bool> {
    sim.ended()
}

/// Taxi at airport A for 20 s: the flight starts as TaxiOut.
fn taxi_at_a(sim: &mut Sim) {
    sim.run(20.0, ground(12.0));
    assert_eq!((sim.session.phase(), sim.session.summary().state), (TaxiOut, FlightState::Active));
}

/// Main menu, then a new flight at airport B (~180 nm north): the events MSFS sends.
fn load_at_b(sim: &mut Sim, flight_loaded: bool) {
    sim.sim_event(SimEvent::SimRunning { running: false });
    sim.gap(60.0, false);
    if flight_loaded {
        sim.sim_event(SimEvent::FlightLoaded { path: "b.FLT".into() });
    }
    sim.sim_event(SimEvent::AircraftLoaded { path: "a".into() });
    sim.lat += 3.0;
    sim.sim_event(SimEvent::SimRunning { running: true });
}

#[test]
fn scenery_test_taxi_at_a_then_on_the_ground_at_b_discards_a() {
    for flight_loaded in [true, false] {
        let mut sim = Sim::new(1000);
        taxi_at_a(&mut sim);
        let a_off_block = sim.session.summary().off_block_ms;
        load_at_b(&mut sim, flight_loaded);
        sim.run(10.0, parked);
        assert_eq!(flight_ended_states(&sim), vec![true], "loaded={flight_loaded}");
        assert_eq!(sim.session.summary().state, FlightState::Discarded, "loaded={flight_loaded}");
        let d = sim.session.take_discarded_flights();
        assert_eq!(d.len(), 1, "loaded={flight_loaded}");
        assert_eq!((d[0].off_block_ms, d[0].shut_down), (a_off_block, false));
        assert_eq!(sim.session.phase(), Preflight, "recording starts over at B");
        // B: the next taxi is a new flight departing from B
        let b_lat = sim.lat;
        sim.run(20.0, ground(12.0));
        assert_eq!(flight_starts(&sim), 2);
        let s = sim.session.summary();
        assert_eq!(s.state, FlightState::Active);
        assert!((s.departure.unwrap().latitude - b_lat).abs() < 0.01, "{:?}", s.departure);
    }
}

#[test]
fn scenery_test_taxi_at_a_then_in_the_air_at_b_lands_as_a_new_flight() {
    // with the events MSFS sends, and as a bare position jump from the ground into the air
    for with_events in [true, false] {
        let mut sim = Sim::new(500);
        taxi_at_a(&mut sim);
        if with_events {
            load_at_b(&mut sim, true);
        } else {
            sim.lat += 3.0;
        }
        let b_lat = sim.lat;
        sim.climb(600.0, 20.0, 700.0, 140.0);
        sim.run(2.0, air(10.0, -150.0, 140.0));
        sim.run(10.0, |t| {
            ground(100.0)(t);
            t.touchdown_vs_fpm = 150.0;
        });
        sim.run(15.0, |t| {
            ground(15.0)(t);
            t.touchdown_vs_fpm = 150.0;
        });
        assert_eq!(sim.ended(), vec![true], "events={with_events}: A ended");
        assert_eq!(sim.session.take_discarded_flights().len(), 1, "events={with_events}");
        assert_eq!(flight_starts(&sim), 2, "events={with_events}");
        let s = sim.session.summary();
        assert_eq!(s.state, FlightState::Active, "events={with_events}");
        assert_eq!((s.takeoff_ms, s.touchdowns.len()), (None, 1), "events={with_events}: a start in the air at B");
        assert!(s.departure.unwrap().latitude >= b_lat - 0.01, "events={with_events}: not departing from A: {:?}", s.departure);
        assert!(!s.integrity.teleport_detected, "events={with_events}");
        assert!(sim.phases().ends_with(&[Final, Landing, TaxiIn]), "events={with_events}: {:?}", sim.phases());
    }
}

#[test]
fn esc_menu_or_aircraft_change_in_place_keeps_the_taxi() {
    let mut sim = Sim::new(1000);
    taxi_at_a(&mut sim);
    sim.sim_event(SimEvent::SimRunning { running: false });
    sim.gap(30.0, false);
    sim.sim_event(SimEvent::SimRunning { running: true });
    sim.run(10.0, ground(12.0));
    sim.sim_event(SimEvent::AircraftLoaded { path: "b".into() });
    sim.run(10.0, ground(12.0));
    assert!(sim.ended().is_empty());
    assert_eq!((sim.session.phase(), sim.session.summary().state), (TaxiOut, FlightState::Active));
    assert!(sim.session.take_discarded_flights().is_empty());
}

#[test]
fn provider_stop_before_flying_discards_and_after_flying_interrupts() {
    let mut sim = Sim::new(1000);
    taxi_at_a(&mut sim);
    let ts = sim.wall_ms;
    sim.events.extend(sim.session.interrupt(ts));
    assert_eq!((sim.ended(), sim.session.summary().state), (vec![true], FlightState::Discarded));
    assert_eq!(sim.session.take_discarded_flights().len(), 1);

    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    let ts = sim.wall_ms;
    sim.events.extend(sim.session.interrupt(ts));
    assert_eq!((sim.ended(), sim.session.summary().state), (vec![true], FlightState::Interrupted));
    assert!(sim.session.take_discarded_flights().is_empty());
}

#[test]
fn real_flight_is_completed_and_never_discarded() {
    let mut sim = Sim::new(1000);
    sim.fly_to_cruise();
    sim.approach_and_land();
    sim.run(10.0, parked);
    assert_eq!((sim.ended(), sim.session.summary().state), (vec![false], FlightState::Completed));
    assert!(sim.session.take_discarded_flights().is_empty());
}
