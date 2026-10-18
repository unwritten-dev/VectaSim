//! Full stop vs. touch-and-go is decided after the rollout: the touchdown
//! report (landing rate) comes right after the bounce window, the outcome follows when the
//! aircraft slowed below 30 kt, climbed away, timed out (120 s) or the stream broke off.

use vectasim_core::FlightPhase::*;
use vectasim_core::flight::TouchdownOutcomeEvent;
use vectasim_core::touchdown::TouchdownOutcome::{self, *};
use vectasim_core::{FlightEvent, FlightSession, FlightState, SimEvent, Telemetry, TouchdownReport};

/// Synthetic flight with a consistent position (moves north at the sample's GS), so no
/// sample looks like a teleport. Collects events and outcomes with the sample time.
struct Sim {
    wall_ms: u64,
    sim_s: f64,
    lat: f64,
    step_ms: u64,
    session: FlightSession,
    events: Vec<(u64, FlightEvent)>,
    outcomes: Vec<TouchdownOutcomeEvent>,
}

impl Sim {
    fn new(step_ms: u64) -> Self {
        Self {
            wall_ms: 1_000_000,
            sim_s: 36_000.0,
            lat: 50.0,
            step_ms,
            session: FlightSession::new(),
            events: Vec::new(),
            outcomes: Vec::new(),
        }
    }

    fn run(&mut self, secs: f64, f: impl Fn(&mut Telemetry)) {
        let n = (secs * 1000.0 / self.step_ms as f64).round() as u64;
        for _ in 0..n {
            self.wall_ms += self.step_ms;
            let dt = self.step_ms as f64 / 1000.0;
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
            let ev = self.session.update(&t);
            self.collect(ev);
        }
    }

    fn collect(&mut self, ev: Vec<FlightEvent>) {
        let ts = self.wall_ms;
        self.events.extend(ev.into_iter().map(|e| (ts, e)));
        self.outcomes.extend(self.session.take_touchdown_outcomes());
    }

    /// Climb/descend continuously from `from` to `to` ft AGL.
    fn climb(&mut self, from: f64, to: f64, fpm: f64, gs: f64) {
        let n = ((to - from).abs() / fpm.abs() * 60.0 * 1000.0 / self.step_ms as f64).round().max(1.0) as u64;
        let vs = if to > from { fpm.abs() } else { -fpm.abs() };
        for i in 1..=n {
            let agl = from + (to - from) * i as f64 / n as f64;
            self.run(self.step_ms as f64 / 1000.0, air(agl, vs, gs));
        }
    }

    /// Taxi, take off, fly a 1 500 ft circuit and come down to 5 ft on short final.
    fn fly_to_short_final(&mut self) {
        self.run(10.0, ground(12.0));
        self.run(5.0, ground(90.0));
        self.climb(10.0, 1_500.0, 1_500.0, 130.0);
        self.run(30.0, air(1_500.0, 0.0, 130.0));
        self.short_final_from(1_500.0);
    }

    fn short_final_from(&mut self, agl: f64) {
        self.climb(agl, 20.0, 700.0, 120.0);
        self.run(1.0, air(5.0, -180.0, 115.0));
    }

    /// Ground roll for `secs`, GS going linearly from `from_kt` to `to_kt`; the sim shows `sim_fpm`.
    fn roll(&mut self, secs: f64, from_kt: f64, to_kt: f64, sim_fpm: f64) {
        let n = (secs * 1000.0 / self.step_ms as f64).round() as u64;
        for i in 1..=n {
            let gs = from_kt + (to_kt - from_kt) * i as f64 / n as f64;
            self.run(self.step_ms as f64 / 1000.0, move |t| {
                ground(gs)(t);
                t.touchdown_vs_fpm = sim_fpm;
            });
        }
    }

    fn touchdowns(&self) -> Vec<(u64, TouchdownReport)> {
        self.events.iter().filter_map(|(ts, e)| if let FlightEvent::Touchdown(r) = e { Some((*ts, r.clone())) } else { None }).collect()
    }

    fn outcome_kinds(&self) -> Vec<TouchdownOutcome> {
        self.outcomes.iter().map(|o| o.outcome).collect()
    }

