//! `FlightSession::debug_state` (Einstellungen → Diagnose → Live-Rohdaten): engine internals
//! follow the mock flight.

use vectasim_core::{FlightPhase, FlightSession, MockFlight};

#[test]
fn debug_state_follows_the_mock_flight() {
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let d = session.debug_state();
    assert_eq!((d.phase, d.candidate.clone(), d.detector.state.as_str()), (FlightPhase::Preflight, None, "ground"));

    let mut saw_candidate = false;
    let mut saw_airborne_qualified = false;
    let mut saw_settling = false;
    for i in 1..=(MockFlight::loop_seconds() as u64 * 10) {
        let t_s = i as f64 / 10.0;
        session.update(&flight.sample(t_s, 1_700_000_000_000 + i * 100));
        let d = session.debug_state();
        if let Some(c) = &d.candidate {
            saw_candidate = true;
            assert!(c.remaining_ms <= c.dwell_ms, "{c:?}");
            assert_ne!(c.phase, d.phase);
        }
        saw_airborne_qualified |= d.airborne_qualified && d.detector.state == "airborne" && d.detector.qualified;
        if d.detector.state == "settling" {
            saw_settling = true;
            assert!(d.detector.stale_sim.is_some());
        }
    }
    assert!(saw_candidate && saw_airborne_qualified && saw_settling);
    let d = session.debug_state();
    assert_eq!(d.touchdowns, 1);
    assert_eq!(d.phase, FlightPhase::Shutdown);
    assert!(d.last_sample_ms.is_some());
}
