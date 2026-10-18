//! A fake sim that flies an endless circuit at EDDF, so the UI, recorder,
//! phase engine and landing debrief can be developed on a machine without a sim.
//!
//! One loop: start-up at a stand north of RWY 25C, taxi, rolling take-off on
//! 25C, left-hand circuit at 2 500 ft AGL (level long enough to count as a
//! cruise, then a descending downwind and base turn), a stabilised 3° straight-in
//! to 25C (threshold crossed at ~50 ft, IAS 140 → 125 kt), a flare from about
//! −700 to −150 fpm, touchdown ~350 m past the threshold a metre or two beside
//! the centreline, rollout to 30 kt, vacate to the north and park.
//!
//! The path is built from analytic legs (straight lines and circular arcs in a
//! runway-aligned frame) and pre-computed at 10 Hz, so a sample depends only on
//! its time – the caller's rate cannot shift the touchdown point. The flare
//! height is solved per loop so the first contact lands 350 m past the threshold;
//! the touchdown rate and lateral offset vary slightly from loop to loop (also
//! so the sim's "last touchdown" value differs between consecutive landings).
//!
//! `MockFlight` is the deterministic generator (also used by tests);
//! `MockProvider` runs it on a thread at a fixed rate. `VECTASIM_MOCK=bounce`
//! selects a variant with one bounce, `VECTASIM_MOCK=goaround` one that goes around
//! from 300 ft on the first final, flies the circuit again and lands (longer loop).
//!
//! Discontinuity variants (UI checks of the session reset without a sim; the provider
//! takes its events from [`MockFlight::step`]):
//! - `VECTASIM_MOCK=teleport`: 5 s into the descending end of the downwind the sim
//!   "loads a new flight": a `FlightLoaded` event, then the aircraft sits parked at the
//!   stand (engines off) until the loop restarts at 300 s. The open flight must end as
//!   interrupted, without a touchdown.
//! - `VECTASIM_MOCK=reconnect`: 5 s into the base turn (~1 800 ft AGL) the link drops:
//!   `Disconnected`, 10 s without telemetry, then `Connected` + aircraft again while the
//!   aircraft flew on. The flight continues and lands normally (one touchdown).



use crate::landing::{RunwayEnd, RunwayFrame};
use crate::{AircraftInfo, Lights, ProviderEvent, SimEvent, SimProvider, Telemetry, now_ms, sleep_interruptible};
use std::f64::consts::{FRAC_PI_2, PI};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// EDDF RWY 25C threshold and the opposite (07C) threshold, from crates/vectasim-data runways.csv.
pub const EDDF_25C_THRESHOLD: (f64, f64) = (50.0451, 8.58698);
pub const EDDF_07C_THRESHOLD: (f64, f64) = (50.0326, 8.53463);
/// EDDF elevation (airports.csv); the mock's ground is flat at this height.
const ELEVATION_FT: f64 = 364.0;
/// Magnetic variation at EDDF, east positive.
const VARIATION_DEG: f64 = 3.0;
/// One loop of the flight; the end is padded with "parked, engines off".
const LOOP_S: f64 = 600.0;
/// Loop of the go-around variant (two circuits).
const LOOP_GA_S: f64 = 1_080.0;
/// Loop of the teleport variant: the flight is cut short by the reload.
const LOOP_TP_S: f64 = 300.0;
/// Teleport variant: seconds into the descending end of the downwind.
const TELEPORT_INTO_LEG_S: f64 = 5.0;
/// Reconnect variant: seconds into the base turn, and the length of the link loss.
const RECONNECT_INTO_LEG_S: f64 = 5.0;
pub const RECONNECT_GAP_S: f64 = 10.0;
/// Leg indices (standard circuit) the discontinuity variants refer to.
const LEG_DOWNWIND_DESCENT: usize = 9;
const LEG_BASE_TURN: usize = 10;
/// Go-around variant: the first final is flown down to where the glide path is 300 ft.
const GO_AROUND_FT: f64 = 300.0;
const DT: f64 = 0.1;

const KT: f64 = 0.514_444; // m/s per kt
const FT_PER_M: f64 = 3.280_84;
const GLIDE_DEG: f64 = 3.0;
const TCH_FT: f64 = 50.0;
/// Where the first contact is aimed, metres past the threshold (standard variant).
const TOUCHDOWN_AIM_M: f64 = 350.0;
const CIRCUIT_R_M: f64 = 1_800.0;
/// Downwind abeam/turn points along the runway axis (s = metres past the 25C threshold).
const CROSSWIND_S: f64 = 3_000.0;
const FINAL_S: f64 = -9_000.0;
const CIRCUIT_AGL_FT: f64 = 2_500.0;
const INTERCEPT_AGL_FT: f64 = 1_500.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MockVariant {
    #[default]
    Standard,
    /// A firm first contact, ~4 ft back into the air, second contact ~2.5 s later.
    Bounce,
    /// Go-around from 300 ft on the first final, second circuit, normal landing.
    GoAround,
    /// Mid-flight reload at the stand: `FlightLoaded` + position jump (see module doc).
    Teleport,
    /// Link loss in the approach: `Disconnected`, 10 s gap, `Connected` (see module doc).
    Reconnect,
}

