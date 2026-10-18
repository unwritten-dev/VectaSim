//! Dead-connection watchdog. A simulator that crashes (CTD) or is killed never sends
//! `SIMCONNECT_RECV_ID_QUIT`, and depending on the build `GetNextDispatch` may keep
//! returning `E_FAIL` ("empty") forever. The watchdog notices the silence, probes
//! with `SimConnect_RequestSystemState("Sim")` and gives up after unanswered probes.
//!
//! Pure state machine: the caller passes the current `Instant`, so tests can drive it.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchdogConfig {
    /// Silence after which a probe is sent while the sim reports a running flight.
    pub idle_running: Duration,
    /// Silence after which a probe is sent while the sim is in a menu / not running
    /// (no SIM_FRAME data flows there, so be more patient).
    pub idle_menu: Duration,
    /// How long to wait for the answer to one probe.
    pub probe_timeout: Duration,
    /// Unanswered probes in a row after which the connection is declared dead.
    pub max_missed: u32,
}

impl Default for WatchdogConfig {
    fn default() -> Self {
        Self {
            idle_running: Duration::from_secs(5),
            idle_menu: Duration::from_secs(30),
            probe_timeout: Duration::from_secs(5),
            max_missed: 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchAction {
    /// Nothing to do.
    Idle,
    /// Send `RequestSystemState("Sim")` now.
    SendProbe,
    /// Probes went unanswered: close the session and reconnect.
    Dead,
}

#[derive(Debug)]
pub struct Watchdog {
    cfg: WatchdogConfig,
    last_rx: Instant,
    probe_at: Option<Instant>,
    missed: u32,
}

impl Watchdog {
    pub fn new(cfg: WatchdogConfig, now: Instant) -> Self {
        Self { cfg, last_rx: now, probe_at: None, missed: 0 }
    }

    /// Any dispatched message proves the connection is alive.
    pub fn on_message(&mut self, now: Instant) {
        self.last_rx = now;
        self.probe_at = None;
        self.missed = 0;
    }

    /// Time since the last message.
    pub fn silence(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_rx)
    }

    pub fn missed(&self) -> u32 {
        self.missed
    }

    /// Call whenever the queue is empty.
    pub fn poll(&mut self, now: Instant, sim_running: bool) -> WatchAction {
        match self.probe_at {
            None => {
                let idle = if sim_running { self.cfg.idle_running } else { self.cfg.idle_menu };
                if self.silence(now) >= idle {
                    self.probe_at = Some(now);
                    WatchAction::SendProbe
                } else {
                    WatchAction::Idle
                }
            }
            Some(sent) if now.saturating_duration_since(sent) >= self.cfg.probe_timeout => {
                self.missed += 1;
                if self.missed >= self.cfg.max_missed.max(1) {
                    WatchAction::Dead
                } else {
                    self.probe_at = Some(now);
                    WatchAction::SendProbe
                }
            }
            Some(_) => WatchAction::Idle,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn running_sim_probes_after_5s_and_dies_after_two_missed_probes() {
        let t0 = Instant::now();
        let mut w = Watchdog::new(WatchdogConfig::default(), t0);
        assert_eq!(w.poll(t0 + s(4), true), WatchAction::Idle);
        assert_eq!(w.poll(t0 + s(5), true), WatchAction::SendProbe);
        assert_eq!(w.poll(t0 + s(9), true), WatchAction::Idle); // waiting for the answer
        assert_eq!(w.poll(t0 + s(10), true), WatchAction::SendProbe); // 1st missed → 2nd probe
        assert_eq!(w.missed(), 1);
        assert_eq!(w.poll(t0 + s(14), true), WatchAction::Idle);
        assert_eq!(w.poll(t0 + s(15), true), WatchAction::Dead);
    }

    #[test]
    fn menu_waits_30s_before_probing() {
        let t0 = Instant::now();
        let mut w = Watchdog::new(WatchdogConfig::default(), t0);
        assert_eq!(w.poll(t0 + s(29), false), WatchAction::Idle);
        assert_eq!(w.poll(t0 + s(30), false), WatchAction::SendProbe);
    }

    #[test]
    fn an_answer_resets_the_probe_cycle() {
        let t0 = Instant::now();
        let mut w = Watchdog::new(WatchdogConfig::default(), t0);
        assert_eq!(w.poll(t0 + s(5), true), WatchAction::SendProbe);
        assert_eq!(w.poll(t0 + s(10), true), WatchAction::SendProbe);
        w.on_message(t0 + s(11)); // SystemState answer (or any message)
        assert_eq!(w.missed(), 0);
        assert_eq!(w.poll(t0 + s(15), true), WatchAction::Idle);
        assert_eq!(w.poll(t0 + s(16), true), WatchAction::SendProbe);
    }

    #[test]
    fn steady_traffic_never_probes() {
        let t0 = Instant::now();
        let mut w = Watchdog::new(WatchdogConfig::default(), t0);
        for i in 1..1000u64 {
            let now = t0 + Duration::from_millis(i * 16);
            w.on_message(now);
            assert_eq!(w.poll(now + Duration::from_millis(5), true), WatchAction::Idle);
        }
    }

    #[test]
    fn configurable_thresholds() {
        let cfg = WatchdogConfig { idle_running: s(1), idle_menu: s(2), probe_timeout: s(1), max_missed: 1 };
        let t0 = Instant::now();
        let mut w = Watchdog::new(cfg, t0);
        assert_eq!(w.poll(t0 + s(1), true), WatchAction::SendProbe);
        assert_eq!(w.poll(t0 + s(2), true), WatchAction::Dead);
    }
}
