//! Turns the live `FlightSession` stream into database rows.
//!
//! Cadence is driven by telemetry timestamps, not wall-clock, so the recorder
//! behaves identically under test and in the app. The whole track of the
//! current flight stays in memory (a 10 h flight at 1 Hz is ~4 MB) and is
//! re-encoded and upserted every `FLUSH_INTERVAL_MS` and on flight end.

use crate::airframe::{AirframeHint, icao_from_atc_model, merge_hint, normalize_registration, resolve_registration};
use crate::store::{FlightContext, PlannedFlight};
use crate::track::{TrackSample, encode_track, subsample};
use crate::{AirportResolver, Result, Store};
use std::sync::{Arc, Mutex, MutexGuard};
use vectasim_core::{AircraftInfo, FlightEvent, FlightPhase, FlightSummary, Telemetry, now_ms};

const SAMPLE_INTERVAL_MS: u64 = 1_000;
const FLUSH_INTERVAL_MS: u64 = 60_000;
/// 1/30 Hz preview: ~120 points for an hour of flying.
const PREVIEW_EVERY: usize = 30;
/// How far from the nearest airport a start/landing position may be to still count as "at" it.
const AIRPORT_MATCH_NM: f64 = 3.0;

/// The current flight's 1 Hz samples, shared with the UI so the live map can draw
/// the whole track without a round trip through SQLite.
pub type LiveTrack = Arc<Mutex<Vec<TrackSample>>>;

pub use crate::store::FlightContext as RecorderContext;

struct Current {
    id: String,
    last_sample_ms: Option<u64>,
    last_flush_ms: u64,
}

/// The dispatch plan the next flight should be attached to, shared with the app
/// so loading an OFP before engine start just works.
pub type PlannedSlot = Arc<Mutex<Option<PlannedFlight>>>;

pub struct FlightRecorder {
    store: Store,
    ctx: FlightContext,
    current: Option<Current>,
    live: LiveTrack,
    resolver: Option<Arc<dyn AirportResolver>>,
    planned: PlannedSlot,
}

impl FlightRecorder {
    pub fn new(store: Store, ctx: FlightContext) -> Self {
        Self { store, ctx, current: None, live: LiveTrack::default(), resolver: None, planned: PlannedSlot::default() }
    }

    pub fn with_planned(mut self, planned: PlannedSlot) -> Self {
        self.planned = planned;
        self
    }

    /// Share an externally owned live-track buffer (survives provider restarts in the app).
    pub fn with_live_track(mut self, live: LiveTrack) -> Self {
        self.live = live;
        self
    }

    pub fn with_resolver(mut self, resolver: Arc<dyn AirportResolver>) -> Self {
        self.resolver = Some(resolver);
        self
    }

    pub fn live_track(&self) -> LiveTrack {
        self.live.clone()
    }

    fn resolve(&self, lat: f64, lon: f64) -> Option<String> {
        self.resolver.as_ref().and_then(|r| r.nearest_ident(lat, lon, AIRPORT_MATCH_NM))
    }

    fn samples(&self) -> MutexGuard<'_, Vec<TrackSample>> {
        self.live.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Id of the flight currently being recorded, if any.
    pub fn current_flight_id(&self) -> Option<&str> {
        self.current.as_ref().map(|c| c.id.as_str())
    }

    /// Aircraft identity usually arrives after connect, sometimes after the flight already started.
    pub fn set_aircraft(&mut self, aircraft: AircraftInfo) -> Result<()> {
        self.ctx.aircraft = Some(aircraft.clone());
        if let Some(c) = &self.current {
            self.store.update_flight_aircraft(&c.id, &aircraft)?;
            let id = c.id.clone();
            self.book_airframe(&id, now_ms())?;
        }
        Ok(())
    }