impl MockVariant {
    /// `VECTASIM_MOCK=bounce|goaround|teleport|reconnect` selects the variant.
    pub fn from_env() -> Self {
        std::env::var("VECTASIM_MOCK").map(|v| Self::parse(&v)).unwrap_or_default()
    }

    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "bounce" => MockVariant::Bounce,
            "goaround" | "go-around" | "ga" => MockVariant::GoAround,
            "teleport" => MockVariant::Teleport,
            "reconnect" => MockVariant::Reconnect,
            _ => MockVariant::Standard,
        }
    }

    /// Length of one loop of this variant, seconds.
    pub fn loop_seconds(self) -> f64 {
        match self {
            MockVariant::GoAround => LOOP_GA_S,
            MockVariant::Teleport => LOOP_TP_S,
            _ => LOOP_S,
        }
    }
}

/// One pre-computed point of the path.
#[derive(Clone, Copy, Debug, Default)]
struct Pt {
    t: f64,
    /// Metres along the 25C landing direction from its threshold, and right of the centreline.
    s: f64,
    x: f64,
    /// Track relative to the runway direction, radians, clockwise (unwrapped).
    theta: f64,
    agl: f64,
    gs_kt: f64,
    vs_fpm: f64,
    pitch: f64,
    bank: f64,
    g: f64,
    gear: f64,
    fuel_used: f64,
    flaps: i32,
    engines: u8,
    brake: bool,
    on_runway: bool,
    /// Sim "last touchdown normal velocity" (positive-down), 0 until the first contact.
    td_fpm: f64,
}

#[derive(Clone, Copy, Debug)]
enum Path {
    Hold,
    Line { len: f64 },
    /// Signed sweep: positive = right turn.
    Arc { radius: f64, sweep: f64 },
}

#[derive(Clone, Copy, Debug)]
enum Speed {
    /// Constant acceleration to this ground speed (kt) at the end of the leg.
    To(f64),
    /// Constant acceleration in kt/s (legs that end on an event).
    Accel(f64),
}

#[derive(Clone, Copy, Debug)]
enum Vert {
    Ground,
    /// Altitude controller: fly to `target` ft AGL at up to `fpm`.
    Ctrl { target: f64, fpm: f64 },
    /// Keep the controller, but never above the 3° glide path (smooth intercept).
    Glide,
    /// Glide path down to `hf` ft, then the flare to the first contact.
    Flare,
    /// Bounce variant: a second on the gear, back into the air, second contact.
    Bounce,
}

#[derive(Clone, Copy, Debug)]
struct Leg {
    path: Path,
    speed: Speed,
    vert: Vert,
    /// Hold legs: duration in seconds.
    dur: f64,
    flaps: i32,
    gear_down: bool,
    engines: u8,
    brake: bool,
    on_runway: bool,
}

impl Leg {
    fn new(path: Path, speed: Speed, vert: Vert) -> Self {
        Self { path, speed, vert, dur: 0.0, flaps: 0, gear_down: true, engines: 2, brake: false, on_runway: false }
    }
    fn hold(dur: f64, engines: u8) -> Self {
        Self { dur, engines, brake: true, ..Self::new(Path::Hold, Speed::To(0.0), Vert::Ground) }
    }
    fn flaps(mut self, f: i32) -> Self {
        self.flaps = f;
        self
    }
    fn gear_up(mut self) -> Self {
        self.gear_down = false;
        self
    }
    fn runway(mut self) -> Self {
        self.on_runway = true;
        self
    }
}

/// Per-loop parameters.
#[derive(Clone, Copy, Debug)]
struct Params {
    variant: MockVariant,
    /// Rate at (first) contact, fpm positive-down.
    td_fpm: f64,
    /// Lateral offset at touchdown, m (positive = right).
    lateral_m: f64,
}

impl Params {
    fn for_loop(variant: MockVariant, n: u64) -> Self {
        let i = (n % 4) as usize;
        let td_fpm = match variant {
            MockVariant::Standard | MockVariant::GoAround | MockVariant::Teleport | MockVariant::Reconnect => {
                [150.0, 120.0, 185.0, 140.0][i]
            }
            MockVariant::Bounce => [330.0, 290.0, 360.0, 310.0][i],
        };
        Self { variant, td_fpm, lateral_m: [-1.8, 2.4, -0.6, 3.1][i] }
    }
}

fn smoothstep(f: f64) -> f64 {
    let f = f.clamp(0.0, 1.0);
    f * f * (3.0 - 2.0 * f)
}

/// Height of the 3° glide path (TCH 50 ft) at `s` metres past the threshold.
fn glide_ft(s: f64) -> f64 {
    TCH_FT - s * (GLIDE_DEG.to_radians().tan() * FT_PER_M)
}

/// Smooth minimum (polynomial, blend width `k`).
fn smin(a: f64, b: f64, k: f64) -> f64 {
    let h = (0.5 + 0.5 * (b - a) / k).clamp(0.0, 1.0);
    b * (1.0 - h) + a * h - k * h * (1.0 - h)
}

