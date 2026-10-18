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
//!   samples), then at the end of the bounce window or the rollout;
//! - a bounce needs at least [`BOUNCE_MIN_AIR_MS`] (0.3 s) in the air between two ground
//!   contacts: a shorter gap (`SIM ON GROUND` flickering on grass or one gear leg, at
//!   sim frame rate) is the same contact (debounce window, see [`BOUNCE_MIN_AIR_MS`]).
//!
//! Outcome (full stop or touch-and-go): the report carries the landing
//! rate as soon as the bounce window is over, but a touch-and-go rolls 10–20 s before it
//! lifts off again, so the outcome is decided separately, after the report, and handed out
//! through [`TouchdownDetector::take_outcome`] (exactly one outcome per report):
//!
//! | outcome                          | condition (whichever comes first)                        |
//! |----------------------------------|----------------------------------------------------------|
//! | [`TouchdownOutcome::FullStop`]   | on ground below 30 kt GS (rollout over)                  |
//! | [`TouchdownOutcome::TouchAndGo`] | airborne again, > 50 ft AGL for 3 s and climbing (higher than where it passed 50 ft, or V/S > 0) – or > 50 ft for 10 s regardless – without having slowed below 30 kt first |
//! | [`TouchdownOutcome::FullStop`]   | on ground 120 s after the first contact, neither of the above |
//! | [`TouchdownOutcome::Unknown`]    | context reset ([`TouchdownDetector::reset`]) before a decision |
//!
//! While the report is still unsent (bounce window open), a decision made then is part of
//! the report itself (`touch_and_go`) and its outcome follows in the same sample. A climb
//! above 50 ft holds the report back until it is decided (at most 3 s), so a short-roll
//! touch-and-go is reported with `touch_and_go = true` right away; a long roll is reported
//! with `touch_and_go = false` and corrected by the outcome. Between the report and the
//! outcome the detector is "rolling": further contacts belong to the same event and do not
//! open a new report.
//!
//! Resets ([`TouchdownDetector::reset`], after a reconnect, teleport or reload): the ring
//! buffer and the `qualified` latch are dropped, so the first ground contact after a
//! reset is never a landing – the detector first needs qualified air time again
//! (> 500 ft AGL, or [`MS_REQUALIFY_AFTER_RESET`] when the reset happened in the air,
//! 60 s otherwise). A confirmed event still settling is handed back, not lost; an event
//! whose outcome was not decided yet gets [`TouchdownOutcome::Unknown`] rather than a guess.
//!
//! Time base: windows and timers (ring buffer, bounce window, confirmation, air time,
//! outcome timeout) run on a [`MonoClock`], so a backward step of the system clock counts
//! as Δt = 0; `TouchdownReport::timestamp_ms` stays the wall-clock time of the first
//! contact. Samples that are paused, slewed or time-accelerated
//! ([`Telemetry::time_accelerated`]) are skipped exactly like in the phase engine. A contact
//! made while fast-forwarding is therefore not evaluated by either; back at 1× on the
//! ground, both see the landing at the first real-time sample (the phase engine fires
//! Landing, the detector opens the report). Slewing and fast-forwarding drop the V/S ring
//! buffer, so the rate is the sim's touchdown value or, without one, the V/S of that
//! sample – never a V/S from before the skipped stretch. The flight carries
//! `time_acceleration_detected` either way.

use crate::Telemetry;
use crate::clock::MonoClock;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const RING_MS: u64 = 2_500;
const PEAK_G_WINDOW_MS: u64 = 500;
const BOUNCE_WINDOW_MS: u64 = 5_000;
/// Shorter air time between two ground contacts is one contact, not a bounce.
pub const BOUNCE_MIN_AIR_MS: u64 = 300;
/// Leaving the ground and climbing above this is a touch-and-go, below it a bounce.
const TOUCH_AND_GO_AGL_FT: f64 = 50.0;
/// … once it stayed above [`TOUCH_AND_GO_AGL_FT`] (and kept climbing) for this long.
pub const TOUCH_AND_GO_CLIMB_MS: u64 = 3_000;
/// … or stayed above it this long, climbing or not.
const TOUCH_AND_GO_AIRBORNE_MS: u64 = 10_000;
/// Rollout over: below this GS on the ground the touchdown is a full stop.
const ROLLOUT_DONE_KT: f64 = 30.0;
/// Without a decision this long after the first contact (on the ground) it is a full stop.
pub const OUTCOME_TIMEOUT_MS: u64 = 120_000;
const QUALIFY_AGL_FT: f64 = 500.0;
const QUALIFY_AIRBORNE_MS: u64 = 60_000;
/// Air time that requalifies a flight after a context reset in the air: long enough
/// that the ring buffer holds real airborne V/S again (and shared with the phase engine).
pub const MS_REQUALIFY_AFTER_RESET: u64 = 10_000;
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

