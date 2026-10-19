//! A fake sim that flies an endless circuit at EDDF, so the UI, recorder,
//! phase engine and landing debrief can be developed on a machine without a sim.
//!
//! One loop: start-up at a stand north of RWY 25C, taxi, rolling take-off on
//! 25C, left-hand circuit at 2 500 ft AGL (level long enough to count as a
//! cruise, then a descending downwind and base turn), a 3° straight-in to 25C and
//! a landing, rollout to 30 kt, vacate to the north and park.
//!
//! The standard variant (the "Demo-Flug") flies a normal, stable approach with a few
//! deliberate small errors so the debrief has something to show (see the
//! `DEMO_*` constants below): fast at the FAF, a little high at 1000 ft, an
//! overshoot when turning onto the final and a gentle S, late landing flaps, a short
//! float and a touchdown ~520 m past the threshold, ~9 m right, ~−230 fpm. The other
//! variants keep the textbook approach (on the path and the centreline, touchdown
//! ~350 m, −120…−185 fpm).
//!
//! The path is built from analytic legs (straight lines and circular arcs in a
//! runway-aligned frame) and pre-computed at 10 Hz, so a sample depends only on
//! its time – the caller's rate cannot shift the touchdown point. The flare
//! height is solved per loop so the first contact lands at the aimed distance;
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
/// Where the first contact is aimed, metres past the threshold (textbook variants; demo: `DEMO_TOUCHDOWN_M`).
const TOUCHDOWN_AIM_M: f64 = 350.0;
const CIRCUIT_R_M: f64 = 1_800.0;
/// Downwind abeam/turn points along the runway axis (s = metres past the 25C threshold).
const CROSSWIND_S: f64 = 3_000.0;
const FINAL_S: f64 = -9_000.0;
const CIRCUIT_AGL_FT: f64 = 2_500.0;
const INTERCEPT_AGL_FT: f64 = 1_500.0;
/// Ground speed at the end of the base turn (start of the final), kt.
const BASE_END_GS_KT: f64 = 146.0;

// ---- Demo-Landung: bewusst kleine Fehler (standard variant only) ----
// A normal landing that stays stable ("stabil", landing "normal") but shows the
// assessment at work. Dots are the debrief's (approach.rs defaults): glideslope
// 1 dot = 0.35°, localizer 1 dot = 52 m at the threshold seen from 300 m beyond
// the far end. All values are deterministic; only the touchdown rate and offset
// vary a little from loop to loop.
/// First contact, metres past the threshold: in the touchdown zone (0…900 m on the
/// 4 000 m 25C), but behind the 400 m aiming point.
const DEMO_TOUCHDOWN_M: f64 = 520.0;
/// Rate at first contact per loop, fpm positive-down (band "normal", ≈ −230 fpm).
const DEMO_TD_FPM: [f64; 4] = [232.0, 240.0, 226.0, 236.0];
/// Lateral offset at touchdown per loop, m right of the centreline (≈ 9 m).
const DEMO_LATERAL_M: [f64; 4] = [9.0, 8.4, 9.6, 8.7];
/// Contact g per fpm: 1 + 230 × 0.0014 ≈ 1.32 g at the contact point (≈ 1.3 g peak in the
/// 20 Hz samples; the textbook variants: 0.0008).
const DEMO_TD_G_PER_FPM: f64 = 0.0014;
const TD_G_PER_FPM: f64 = 0.0008;
/// The flare: from about 20–25 ft, ~5.5 s with a short float (≈ −160 fpm) before the
/// aircraft settles at the touchdown rate.
const DEMO_FLARE_S: f64 = 5.5;
/// Speed: the base turn ends at 144.5 kt GS (≈ Vref + 12 kt IAS at the FAF), bled off to
/// ≈ Vref + 4 kt at 500 ft and to ≈ Vref − 3 kt over the threshold (Vref = the flown
/// median 500 → 100 ft).
const DEMO_BASE_END_GS_KT: f64 = 144.5;
const DEMO_GS_500_KT: f64 = 136.0;
const DEMO_GS_THRESHOLD_KT: f64 = 127.0;
/// Landing flaps (FULL = 4) only at about this height; flaps 3 before.
const DEMO_FLAPS_FULL_FT: f64 = 1_100.0;
/// Glidepath deviation (dots, + = above) over the nominal 3° path height (ft):
/// +0.5 dot at 1000 ft, captured by 500 ft, briefly −0.3 dot (low) below 300 ft, on
/// the path again over the threshold. Smoothstep between the knots.
const DEMO_GS_DOTS: [(f64, f64); 6] = [(1_400.0, 0.0), (1_050.0, 0.5), (550.0, 0.0), (330.0, 0.0), (220.0, -0.3), (110.0, 0.0)];
const DEMO_GS_DOT_DEG: f64 = 0.35;
/// Lateral profile (dots, + = right) at s metres past the threshold, smoothstep between
/// the knots: the base turn ends on the centreline still turning, overshoots 0.62 dot to
/// the right (above 1 000 ft) and is corrected within ~15 s; then a gentle S between
/// 1 000 and 300 ft (right 0.4, left 0.42, right 0.38 dot = two side changes beyond the
/// 0.3-dot dead band), settling to the touchdown offset from `DEMO_LATERAL_END_S` on.
const DEMO_LOC_DOTS: [(f64, f64); 6] = [(-9_000.0, 0.0), (-7_750.0, 0.62), (-6_650.0, 0.0), (-4_650.0, 0.40), (-3_200.0, -0.42), (-2_050.0, 0.38)];
const DEMO_LATERAL_END_S: f64 = -800.0;
const DEMO_LOC_DOT_M_AT_THRESHOLD: f64 = 52.0;