    fn phases(&self) -> Vec<vectasim_core::FlightPhase> {
        self.events.iter().filter_map(|(_, e)| if let FlightEvent::PhaseChanged(tr) = e { Some(tr.to) } else { None }).collect()
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
fn touch_and_go_with_a_15_s_roll_is_a_touch_and_go() {
    let mut sim = Sim::new(250);
    sim.fly_to_short_final();
    let contact = sim.wall_ms + 250;
    // 15 s on the runway, never below 30 kt: flaps reset, power up …
    sim.roll(15.0, 80.0, 60.0, 190.0);
    let tds = sim.touchdowns();
    assert_eq!(tds.len(), 1, "the landing rate is out before the decision: {tds:?}");
    let (sent_at, r) = &tds[0];
    assert_eq!(r.timestamp_ms, contact);
    assert!(*sent_at - contact <= 6_000, "reported at the end of the bounce window, {} ms after contact", sent_at - contact);
    assert_eq!((r.landing_rate_fpm, r.touch_and_go), (-190.0, false), "not decided yet when reported");
    assert_eq!(sim.session.pending_touchdown(), Some(0));
    assert!(sim.outcomes.is_empty());
    let s = sim.session.summary();
    assert_eq!((s.landing_rate_fpm, s.landing_ms), (None, None), "nothing provisional while rolling");

    // … and off again
    sim.climb(10.0, 1_000.0, 800.0, 90.0);
    assert_eq!(sim.outcome_kinds(), vec![TouchAndGo]);
    let o = &sim.outcomes[0];
    assert_eq!((o.index, o.touchdown_ms), (0, contact));
    assert!(o.timestamp_ms - contact > 15_000 && o.timestamp_ms - contact < 25_000, "decided in the climb-out");
    assert_eq!(sim.session.pending_touchdown(), None);
    let s = sim.session.summary();
    assert!(s.touchdowns[0].touch_and_go, "summary corrected in place");
    assert_eq!((s.landing_rate_fpm, s.landing_ms), (None, None), "a touch-and-go is never the flight's landing");
    assert!(sim.phases().ends_with(&[Landing, Climb]), "{:?}", sim.phases());

    // the full stop afterwards is the flight's landing
    sim.run(30.0, air(1_000.0, 0.0, 110.0));
    sim.short_final_from(1_000.0);
    let contact2 = sim.wall_ms + 250;
    sim.roll(10.0, 80.0, 40.0, 120.0);
    sim.roll(5.0, 40.0, 15.0, 120.0);
    assert_eq!(sim.outcome_kinds(), vec![TouchAndGo, FullStop]);
    let s = sim.session.summary();
    assert_eq!(s.touchdowns.iter().map(|t| t.touch_and_go).collect::<Vec<_>>(), vec![true, false]);
    assert_eq!((s.landing_rate_fpm, s.landing_ms), (Some(-120.0), Some(contact2)));
    assert_eq!(sim.session.phase(), TaxiIn);
}

#[test]
fn full_stop_after_8_s_is_a_full_stop() {
    let mut sim = Sim::new(250);
    sim.fly_to_short_final();
    let contact = sim.wall_ms + 250;
    // hard braking: 110 → 26 kt in 8 s
    sim.roll(5.5, 110.0, 52.0, 140.0);
    assert_eq!(sim.touchdowns().len(), 1, "reported after the bounce window, still fast");
    assert_eq!(sim.session.pending_touchdown(), Some(0));
    assert_eq!(sim.session.summary().landing_ms, None);
    sim.roll(2.5, 52.0, 26.0, 140.0);
    assert_eq!(sim.outcome_kinds(), vec![FullStop]);
    let o = &sim.outcomes[0];
    assert!(o.timestamp_ms - contact >= 7_000 && o.timestamp_ms - contact <= 8_000, "below 30 kt: {} ms", o.timestamp_ms - contact);
    let s = sim.session.summary();
    assert!(!s.touchdowns[0].touch_and_go);
    assert_eq!((s.landing_rate_fpm, s.landing_ms), (Some(-140.0), Some(contact)), "landing time is the first contact");
    sim.roll(5.0, 26.0, 12.0, 140.0);
    assert_eq!(sim.session.phase(), TaxiIn);
    assert_eq!(sim.session.summary().landing_ms, Some(contact), "TaxiIn does not move it");
    assert_eq!(sim.outcomes.len(), 1, "one outcome per touchdown");
}

#[test]
fn full_stop_already_below_30_kt_at_the_report_comes_with_it() {
    // short-field landing at 1 Hz: below 30 kt before the 5 s window closes
    let mut sim = Sim::new(1000);
    sim.fly_to_short_final();
    sim.roll(4.0, 50.0, 20.0, 100.0);
    let tds = sim.touchdowns();
    assert_eq!(tds.len(), 1);
    assert_eq!(sim.outcome_kinds(), vec![FullStop]);
    assert_eq!(sim.outcomes[0].timestamp_ms, tds[0].0, "same sample as the report");
    assert_eq!(sim.session.pending_touchdown(), None);
}

#[test]
fn bounce_series_stays_one_event_with_one_outcome() {
    let mut sim = Sim::new(50);
    sim.fly_to_short_final();
    let contact = sim.wall_ms + 50;
    let bump = |sim: &mut Sim, agl: f64, secs: f64| {
        sim.run(secs, move |t| {
            air(agl, 200.0, 105.0)(t);
            t.touchdown_vs_fpm = 300.0;
        })
    };
    sim.roll(0.4, 118.0, 116.0, 300.0);
    bump(&mut sim, 6.0, 0.8);
    sim.roll(0.5, 112.0, 110.0, 360.0); // harder second contact
    bump(&mut sim, 3.0, 0.6);
    sim.roll(12.0, 108.0, 45.0, 210.0);
    sim.roll(4.0, 45.0, 20.0, 210.0);
    let tds = sim.touchdowns();
    assert_eq!(tds.len(), 1, "{tds:?}");
    let r = &tds[0].1;
    assert_eq!((r.timestamp_ms, r.bounces, r.landing_rate_fpm), (contact, 2, -360.0));
    assert_eq!(sim.outcome_kinds(), vec![FullStop]);
    assert_eq!(sim.session.summary().landing_rate_fpm, Some(-360.0));
}

#[test]
fn no_decision_for_120_s_on_the_ground_is_a_full_stop() {
    let mut sim = Sim::new(1000);
    sim.fly_to_short_final();
    let contact = sim.wall_ms + 1000;
    // a long fast backtrack above 30 kt (e.g. a stuck GS value): no rollout, no climb
    sim.roll(110.0, 45.0, 40.0, 160.0);
    assert!(sim.outcomes.is_empty());
    assert_eq!(sim.session.pending_touchdown(), Some(0));
    sim.roll(15.0, 40.0, 40.0, 160.0);
    assert_eq!(sim.outcome_kinds(), vec![FullStop]);
    assert_eq!(sim.outcomes[0].timestamp_ms - contact, 120_000);
    let s = sim.session.summary();
    assert_eq!((s.landing_rate_fpm, s.landing_ms), (Some(-160.0), Some(contact)));
    assert_eq!(sim.session.phase(), Landing, "the phase engine still waits for 35 kt");
}

#[test]
fn reconnect_while_pending_is_unknown_not_a_guess() {
    let mut sim = Sim::new(250);
    sim.fly_to_short_final();
    let contact = sim.wall_ms + 250;
    sim.roll(7.0, 80.0, 70.0, 150.0);
    assert_eq!(sim.session.pending_touchdown(), Some(0));
    let ev = sim.session.reset_position_context();
    sim.collect(ev);
    assert_eq!(sim.outcome_kinds(), vec![Unknown]);
    assert_eq!(sim.outcomes[0].touchdown_ms, contact);
    let s = sim.session.summary();
    assert!(!s.touchdowns[0].touch_and_go, "unknown is stored as no touch-and-go");
    assert_eq!(s.landing_rate_fpm, Some(-150.0), "counts like the stored row does");
    assert_eq!(s.landing_ms, None, "still rolling: the phase decides");
    // rolling on after the reconnect: no new touchdown, no second outcome; TaxiIn sets the time
    sim.roll(10.0, 70.0, 15.0, 150.0);
    assert_eq!((sim.touchdowns().len(), sim.outcomes.len()), (1, 1));
    assert_eq!(sim.session.phase(), TaxiIn);
    assert_eq!(sim.session.summary().landing_ms, Some(contact), "the Landing transition, same sample as the contact");
    assert_eq!(sim.session.summary().state, FlightState::Active);
}

#[test]
fn flight_loaded_while_pending_settles_unknown_before_the_flight_ends() {
    let mut sim = Sim::new(250);
    sim.fly_to_short_final();
    sim.roll(6.0, 80.0, 75.0, 150.0);
    let ev = sim.session.on_sim_event(&SimEvent::FlightLoaded { path: "x.FLT".into() });
    // the outcome is applied before FlightEnded, so the ended summary is final
    assert!(matches!(ev.last(), Some(FlightEvent::FlightEnded { interrupted: true, .. })), "{ev:?}");
    sim.collect(ev);
    assert_eq!(sim.outcome_kinds(), vec![Unknown]);
    let s = sim.session.summary();
    assert_eq!(s.state, FlightState::Interrupted);
    assert_eq!(sim.session.pending_touchdown(), None);
    assert!(!s.touchdowns[0].touch_and_go);
}

#[test]
fn reset_inside_the_bounce_window_hands_back_report_and_unknown() {
    let mut sim = Sim::new(250);
    sim.fly_to_short_final();
    sim.roll(3.0, 110.0, 95.0, 175.0); // confirmed, window still open
    assert!(sim.touchdowns().is_empty());
    let ev = sim.session.reset_position_context();
    sim.collect(ev);
    assert_eq!(sim.touchdowns().len(), 1, "a confirmed contact is not lost");
    assert_eq!(sim.outcome_kinds(), vec![Unknown], "but its outcome is not guessed");
}

#[test]
fn short_roll_touch_and_go_is_decided_in_the_report() {
    // the climb-out holds the report up to 3 s, so consumers that only see the report
    // (recorder, toast) get the touch-and-go flag right away
    let mut sim = Sim::new(250);
    sim.fly_to_short_final();
    sim.roll(2.0, 75.0, 72.0, 260.0);
    sim.climb(10.0, 1_000.0, 1_200.0, 85.0);
    let tds = sim.touchdowns();
    assert_eq!(tds.len(), 1);
    assert!(tds[0].1.touch_and_go);
    assert_eq!(sim.outcome_kinds(), vec![TouchAndGo]);
    assert_eq!(sim.outcomes[0].timestamp_ms, tds[0].0, "same sample as the report");
}
