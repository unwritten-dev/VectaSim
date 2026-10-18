//! Monotonic time base for dwell timers and windows.
//!
//! `Telemetry::timestamp_ms` is the wall clock at reception and stays that way: it is what
//! the logbook shows and stores (off-block, landing, track `t_ms`). Durations inside the
//! phase engine, the touchdown detector and the flight session must not depend on it
//! running forwards, though: an NTP correction or a manual clock change can step it back
//! by seconds or hours. Each of those components keeps a [`MonoClock`] that maps the wall
//! clock onto a monotonic scale:
//!
//! - wall clock moves forward by Δt → the monotonic time moves forward by Δt;
//! - wall clock steps back → that sample counts as Δt = 0 and the step is added to an
//!   offset, so later samples continue from where the monotonic time was (a `clock_jump`,
//!   logged by [`crate::FlightSession`] and counted in [`MonoClock::jumps`]).
//!
//! A forward step cannot be told apart from a data gap; the session's gap check (sim
//! clock stood still → pause, cut out of the timers) already covers that case.
//!
//! Timestamps a component hands out (lift-off, debug "since" values) are converted back
//! with [`MonoClock::to_wall`]: on the wall-clock scale as it is *now*, so they line up with
//! the samples recorded after the jump.

/// Wall clock (ms since Unix epoch) → monotonic ms; see the module doc.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MonoClock {
    last_wall: Option<u64>,
    offset_ms: u64,
    jumps: u32,
    last_jump_ms: u64,
}

impl MonoClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Monotonic time of a sample taken at `wall_ms`. Never smaller than the previous result.
    pub fn advance(&mut self, wall_ms: u64) -> u64 {
        if let Some(last) = self.last_wall
            && wall_ms < last
        {
            let back = last - wall_ms;
            self.offset_ms = self.offset_ms.saturating_add(back);
            self.jumps += 1;
            self.last_jump_ms = back;
        }
        self.last_wall = Some(wall_ms);
        wall_ms.saturating_add(self.offset_ms)
    }

    /// A monotonic time of this clock on today's wall-clock scale.
    pub fn to_wall(&self, mono_ms: u64) -> u64 {
        mono_ms.saturating_sub(self.offset_ms)
    }

    /// Backward steps of the wall clock seen so far.
    pub fn jumps(&self) -> u32 {
        self.jumps
    }

    /// Size of the latest backward step, ms (0 before the first one).
    pub fn last_jump_ms(&self) -> u64 {
        self.last_jump_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backward_step_counts_as_zero_and_time_continues() {
        let mut c = MonoClock::new();
        assert_eq!(c.advance(10_000_000), 10_000_000);
        assert_eq!(c.advance(10_001_000), 10_001_000);
        // clock set back by an hour
        assert_eq!(c.advance(6_401_000 + 1_000), 10_001_000);
        assert_eq!((c.jumps(), c.last_jump_ms()), (1, 3_600_000 - 1_000));
        assert_eq!(c.advance(6_401_000 + 2_000), 10_002_000);
        assert_eq!(c.to_wall(10_002_000), 6_401_000 + 2_000);
        // forward is passed through
        assert_eq!(c.advance(6_401_000 + 7_000), 10_007_000);
        assert_eq!(c.jumps(), 1);
    }

    #[test]
    fn same_timestamp_is_no_jump() {
        let mut c = MonoClock::new();
        c.advance(5);
        assert_eq!(c.advance(5), 5);
        assert_eq!(c.jumps(), 0);
    }
}