/// How a touchdown ended (see the module doc for the rules).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TouchdownOutcome {
    /// Reported, not decided yet (still rolling).
    #[default]
    Pending,
    /// Rolled out (below 30 kt), or still on the ground 120 s after the first contact.
    FullStop,
    /// Climbed away again without having rolled out.
    TouchAndGo,
    /// The data stream broke off (reconnect, teleport, reload) before a decision.
    Unknown,
}

impl TouchdownOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            TouchdownOutcome::Pending => "pending",
            TouchdownOutcome::FullStop => "fullStop",
            TouchdownOutcome::TouchAndGo => "touchAndGo",
            TouchdownOutcome::Unknown => "unknown",
        }
    }

    pub fn is_decided(self) -> bool {
        self != TouchdownOutcome::Pending
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
    /// Aircraft climbed away again instead of rolling out. In a freshly emitted report this
    /// is only `true` when that was already decided; a long-roll touch-and-go is corrected
    /// by the [`TouchdownOutcome`] that follows (see the module doc).
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

/// Climb-out tracking for the touch-and-go decision: when (and at which AGL) the aircraft
/// passed [`TOUCH_AND_GO_AGL_FT`] in the current airborne stretch.
#[derive(Clone, Copy, Debug, Default)]
struct ClimbOut {
    since: Option<(u64, f64)>,
}

impl ClimbOut {
    /// Feed one sample; true once it is a touch-and-go: > 50 ft for 3 s and climbing (higher
    /// than where it passed 50 ft, or a positive V/S), or > 50 ft for 10 s whatever it does
    /// (it is flying again; the phase engine's Landing → Climb takes as long).
    fn update(&mut self, on_ground: bool, t: &Telemetry, now: u64) -> bool {
        let agl_ft = t.altitude_agl_ft;
        // NaN AGL counts as "not above"
        if on_ground || agl_ft.is_nan() || agl_ft <= TOUCH_AND_GO_AGL_FT {
            self.since = None;
            return false;
        }
        let (since, start_agl) = *self.since.get_or_insert((now, agl_ft));
        let above_ms = now.saturating_sub(since);
        let climbing = agl_ft > start_agl || t.vertical_speed_fpm > 0.0;
        above_ms >= TOUCH_AND_GO_CLIMB_MS && climbing || above_ms >= TOUCH_AND_GO_AIRBORNE_MS
    }

    /// Above 50 ft for less than [`TOUCH_AND_GO_CLIMB_MS`]: the decision is imminent.
    fn deciding(&self, now: u64) -> bool {
        self.since.is_some_and(|(s, _)| now.saturating_sub(s) < TOUCH_AND_GO_CLIMB_MS)
    }

    fn shift(&mut self, ms: u64) {
        if let Some((s, _)) = self.since.as_mut() {
            *s = s.saturating_add(ms);
        }
    }
}

#[derive(Debug)]
struct Event {
    report: TouchdownReport,
    /// First contact of the event (the outcome timeout runs from here).
    first_contact_ms: u64,
    last_contact_ms: u64,
    airborne_now: bool,
    /// When the current airborne stretch inside the window began.
    air_since_ms: u64,
    /// Start and sample count of the current corroborated ground run.
    ground_since_ms: u64,
    ground_samples: u32,
    confirmed: bool,
    /// Raw sim touchdown value while still airborne: a value equal to it is the previous
    /// landing's, not this one's.
    stale_sim: f64,
    /// Last airborne V/S before the current contact.
    contact_vs: f64,
    climb: ClimbOut,
}

/// Reported touchdown whose outcome is not decided yet.
#[derive(Debug)]
struct Rollout {
    first_contact_ms: u64,
    /// Start of the current airborne stretch, if airborne.
    air_since_ms: Option<u64>,
    climb: ClimbOut,
}

#[derive(Debug)]
enum State {
    /// Not yet clearly airborne in this flight.
    Ground,
    /// Flying; `qualified` latches once it was clearly a flight (> 500 ft AGL or > 60 s).
    Airborne { since: u64, qualified: bool },
    /// First contact happened; collecting peak G, bounces and confirmation.
    Settling(Box<Event>),
    /// Report emitted, waiting for the outcome (full stop or touch-and-go).
    Rolling(Rollout),
}

#[derive(Debug)]
pub struct TouchdownDetector {
    ring: VecDeque<Sample>,
    state: State,
    /// Raw sim touchdown value of the latest airborne sample.
    last_air_sim: f64,
    /// Air time that qualifies (shorter right after a reset in the air).
    qualify_ms: u64,
    /// Wall clock → monotonic time for every window and timer above (reports keep wall time).
    clock: MonoClock,
    /// Decided outcome of the last report, with the wall-clock time of the decision.
    outcome: Option<(TouchdownOutcome, u64)>,
    /// Wall-clock time of the latest sample (time of an outcome decided by a reset).
    last_wall_ms: u64,
}

impl Default for TouchdownDetector {
    fn default() -> Self {
        Self::new()
    }
}

/// Detector internals for the Diagnose view.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorDebug {
    /// ground | airborne | settling | rolling (reported, outcome pending)
    pub state: String,
    pub airborne_since_ms: Option<u64>,
    /// Airborne long/high enough that the next contact counts as a landing.
    pub qualified: bool,
    pub qualify_ms: u64,
    /// Settling: corroborated ground samples / confirmed / bounces / back in the air.
    pub ground_samples: u32,
    pub confirmed: bool,
    pub bounces: u32,
    pub airborne_now: bool,
    /// Settling: the sim touchdown value that still belongs to the previous landing.
    pub stale_sim: Option<f64>,
    /// Raw sim touchdown value of the latest airborne sample.
    pub last_air_sim: f64,
}