/// IAS from TAS (no wind): ~2 % per 1 000 ft density altitude, ISA.
fn ias_of(tas_kt: f64, msl_ft: f64) -> f64 {
    tas_kt / (1.0 + 0.02 * msl_ft / 1000.0)
}

/// Lateral offset of the final approach and rollout: blends in over the last
/// 3 km before the threshold, holds through touchdown, back on the centreline by 1 300 m.
fn lateral_offset(s: f64, off: f64) -> f64 {
    off * smoothstep((s + 3000.0) / 2000.0) * (1.0 - smoothstep((s - 700.0) / 600.0))
}

struct Builder {
    p: Params,
    pts: Vec<Pt>,
    cur: Pt,
    /// Altitude controller: target, max rate, and its own altitude/V/S (the glide path limits what is flown).
    target_agl: f64,
    max_fpm: f64,
    ctrl_agl: f64,
    ctrl_vs: f64,
    /// Flare height for this build.
    hf: f64,
    /// Flare state: (start time, start V/S fpm (negative), duration).
    flare: Option<(f64, f64, f64)>,
    /// Bounce: time of the first contact.
    bounce_t0: Option<f64>,
    /// Where the first contact happened (s).
    touchdown_s: Option<f64>,
    /// Start time of each leg, seconds into the loop.
    leg_starts: Vec<f64>,
}

impl Builder {
    fn new(p: Params, hf: f64) -> Self {
        let cur = Pt { s: 30.0, x: 300.0, theta: -FRAC_PI_2, brake: true, gear: 100.0, g: 1.0, ..Default::default() };
        Self {
            p,
            pts: vec![cur],
            cur,
            target_agl: 0.0,
            max_fpm: 0.0,
            ctrl_agl: 0.0,
            ctrl_vs: 0.0,
            hf,
            flare: None,
            bounce_t0: None,
            touchdown_s: None,
            leg_starts: Vec::new(),
        }
    }

    fn legs(variant: MockVariant) -> Vec<Leg> {
        use Path::*;
        use Speed::*;
        use Vert::*;
        let climb = Ctrl { target: CIRCUIT_AGL_FT, fpm: 2_500.0 };
        let downwind_len = CROSSWIND_S - FINAL_S;
        let circuit = [
            // crosswind/downwind turn (left), level-off at 2 500 ft
            Leg::new(Arc { radius: CIRCUIT_R_M, sweep: -PI }, To(215.0), climb).gear_up(),
            Leg::new(Line { len: downwind_len * 0.7 }, To(215.0), climb).gear_up(),
            // descending end of the downwind and base turn (left) onto a 9 km final
            Leg::new(Line { len: downwind_len * 0.3 }, To(200.0), Ctrl { target: INTERCEPT_AGL_FT, fpm: 900.0 }).gear_up(),
            Leg::new(Arc { radius: CIRCUIT_R_M, sweep: -PI }, To(146.0), Ctrl { target: INTERCEPT_AGL_FT, fpm: 900.0 }).flaps(2),
        ];
        let mut legs = Self::departure(climb);
        legs.extend(circuit);
        if variant == MockVariant::GoAround {
            // first final down to 300 ft on the glide path, then climb straight ahead into a second circuit
            let ga_s = -(GO_AROUND_FT - TCH_FT) / (GLIDE_DEG.to_radians().tan() * FT_PER_M);
            legs.push(Leg::new(Line { len: ga_s - FINAL_S }, To(132.0), Glide).flaps(4));
            legs.push(Leg::new(Line { len: CROSSWIND_S - ga_s }, To(185.0), Ctrl { target: CIRCUIT_AGL_FT, fpm: 2_000.0 }).flaps(2).gear_up());
            legs.extend(circuit);
        }
        legs.extend(Self::arrival(variant));
        legs
    }

    /// Start-up, taxi, take-off and the climb-out to the crosswind turn.
    fn departure(climb: Vert) -> Vec<Leg> {
        use Path::*;
        use Speed::*;
        use Vert::*;
        vec![
            Leg::hold(10.0, 0),
            Leg::hold(6.0, 2),
            // stand → holding point → 90° right onto the 25C centreline at the threshold
            Leg::new(Line { len: 40.0 }, To(18.0), Ground).flaps(1),
            Leg::new(Line { len: 220.0 }, To(18.0), Ground).flaps(1),
            Leg::new(Arc { radius: 40.0, sweep: FRAC_PI_2 }, To(12.0), Ground).flaps(1).runway(),
            // rolling take-off, liftoff at 150 kt
            Leg::new(Line { len: 1_350.0 }, To(150.0), Ground).flaps(1).runway(),
            Leg::new(Line { len: CROSSWIND_S - 1_420.0 }, To(185.0), climb).flaps(1).gear_up(),
        ]
    }