// ---- approach data (track v2) of the mock world ----
/// Wind at the aircraft, everywhere and at every height: 250° true / 8 kt (a typical
/// EDDF westerly, ~8 kt headwind on 25C). The path itself is flown over the ground and
/// TAS stays = GS, so the IAS/TAS the landing analysis sees are unchanged by it.
pub const MOCK_WIND_DIR_TRUE_DEG: f64 = 250.0;
pub const MOCK_WIND_KT: f64 = 8.0;
/// NAV 1 is tuned to the ILS 25C for the whole flight: 3.0° glideslope, antenna at the
/// point where the 3° path (TCH 50 ft) meets the runway; localizer 300 m beyond the far end.
pub const MOCK_ILS_GS_DEG: f64 = 3.0;
const LOC_BEYOND_END_M: f64 = 300.0;
/// Localizer full-scale needle deflection (±127) = 2 dots = ±104 m at the threshold (ICAO
/// course sector): 2 × the debrief's geometric dot seen from the localizer antenna.
const LOC_FULL_SCALE_DOTS: f64 = 2.0;
/// Glideslope usable within this distance and this angle off the localizer course.
const GS_RANGE_M: f64 = 10.0 * 1_852.0;
const GS_SECTOR_DEG: f64 = 8.0;
/// A320neo: flap handle 0, 1, 2, 3, FULL; design speeds (cfg constants).
const FLAP_POSITIONS: i32 = 5;
const DESIGN_VS0_KT: f64 = 104.0;
const DESIGN_VS1_KT: f64 = 125.0;
const DESIGN_VC_KT: f64 = 350.0;

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
    /// The demo landing with its small errors (standard variant, see `DEMO_*`).
    demo: bool,
}

impl Params {
    fn for_loop(variant: MockVariant, n: u64) -> Self {
        let i = (n % 4) as usize;
        if variant == MockVariant::Standard {
            return Self { variant, td_fpm: DEMO_TD_FPM[i], lateral_m: DEMO_LATERAL_M[i], demo: true };
        }
        let td_fpm = match variant {
            MockVariant::Bounce => [330.0, 290.0, 360.0, 310.0][i],
            _ => [150.0, 120.0, 185.0, 140.0][i],
        };
        Self { variant, td_fpm, lateral_m: [-1.8, 2.4, -0.6, 3.1][i], demo: false }
    }