impl TouchdownDetector {
    pub fn debug(&self) -> DetectorDebug {
        let mut d = DetectorDebug { last_air_sim: self.last_air_sim, qualify_ms: self.qualify_ms, ..Default::default() };
        match &self.state {
            State::Ground => d.state = "ground".into(),
            State::Airborne { since, qualified } => {
                d.state = "airborne".into();
                d.airborne_since_ms = Some(self.clock.to_wall(*since));
                d.qualified = *qualified;
            }
            State::Settling(ev) => {
                d.state = "settling".into();
                d.qualified = true;
                d.ground_samples = ev.ground_samples;
                d.confirmed = ev.confirmed;
                d.bounces = ev.report.bounces;
                d.airborne_now = ev.airborne_now;
                d.stale_sim = Some(ev.stale_sim);
            }
            State::Rolling(r) => {
                d.state = "rolling".into();
                d.qualified = true;
                d.confirmed = true;
                d.airborne_now = r.air_since_ms.is_some();
                d.airborne_since_ms = r.air_since_ms.map(|m| self.clock.to_wall(m));
            }
        }
        d
    }

    pub fn new() -> Self {
        Self {
            ring: VecDeque::new(),
            state: State::Ground,
            last_air_sim: 0.0,
            qualify_ms: QUALIFY_AIRBORNE_MS,
            clock: MonoClock::new(),
            outcome: None,
            last_wall_ms: 0,
        }
    }

