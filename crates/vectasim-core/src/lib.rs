//! Sim-agnostic core: the common `Telemetry` model every sim provider fills,
//! the `SimProvider` trait, and a `MockProvider` for development without a sim.
//!
//! Design (decouples sim rate from consumer rate): providers push
//! `ProviderEvent`s at their native rate over a channel; consumers
//! (recorder, phase engine, UI) downsample as they see fit.

pub mod approach;
pub mod clock;
pub mod diag;
pub mod flight;
pub mod gload;
pub mod lang;
pub mod landing;
pub mod mock;
pub mod phase;
pub mod telemetry;
pub mod touchdown;

pub use clock::MonoClock;
pub use gload::{GLoadPoint, GLoadSource, GLoadStats};
pub use lang::Lang;
pub use flight::{CandidateDebug, FlightDebug, FlightEvent, FlightSession, FlightState, FlightSummary, IntegrityFlags};
pub use mock::{MockFlight, MockProvider, MockVariant};
pub use phase::{FlightPhase, PhaseEngine, PhaseTransition, SkipReason};
pub use telemetry::{AircraftInfo, Lights, Telemetry};
pub use touchdown::{DetectorDebug, LandingRateSource, TouchdownDetector, TouchdownReport};

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;

/// Discrete events from the simulator that are not part of the periodic telemetry.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SimEvent {
    Paused { paused: bool },
    SimRunning { running: bool },
    Crashed,
    AircraftLoaded { path: String },
    FlightLoaded { path: String },
}

/// Everything a provider can report. `Telemetry` is high-frequency; the rest is sparse.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderEvent {
    Connecting,
    Connected { sim_name: String, sim_version: String },
    Disconnected { reason: String },
    Error { message: String },
    Aircraft(AircraftInfo),
    /// Boxed: a sample is ~440 B with the track-v2 options, the other variants are a few
    /// words; one allocation per sample (10–60 Hz) is negligible next to the clone it moves.
    Telemetry(Box<Telemetry>),
    Sim(SimEvent),
}

/// A source of sim data. Runs on its own thread and reports through `tx` until
/// `stop` is set or the channel is closed.
pub trait SimProvider: Send {
    fn name(&self) -> &'static str;
    fn start(self: Box<Self>, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()>;
    /// Raw-value diagnostics this provider keeps up to date (none for providers without
    /// raw sim definitions, e.g. the mock).
    fn raw_diag(&self) -> Option<diag::SharedRawDiag> {
        None
    }
}

/// Sleep in small slices so a stop request is noticed quickly.
pub fn sleep_interruptible(total: std::time::Duration, stop: &AtomicBool) -> bool {
    let slice = std::time::Duration::from_millis(50);
    let mut waited = std::time::Duration::ZERO;
    while waited < total {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        let d = slice.min(total - waited);
        std::thread::sleep(d);
        waited += d;
    }
    !stop.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