    /// Final, flare, (bounce,) rollout, vacate and park.
    fn arrival(variant: MockVariant) -> Vec<Leg> {
        use Path::*;
        use Speed::*;
        use Vert::*;
        vec![
            Leg::new(Line { len: -FINAL_S }, To(126.0), Glide).flaps(4),
            Leg::new(Line { len: f64::INFINITY }, Accel(-1.2), Flare).flaps(4).runway(),
            Leg::new(Line { len: if variant == MockVariant::Bounce { f64::INFINITY } else { 0.0 } }, Accel(-1.5), Bounce)
                .flaps(4)
                .runway(),
            // rollout to 30 kt, vacate right (north) and taxi to the stand
            Leg::new(Line { len: 950.0 }, To(30.0), Ground).flaps(4).runway(),
            Leg::new(Line { len: 150.0 }, To(15.0), Ground).flaps(4).runway(),
            Leg::new(Arc { radius: 50.0, sweep: FRAC_PI_2 }, To(15.0), Ground),
            Leg::new(Line { len: 230.0 }, To(15.0), Ground),
            Leg::new(Line { len: 25.0 }, To(0.0), Ground),
            Leg::hold(4.0, 2),
        ]
    }

    fn run(mut self) -> Self {
        for leg in Self::legs(self.p.variant) {
            self.leg_starts.push(self.cur.t);
            self.fly(leg);
        }
        self
    }

    fn fly(&mut self, leg: Leg) {
        if let Vert::Ctrl { target, fpm } = leg.vert {
            self.target_agl = target;
            self.max_fpm = fpm;
            // after a glide-path leg (go-around) the controller resumes from where the aircraft is
            if (self.ctrl_agl - self.cur.agl).abs() > 1.0 {
                self.ctrl_agl = self.cur.agl;
                self.ctrl_vs = self.cur.vs_fpm;
            }
        }
        if let Path::Hold = leg.path {
            let n = (leg.dur / DT).round() as usize;
            let mut c = self.cur;
            c.gs_kt = 0.0;
            for _ in 0..n {
                self.step(leg, c, DT, 0.0);
            }
            return;
        }
        let (start, theta0) = ((self.cur.s, self.cur.x), self.cur.theta);
        let len = match leg.path {
            Path::Line { len } => len,
            Path::Arc { radius, sweep } => radius * sweep.abs(),
            Path::Hold => 0.0,
        };
        if len <= 0.0 {
            return;
        }
        let v0 = self.cur.gs_kt * KT;
        let accel = match leg.speed {
            Speed::To(v1) => ((v1 * KT).powi(2) - v0 * v0) / (2.0 * len),
            Speed::Accel(a) => a * KT,
        };
        let (mut d, mut v) = (0.0, v0);
        loop {
            let mut dt = DT;
            let mut v1 = (v + accel * dt).max(0.3);
            let mut step = (v + v1) / 2.0 * dt;
            if d + step >= len {
                // last, shortened step ends exactly at the leg end
                step = len - d;
                dt = step / ((v + v1) / 2.0);
                v1 = v + accel * dt;
                if dt < 1e-3 {
                    break;
                }
            }
            d += step;
            v = v1;
            let (pos, theta) = position(leg.path, start, theta0, d);
            let mut c = self.cur;
            c.s = pos.0;
            c.x = pos.1;
            c.theta = theta;
            c.gs_kt = v / KT;
            let bank = match leg.path {
                Path::Arc { radius, sweep } => (v * v / (9.81 * radius)).atan().to_degrees() * sweep.signum(),
                _ => 0.0,
            };
            let ended = self.step(leg, c, dt, bank);
            if ended || d >= len - 1e-9 {
                break;
            }
        }
    }

