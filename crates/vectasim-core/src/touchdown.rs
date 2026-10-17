//! Touchdown detector, fed with the full-rate telemetry stream.
//!
//! Why a separate component from the phase engine: the sim's `VERTICAL SPEED`
//! is meaningless once on the ground and 1 Hz sampling misses the real contact
//! value (contact lasts a single sim frame). So we keep a short ring
//! buffer of airborne samples and, on the on-ground edge, report the last
//! airborne V/S, the sim's own touchdown value where available, peak G in the
//! half second after contact, and bounces within a 5 s window.
//!
//! Landing-rate rules:
//! - headline rate per event = the sim's touchdown normal velocity, negative-down,
//!   rounded; if the sim reports ~0 (|v| < 1 fpm, e.g. off registered runways)
//!   the last airborne V/S before contact ([`compute_landing_rate`]);
//! - the sim value is "last touchdown", so every bounce contact can bring a fresh
//!   value: the event's rate is the worst contact of that event, never a flight peak;
//! - an on-ground flag is only believed when AGL ≤ 50 ft (or, without a usable AGL,
//!   GS ≤ 200 kt) – [`ground_contact_corroborated`];
//! - first contact opens the report; it is only emitted after the aircraft was
//!   corroborated on ground for 3 consecutive samples spanning ≥ 2 s (three 1 Hz
//!   samples), then at the end of the bounce window or the rollout.

use crate::Telemetry;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const RING_MS: u64 = 2_500;
const PEAK_G_WINDOW_MS: u64 = 500;
const BOUNCE_WINDOW_MS: u64 = 5_000;
/// Leaving the ground and climbing above this is a touch-and-go, below it a bounce.
const TOUCH_AND_GO_AGL_FT: f64 = 50.0;
const ROLLOUT_DONE_KT: f64 = 30.0;
const QUALIFY_AGL_FT: f64 = 500.0;
const QUALIFY_AIRBORNE_MS: u64 = 60_000;
const G_MAX_PLAUSIBLE: f64 = 5.0;
/// On-ground corroboration: AGL limit, or GS limit when AGL is unusable.
pub const ON_GROUND_MAX_AGL_FT: f64 = 50.0;
pub const ON_GROUND_MAX_GS_KT: f64 = 200.0;
/// Confirmation: consecutive corroborated ground samples and the time they must span.
const CONFIRM_SAMPLES: u32 = 3;
const CONFIRM_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LandingRateSource {
    /// The sim's touchdown normal velocity.
    Sim,
    /// Last airborne V/S sample before contact (sim reported none).
    #[default]
    Measured,
}

impl LandingRateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            LandingRateSource::Sim => "sim",
            LandingRateSource::Measured => "measured",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "sim" { LandingRateSource::Sim } else { LandingRateSource::Measured }
    }
}

/// Headline landing rate of one contact: `-(sim touchdown velocity)` in fpm, negative-down,
/// or the last airborne V/S if the sim value is below 1 fpm. Rounded to whole fpm.
/// `sim_touchdown_fpm` is the raw sim value (MSFS: positive-down).
pub fn compute_landing_rate(sim_touchdown_fpm: f64, last_airborne_vs_fpm: f64) -> (f64, LandingRateSource) {
    let fpm = -sim_touchdown_fpm.abs();
    if fpm.is_finite() && fpm.abs() >= 1.0 {
        (fpm.round(), LandingRateSource::Sim)
    } else {
        (last_airborne_vs_fpm.round(), LandingRateSource::Measured)
    }
}

