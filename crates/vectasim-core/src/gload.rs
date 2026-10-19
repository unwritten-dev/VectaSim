//! G-load over the whole flight: highest and lowest load factor in the air, with time,
//! phase and altitude, plus how often it left the 0.5–1.5 g band for a noticeable moment.
//! The landing itself is judged separately (`TouchdownReport::peak_g`); this is everything
//! else – a hard rotation, turbulence, an abrupt level-off, a push-over.
//!
//! Rules (live: every telemetry sample, typically 10–20 Hz; old flights: the 1 Hz track):
//! - only airborne samples (`on_ground` false) that the phase engine evaluated: paused,
//!   slewed and time-accelerated samples are left out, and break the smoothing and a
//!   running excursion;
//! - not delivered (exactly 0.0, which no sim reports in flight), non-finite or outside
//!   ±[`G_PLAUSIBLE`] g counts as no value;
//! - noise filter: moving average over [`SMOOTHING_MS`] (at 1 Hz that is the sample itself),
//!   so a single spiky frame does not count – max, min and the excursions use the average;
//! - touchdown window: samples from [`TOUCHDOWN_WINDOW_MS`] before a ground contact (airborne
//!   → `on_ground`) until as long after it are left out – that load is the landing's
//!   `peak_g`. To drop the seconds *before* the contact, samples are committed with a delay
//!   of the window; a lift-off is not a ground contact and stays in;
//! - excursions: above [`HIGH_G`] or below [`LOW_G`] for at least [`EXCURSION_MIN_MS`]
//!   (from the first sample outside to the current one) counts once; the next one needs
//!   the load back inside the band first.

use crate::phase::FlightPhase;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Moving-average window of the noise filter, ms.
pub const SMOOTHING_MS: u64 = 300;
/// Left out around every ground contact (before and after), ms – the landing's own window.
pub const TOUCHDOWN_WINDOW_MS: u64 = 3_000;
/// An excursion above this counts as a "high-g moment", g.
pub const HIGH_G: f64 = 1.5;
/// An excursion below this counts as a "low-g moment", g.
pub const LOW_G: f64 = 0.5;
/// An excursion has to last this long to count (debounce), ms.
pub const EXCURSION_MIN_MS: u64 = 500;
/// Values beyond ±this are garbage (sim glitch, reload), g.
pub const G_PLAUSIBLE: f64 = 10.0;

/// Where the numbers come from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GLoadSource {
    /// Recorded live from the telemetry stream.
    #[default]
    Live,
    /// Derived afterwards from the stored 1 Hz track (flights recorded before this existed).
    Track,
}

impl GLoadSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Track => "track",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "live" => Some(Self::Live),
            "track" => Some(Self::Track),
            _ => None,
        }
    }
}

/// One extreme: the (smoothed) load, when, in which phase and at what altitude.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GLoadPoint {
    pub g: f64,
    pub timestamp_ms: u64,
    pub phase: FlightPhase,
    pub altitude_msl_ft: f64,
}

/// The g-load of a flight outside the touchdowns (see the module doc).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GLoadStats {
    /// `None` while no airborne sample was evaluated.
    pub max: Option<GLoadPoint>,
    pub min: Option<GLoadPoint>,
    /// Excursions above [`HIGH_G`] / below [`LOW_G`] of at least [`EXCURSION_MIN_MS`].
    pub high_count: u32,
    pub low_count: u32,
    #[serde(default)]
    pub source: GLoadSource,
}

impl GLoadStats {
    /// Two stretches of one flight (resume / merge): the extremes win, the counts add up.
    /// The source is `Track` as soon as one part is.
    pub fn merged(&self, other: &GLoadStats) -> GLoadStats {
        let pick = |a: Option<GLoadPoint>, b: Option<GLoadPoint>, higher: bool| match (a, b) {
            (Some(x), Some(y)) => Some(if (y.g > x.g) == higher && y.g != x.g { y } else { x }),
            (x, y) => x.or(y),
        };
        GLoadStats {
            max: pick(self.max, other.max, true),
            min: pick(self.min, other.min, false),
            high_count: self.high_count + other.high_count,
            low_count: self.low_count + other.low_count,
            source: if self.source == GLoadSource::Track || other.source == GLoadSource::Track {
                GLoadSource::Track
            } else {
                GLoadSource::Live
            },
        }
    }

    /// Nothing measured.
    pub fn is_empty(&self) -> bool {
        self.max.is_none() && self.min.is_none()
    }
}