    /// Advance one step to the new horizontal state `c`; computes the vertical
    /// profile and the rest. Returns true when an event ended the leg.
    fn step(&mut self, leg: Leg, mut c: Pt, dt: f64, bank_target: f64) -> bool {
        let prev = self.cur;
        let dt_eff = dt;
        c.t = prev.t + dt;
        let mut ended = false;
        let mut contact = false;
        match leg.vert {
            Vert::Ground => {
                c.agl = 0.0;
                c.vs_fpm = 0.0;
            }
            Vert::Ctrl { .. } | Vert::Glide => {
                // capture with a ~12 s time constant, V/S changes limited to 250 fpm/s
                let cmd = ((self.target_agl - self.ctrl_agl) * 5.0).clamp(-self.max_fpm, self.max_fpm);
                let max_dvs = 250.0 * dt_eff;
                self.ctrl_vs += (cmd - self.ctrl_vs).clamp(-max_dvs, max_dvs);
                self.ctrl_agl = (self.ctrl_agl + self.ctrl_vs / 60.0 * dt_eff).max(0.0);
                let mut agl = self.ctrl_agl;
                if let Vert::Glide = leg.vert {
                    agl = smin(agl, glide_ft(c.s), 60.0);
                    c.x = lateral_offset(c.s, self.p.lateral_m);
                }
                c.agl = agl.max(0.0);
                c.vs_fpm = (c.agl - prev.agl) / dt_eff * 60.0;
            }
            Vert::Flare | Vert::Bounce => {
                let (agl, vs) = if let Vert::Flare = leg.vert { self.flare_vs(c.t, c.s, &prev, dt_eff) } else { self.bounce_vs(c.t, &prev, dt_eff) };
                if agl <= 0.0 && (prev.agl > 0.0 || vs < 0.0) {
                    // contact: shorten the step to the exact moment the wheels reach the ground
                    let f = if prev.agl > 0.0 { (prev.agl / (prev.agl - agl)).clamp(0.0, 1.0) } else { 1.0 };
                    c.t = prev.t + dt_eff * f;
                    c.s = prev.s + (c.s - prev.s) * f;
                    c.gs_kt = prev.gs_kt + (c.gs_kt - prev.gs_kt) * f;
                    c.agl = 0.0;
                    // the contact point still shows the V/S it arrived with
                    c.vs_fpm = prev.vs_fpm + (vs - prev.vs_fpm) * f;
                    c.td_fpm = -c.vs_fpm.min(-1.0);
                    contact = true;
                    ended = true;
                    if self.touchdown_s.is_none() {
                        self.touchdown_s = Some(c.s);
                    }
                } else {
                    c.agl = agl.max(0.0);
                    c.vs_fpm = if c.agl > 0.0 { vs } else { 0.0 };
                }
                c.x = lateral_offset(c.s, self.p.lateral_m);
            }
        }
        if matches!(leg.vert, Vert::Ground) && leg.on_runway && self.touchdown_s.is_some() {
            // rollout: drift back from the touchdown offset to the centreline
            c.x = lateral_offset(c.s, self.p.lateral_m);
        }

        c.flaps = leg.flaps;
        c.engines = leg.engines;
        c.brake = leg.brake;
        c.on_runway = leg.on_runway;
        // gear: retract above 50 ft once commanded, extend at 10 %/s
        let gear_target = if leg.gear_down {
            100.0
        } else if c.agl > 50.0 {
            0.0
        } else {
            prev.gear
        };
        c.gear = prev.gear + (gear_target - prev.gear).clamp(-10.0 * dt_eff, 10.0 * dt_eff);

        let on_ground = c.agl <= 0.0;
        let ias = ias_of(c.gs_kt, ELEVATION_FT + c.agl);
        let pitch_target = if on_ground {
            // rotation in the last ~3 s of the take-off roll
            if leg.on_runway && matches!(leg.speed, Speed::To(v) if v >= 150.0) && c.gs_kt > 135.0 { (c.gs_kt - 135.0) / 15.0 * 8.0 } else { 0.0 }
        } else {
            let fpa = (c.vs_fpm / 60.0 / FT_PER_M).atan2(c.gs_kt * KT).to_degrees();
            fpa + (5.5 * (130.0 / ias.max(60.0)).powi(2)).clamp(1.5, 9.0)
        };
        let lag = |prev: f64, target: f64, tau: f64| prev + (target - prev) * (dt_eff / tau).min(1.0);
        c.pitch = lag(prev.pitch, pitch_target, if on_ground { 2.0 } else { 0.8 });
        c.bank = lag(prev.bank, bank_target, 1.5);
        let dvs = (c.vs_fpm - prev.vs_fpm) / 60.0 / FT_PER_M / dt_eff;
        c.g = if contact {
            1.0 + c.td_fpm * 0.0008
        } else if on_ground {
            lag(prev.g, 1.0, 0.2)
        } else {
            1.0 / c.bank.to_radians().cos() + dvs / 9.81
        };
        let burn = if c.engines == 0 {
            0.0
        } else if on_ground && c.gs_kt < 40.0 {
            0.2
        } else if c.vs_fpm > 500.0 || on_ground {
            1.6
        } else if c.vs_fpm < -300.0 {
            0.35
        } else {
            0.75
        };
        c.fuel_used = prev.fuel_used + burn * dt_eff;
        self.cur = c;
        self.pts.push(c);
        ended
    }

    /// Height and V/S on the glide path and in the flare (may go below 0 at contact).
    fn flare_vs(&mut self, t: f64, s: f64, prev: &Pt, dt: f64) -> (f64, f64) {
        let glide = glide_ft(s);
        if self.flare.is_none() && glide <= self.hf {
            // V/S(τ) = v0 + (v1 − v0)(τ/T)²: the mean (2 v0 + v1)/3 must lose the flare height
            let v0 = prev.vs_fpm;
            let mean = (2.0 * v0 - self.p.td_fpm) / 3.0;
            self.flare = Some((prev.t, v0, prev.agl / (-mean / 60.0)));
        }
        match self.flare {
            None => (glide, (glide - prev.agl) / dt * 60.0),
            Some((t0, v0, dur)) => {
                let f = ((t - t0) / dur).min(1.0);
                let vs = v0 + (-self.p.td_fpm - v0) * f * f;
                (prev.agl + (prev.vs_fpm + vs) / 2.0 / 60.0 * dt, vs)
            }
        }
    }

    /// Bounce after the first contact: 1 s on the gear (so the 1 Hz track sees both
    /// contacts), +400 fpm decaying to 0 over 1.2 s (~4 ft), then down at about half
    /// the first contact's rate.
    fn bounce_vs(&mut self, t: f64, prev: &Pt, dt: f64) -> (f64, f64) {
        let t0 = *self.bounce_t0.get_or_insert(prev.t);
        let tau = t - t0 - 1.0;
        if tau < 0.0 {
            return (0.0, 0.0);
        }
        let down = (self.p.td_fpm * 0.55).max(150.0);
        let vs = if tau <= 1.2 { 400.0 * (1.0 - tau / 1.2) } else { -down * ((tau - 1.2) / 2.4).min(1.0) };
        let agl = prev.agl + (prev.vs_fpm + vs) / 2.0 / 60.0 * dt;
        // never back to the ground on the way up
        if tau <= 1.2 { (agl.max(0.01), vs) } else { (agl, vs) }
    }
}