    /// Book the flight onto its airframe unless it already is: the OFP registration
    /// (attached by `attach_plan`) wins, else the sim's ATC ID if it looks like a registration.
    fn book_airframe(&self, id: &str, now: u64) -> Result<()> {
        if self.store.flight_airframe_reg(id)?.is_some() {
            return Ok(());
        }
        let plan = self.planned.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let ac = self.ctx.aircraft.clone().unwrap_or_default();
        let Some(reg) = resolve_registration(plan.as_ref().map(|p| p.registration.as_str()), Some(&ac.atc_id)) else {
            return Ok(());
        };
        let from_sim = AirframeHint {
            icao_type: icao_from_atc_model(&ac.atc_model).unwrap_or_default(),
            title: ac.title.clone(),
            airline: ac.atc_airline.clone(),
        };
        // the plan's type facts only describe the airframe when its registration is the one booked
        let hint = match plan.filter(|p| normalize_registration(&p.registration).as_deref() == Some(reg.as_str())) {
            Some(p) => merge_hint(
                AirframeHint { icao_type: p.aircraft_icao.to_uppercase(), title: p.aircraft_name, airline: p.airline_icao.to_uppercase() },
                &from_sim,
            ),
            None => from_sim,
        };
        log::info!("flight {id} booked onto airframe {reg}");
        self.store.book_flight_airframe(id, &reg, &hint, now)
    }

    pub fn set_sim_name(&mut self, sim_name: Option<String>) {
        self.ctx.sim_name = sim_name;
    }

    /// Feed the sample that produced `events` together with the session's current summary.
    pub fn on_telemetry(&mut self, t: &Telemetry, summary: &FlightSummary, events: &[FlightEvent]) -> Result<()> {
        let now = t.timestamp_ms;
        for ev in events {
            match ev {
                FlightEvent::FlightStarted { .. } => self.start(summary, now)?,
                FlightEvent::PhaseChanged(tr) => {
                    if let Some(c) = &self.current {
                        self.store.insert_phase_event(&c.id, tr.from, tr.to, tr.timestamp_ms)?;
                        self.store.update_flight(&c.id, summary, "active", now)?;
                        if tr.to == FlightPhase::Landing {
                            let arr = self.resolve(tr.telemetry.latitude, tr.telemetry.longitude);
                            self.store.set_arrival_icao(&c.id, arr.as_deref())?;
                        }
                    }
                }
                FlightEvent::Touchdown(r) => {
                    if let Some(c) = &self.current {
                        self.store.insert_touchdown(&c.id, r)?;
                    }
                }
                FlightEvent::FlightEnded { .. } => self.finish(summary, now)?,
            }
        }

        let Some(c) = self.current.as_mut() else { return Ok(()) };
        if c.last_sample_ms.is_none_or(|last| now.saturating_sub(last) >= SAMPLE_INTERVAL_MS) {
            c.last_sample_ms = Some(now);
            self.live.lock().unwrap_or_else(|e| e.into_inner()).push(TrackSample::from(t));
        }
        if now.saturating_sub(c.last_flush_ms) >= FLUSH_INTERVAL_MS {
            self.flush(summary, now)?;
        }
        Ok(())
    }

    fn start(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        if self.current.is_some() {
            // a new flight began before the old one reached Shutdown – close the old one as-is
            self.finish(summary, now)?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dep = summary.departure.and_then(|p| self.resolve(p.latitude, p.longitude));
        self.store.insert_flight(&id, summary, &self.ctx, dep.as_deref(), now)?;
        log::info!("recording flight {id} (dep {})", dep.as_deref().unwrap_or("?"));
        self.samples().clear();
        if let Some(plan) = self.planned.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            self.store.attach_plan(&id, plan)?;
        }
        self.book_airframe(&id, now)?;
        self.current = Some(Current { id, last_sample_ms: None, last_flush_ms: now });
        Ok(())
    }

    fn flush(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        let Some(c) = self.current.as_mut() else { return Ok(()) };
        let (count, data, preview) = {
            let samples = self.live.lock().unwrap_or_else(|e| e.into_inner());
            (samples.len(), encode_track(&samples), encode_track(&subsample(&samples, PREVIEW_EVERY)))
        };
        self.store.upsert_track(&c.id, count, &data, &preview, now)?;
        self.store.update_flight(&c.id, summary, "active", now)?;
        c.last_flush_ms = now;
        Ok(())
    }

    fn finish(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        self.flush(summary, now)?;
        if let Some(c) = self.current.take() {
            self.store.update_flight(&c.id, summary, "completed", now)?;
            log::info!("flight {} completed with {} track samples", c.id, self.samples().len());
        }
        Ok(())
    }

    /// Persist what we have without ending the flight (call on app shutdown).
    pub fn checkpoint(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        self.flush(summary, now)
    }
}