/// Whether an on-ground flag is backed by the rest of the sample. MSFS can report
/// "on ground" for single frames at altitude; such a sample counts as airborne.
pub fn ground_contact_corroborated(t: &Telemetry) -> bool {
    t.on_ground
        && if t.altitude_agl_ft.is_finite() {
            t.altitude_agl_ft <= ON_GROUND_MAX_AGL_FT
        } else {
            t.ground_speed_kt <= ON_GROUND_MAX_GS_KT
        }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TouchdownReport {
    pub timestamp_ms: u64,
    /// V/S of the last airborne sample before contact (negative = descending).
    pub vs_fpm_measured: f64,
    /// Sim-reported touchdown V/S of the first contact, normalised to negative-down; 0 if the sim has none.
    pub vs_fpm_sim: f64,
    /// Hardest contact in the bounce window, measured or sim, whichever is more negative.
    pub vs_fpm_hardest: f64,
    pub peak_g: f64,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub ground_speed_kt: f64,
    pub heading_true_deg: f64,
    pub latitude: f64,
    pub longitude: f64,
    pub bounces: u32,
    /// Aircraft climbed away again instead of rolling out.
    pub touch_and_go: bool,
    /// Headline landing rate of this event: worst contact, sim value preferred (see module doc).
    #[serde(default)]
    pub landing_rate_fpm: f64,
    #[serde(default)]
    pub landing_rate_source: LandingRateSource,
}

#[derive(Clone, Copy, Debug)]
struct Sample {
    ts: u64,
    vs: f64,
    on_ground: bool,
}

#[derive(Debug)]
struct Event {
    report: TouchdownReport,
    last_contact_ms: u64,
    airborne_now: bool,
    /// Start and sample count of the current corroborated ground run.
    ground_since_ms: u64,
    ground_samples: u32,
    confirmed: bool,
    /// Raw sim touchdown value while still airborne: a value equal to it is the previous
    /// landing's, not this one's.
    stale_sim: f64,
    /// Last airborne V/S before the current contact.
    contact_vs: f64,
}

#[derive(Debug)]
enum State {
    /// Not yet clearly airborne in this flight.
    Ground,
    /// Flying; `qualified` latches once it was clearly a flight (> 500 ft AGL or > 60 s).
    Airborne { since: u64, qualified: bool },
    /// First contact happened; collecting peak G, bounces and confirmation.
    Settling(Box<Event>),
}

#[derive(Debug)]
pub struct TouchdownDetector {
    ring: VecDeque<Sample>,
    state: State,
    /// Raw sim touchdown value of the latest airborne sample.
    last_air_sim: f64,
}

impl Default for TouchdownDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl TouchdownDetector {
    pub fn new() -> Self {
        Self { ring: VecDeque::new(), state: State::Ground, last_air_sim: 0.0 }
    }

    /// Feed one sample; returns a finished report once the event is confirmed and over
    /// (or as a touch-and-go when the aircraft climbed away).
    pub fn update(&mut self, t: &Telemetry) -> Option<TouchdownReport> {
        if t.paused || t.slew {
            return None;
        }
        let now = t.timestamp_ms;
        let g = if (0.0..=G_MAX_PLAUSIBLE).contains(&t.g_force) { t.g_force } else { 1.0 };
        let on_ground = ground_contact_corroborated(t);
        self.push(Sample { ts: now, vs: t.vertical_speed_fpm, on_ground });

        let out = match std::mem::replace(&mut self.state, State::Ground) {
            State::Ground => {
                self.state = if on_ground { State::Ground } else { State::Airborne { since: now, qualified: false } };
                None
            }
            State::Airborne { since, qualified } => {
                let qualified =
                    qualified || t.altitude_agl_ft > QUALIFY_AGL_FT || now.saturating_sub(since) > QUALIFY_AIRBORNE_MS;
                if on_ground {
                    if qualified {
                        let mut ev = self.first_contact(t);
                        ev.note_sim(t.touchdown_vs_fpm);
                        self.state = State::Settling(Box::new(ev));
                    } else {
                        // brief hop (e.g. aircraft reload on the runway) – not a landing
                        self.state = State::Ground;
                    }
                } else {
                    self.state = State::Airborne { since, qualified };
                }
                None
            }
            State::Settling(ev) => self.settle(ev, t, on_ground, g),
        };
        if !on_ground {
            self.last_air_sim = t.touchdown_vs_fpm;
        }
        out
    }

    fn settle(&mut self, mut ev: Box<Event>, t: &Telemetry, on_ground: bool, g: f64) -> Option<TouchdownReport> {
        let now = t.timestamp_ms;
        // peak G shortly after each contact
        if now.saturating_sub(ev.last_contact_ms) <= PEAK_G_WINDOW_MS {
            ev.report.peak_g = ev.report.peak_g.max(g);
        }
        if !on_ground {
            if t.altitude_agl_ft > TOUCH_AND_GO_AGL_FT {
                // climbed away: a touch-and-go (kept, but never the flight's landing rate)
                ev.report.touch_and_go = true;
                self.state = State::Airborne { since: now, qualified: true };
                return Some(ev.report);
            }
            if !ev.airborne_now {
                ev.airborne_now = true;
                // a sim value already shown now belongs to the earlier contact
                ev.stale_sim = t.touchdown_vs_fpm;
            }
        } else if ev.airborne_now {
            // came back down inside the window without climbing away: a bounce
            ev.report.bounces += 1;
            ev.contact_vs = self.last_airborne_vs().unwrap_or(t.vertical_speed_fpm);
            ev.report.vs_fpm_hardest = ev.report.vs_fpm_hardest.min(ev.contact_vs);
            ev.consider(compute_landing_rate(0.0, ev.contact_vs));
            ev.airborne_now = false;
            ev.last_contact_ms = now;
            ev.ground_since_ms = now;
            ev.ground_samples = 1;
            ev.note_sim(t.touchdown_vs_fpm);
        } else {
            ev.ground_samples += 1;
            ev.note_sim(t.touchdown_vs_fpm);
        }
        if !ev.confirmed && !ev.airborne_now {
            ev.confirmed = ev.ground_samples >= CONFIRM_SAMPLES && now.saturating_sub(ev.ground_since_ms) >= CONFIRM_MS;
        }
        let window_closed = now.saturating_sub(ev.last_contact_ms) > BOUNCE_WINDOW_MS;
        let rolled_out = on_ground && t.ground_speed_kt < ROLLOUT_DONE_KT;
        if ev.confirmed && (window_closed || rolled_out) {
            self.state = State::Ground;
            return Some(ev.report);
        }
        if window_closed && ev.airborne_now {
            // stayed low in the air for the whole window: it did not stay down
            ev.report.touch_and_go = true;
            self.state = State::Airborne { since: now, qualified: true };
            return Some(ev.report);
        }
        self.state = State::Settling(ev);
        None
    }

    fn push(&mut self, s: Sample) {
        self.ring.push_back(s);
        while self.ring.front().is_some_and(|f| s.ts.saturating_sub(f.ts) > RING_MS) {
            self.ring.pop_front();
        }
    }

    fn last_airborne_vs(&self) -> Option<f64> {
        self.ring.iter().rev().find(|s| !s.on_ground).map(|s| s.vs)
    }

    fn first_contact(&self, t: &Telemetry) -> Event {
        let vs_measured = self.last_airborne_vs().unwrap_or(t.vertical_speed_fpm);
        let (rate, source) = compute_landing_rate(0.0, vs_measured);
        Event {
            report: TouchdownReport {
                timestamp_ms: t.timestamp_ms,
                vs_fpm_measured: vs_measured,
                // filled by `note_sim` once the sim reports this touchdown
                vs_fpm_sim: 0.0,
                vs_fpm_hardest: vs_measured,
                peak_g: t.g_force.clamp(0.0, G_MAX_PLAUSIBLE),
                pitch_deg: t.pitch_deg,
                bank_deg: t.bank_deg,
                ground_speed_kt: t.ground_speed_kt,
                heading_true_deg: t.heading_true_deg,
                latitude: t.latitude,
                longitude: t.longitude,
                bounces: 0,
                touch_and_go: false,
                landing_rate_fpm: rate,
                landing_rate_source: source,
            },
            last_contact_ms: t.timestamp_ms,
            airborne_now: false,
            ground_since_ms: t.timestamp_ms,
            ground_samples: 1,
            confirmed: false,
            stale_sim: self.last_air_sim,
            contact_vs: vs_measured,
        }
    }
}

impl Event {
    /// A sim touchdown value seen on the ground; counts when it belongs to this event.
    fn note_sim(&mut self, raw: f64) {
        if raw == self.stale_sim || !raw.is_finite() || raw.abs() < 1.0 {
            return;
        }
        // MSFS reports PLANE TOUCHDOWN NORMAL VELOCITY positive-down; normalise to the
        // V/S sign convention so the UI can compare the two.
        let sim = -raw.abs();
        if self.report.bounces == 0 && self.report.vs_fpm_sim == 0.0 {
            self.report.vs_fpm_sim = sim;
        }
        self.report.vs_fpm_hardest = self.report.vs_fpm_hardest.min(sim);
        self.consider(compute_landing_rate(raw, self.contact_vs));
    }

    /// Keep the worst contact of this event as its landing rate. A sim value outranks a
    /// measured fallback (the reference only falls back when the sim has nothing).
    fn consider(&mut self, (rate, source): (f64, LandingRateSource)) {
        let r = &mut self.report;
        let replace = match (r.landing_rate_source, source) {
            (LandingRateSource::Measured, LandingRateSource::Sim) => true,
            (LandingRateSource::Sim, LandingRateSource::Measured) => false,
            _ => rate.abs() > r.landing_rate_fpm.abs(),
        };
        if replace {
            r.landing_rate_fpm = rate;
            r.landing_rate_source = source;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Feed {
        det: TouchdownDetector,
        t_ms: u64,
        step: u64,
        out: Vec<TouchdownReport>,
    }

    impl Feed {
        fn new(step: u64) -> Self {
            Self { det: TouchdownDetector::new(), t_ms: 1_000_000, step, out: Vec::new() }
        }
        fn run(&mut self, secs: f64, f: impl Fn(&mut Telemetry)) {
            for _ in 0..((secs * 1000.0) / self.step as f64).round() as u64 {
                self.t_ms += self.step;
                let mut t = Telemetry { timestamp_ms: self.t_ms, sim_rate: 1.0, ..Default::default() };
                f(&mut t);
                if let Some(r) = self.det.update(&t) {
                    self.out.push(r);
                }
            }
        }
    }

    fn air(agl: f64, vs: f64, sim: f64) -> impl Fn(&mut Telemetry) {
        move |t| {
            t.on_ground = false;
            t.altitude_agl_ft = agl;
            t.vertical_speed_fpm = vs;
            t.ground_speed_kt = 140.0;
            t.touchdown_vs_fpm = sim;
        }
    }

    fn ground(gs: f64, sim: f64) -> impl Fn(&mut Telemetry) {
        move |t| {
            t.on_ground = true;
            t.altitude_agl_ft = 0.0;
            t.ground_speed_kt = gs;
            t.touchdown_vs_fpm = sim;
        }
    }

    #[test]
    fn landing_rate_prefers_sim_and_falls_back_to_measured() {
        assert_eq!(compute_landing_rate(212.4, -180.0), (-212.0, LandingRateSource::Sim));
        assert_eq!(compute_landing_rate(0.4, -180.6), (-181.0, LandingRateSource::Measured));
        assert_eq!(compute_landing_rate(0.0, -95.2), (-95.0, LandingRateSource::Measured));
    }

    #[test]
    fn sim_value_zero_falls_back_to_measured_vs() {
        let mut f = Feed::new(50);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(20.0, -240.0, 0.0));
        f.run(8.0, ground(100.0, 0.0)); // sim reports nothing (off a registered runway)
        assert_eq!(f.out.len(), 1);
        let r = &f.out[0];
        assert_eq!((r.landing_rate_fpm, r.landing_rate_source), (-240.0, LandingRateSource::Measured));
        assert_eq!(r.vs_fpm_sim, 0.0);
    }

    #[test]
    fn stale_sim_value_of_the_previous_landing_is_ignored() {
        let mut f = Feed::new(50);
        // the sim still holds 310 fpm from an earlier landing while we fly this approach
        f.run(70.0, air(1500.0, -700.0, 310.0));
        f.run(2.0, air(20.0, -150.0, 310.0));
        f.run(8.0, ground(100.0, 310.0));
        let r = &f.out[0];
        assert_eq!((r.landing_rate_fpm, r.landing_rate_source), (-150.0, LandingRateSource::Measured));
    }

    #[test]
    fn worst_of_bounces_within_one_event() {
        let mut f = Feed::new(50);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(15.0, -180.0, 0.0));
        f.run(0.4, ground(125.0, 180.0)); // first contact, sim 180 fpm
        f.run(0.8, air(4.0, -330.0, 180.0)); // bounce
        f.run(6.0, ground(110.0, 330.0)); // second contact is harder, sim updates
        assert_eq!(f.out.len(), 1, "{:?}", f.out);
        let r = &f.out[0];
        assert_eq!(r.bounces, 1);
        assert_eq!((r.landing_rate_fpm, r.landing_rate_source), (-330.0, LandingRateSource::Sim));
        assert_eq!(r.vs_fpm_sim, -180.0, "first contact's sim value stays visible");
        assert_eq!(r.vs_fpm_measured, -180.0);
        assert_eq!(r.vs_fpm_hardest, -330.0);

        // the next landing of the same flight starts from scratch: no flight-wide peak
        f.run(70.0, air(1500.0, -700.0, 330.0));
        f.run(2.0, air(15.0, -90.0, 330.0));
        f.run(8.0, ground(100.0, 93.0));
        let r = &f.out[1];
        assert_eq!((r.landing_rate_fpm, r.bounces), (-93.0, 0));
    }

    #[test]
    fn bounce_without_new_sim_value_keeps_the_sim_rate() {
        let mut f = Feed::new(50);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(15.0, -200.0, 0.0));
        f.run(0.4, ground(125.0, 210.0));
        f.run(0.8, air(4.0, -260.0, 210.0));
        f.run(6.0, ground(110.0, 210.0)); // sim did not register the bounce
        let r = &f.out[0];
        assert_eq!((r.landing_rate_fpm, r.landing_rate_source), (-210.0, LandingRateSource::Sim));
        assert_eq!(r.vs_fpm_hardest, -260.0, "measured bounce still shows as hardest contact");
    }

    #[test]
    fn uncorroborated_on_ground_at_altitude_is_ignored() {
        let mut f = Feed::new(1000);
        f.run(120.0, air(8900.0, 0.0, 0.0));
        // the sim can claim "on ground" at altitude for a few samples
        f.run(10.0, |t| {
            air(8900.0, 0.0, 0.0)(t);
            t.on_ground = true;
        });
        f.run(60.0, air(1500.0, -700.0, 0.0));
        f.run(3.0, air(20.0, -95.0, 0.0));
        f.run(10.0, ground(100.0, 93.0));
        assert_eq!(f.out.len(), 1, "{:?}", f.out);
        assert_eq!(f.out[0].landing_rate_fpm, -93.0);

        // without a usable AGL the ground speed decides
        let t = Telemetry { on_ground: true, altitude_agl_ft: f64::NAN, ground_speed_kt: 250.0, ..Default::default() };
        assert!(!ground_contact_corroborated(&t));
        assert!(ground_contact_corroborated(&Telemetry { ground_speed_kt: 120.0, ..t }));
    }

    #[test]
    fn report_waits_for_confirmation() {
        // 1 Hz: below 30 kt already on the 2nd ground sample – still waits for the 3rd
        let mut f = Feed::new(1000);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -120.0, 0.0));
        f.run(1.0, ground(40.0, 0.0));
        let contact = f.t_ms;
        f.run(1.0, ground(25.0, 0.0));
        assert!(f.out.is_empty(), "rolled out but not yet confirmed");
        f.run(1.0, ground(20.0, 0.0));
        assert_eq!(f.out.len(), 1);
        let r = &f.out[0];
        assert_eq!(r.timestamp_ms, contact, "carries the first contact's time");
        assert!(!r.touch_and_go);
    }

    #[test]
    fn touch_and_go_before_confirmation_is_flagged() {
        let mut f = Feed::new(250);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -200.0, 0.0));
        f.run(1.0, ground(120.0, 200.0));
        f.run(5.0, air(300.0, 900.0, 200.0));
        assert_eq!(f.out.len(), 1);
        assert!(f.out[0].touch_and_go);
        assert_eq!(f.out[0].landing_rate_fpm, -200.0);
    }
}