/// Position and track after `d` metres along a leg.
fn position(path: Path, (s0, x0): (f64, f64), theta0: f64, d: f64) -> ((f64, f64), f64) {
    match path {
        Path::Hold => ((s0, x0), theta0),
        Path::Line { .. } => ((s0 + d * theta0.cos(), x0 + d * theta0.sin()), theta0),
        Path::Arc { radius: r, sweep } => {
            if sweep >= 0.0 {
                let (cs, cx) = (s0 - r * theta0.sin(), x0 + r * theta0.cos());
                let th = theta0 + d / r;
                ((cs + r * th.sin(), cx - r * th.cos()), th)
            } else {
                let (cs, cx) = (s0 + r * theta0.sin(), x0 - r * theta0.cos());
                let th = theta0 - d / r;
                ((cs - r * th.sin(), cx + r * th.cos()), th)
            }
        }
    }
}

/// The pre-computed path of one loop.
#[derive(Debug, Clone)]
struct Track {
    pts: Vec<Pt>,
    touchdown_s: f64,
    /// Teleport variant: loop time of the reload.
    teleport_s: f64,
    /// Reconnect variant: loop time the link drops.
    reconnect_s: f64,
}

impl Track {
    fn of(b: Builder) -> Self {
        let leg = |i: usize| b.leg_starts.get(i).copied().unwrap_or(f64::INFINITY);
        Track {
            touchdown_s: b.touchdown_s.unwrap_or(f64::NAN),
            teleport_s: leg(LEG_DOWNWIND_DESCENT) + TELEPORT_INTO_LEG_S,
            reconnect_s: leg(LEG_BASE_TURN) + RECONNECT_INTO_LEG_S,
            pts: b.pts,
        }
    }
}

fn build(p: Params) -> Track {
    if p.variant == MockVariant::Bounce {
        // a late, short flare from 25 ft: firm contact a little before the aim point
        return Track::of(Builder::new(p, 25.0).run());
    }
    // flare height so the first contact is TOUCHDOWN_AIM_M past the threshold (monotonic: higher flare → longer)
    let (mut lo, mut hi) = (5.0, 60.0);
    let mut best: Option<Builder> = None;
    for _ in 0..30 {
        let hf = (lo + hi) / 2.0;
        let b = Builder::new(p, hf).run();
        let s = b.touchdown_s.unwrap_or(f64::INFINITY);
        if s > TOUCHDOWN_AIM_M {
            hi = hf;
        } else {
            lo = hf;
        }
        let err = (s - TOUCHDOWN_AIM_M).abs();
        if best.as_ref().is_none_or(|b| err < (b.touchdown_s.unwrap_or(f64::INFINITY) - TOUCHDOWN_AIM_M).abs()) {
            best = Some(b);
        }
        if err < 0.5 {
            break;
        }
    }
    Track::of(best.expect("built"))
}

/// Deterministic scripted flight. Call `sample(t_s)` with monotonically
/// increasing seconds; one loop takes `MockFlight::loop_seconds()`.
#[derive(Debug)]
pub struct MockFlight {
    variant: MockVariant,
    loop_n: u64,
    track: Track,
    frame: RunwayFrame,
    /// Loop number and loop time of the previous `step` (event edges).
    last_step: Option<(u64, f64)>,
    /// Reconnect variant: the link is currently "down".
    link_down: bool,
}

impl Default for MockFlight {
    fn default() -> Self {
        Self::new()
    }
}

impl MockFlight {
    pub fn new() -> Self {
        Self::with_variant(MockVariant::Standard)
    }

    pub fn with_variant(variant: MockVariant) -> Self {
        Self {
            variant,
            loop_n: 0,
            track: build(Params::for_loop(variant, 0)),
            frame: RunwayFrame::new(&Self::runway()),
            last_step: None,
            link_down: false,
        }
    }

    /// Loop time of the reload (teleport variant), seconds.
    pub fn teleport_seconds(&self) -> f64 {
        self.track.teleport_s
    }

    /// Loop time the link drops (reconnect variant), seconds.
    pub fn reconnect_seconds(&self) -> f64 {
        self.track.reconnect_s
    }