    /// Where the first contact is aimed, metres past the threshold.
    fn touchdown_aim_m(&self) -> f64 {
        if self.demo { DEMO_TOUCHDOWN_M } else { TOUCHDOWN_AIM_M }
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
    off * smoothstep((s + 3000.0) / 2000.0) * rollout_fade(s)
}

/// After the touchdown the offset fades out: back on the centreline by 1 300 m.
fn rollout_fade(s: f64) -> f64 {
    1.0 - smoothstep((s - 700.0) / 600.0)
}

/// Smoothstep interpolation through `(x, y)` knots sorted by x; constant beyond the ends.
fn knots(k: &[(f64, f64)], x: f64) -> f64 {
    let (first, last) = (k[0], k[k.len() - 1]);
    if x <= first.0 {
        return first.1;
    }
    if x >= last.0 {
        return last.1;
    }
    let i = k.partition_point(|p| p.0 <= x);
    let (a, b) = (k[i - 1], k[i]);
    a.1 + (b.1 - a.1) * smoothstep((x - a.0) / (b.0 - a.0))
}

/// Demo glidepath deviation in dots at `s` (from the knots over the nominal path height).
fn demo_gs_dots(s: f64) -> f64 {
    // knots run from high to low; flip to increasing x
    let k: Vec<(f64, f64)> = DEMO_GS_DOTS.iter().rev().copied().collect();
    knots(&k, glide_ft(s))
}

/// Height of the path flown at `s`: the 3° glide path, with the demo's deviation.
fn path_ft(s: f64, demo: bool) -> f64 {
    if !demo {
        return glide_ft(s);
    }
    let gpip = TCH_FT / FT_PER_M / GLIDE_DEG.to_radians().tan();
    (gpip - s) * (GLIDE_DEG + DEMO_GS_DOT_DEG * demo_gs_dots(s)).to_radians().tan() * FT_PER_M
}

/// Where the demo path is `ft` high on the final (s between the final start and the threshold).
fn demo_s_at_ft(ft: f64) -> f64 {
    let (mut lo, mut hi) = (FINAL_S, 0.0);
    for _ in 0..60 {
        let mid = (lo + hi) / 2.0;
        if path_ft(mid, true) > ft {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// Demo lateral offset (m right) at `s`: the `DEMO_LOC_DOTS` profile converted with the
/// localizer geometry (`loc_ant_s` = the virtual antenna, s), then the touchdown offset,
/// faded out on the rollout.
fn demo_lateral(s: f64, off: f64, loc_ant_s: f64) -> f64 {
    let dot = DEMO_LOC_DOT_M_AT_THRESHOLD.atan2(loc_ant_s);
    let mut k: Vec<(f64, f64)> = DEMO_LOC_DOTS.iter().map(|&(ks, d)| (ks, (loc_ant_s - ks) * (d * dot).tan())).collect();
    k.push((DEMO_LATERAL_END_S, off));
    knots(&k, s) * rollout_fade(s)
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
    /// Flare state: (start time, start V/S fpm (negative), duration, demo float amplitude fpm).
    flare: Option<(f64, f64, f64, f64)>,
    /// Localizer antenna position (s) of the debrief's geometry, for the demo lateral profile.
    loc_ant_s: f64,
    /// Direction of the current path leg (the track without the demo's lateral profile).
    path_theta: f64,
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
            loc_ant_s: RunwayFrame::new(&MockFlight::runway()).length_m + LOC_BEYOND_END_M,
            path_theta: cur.theta,
            bounce_t0: None,
            touchdown_s: None,
            leg_starts: Vec::new(),
        }
    }

    fn legs(p: &Params) -> Vec<Leg> {
        use Path::*;
        use Speed::*;
        use Vert::*;
        let variant = p.variant;
        let climb = Ctrl { target: CIRCUIT_AGL_FT, fpm: 2_500.0 };
        let downwind_len = CROSSWIND_S - FINAL_S;
        let base_end_gs = if p.demo { DEMO_BASE_END_GS_KT } else { BASE_END_GS_KT };
        let circuit = [
            // crosswind/downwind turn (left), level-off at 2 500 ft
            Leg::new(Arc { radius: CIRCUIT_R_M, sweep: -PI }, To(215.0), climb).gear_up(),
            Leg::new(Line { len: downwind_len * 0.7 }, To(215.0), climb).gear_up(),
            // descending end of the downwind and base turn (left) onto a 9 km final
            Leg::new(Line { len: downwind_len * 0.3 }, To(200.0), Ctrl { target: INTERCEPT_AGL_FT, fpm: 900.0 }).gear_up(),
            Leg::new(Arc { radius: CIRCUIT_R_M, sweep: -PI }, To(base_end_gs), Ctrl { target: INTERCEPT_AGL_FT, fpm: 900.0 }).flaps(2),
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
        legs.extend(Self::arrival(variant, p.demo));
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
    fn arrival(variant: MockVariant, demo: bool) -> Vec<Leg> {
        use Path::*;
        use Speed::*;
        use Vert::*;
        let final_legs = if demo {
            // flaps 3 down to ~1 100 ft, FULL after; the FAF excess bled off by 500 ft
            let (s_full, s_500) = (demo_s_at_ft(DEMO_FLAPS_FULL_FT), demo_s_at_ft(500.0));
            let f = (s_full - FINAL_S) / (s_500 - FINAL_S);
            let gs_full = (DEMO_BASE_END_GS_KT.powi(2) + (DEMO_GS_500_KT.powi(2) - DEMO_BASE_END_GS_KT.powi(2)) * f).sqrt();
            vec![
                Leg::new(Line { len: s_full - FINAL_S }, To(gs_full), Glide).flaps(3),
                Leg::new(Line { len: s_500 - s_full }, To(DEMO_GS_500_KT), Glide).flaps(4),
                Leg::new(Line { len: -s_500 }, To(DEMO_GS_THRESHOLD_KT), Glide).flaps(4),
            ]
        } else {
            vec![Leg::new(Line { len: -FINAL_S }, To(126.0), Glide).flaps(4)]
        };
        let mut legs = final_legs;
        legs.extend([
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
        ]);
        legs
    }

    /// Lateral offset on the final, flare and rollout.
    fn lateral(&self, s: f64) -> f64 {
        if self.p.demo { demo_lateral(s, self.p.lateral_m, self.loc_ant_s) } else { lateral_offset(s, self.p.lateral_m) }
    }

    fn run(mut self) -> Self {
        for leg in Self::legs(&self.p) {
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
        // the path direction, not the demo's S-turn track on top of it
        let (start, theta0) = ((self.cur.s, self.cur.x), self.path_theta);
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
            self.path_theta = theta;
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
                    agl = smin(agl, path_ft(c.s, self.p.demo), 60.0);
                    c.x = self.lateral(c.s);
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
                c.x = self.lateral(c.s);
            }
        }
        let mut bank_target = bank_target;
        if self.p.demo && matches!(leg.vert, Vert::Glide | Vert::Flare | Vert::Bounce) {
            // the S on the final: track along the lateral profile, bank from its curvature
            let (h, v) = (1.0, c.gs_kt * KT);
            let (xm, x0, xp) = (self.lateral(c.s - h), self.lateral(c.s), self.lateral(c.s + h));
            c.theta += ((xp - xm) / (2.0 * h)).atan();
            bank_target = if c.agl > 0.0 { (v * v * (xp - 2.0 * x0 + xm) / (h * h) / 9.81).atan().to_degrees() } else { 0.0 };
        }
        if matches!(leg.vert, Vert::Ground) && leg.on_runway && self.touchdown_s.is_some() {
            // rollout: drift back from the touchdown offset to the centreline
            c.x = self.lateral(c.s);
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
            1.0 + c.td_fpm * if self.p.demo { DEMO_TD_G_PER_FPM } else { TD_G_PER_FPM }
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
        let glide = path_ft(s, self.p.demo);
        let v1 = -self.p.td_fpm;
        if self.flare.is_none() && glide <= self.hf {
            let v0 = prev.vs_fpm;
            self.flare = Some(if self.p.demo {
                // V/S(f) = v1 + (v0 − v1)(1 − f)³ + A·sin(πf) over a fixed time: most of the
                // rate is taken out early, a short float, then the aircraft settles at v1.
                // Its mean v1 + (v0 − v1)/4 + 2A/π must lose the flare height in DEMO_FLARE_S.
                // (the flare height was crossed a moment before this step: end on time anyway)
                let dur = DEMO_FLARE_S - (self.hf - prev.agl) * 60.0 / -v0.min(-1.0);
                let mean = -prev.agl * 60.0 / dur;
                (prev.t, v0, dur, (mean - v1 - (v0 - v1) / 4.0) * FRAC_PI_2)
            } else {
                // V/S(τ) = v0 + (v1 − v0)(τ/T)²: the mean (2 v0 + v1)/3 must lose the flare height
                let mean = (2.0 * v0 + v1) / 3.0;
                (prev.t, v0, prev.agl / (-mean / 60.0), 0.0)
            });
        }
        match self.flare {
            None => (glide, (glide - prev.agl) / dt * 60.0),
            Some((t0, v0, dur, float)) => {
                let f = ((t - t0) / dur).min(1.0);
                let vs = if self.p.demo { v1 + (v0 - v1) * (1.0 - f).powi(3) + float * (PI * f).sin() } else { v0 + (v1 - v0) * f * f };
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
    // flare height so the first contact is at the aimed distance past the threshold (monotonic:
    // a higher flare lands longer; with the demo's fixed flare time it starts earlier, so shorter)
    let aim = p.touchdown_aim_m();
    let (mut lo, mut hi) = if p.demo { (12.0, 32.0) } else { (5.0, 60.0) };
    let mut best: Option<Builder> = None;
    for _ in 0..30 {
        let hf = (lo + hi) / 2.0;
        let b = Builder::new(p, hf).run();
        let s = b.touchdown_s.unwrap_or(f64::INFINITY);
        if (s > aim) != p.demo {
            hi = hf;
        } else {
            lo = hf;
        }
        let err = (s - aim).abs();
        if best.as_ref().is_none_or(|b| err < (b.touchdown_s.unwrap_or(f64::INFINITY) - aim).abs()) {
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
        out.push(ProviderEvent::Telemetry(Box::new(self.sample(t_s, timestamp_ms))));
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
            ..self.approach_data(&p)
        }
    }

    /// The track-v2 values of a point: wind, ILS 25C on NAV 1, autopilot bits, N1,
    /// spoilers, alpha, flap positions and design speeds (see the `MOCK_*` constants).
    fn approach_data(&self, p: &Pt) -> Telemetry {
        let on_ground = p.agl <= 0.0;
        let landed = p.td_fpm > 0.0;
        // ILS geometry in the runway frame (s along the landing direction, x right)
        let loc_s = self.frame.length_m + LOC_BEYOND_END_M;
        let loc_err = p.x.atan2(loc_s - p.s).to_degrees();
        let gs_antenna_s = TCH_FT / FT_PER_M / MOCK_ILS_GS_DEG.to_radians().tan();
        let to_gs = gs_antenna_s - p.s;
        let gs_error = (p.agl / FT_PER_M).atan2(to_gs).to_degrees() - MOCK_ILS_GS_DEG;
        let gs_valid = to_gs > 0.0 && (loc_s - p.s).hypot(p.x) < GS_RANGE_M && loc_err.abs() < GS_SECTOR_DEG;
        let course = self.frame.heading_deg;
        let on_course = !on_ground && p.s < 0.0 && angle_diff(course + p.theta.to_degrees(), course) < 20.0 && p.x.abs() < 1_000.0;
        // automation: AP from 800 ft after take-off to 800 ft on final, A/THR down to the flare
        let ap = !on_ground && p.agl > 800.0;
        let appr = ap && on_course;
        let athr = !on_ground && p.agl > 30.0 && p.engines > 0;
        // N1: climb/level/descent from the V/S, idle in the flare, reverse on the rollout
        let n1 = if p.engines == 0 {
            0.0
        } else if on_ground {
            if p.on_runway && !landed && p.gs_kt > 5.0 {
                86.0
            } else if p.on_runway && landed && p.gs_kt > 60.0 {
                70.0
            } else {
                21.0 + p.gs_kt * 0.1
            }
        } else if landed || p.agl < 30.0 && p.vs_fpm < 0.0 {
            22.0
        } else {
            (52.0 + p.vs_fpm * 0.012).clamp(24.0, 88.0)
        };
        let reverse = on_ground && p.on_runway && landed && p.gs_kt > 60.0;
        let spoilers = if on_ground && p.on_runway && landed && p.gs_kt > 30.0 { 100.0 } else { 0.0 };
        let fpa = (p.vs_fpm / 60.0 / FT_PER_M).atan2((p.gs_kt * KT).max(1.0)).to_degrees();
        Telemetry {
            wind_dir_true_deg: Some(MOCK_WIND_DIR_TRUE_DEG),
            wind_kt: Some(MOCK_WIND_KT),
            nav_has_localizer: Some(true),
            nav_has_glide_slope: Some(true),
            nav_gs_flag: Some(gs_valid),
            nav_gs_error_deg: Some(gs_error),
            nav_gs_angle_deg: Some(MOCK_ILS_GS_DEG),
            // needle right (+) when the aircraft is left of the course
            nav_cdi: Some((-loc_err / (LOC_FULL_SCALE_DOTS * DEMO_LOC_DOT_M_AT_THRESHOLD.atan2(loc_s).to_degrees()) * 127.0).clamp(-127.0, 127.0)),
            nav_radial_error_deg: Some(loc_err),
            nav_loc_course_deg: Some((course - VARIATION_DEG).rem_euclid(360.0)),
            autopilot_master: Some(ap),
            autopilot_approach_hold: Some(appr),
            autopilot_glideslope_hold: Some(appr && gs_valid && gs_error.abs() < 0.5),
            autothrottle_active: Some(athr),
            n1_pct: Some(n1),
            throttle_lever_pct: Some(if reverse { 0.0 } else { ((n1 - 20.0) / 68.0 * 100.0).clamp(0.0, 100.0) }),
            spoilers_handle_pct: Some(spoilers),
            spoilers_armed: Some(p.flaps >= 3 && p.gear >= 99.0 && (!on_ground || landed && p.on_runway)),
            spoilers_pct: Some(spoilers),
            alpha_deg: Some(if on_ground { p.pitch } else { p.pitch - fpa }),
            flap_positions: Some(FLAP_POSITIONS),
            design_vs0_kt: Some(DESIGN_VS0_KT),
            design_vs1_kt: Some(DESIGN_VS1_KT),
            design_vc_kt: Some(DESIGN_VC_KT),
            ..Default::default()
        }
    }
}

/// Unsigned difference of two headings, degrees (0…180).
fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    d.min(360.0 - d)
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
    fn every_loop_fits_and_hits_its_touchdown_aim() {
        // (teleport / reconnect fly the standard path)
        for variant in [MockVariant::Standard, MockVariant::Bounce, MockVariant::GoAround] {
            for n in 0..4 {
                let tr = build(Params::for_loop(variant, n));
                let end = tr.pts.last().unwrap().t;
                // the rest of the loop is parked with engines off (shutdown dwell)
                assert!(end <= variant.loop_seconds() - 15.0, "{variant:?}/{n}: path takes {end:.0} s");
                let tol = if variant == MockVariant::Bounce { 60.0 } else { 2.0 };
                let aim = Params::for_loop(variant, n).touchdown_aim_m();
                assert!((tr.touchdown_s - aim).abs() < tol, "{variant:?}/{n}: {}", tr.touchdown_s);
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
