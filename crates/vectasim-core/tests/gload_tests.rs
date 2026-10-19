//! G-load over the whole flight through `FlightSession`: pause, slew and the touchdown
//! window are left out, short spikes and short excursions do not count.

use vectasim_core::FlightPhase::*;
use vectasim_core::{FlightSession, FlightState, GLoadSource, Telemetry};

const STEP_MS: u64 = 100; // 10 Hz

struct Sim {
    t_ms: u64,
    session: FlightSession,
    agl: f64,
}

impl Sim {
    fn new() -> Self {
        Self { t_ms: 1_000_000, session: FlightSession::new(), agl: 0.0 }
    }

    /// `secs` of samples moving AGL linearly to `to_agl`, each tweaked by `f(t, elapsed_s)`.
    fn run(&mut self, secs: f64, to_agl: f64, mut f: impl FnMut(&mut Telemetry, f64)) {
        let n = (secs * 1000.0 / STEP_MS as f64).round() as u64;
        let from = self.agl;
        for i in 1..=n {
            self.t_ms += STEP_MS;
            self.agl = from + (to_agl - from) * i as f64 / n as f64;
            let mut t = Telemetry {
                timestamp_ms: self.t_ms,
                sim_rate: 1.0,
                num_engines: 2,
                engines_running: 2,
                fuel_total_kg: 5_000.0,
                on_ground: self.agl <= 0.0,
                altitude_agl_ft: self.agl,
                altitude_msl_ft: 400.0 + self.agl,
                g_force: 1.0,
                ..Default::default()
            };
            f(&mut t, i as f64 * STEP_MS as f64 / 1000.0);
            self.session.update(&t);
        }
    }
}

fn gs(v: f64, vs: f64) -> impl FnMut(&mut Telemetry, f64) {
    move |t, _| {
        t.ground_speed_kt = v;
        t.vertical_speed_fpm = vs;
    }
}

#[test]
fn flight_g_load_skips_pause_slew_and_touchdown() {
    let mut sim = Sim::new();
    sim.run(5.0, 0.0, gs(12.0, 0.0)); // taxi out: flight starts
    sim.run(5.0, 0.0, gs(90.0, 0.0)); // take-off roll
    assert_eq!(sim.session.summary().state, FlightState::Active);
    // climb with a 1.6 g pull for 1.2 s and a single 2.5 g frame (noise)
    sim.run(40.0, 3_000.0, |t, s| {
        gs(160.0, 1_500.0)(t, s);
        if (10.0..11.2).contains(&s) {
            t.g_force = 1.6;
        }
        if (20.0..20.05).contains(&s) {
            t.g_force = 2.5;
        }
    });
    // cruise; paused at 3 g, slewed at 0.1 g: neither counts
    sim.run(60.0, 3_000.0, gs(250.0, 0.0));
    sim.run(10.0, 3_000.0, |t, s| {
        gs(250.0, 0.0)(t, s);
        t.paused = true;
        t.g_force = 3.0;
    });
    sim.run(5.0, 3_000.0, |t, s| {
        gs(250.0, 0.0)(t, s);
        t.slew = true;
        t.g_force = 0.1;
    });
    sim.run(30.0, 3_000.0, gs(250.0, 0.0));
    // a 0.4 s dip to 0.3 g (debounce: not counted, but the minimum) ...
    sim.run(2.0, 3_000.0, |t, s| {
        gs(250.0, 0.0)(t, s);
        if (1.0..1.4).contains(&s) {
            t.g_force = 0.3;
        }
    });
    // ... descent, a 0.6 g flare in the last 2 s, contact at 2.2 g: the touchdown window
    sim.run(60.0, 20.0, gs(180.0, -1_000.0));
    sim.run(2.0, 1.0, |t, s| {
        gs(130.0, -300.0)(t, s);
        t.g_force = 0.6;
    });
    sim.run(1.0, 0.0, |t, s| {
        gs(125.0, -300.0)(t, s);
        t.g_force = if t.on_ground { 2.2 } else { 0.6 };
    });
    sim.run(20.0, 0.0, gs(20.0, 0.0));

    let g = sim.session.summary().g_load;
    assert_eq!(g.source, GLoadSource::Live);
    let max = g.max.expect("max");
    let min = g.min.expect("min");
    assert!((max.g - 1.6).abs() < 1e-9, "max {max:?}");
    assert!(matches!(max.phase, Takeoff | Climb), "{max:?}");
    assert!(max.altitude_msl_ft > 400.0 && max.altitude_msl_ft < 3_400.0, "{max:?}");
    // the 0.3 g dip averaged over 0.3 s still reaches 0.3 in its middle
    assert!((min.g - 0.3).abs() < 1e-9, "min {min:?}");
    assert!(min.phase.is_airborne_phase(), "{min:?}");
    assert_eq!((g.high_count, g.low_count), (1, 0));
}

#[test]
fn interrupted_flight_keeps_the_held_back_seconds() {
    let mut sim = Sim::new();
    sim.run(5.0, 0.0, gs(12.0, 0.0));
    sim.run(5.0, 0.0, gs(90.0, 0.0));
    sim.run(20.0, 2_000.0, |t, s| {
        gs(160.0, 1_500.0)(t, s);
        if s > 18.5 {
            t.g_force = 1.45;
        }
    });
    // the last 3 s are still held back (a touchdown could follow) ...
    assert!(sim.session.summary().g_load.max.unwrap().g < 1.45);
    // ... and committed when the flight ends without one
    let ts = sim.t_ms;
    sim.session.interrupt(ts);
    let g = sim.session.summary().g_load;
    assert_eq!(sim.session.summary().state, FlightState::Interrupted);
    assert!((g.max.unwrap().g - 1.45).abs() < 1e-9, "{g:?}");
}

#[test]
fn stray_on_ground_flag_at_altitude_keeps_the_g_peak() {
    // audit 0.5.0 N3: the tracker took the raw flag, so a spurious "on ground" in the cruise
    // dropped the 3 s before it as a touchdown window
    let mut sim = Sim::new();
    sim.run(5.0, 0.0, gs(12.0, 0.0));
    sim.run(5.0, 0.0, gs(90.0, 0.0));
    sim.run(40.0, 6_000.0, gs(200.0, 9_000.0));
    sim.run(30.0, 6_000.0, gs(250.0, 0.0));
    sim.run(3.0, 6_000.0, |t, s| {
        gs(250.0, 0.0)(t, s);
        if s < 1.5 {
            t.g_force = 1.8;
        }
    });
    // MSFS can claim "on ground" for a frame at altitude; AGL does not back it
    sim.run(0.1, 6_000.0, |t, s| {
        gs(250.0, 0.0)(t, s);
        t.on_ground = true;
    });
    sim.run(20.0, 6_000.0, gs(250.0, 0.0));
    let max = sim.session.summary().g_load.max.expect("max");
    assert!((max.g - 1.8).abs() < 1e-9, "{max:?}");
}