    /// Everything the provider sends for the tick at `t_s`: usually one telemetry sample,
    /// plus the discontinuity events of the teleport / reconnect variants, or nothing
    /// while the reconnect variant's link is down.
    pub fn step(&mut self, t_s: f64, timestamp_ms: u64) -> Vec<ProviderEvent> {
        let loop_s = self.variant.loop_seconds();
        let n = (t_s / loop_s).floor().max(0.0) as u64;
        let lt = t_s - n as f64 * loop_s;
        let crossed = |at: f64, last: Option<(u64, f64)>| last.is_some_and(|(ln, l)| ln == n && l < at) && lt >= at;
        let last = self.last_step.replace((n, lt));
        let mut out = Vec::new();
        match self.variant {
            MockVariant::Teleport if crossed(self.track.teleport_s, last) => {
                out.push(ProviderEvent::Sim(SimEvent::FlightLoaded { path: "mock/stand.FLT".into() }));
            }
            MockVariant::Reconnect => {
                let rc = self.track.reconnect_s;
                let down = (rc..rc + RECONNECT_GAP_S).contains(&lt);
                if down {
                    if !self.link_down {
                        self.link_down = true;
                        out.push(ProviderEvent::Disconnected { reason: "mock: connection lost".into() });
                    }
                    return out;
                }
                if std::mem::take(&mut self.link_down) {
                    out.push(ProviderEvent::Connected { sim_name: "VectaSim Mock".into(), sim_version: "0.1".into() });
                    out.push(ProviderEvent::Aircraft(Self::aircraft()));
                }
            }
            _ => {}
        }
        out.push(ProviderEvent::Telemetry(self.sample(t_s, timestamp_ms)));
        out
    }

    /// Loop length of the standard and bounce variants (see [`MockVariant::loop_seconds`]).
    pub fn loop_seconds() -> f64 {
        LOOP_S
    }

    /// The runway the mock lands on (25C), as the landing analysis sees it.
    pub fn runway() -> RunwayEnd {
        RunwayEnd {
            airport: "EDDF".into(),
            ident: "25C".into(),
            opposite_ident: "07C".into(),
            threshold_lat: EDDF_25C_THRESHOLD.0,
            threshold_lon: EDDF_25C_THRESHOLD.1,
            end_lat: EDDF_07C_THRESHOLD.0,
            end_lon: EDDF_07C_THRESHOLD.1,
            length_m: 0.0,
            width_m: 60.0,
            surface: "ASP".into(),
            elevation_ft: Some(ELEVATION_FT),
        }
    }

    /// Planned first-contact distance past the threshold for the current loop, m.
    pub fn planned_touchdown_m(&self) -> f64 {
        self.track.touchdown_s
    }

    /// Seconds into a loop at which the path ends (parked, engines off afterwards).
    pub fn path_seconds(&self) -> f64 {
        self.track.pts.last().map_or(0.0, |p| p.t)
    }

    pub fn aircraft() -> AircraftInfo {
        AircraftInfo {
            title: "Mock Airlines A320neo".into(),
            atc_model: "A20N".into(),
            atc_type: "Airbus".into(),
            atc_id: "D-AVCT".into(),
            atc_airline: "Mock Air".into(),
            atc_flight_number: "VS001".into(),
        }
    }

    fn point_at(&self, t: f64) -> Pt {
        let pts = &self.track.pts;
        if self.variant == MockVariant::Teleport && t >= self.track.teleport_s {
            // reloaded at the stand: parked, cold and dark until the loop restarts
            return Pt { t, engines: 0, brake: true, ..pts[0] };
        }
        let i = pts.partition_point(|p| p.t <= t);
        if i == 0 {
            return pts[0];
        }
        if i >= pts.len() {
            let mut p = *pts.last().unwrap();
            p.engines = 0;
            p.brake = true;
            return p;
        }
        let (a, b) = (pts[i - 1], pts[i]);
        let f = if b.t > a.t { (t - a.t) / (b.t - a.t) } else { 0.0 };
        let l = |x: f64, y: f64| x + (y - x) * f;
        Pt {
            t,
            s: l(a.s, b.s),
            x: l(a.x, b.x),
            theta: l(a.theta, b.theta),
            agl: l(a.agl, b.agl),
            gs_kt: l(a.gs_kt, b.gs_kt),
            vs_fpm: l(a.vs_fpm, b.vs_fpm),
            pitch: l(a.pitch, b.pitch),
            bank: l(a.bank, b.bank),
            g: l(a.g, b.g),
            gear: l(a.gear, b.gear),
            fuel_used: l(a.fuel_used, b.fuel_used),
            // a new sim touchdown value shows from the contact point on, never while still airborne
            td_fpm: a.td_fpm,
            ..b
        }
    }