/// One sample as the tracker sees it.
#[derive(Clone, Copy, Debug)]
pub struct GSample {
    /// Monotonic time for the windows, ms.
    pub mono_ms: u64,
    /// Wall-clock time handed out with an extreme, ms.
    pub wall_ms: u64,
    pub g: f64,
    pub on_ground: bool,
    /// Paused / slewed / time-accelerated: not evaluated, breaks smoothing and excursion.
    pub excluded: bool,
    pub phase: FlightPhase,
    pub altitude_msl_ft: f64,
}

#[derive(Clone, Copy, Debug)]
struct Smoothed {
    mono_ms: u64,
    point: GLoadPoint,
    /// First sample after a gap in the evaluated samples: a running excursion ends there.
    after_break: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Band {
    Inside,
    High { since: u64, counted: bool },
    Low { since: u64, counted: bool },
}

/// Aggregates [`GLoadStats`] sample by sample (see the module doc).
#[derive(Clone, Debug)]
pub struct GLoadTracker {
    stats: GLoadStats,
    /// Raw values of the last [`SMOOTHING_MS`] (mono ms, g).
    window: VecDeque<(u64, f64)>,
    /// Smoothed samples not yet committed (the touchdown window may still drop them).
    delayed: VecDeque<Smoothed>,
    band: Band,
    /// Previous evaluated sample was airborne (a ground contact is airborne → on ground).
    was_airborne: bool,
    /// Airborne samples before this (mono ms) belong to the last touchdown.
    exclude_until: u64,
    /// The evaluated samples had a gap since the last one held back.
    pending_break: bool,
}

impl Default for GLoadTracker {
    fn default() -> Self {
        Self::new(GLoadSource::Live)
    }
}

impl GLoadTracker {
    pub fn new(source: GLoadSource) -> Self {
        Self {
            stats: GLoadStats { source, ..Default::default() },
            window: VecDeque::new(),
            delayed: VecDeque::new(),
            band: Band::Inside,
            was_airborne: false,
            exclude_until: 0,
            pending_break: false,
        }
    }

    /// What is committed so far (the last [`TOUCHDOWN_WINDOW_MS`] are still held back).
    pub fn stats(&self) -> &GLoadStats {
        &self.stats
    }

    pub fn update(&mut self, s: GSample) {
        // commit what the touchdown window can no longer drop
        while let Some(d) = self.delayed.front().copied() {
            if s.mono_ms.saturating_sub(d.mono_ms) <= TOUCHDOWN_WINDOW_MS {
                break;
            }
            self.delayed.pop_front();
            self.commit(d);
        }
        if s.excluded {
            self.break_run();
            return;
        }
        if s.on_ground {
            if self.was_airborne {
                // ground contact: the seconds before it and after it are the landing's
                self.delayed.clear();
                self.exclude_until = s.mono_ms + TOUCHDOWN_WINDOW_MS;
            }
            self.was_airborne = false;
            self.break_run();
            return;
        }
        self.was_airborne = true;
        let valid = s.g.is_finite() && s.g != 0.0 && s.g.abs() <= G_PLAUSIBLE;
        if !valid || s.mono_ms < self.exclude_until {
            self.break_run();
            return;
        }
        self.window.push_back((s.mono_ms, s.g));
        while let Some(&(ts, _)) = self.window.front() {
            if s.mono_ms.saturating_sub(ts) < SMOOTHING_MS {
                break;
            }
            self.window.pop_front();
        }
        let g = self.window.iter().map(|(_, g)| g).sum::<f64>() / self.window.len() as f64;
        self.delayed.push_back(Smoothed {
            mono_ms: s.mono_ms,
            point: GLoadPoint { g, timestamp_ms: s.wall_ms, phase: s.phase, altitude_msl_ft: s.altitude_msl_ft },
            after_break: std::mem::take(&mut self.pending_break),
        });
    }

    /// The stream is not continuous any more (reconnect, teleport): smoothing and a running
    /// excursion start over; held-back samples are dropped (they cannot be told apart from
    /// a ground contact that was not seen).
    pub fn reset_context(&mut self) {
        self.delayed.clear();
        self.was_airborne = false;
        self.exclude_until = 0;
        self.break_run();
    }

    /// The flight ended without a ground contact following (interrupted, track end):
    /// commit what is held back.
    pub fn flush(&mut self) {
        while let Some(d) = self.delayed.pop_front() {
            self.commit(d);
        }
    }