    /// Drop the V/S history and the airborne latch (data stream discontinuity). Returns
    /// the report of a confirmed touchdown that was still settling, so it is not lost.
    /// `resume_airborne`: the reset happened in the air, requalify after a short stretch.
    /// A touchdown reported (now or before) without a decided outcome gets
    /// [`TouchdownOutcome::Unknown`] (see [`TouchdownDetector::take_outcome`]).
    pub fn reset(&mut self, resume_airborne: bool) -> Option<TouchdownReport> {
        self.ring.clear();
        self.qualify_ms = if resume_airborne { MS_REQUALIFY_AFTER_RESET } else { QUALIFY_AIRBORNE_MS };
        match std::mem::replace(&mut self.state, State::Ground) {
            State::Settling(ev) if ev.confirmed => {
                self.decide(TouchdownOutcome::Unknown, self.last_wall_ms);
                Some(ev.report)
            }
            State::Rolling(_) => {
                self.decide(TouchdownOutcome::Unknown, self.last_wall_ms);
                None
            }
            _ => None,
        }
    }

    /// The outcome of the last report once it is decided (exactly once per report), with
    /// the wall-clock time of the decision. Call after [`TouchdownDetector::update`] and
    /// [`TouchdownDetector::reset`]; a report and its outcome can come from the same call.
    pub fn take_outcome(&mut self) -> Option<(TouchdownOutcome, u64)> {
        self.outcome.take()
    }

    /// A touchdown was reported and its outcome is not decided yet.
    pub fn outcome_pending(&self) -> bool {
        matches!(self.state, State::Rolling(_))
    }

    /// Cut a pause of `ms` out of the timers (air time, bounce window, outcome timeout).
    pub fn shift_time(&mut self, ms: u64) {
        for s in &mut self.ring {
            s.ts = s.ts.saturating_add(ms);
        }
        match &mut self.state {
            State::Ground => {}
            State::Airborne { since, .. } => *since = since.saturating_add(ms),
            State::Settling(ev) => {
                ev.first_contact_ms = ev.first_contact_ms.saturating_add(ms);
                ev.last_contact_ms = ev.last_contact_ms.saturating_add(ms);
                ev.ground_since_ms = ev.ground_since_ms.saturating_add(ms);
                ev.climb.shift(ms);
            }
            State::Rolling(r) => {
                r.first_contact_ms = r.first_contact_ms.saturating_add(ms);
                if let Some(s) = r.air_since_ms.as_mut() {
                    *s = s.saturating_add(ms);
                }
                r.climb.shift(ms);
            }
        }
    }