    /// Telemetry at `t_s` seconds since start; `timestamp_ms` is stamped as given.
    pub fn sample(&mut self, t_s: f64, timestamp_ms: u64) -> Telemetry {
        let loop_s = self.variant.loop_seconds();
        let n = (t_s / loop_s).floor().max(0.0) as u64;
        if n != self.loop_n {
            self.loop_n = n;
            self.track = build(Params::for_loop(self.variant, n));
        }
        let t = t_s - n as f64 * loop_s;
        let p = self.point_at(t);

        let (lat, lon) = self.frame.unproject(p.s, p.x);
        let heading_true = (self.frame.heading_deg + p.theta.to_degrees()).rem_euclid(360.0);
        let on_ground = p.agl <= 0.0;
        let msl = ELEVATION_FT + p.agl;
        let moving = p.gs_kt > 0.5;
        let airborne_or_runway = !on_ground || p.on_runway;
        Telemetry {
            timestamp_ms,
            sim_zulu_time_s: (timestamp_ms / 1000 % 86_400) as f64,
            latitude: lat,
            longitude: lon,
            altitude_msl_ft: msl,
            altitude_agl_ft: p.agl,
            ias_kt: ias_of(p.gs_kt, msl),
            tas_kt: p.gs_kt,
            ground_speed_kt: p.gs_kt,
            vertical_speed_fpm: p.vs_fpm,
            heading_mag_deg: (heading_true - VARIATION_DEG).rem_euclid(360.0),
            heading_true_deg: heading_true,
            pitch_deg: p.pitch,
            bank_deg: p.bank,
            g_force: p.g,
            on_ground,
            touchdown_vs_fpm: p.td_fpm,
            gear_pct: p.gear,
            flaps_index: p.flaps,
            num_engines: 2,
            engines_running: p.engines,
            fuel_total_kg: 6500.0 - p.fuel_used,
            total_weight_kg: 62000.0 - p.fuel_used,
            parking_brake: p.brake,
            sim_rate: 1.0,
            paused: false,
            slew: false,
            lights: Lights {
                beacon: p.engines > 0,
                nav: true,
                strobe: airborne_or_runway,
                landing: !on_ground && msl < 10_000.0 || p.on_runway && p.gs_kt > 40.0,
                taxi: on_ground && moving && !p.on_runway,
            },
            // decimal digits, as the providers decode the sim's BCD squawk
            transponder_code: 2000,
        }
    }
}

pub struct MockProvider {
    pub rate_hz: f64,
    pub variant: MockVariant,
}

impl Default for MockProvider {
    fn default() -> Self {
        Self { rate_hz: 20.0, variant: MockVariant::from_env() }
    }
}

impl SimProvider for MockProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn start(self: Box<Self>, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
        std::thread::Builder::new()
            .name("mock-provider".into())
            .spawn(move || run(*self, tx, stop))
            .expect("spawn mock provider")
    }
}

fn run(cfg: MockProvider, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) {
    let _ = tx.send(ProviderEvent::Connecting);
    if !sleep_interruptible(Duration::from_millis(400), &stop) {
        return;
    }
    let _ = tx.send(ProviderEvent::Connected { sim_name: "VectaSim Mock".into(), sim_version: "0.1".into() });
    let _ = tx.send(ProviderEvent::Aircraft(MockFlight::aircraft()));
    log::info!("mock flight variant {:?}", cfg.variant);

    let period = Duration::from_secs_f64(1.0 / cfg.rate_hz);
    let start = Instant::now();
    let mut flight = MockFlight::with_variant(cfg.variant);
    while !stop.load(Ordering::Relaxed) {
        for ev in flight.step(start.elapsed().as_secs_f64(), now_ms()) {
            if tx.send(ev).is_err() {
                return;
            }
        }
        std::thread::sleep(period);
    }
    let _ = tx.send(ProviderEvent::Disconnected { reason: "stopped".into() });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_loop_fits_and_aims_at_350_m() {
        // (teleport / reconnect fly the standard path)
        for variant in [MockVariant::Standard, MockVariant::Bounce, MockVariant::GoAround] {
            for n in 0..4 {
                let tr = build(Params::for_loop(variant, n));
                let end = tr.pts.last().unwrap().t;
                // the rest of the loop is parked with engines off (shutdown dwell)
                assert!(end <= variant.loop_seconds() - 15.0, "{variant:?}/{n}: path takes {end:.0} s");
                let tol = if variant == MockVariant::Bounce { 60.0 } else { 2.0 };
                assert!((tr.touchdown_s - TOUCHDOWN_AIM_M).abs() < tol, "{variant:?}/{n}: {}", tr.touchdown_s);
                assert!(tr.pts.windows(2).all(|w| w[1].t > w[0].t));
            }
        }
    }

    #[test]
    fn variant_names() {
        assert_eq!(MockVariant::parse(" Bounce "), MockVariant::Bounce);
        assert_eq!(MockVariant::parse(""), MockVariant::Standard);
        assert_eq!(MockVariant::parse("other"), MockVariant::Standard);
        assert_eq!(MockVariant::parse("GoAround"), MockVariant::GoAround);
        assert_eq!(MockVariant::parse("teleport"), MockVariant::Teleport);
        assert_eq!(MockVariant::parse("Reconnect"), MockVariant::Reconnect);
    }

    #[test]
    fn discontinuity_variants_happen_where_documented() {
        let tp = build(Params::for_loop(MockVariant::Teleport, 0));
        let p = |tr: &Track, t: f64| tr.pts[tr.pts.partition_point(|p| p.t <= t)];
        assert!(p(&tp, tp.teleport_s).agl > 2_000.0, "teleport from the downwind at {:.0} s", tp.teleport_s);
        assert!(tp.teleport_s + 20.0 < LOOP_TP_S, "{}", tp.teleport_s);
        let rc = build(Params::for_loop(MockVariant::Reconnect, 0));
        for t in [rc.reconnect_s, rc.reconnect_s + RECONNECT_GAP_S] {
            let pt = p(&rc, t);
            assert!(pt.agl > 1_000.0, "link loss above 1 000 ft AGL: {:.0} ft at {t:.0} s", pt.agl);
        }
    }
}