    /// A gap in the evaluated samples: smoothing starts over, and an excursion running
    /// before it is not continued after it (marked on the next sample held back, since the
    /// ones before the gap are still waiting for the touchdown window).
    fn break_run(&mut self) {
        self.window.clear();
        if self.delayed.is_empty() {
            self.band = Band::Inside;
        }
        self.pending_break = true;
    }

    fn commit(&mut self, d: Smoothed) {
        let p = d.point;
        let st = &mut self.stats;
        if st.max.is_none_or(|m| p.g > m.g) {
            st.max = Some(p);
        }
        if st.min.is_none_or(|m| p.g < m.g) {
            st.min = Some(p);
        }
        let now = d.mono_ms;
        if d.after_break {
            self.band = Band::Inside;
        }
        self.band = match self.band {
            Band::High { since, counted } if p.g > HIGH_G => Band::High { since, counted },
            Band::Low { since, counted } if p.g < LOW_G => Band::Low { since, counted },
            _ if p.g > HIGH_G => Band::High { since: now, counted: false },
            _ if p.g < LOW_G => Band::Low { since: now, counted: false },
            _ => Band::Inside,
        };
        match &mut self.band {
            Band::High { since, counted } if !*counted && now.saturating_sub(*since) >= EXCURSION_MIN_MS => {
                *counted = true;
                st.high_count += 1;
            }
            Band::Low { since, counted } if !*counted && now.saturating_sub(*since) >= EXCURSION_MIN_MS => {
                *counted = true;
                st.low_count += 1;
            }
            _ => {}
        }
    }
}

/// Phase at `t_ms` from a flight's phase transitions (`(to, timestamp_ms)`, oldest first);
/// before the first one: `Preflight`.
pub fn phase_at(transitions: &[(FlightPhase, u64)], t_ms: u64) -> FlightPhase {
    transitions.iter().take_while(|(_, ts)| *ts <= t_ms).last().map_or(FlightPhase::Preflight, |(p, _)| *p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn air(ms: u64, g: f64) -> GSample {
        GSample {
            mono_ms: ms,
            wall_ms: 1_000_000 + ms,
            g,
            on_ground: false,
            excluded: false,
            phase: FlightPhase::Cruise,
            altitude_msl_ft: 30_000.0,
        }
    }

    /// Feeds `g(t)` at 10 Hz from `from` to `to` (exclusive), ms.
    fn feed(tr: &mut GLoadTracker, from: u64, to: u64, g: impl Fn(u64) -> f64) {
        let mut t = from;
        while t < to {
            tr.update(air(t, g(t)));
            t += 100;
        }
    }

    #[test]
    fn single_spike_is_smoothed_away() {
        let mut tr = GLoadTracker::default();
        feed(&mut tr, 0, 10_000, |t| if t == 5_000 { 2.5 } else { 1.0 });
        tr.flush();
        let s = tr.stats();
        // 2.5 averaged with the two 1.0 before it: 1.5 – not above HIGH_G, not 2.5
        assert!((s.max.unwrap().g - 1.5).abs() < 1e-9, "{:?}", s.max);
        assert_eq!(s.high_count, 0);
    }

    #[test]
    fn excursion_needs_half_a_second() {
        let mut tr = GLoadTracker::default();
        // 0.4 s at 1.8 g: no count; later 1 s at 1.8 g: one count; 1 s at 0.3 g: one low count
        feed(&mut tr, 0, 20_000, |t| match t {
            2_000..2_400 => 1.8,
            8_000..9_000 => 1.8,
            14_000..15_000 => 0.3,
            _ => 1.0,
        });
        tr.flush();
        let s = tr.stats();
        assert_eq!(s.high_count, 1);
        assert_eq!(s.low_count, 1);
        assert!((s.max.unwrap().g - 1.8).abs() < 1e-9);
        assert!((s.min.unwrap().g - 0.3).abs() < 1e-9);
        assert_eq!(s.max.unwrap().phase, FlightPhase::Cruise);
    }

    #[test]
    fn long_excursion_counts_once_and_rearms() {
        let mut tr = GLoadTracker::default();
        feed(&mut tr, 0, 30_000, |t| match t {
            2_000..10_000 => 1.7,
            15_000..16_000 => 1.7,
            _ => 1.0,
        });
        tr.flush();
        assert_eq!(tr.stats().high_count, 2);
    }

    #[test]
    fn paused_and_slewed_samples_are_left_out() {
        let mut tr = GLoadTracker::default();
        feed(&mut tr, 0, 5_000, |_| 1.1);
        for t in (5_000..8_000).step_by(100) {
            tr.update(GSample { excluded: true, ..air(t, 3.0) });
        }
        feed(&mut tr, 8_000, 12_000, |_| 0.9);
        tr.flush();
        let s = tr.stats();
        assert!((s.max.unwrap().g - 1.1).abs() < 1e-9);
        assert!((s.min.unwrap().g - 0.9).abs() < 1e-9);
        assert_eq!(s.high_count, 0);
    }

    #[test]
    fn touchdown_window_is_left_out_but_lift_off_is_not() {
        let mut tr = GLoadTracker::default();
        // lift-off at 0 (ground before): rotation 1.3 g right after it stays in
        for t in (0..2_000).step_by(100) {
            tr.update(GSample { on_ground: true, ..air(t, 1.0) });
        }
        feed(&mut tr, 2_000, 3_000, |_| 1.3);
        feed(&mut tr, 3_000, 20_000, |_| 1.0);
        // flare 0.7 g in the last 2 s before the contact, contact 2.2 g, bounce 1.9 g
        feed(&mut tr, 20_000, 22_000, |_| 0.7);
        tr.update(GSample { on_ground: true, ..air(22_000, 2.2) });
        feed(&mut tr, 22_100, 23_500, |_| 1.9);
        for t in (23_500..40_000).step_by(100) {
            tr.update(GSample { on_ground: true, ..air(t, 1.0) });
        }
        tr.flush();
        let s = tr.stats();
        assert!((s.max.unwrap().g - 1.3).abs() < 1e-9, "{:?}", s.max);
        assert!((s.min.unwrap().g - 1.0).abs() < 1e-9, "{:?}", s.min);
        assert_eq!(s.high_count, 0);
        assert_eq!(s.low_count, 0);
    }

    #[test]
    fn garbage_and_missing_values_are_ignored() {
        let mut tr = GLoadTracker::default();
        feed(&mut tr, 0, 5_000, |t| match t {
            1_000 => f64::NAN,
            2_000 => 0.0,
            3_000 => 25.0,
            _ => 1.05,
        });
        tr.flush();
        let s = tr.stats();
        assert!((s.max.unwrap().g - 1.05).abs() < 1e-9);
        assert!((s.min.unwrap().g - 1.05).abs() < 1e-9);
    }

    #[test]
    fn one_hz_needs_two_samples_outside() {
        let mut tr = GLoadTracker::new(GLoadSource::Track);
        let gs = [1.0, 1.6, 1.0, 1.6, 1.7, 1.0, 0.4, 0.3, 1.0];
        for (i, g) in gs.iter().enumerate() {
            tr.update(air(i as u64 * 1_000, *g));
        }
        tr.flush();
        let s = tr.stats();
        assert_eq!((s.high_count, s.low_count), (1, 1));
        assert_eq!(s.source, GLoadSource::Track);
    }

    #[test]
    fn merged_keeps_extremes_and_adds_counts() {
        let p = |g| Some(GLoadPoint { g, ..Default::default() });
        let a = GLoadStats { max: p(1.4), min: p(0.8), high_count: 1, low_count: 0, source: GLoadSource::Live };
        let b = GLoadStats { max: p(1.6), min: p(0.9), high_count: 2, low_count: 1, source: GLoadSource::Track };
        let m = a.merged(&b);
        assert_eq!(m.max.unwrap().g, 1.6);
        assert_eq!(m.min.unwrap().g, 0.8);
        assert_eq!((m.high_count, m.low_count), (3, 1));
        assert_eq!(m.source, GLoadSource::Track);
        assert_eq!(GLoadStats::default().merged(&a), GLoadStats { source: GLoadSource::Live, ..a });
    }

    #[test]
    fn phase_at_picks_the_last_transition() {
        let tr = [(FlightPhase::TaxiOut, 10), (FlightPhase::Takeoff, 20), (FlightPhase::Climb, 30)];
        assert_eq!(phase_at(&tr, 5), FlightPhase::Preflight);
        assert_eq!(phase_at(&tr, 20), FlightPhase::Takeoff);
        assert_eq!(phase_at(&tr, 99), FlightPhase::Climb);
    }
}
