//! Events for the WebSocket, derived from consecutive snapshots (the server polls at 2 Hz
//! instead of hooking into the live path, so the forwarder never waits for a client).

use crate::api::Snapshot;
use vectasim_core::{FlightPhase, FlightState};

/// What changed between two snapshots.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    /// Connection state of the sim provider changed.
    Status,
    Phase { from: FlightPhase, to: FlightPhase },
    /// A new touchdown in the running flight (the landing overlay shows it).
    Touchdown { index: u32 },
    /// The flight was closed and is in the logbook.
    FlightSaved { flight_id: Option<String>, state: FlightState },
}

#[derive(Clone, Debug, PartialEq)]
struct Key {
    connection: String,
    /// Identity of the flight: logbook id, else off-block time.
    flight: Option<(Option<String>, Option<u64>)>,
    phase: Option<FlightPhase>,
    state: Option<FlightState>,
    touchdowns: u32,
}

impl Key {
    fn of(s: &Snapshot) -> Self {
        let f = s.flight.as_ref();
        Self {
            connection: s.status.connection.clone(),
            flight: f.map(|f| (f.id.clone(), f.off_block_ms)),
            phase: f.map(|f| f.phase),
            state: f.map(|f| f.state),
            touchdowns: f.map_or(0, |f| f.touchdowns),
        }
    }

    fn same_flight(&self, other: &Key) -> bool {
        match (&self.flight, &other.flight) {
            (Some((a_id, a_ob)), Some((b_id, b_ob))) => match (a_id, b_id) {
                (Some(a), Some(b)) => a == b,
                // the logbook id appears a moment after the flight starts
                _ => a_ob == b_ob,
            },
            _ => false,
        }
    }
}

/// Remembers the previous snapshot; [`Tracker::step`] reports the changes.
#[derive(Debug, Default)]
pub struct Tracker {
    prev: Option<Key>,
}

impl Tracker {
    /// Forget the previous snapshot (nobody listened for a while: no stale events on return).
    pub fn reset(&mut self) {
        self.prev = None;
    }

    pub fn step(&mut self, snap: &Snapshot) -> Vec<Change> {
        let now = Key::of(snap);
        let Some(prev) = self.prev.replace(now.clone()) else { return Vec::new() };
        let mut out = Vec::new();
        if prev.connection != now.connection {
            out.push(Change::Status);
        }
        let same = prev.same_flight(&now);
        if let (Some(from), Some(to)) = (prev.phase, now.phase)
            && from != to
        {
            out.push(Change::Phase { from, to });
        }
        if same && now.touchdowns > prev.touchdowns {
            out.push(Change::Touchdown { index: now.touchdowns - 1 });
        }
        // a discarded ground session is no saved flight: no `flightSaved` for it
        let closed = |s: Option<FlightState>| matches!(s, Some(FlightState::Completed | FlightState::Interrupted));
        if same && prev.state == Some(FlightState::Active) && closed(now.state) {
            let flight_id = snap.flight.as_ref().and_then(|f| f.id.clone());
            out.push(Change::FlightSaved { flight_id, state: now.state.unwrap_or_default() });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Flight, Status};

    fn snap(phase: FlightPhase, state: FlightState, touchdowns: u32) -> Snapshot {
        Snapshot {
            status: Status { connection: "connected".into(), ..Default::default() },
            flight: Some(Flight { id: Some("f1".into()), off_block_ms: Some(1), phase, state, touchdowns, ..Default::default() }),
            telemetry: None,
        }
    }

    #[test]
    fn first_snapshot_is_quiet() {
        let mut t = Tracker::default();
        assert!(t.step(&snap(FlightPhase::Final, FlightState::Active, 1)).is_empty());
    }

    #[test]
    fn phase_touchdown_and_saved() {
        let mut t = Tracker::default();
        t.step(&snap(FlightPhase::Final, FlightState::Active, 0));
        assert_eq!(
            t.step(&snap(FlightPhase::Landing, FlightState::Active, 1)),
            [Change::Phase { from: FlightPhase::Final, to: FlightPhase::Landing }, Change::Touchdown { index: 0 }]
        );
        assert!(t.step(&snap(FlightPhase::Landing, FlightState::Active, 1)).is_empty());
        assert_eq!(
            t.step(&snap(FlightPhase::Shutdown, FlightState::Completed, 1)),
            [
                Change::Phase { from: FlightPhase::Landing, to: FlightPhase::Shutdown },
                Change::FlightSaved { flight_id: Some("f1".into()), state: FlightState::Completed }
            ]
        );
    }

    #[test]
    fn a_discarded_ground_session_is_not_saved() {
        let mut t = Tracker::default();
        t.step(&snap(FlightPhase::TaxiOut, FlightState::Active, 0));
        let changes = t.step(&snap(FlightPhase::Shutdown, FlightState::Discarded, 0));
        assert!(!changes.iter().any(|c| matches!(c, Change::FlightSaved { .. })), "{changes:?}");
    }

    #[test]
    fn connection_changes_and_reset() {
        let mut t = Tracker::default();
        let mut s = snap(FlightPhase::Cruise, FlightState::Active, 0);
        t.step(&s);
        s.status.connection = "disconnected".into();
        assert_eq!(t.step(&s), [Change::Status]);
        t.reset();
        s.status.connection = "connected".into();
        assert!(t.step(&s).is_empty());
    }

    #[test]
    fn a_new_flight_is_not_saved_by_the_old_one() {
        let mut t = Tracker::default();
        t.step(&snap(FlightPhase::TaxiIn, FlightState::Active, 1));
        let mut other = snap(FlightPhase::Preflight, FlightState::Completed, 0);
        other.flight.as_mut().unwrap().id = Some("f2".into());
        let changes = t.step(&other);
        assert!(!changes.iter().any(|c| matches!(c, Change::FlightSaved { .. })), "{changes:?}");
    }
}
