//! Raw-value diagnostics shared between a provider thread and the UI
//! (Einstellungen → Diagnose → Live-Rohdaten).
//!
//! A provider that has raw definitions (SimConnect, Replay) updates a [`SharedRawDiag`] per
//! message; the app takes a [`RawDiag::snapshot`] at most a few times per second. Providers
//! without raw data (Mock) have none.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub type SharedRawDiag = Arc<Mutex<RawDiag>>;

/// Events kept in the log.
pub const EVENT_LOG_LEN: usize = 100;
/// Failed HRESULTs kept.
pub const HR_LOG_LEN: usize = 10;
/// Rate window, ms of source time.
pub const RATE_WINDOW_MS: u64 = 5_000;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDiag {
    /// `simconnect` or `replay`.
    pub source: String,
    pub defs: Vec<DefDiag>,
    pub events: VecDeque<DiagEvent>,
    /// Events logged so far (the log keeps the last 100).
    pub events_total: u64,
    pub connection: ConnDiag,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefDiag {
    /// FAST / SLOW / STATIC
    pub label: String,
    pub req: u32,
    /// SIM_FRAME / SECOND / ONCE
    pub period: String,
    pub vars: Vec<VarDiag>,
    /// Payloads received in this session.
    pub updates: u64,
    /// Wall clock of the last payload.
    pub last_wall_ms: Option<u64>,
    /// Filled by [`RawDiag::snapshot`].
    pub age_ms: Option<u64>,
    pub rate_hz: f64,
    #[serde(skip)]
    pub rate: RateMeter,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VarDiag {
    pub name: String,
    pub unit: Option<String>,
    /// `false` once the sim rejected the variable (dropped from the definition).
    pub active: bool,
    /// FLOAT64 as received (`None` = NaN or never received).
    pub raw: Option<f64>,
    /// STRING256 as received.
    pub raw_text: Option<String>,
    /// The value VectaSim uses after conversion (Telemetry field), in `value_unit`.
    pub value: Option<f64>,
    pub value_text: Option<String>,
    pub value_unit: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEvent {
    pub wall_ms: u64,
    /// event | filename | exception | open | quit | hr | systemState | end | warning
    pub kind: String,
    /// Event name, exception name, call …
    pub name: String,
    /// `dwData` of an event, hex.
    pub data_hex: Option<String>,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnDiag {
    /// Loaded SimConnect.dll (or the replayed file).
    pub dll: Option<String>,
    pub sim_name: Option<String>,
    /// Application version from RECV_OPEN.
    pub sim_version: Option<String>,
    /// SimConnect version from RECV_OPEN.
    pub simconnect_version: Option<String>,
    /// RECV_OPEN messages seen (sessions).
    pub sessions: u32,
    /// Sessions after the first.
    pub reconnects: u32,
    pub connected_wall_ms: Option<u64>,
    /// Last "Sim" system state (1 = flight running).
    pub sim_state: Option<u32>,
    pub last_hresults: VecDeque<HrDiag>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HrDiag {
    pub wall_ms: u64,
    pub call: String,
    pub hr: String,
}

/// Update rate over a sliding window of source timestamps.
#[derive(Clone, Debug, Default)]
pub struct RateMeter {
    window: VecDeque<u64>,
}

impl RateMeter {
    pub fn push(&mut self, t_ms: u64) {
        self.window.push_back(t_ms);
        while self.window.front().is_some_and(|f| t_ms.saturating_sub(*f) > RATE_WINDOW_MS) {
            self.window.pop_front();
        }
    }

    /// Updates per second in the window; 0 with fewer than two updates.
    pub fn hz(&self) -> f64 {
        match (self.window.front(), self.window.back()) {
            (Some(a), Some(b)) if b > a => (self.window.len() - 1) as f64 * 1000.0 / (b - a) as f64,
            _ => 0.0,
        }
    }
}

impl RawDiag {
    pub fn new(source: &str) -> Self {
        Self { source: source.into(), ..Default::default() }
    }

    pub fn shared(source: &str) -> SharedRawDiag {
        Arc::new(Mutex::new(Self::new(source)))
    }

    pub fn push_event(&mut self, e: DiagEvent) {
        if self.events.len() == EVENT_LOG_LEN {
            self.events.pop_front();
        }
        self.events.push_back(e);
        self.events_total += 1;
    }

    pub fn push_hr(&mut self, h: HrDiag) {
        if self.connection.last_hresults.len() == HR_LOG_LEN {
            self.connection.last_hresults.pop_front();
        }
        self.connection.last_hresults.push_back(h);
    }

    /// Copy with age and rate filled in for `now_wall_ms`. A definition silent for longer
    /// than the rate window reports 0 Hz.
    pub fn snapshot(&self, now_wall_ms: u64) -> RawDiag {
        let mut s = self.clone();
        for d in &mut s.defs {
            d.age_ms = d.last_wall_ms.map(|w| now_wall_ms.saturating_sub(w));
            d.rate_hz = if d.age_ms.is_some_and(|a| a <= RATE_WINDOW_MS) { d.rate.hz() } else { 0.0 };
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_over_the_window() {
        let mut m = RateMeter::default();
        assert_eq!(m.hz(), 0.0);
        m.push(1000);
        assert_eq!(m.hz(), 0.0);
        // 60 Hz for 10 s: the window holds the last 5 s
        for i in 0..600u64 {
            m.push(1000 + i * 1000 / 60);
        }
        assert!((m.hz() - 60.0).abs() < 0.5, "{}", m.hz());
        // then 1 Hz
        let last = 1000 + 599 * 1000 / 60;
        for i in 1..=10u64 {
            m.push(last + i * 1000);
        }
        assert!((m.hz() - 1.0).abs() < 0.01, "{}", m.hz());
    }

    #[test]
    fn snapshot_fills_age_and_zeroes_stale_rates() {
        let mut d = RawDiag::new("simconnect");
        let mut def = DefDiag { label: "FAST".into(), last_wall_ms: Some(10_000), ..Default::default() };
        for i in 0..61u64 {
            def.rate.push(i * 1000 / 60);
        }
        d.defs.push(def);
        d.defs.push(DefDiag { label: "STATIC".into(), ..Default::default() });
        let s = d.snapshot(10_250);
        assert_eq!(s.defs[0].age_ms, Some(250));
        assert!((s.defs[0].rate_hz - 60.0).abs() < 1.0, "{}", s.defs[0].rate_hz);
        assert_eq!(s.defs[1].age_ms, None);
        assert_eq!(s.defs[1].rate_hz, 0.0);
        let stale = d.snapshot(16_000);
        assert_eq!(stale.defs[0].age_ms, Some(6_000));
        assert_eq!(stale.defs[0].rate_hz, 0.0, "silent definition reports 0 Hz");
    }

    #[test]
    fn logs_are_bounded() {
        let mut d = RawDiag::new("x");
        for i in 0..150u64 {
            d.push_event(DiagEvent { wall_ms: i, ..Default::default() });
            d.push_hr(HrDiag { wall_ms: i, ..Default::default() });
        }
        assert_eq!(d.events.len(), EVENT_LOG_LEN);
        assert_eq!(d.events.front().unwrap().wall_ms, 50);
        assert_eq!(d.connection.last_hresults.len(), HR_LOG_LEN);
    }
}