    /// Feed one sample; returns a finished report once the event is confirmed and the bounce
    /// window is over (or the rollout or a touch-and-go was decided before that). The
    /// outcome follows through [`TouchdownDetector::take_outcome`].
    pub fn update(&mut self, t: &Telemetry) -> Option<TouchdownReport> {
        // the clock sees every sample, so a backward step during a pause is absorbed too
        let now = self.clock.advance(t.timestamp_ms);
        self.last_wall_ms = t.timestamp_ms;
        // same rule as the phase engine: paused, slewed and time-accelerated samples do not count
        if t.slew || t.time_accelerated() {
            // the aircraft moved on without us: the V/S history no longer describes it
            self.ring.clear();
        }
        if t.paused || t.slew || t.time_accelerated() {
            return None;
        }
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
                    qualified || t.altitude_agl_ft > QUALIFY_AGL_FT || now.saturating_sub(since) > self.qualify_ms;
                if on_ground {
                    if qualified {
                        self.qualify_ms = QUALIFY_AIRBORNE_MS;
                        let mut ev = self.first_contact(t, now);
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
            State::Settling(ev) => self.settle(ev, t, now, on_ground, g),
            State::Rolling(r) => {
                self.roll(r, t, now, on_ground);
                None
            }
        };
        if !on_ground {
            self.last_air_sim = t.touchdown_vs_fpm;
        }
        out
    }

    fn decide(&mut self, outcome: TouchdownOutcome, wall_ms: u64) {
        self.outcome = Some((outcome, wall_ms));
    }

    fn settle(&mut self, mut ev: Box<Event>, t: &Telemetry, now: u64, on_ground: bool, g: f64) -> Option<TouchdownReport> {
        // peak G shortly after each contact
        if now.saturating_sub(ev.last_contact_ms) <= PEAK_G_WINDOW_MS {
            ev.report.peak_g = ev.report.peak_g.max(g);
        }
        if ev.climb.update(on_ground, t, now) {
            // climbed away before the report went out: a touch-and-go (kept, but never the
            // flight's landing rate), decided together with the report
            ev.report.touch_and_go = true;
            self.decide(TouchdownOutcome::TouchAndGo, t.timestamp_ms);
            self.state = State::Airborne { since: ev.air_since_ms, qualified: true };
            return Some(ev.report);
        }
        if !on_ground {
            if !ev.airborne_now {
                ev.airborne_now = true;
                ev.air_since_ms = now;
                // a sim value already shown now belongs to the earlier contact
                ev.stale_sim = t.touchdown_vs_fpm;
            }
        } else if ev.airborne_now && now.saturating_sub(ev.air_since_ms) < BOUNCE_MIN_AIR_MS {
            // ground flag flickered: still the same contact, the ground run goes on
            ev.airborne_now = false;
            ev.ground_samples += 1;
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
        if ev.confirmed && on_ground && t.ground_speed_kt < ROLLOUT_DONE_KT {
            // the rollout is already over: report and outcome at once
            self.decide(TouchdownOutcome::FullStop, t.timestamp_ms);
            self.state = State::Ground;
            return Some(ev.report);
        }
        // A climb above 50 ft holds the report until the touch-and-go is decided (≤ 3 s);
        // hanging above 50 ft without climbing further, the window closes as usual.
        let window_closed = now.saturating_sub(ev.last_contact_ms) > BOUNCE_WINDOW_MS;
        if window_closed && !ev.climb.deciding(now) && (ev.confirmed || ev.airborne_now) {
            // landing rate known, outcome not yet: report now, decide after the rollout
            self.state = State::Rolling(Rollout {
                first_contact_ms: ev.first_contact_ms,
                air_since_ms: ev.airborne_now.then_some(ev.air_since_ms),
                climb: ev.climb,
            });
            return Some(ev.report);
        }
        self.state = State::Settling(ev);
        None
    }

    /// Reported, outcome pending: rolled out, climbed away, or timed out.
    fn roll(&mut self, mut r: Rollout, t: &Telemetry, now: u64, on_ground: bool) {
        if on_ground {
            r.air_since_ms = None;
            r.climb.update(true, t, now);
            if t.ground_speed_kt < ROLLOUT_DONE_KT || now.saturating_sub(r.first_contact_ms) >= OUTCOME_TIMEOUT_MS {
                self.decide(TouchdownOutcome::FullStop, t.timestamp_ms);
                self.state = State::Ground;
                return;
            }
        } else {
            let since = *r.air_since_ms.get_or_insert(now);
            if r.climb.update(false, t, now) {
                self.decide(TouchdownOutcome::TouchAndGo, t.timestamp_ms);
                // the climb-out belongs to a real flight: the next contact is a landing again
                self.state = State::Airborne { since, qualified: true };
                return;
            }
        }
        self.state = State::Rolling(r);
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

    fn first_contact(&self, t: &Telemetry, now: u64) -> Event {
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
            first_contact_ms: now,
            last_contact_ms: now,
            airborne_now: false,
            air_since_ms: now,
            ground_since_ms: now,
            ground_samples: 1,
            confirmed: false,
            stale_sim: self.last_air_sim,
            contact_vs: vs_measured,
            climb: ClimbOut::default(),
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
    /// measured fallback, used only when the sim reports nothing usable.
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
        outcomes: Vec<TouchdownOutcome>,
    }

    impl Feed {
        fn new(step: u64) -> Self {
            Self { det: TouchdownDetector::new(), t_ms: 1_000_000, step, out: Vec::new(), outcomes: Vec::new() }
        }
        fn run(&mut self, secs: f64, f: impl Fn(&mut Telemetry)) {
            for _ in 0..((secs * 1000.0) / self.step as f64).round() as u64 {
                self.t_ms += self.step;
                let mut t = Telemetry { timestamp_ms: self.t_ms, sim_rate: 1.0, ..Default::default() };
                f(&mut t);
                if let Some(r) = self.det.update(&t) {
                    self.out.push(r);
                }
                self.outcomes.extend(self.det.take_outcome().map(|(o, _)| o));
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
    fn ground_flag_flicker_under_0_3_s_is_one_contact() {
        // 50 Hz-ish: the on-ground flag drops for 0.2 s twice (grass, one gear leg) – no bounce
        let mut f = Feed::new(50);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -160.0, 0.0));
        f.run(0.5, ground(120.0, 160.0));
        f.run(0.2, air(0.5, -20.0, 160.0));
        f.run(0.6, ground(118.0, 160.0));
        f.run(0.25, air(0.5, -10.0, 160.0));
        f.run(8.0, ground(100.0, 160.0));
        assert_eq!(f.out.len(), 1, "{:?}", f.out);
        let r = &f.out[0];
        assert_eq!((r.bounces, r.touch_and_go), (0, false));
        assert_eq!((r.landing_rate_fpm, r.landing_rate_source), (-160.0, LandingRateSource::Sim));
        assert_eq!(r.vs_fpm_hardest, -160.0, "the flicker's V/S is no contact of its own");

        // 0.3 s and more in the air is a bounce
        let mut f = Feed::new(50);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -160.0, 0.0));
        f.run(0.5, ground(120.0, 160.0));
        f.run(0.35, air(1.5, -60.0, 160.0));
        f.run(8.0, ground(100.0, 160.0));
        assert_eq!(f.out[0].bounces, 1, "{:?}", f.out);
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
        assert_eq!(f.outcomes, vec![TouchdownOutcome::TouchAndGo]);
    }

    #[test]
    fn outcome_follows_the_report_once() {
        let mut f = Feed::new(250);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -150.0, 0.0));
        f.run(8.0, ground(90.0, 150.0));
        assert_eq!((f.out.len(), f.outcomes.len()), (1, 0), "reported, still rolling");
        assert!(f.det.outcome_pending());
        assert_eq!(f.det.debug().state, "rolling");
        // a hop below 50 ft while rolling is neither a new touchdown nor a decision
        f.run(1.0, air(20.0, 300.0, 0.0));
        f.run(3.0, ground(60.0, 150.0));
        assert_eq!((f.out.len(), f.outcomes.len()), (1, 0));
        f.run(2.0, ground(25.0, 150.0));
        assert_eq!(f.outcomes, vec![TouchdownOutcome::FullStop]);
        assert!(!f.det.outcome_pending());
        assert_eq!(f.det.take_outcome(), None, "handed out once");
    }

