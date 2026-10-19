//! In-sim text messages (`SimConnect_Text`): a short line VectaSim shows inside the simulator,
//! e.g. the landing rate after touchdown.
//!
//! The app queues a message with [`show_text`]; the running SimConnect session sends it with
//! its next pump iteration (SimConnect clients are single-threaded, so only the session thread
//! may call the API). Messages that wait longer than [`MAX_AGE`] (no sim connected) are
//! dropped: a landing rate shown minutes later would be confusing. At most [`MAX_QUEUED`]
//! wait; older ones make room.
//!
//! Support differs by simulator: the SDK documents `SimConnect_Text` for FSX/P3D, MSFS shows
//! the print types as a line at the top of the screen in some versions and nothing in others.
//! A missing export or a rejected call is logged and otherwise ignored – never an error for
//! the recording.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A queued message older than this is not shown any more.
pub const MAX_AGE: Duration = Duration::from_secs(30);
/// Messages waiting at most.
pub const MAX_QUEUED: usize = 4;
/// Longest display time we ask for, seconds.
pub const MAX_SECONDS: f32 = 60.0;
/// SimConnect's text buffer is limited; longer lines are cut at a char boundary (bytes, incl. NUL).
pub const MAX_BYTES: usize = 255;

#[derive(Debug, Clone, PartialEq)]
pub struct SimText {
    pub text: String,
    /// How long the sim shows it, seconds (clamped to 1..=[`MAX_SECONDS`]).
    pub seconds: f32,
    pub queued: Instant,
}

/// Shared queue between the app (producer) and the SimConnect session (consumer).
#[derive(Debug, Clone, Default)]
pub struct TextQueue(Arc<Mutex<VecDeque<SimText>>>);

impl TextQueue {
    pub fn push(&self, text: &str, seconds: f32, now: Instant) {
        let text = clip(text.trim());
        if text.is_empty() {
            return;
        }
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        while q.len() >= MAX_QUEUED {
            q.pop_front();
        }
        let seconds = if seconds.is_finite() { seconds.clamp(1.0, MAX_SECONDS) } else { 10.0 };
        q.push_back(SimText { text, seconds, queued: now });
    }

    /// Everything due at `now`, oldest first; stale messages are dropped.
    pub fn take(&self, now: Instant) -> Vec<SimText> {
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        q.drain(..).filter(|m| now.saturating_duration_since(m.queued) <= MAX_AGE).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

/// The process-wide queue the SimConnect provider drains.
pub fn global() -> &'static TextQueue {
    static Q: OnceLock<TextQueue> = OnceLock::new();
    Q.get_or_init(TextQueue::default)
}

/// Show `text` in the simulator for `seconds` (with the next SimConnect pump; dropped after
/// [`MAX_AGE`] if no MSFS session is connected).
pub fn show_text(text: &str, seconds: f32) {
    global().push(text, seconds, Instant::now());
}

/// Cut to [`MAX_BYTES`] − 1 bytes (room for the NUL) at a char boundary, an ellipsis marking the cut.
fn clip(s: &str) -> String {
    let limit = MAX_BYTES - 1;
    if s.len() <= limit {
        return s.to_owned();
    }
    let mut end = limit - '…'.len_utf8();
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_order_and_drops_stale() {
        let q = TextQueue::default();
        let t0 = Instant::now();
        q.push("old", 10.0, t0);
        q.push("new", 10.0, t0 + Duration::from_secs(25));
        let got = q.take(t0 + Duration::from_secs(40));
        assert_eq!(got.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["new"]);
        assert!(q.is_empty());
    }

    #[test]
    fn bounded_clamped_and_clipped() {
        let q = TextQueue::default();
        let t0 = Instant::now();
        for i in 0..6 {
            q.push(&format!("m{i}"), 500.0, t0);
        }
        q.push("   ", 5.0, t0);
        let got = q.take(t0);
        assert_eq!(got.len(), MAX_QUEUED);
        assert_eq!(got[0].text, "m2");
        assert_eq!(got[0].seconds, MAX_SECONDS);
        let long = "ä".repeat(400);
        q.push(&long, f32::NAN, t0);
        let m = &q.take(t0)[0];
        assert!(m.text.len() < MAX_BYTES && m.text.ends_with('…'));
        assert_eq!(m.seconds, 10.0);
    }
}