    #[test]
    fn level_above_50_ft_for_10_s_is_a_touch_and_go_too() {
        // synthetic: no climb at all after the lift-off, yet clearly flying again; the next
        // landing must not be swallowed by a touchdown that never got its outcome
        let mut f = Feed::new(250);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -150.0, 0.0));
        f.run(8.0, ground(90.0, 150.0));
        f.run(9.0, air(400.0, -100.0, 150.0));
        assert!(f.outcomes.is_empty(), "level and sinking: not yet");
        f.run(1.5, air(400.0, -100.0, 150.0));
        assert_eq!(f.outcomes, vec![TouchdownOutcome::TouchAndGo]);
        f.run(60.0, air(1500.0, -700.0, 150.0));
        f.run(2.0, air(10.0, -120.0, 150.0));
        f.run(8.0, ground(20.0, 121.0));
        assert_eq!(f.out.len(), 2);
        assert_eq!(f.outcomes, vec![TouchdownOutcome::TouchAndGo, TouchdownOutcome::FullStop]);
    }

    #[test]
    fn reset_while_rolling_is_unknown() {
        let mut f = Feed::new(250);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -150.0, 0.0));
        f.run(7.0, ground(90.0, 150.0));
        assert_eq!(f.det.reset(false), None, "already reported");
        assert_eq!(f.det.take_outcome(), Some((TouchdownOutcome::Unknown, f.t_ms)));
        // an unconfirmed contact is dropped without an outcome
        let mut f = Feed::new(250);
        f.run(70.0, air(1500.0, -700.0, 0.0));
        f.run(2.0, air(10.0, -150.0, 0.0));
        f.run(0.5, ground(120.0, 150.0));
        assert_eq!(f.det.reset(false), None);
        assert_eq!(f.det.take_outcome(), None);
    }
}
