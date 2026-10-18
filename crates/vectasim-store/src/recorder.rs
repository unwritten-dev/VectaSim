//! Turns the live `FlightSession` stream into database rows.
//!
//! Cadence is driven by telemetry timestamps, not wall-clock, so the recorder
//! behaves identically under test and in the app. The whole track of the
//! current flight stays in memory (a 10 h flight at 1 Hz is ~4 MB) and is
//! re-encoded and upserted every `FLUSH_INTERVAL_MS` and on flight end.
//!
//! Failure handling: every event of a sample is handled on its own, so a failed
//! write (database locked, disk full) never swallows the events after it – least of
//! all `FlightEnded`. What failed and matters is kept and retried with the next sample:
//! the flight row of a `FlightStarted`, touchdowns, and the end of a flight (the
//! flight stays "ending" until its final state is written). The first error of a
//! call is returned after everything else was attempted; the rest are logged.

use crate::airframe::{AirframeHint, icao_from_atc_model, merge_hint, normalize_registration, resolve_registration};
use crate::store::{FlightContext, PlannedFlight};
use crate::track::{TrackSample, encode_track, subsample};
use crate::{AirportResolver, Result, Store, StoreError};
use std::sync::{Arc, Mutex, MutexGuard};
use vectasim_core::flight::TouchdownOutcomeEvent;
use vectasim_core::touchdown::TouchdownOutcome;
use vectasim_core::{AircraftInfo, FlightEvent, FlightPhase, FlightState, FlightSummary, Telemetry, TouchdownReport, now_ms};

const SAMPLE_INTERVAL_MS: u64 = 1_000;
/// Track upsert cadence: bounds what a crash or a hard close loses to 15 s of track
/// (one `UPDATE tracks` + `UPDATE flights` per 15 s is negligible store load).
const FLUSH_INTERVAL_MS: u64 = 15_000;
/// 1/30 Hz preview: ~120 points for an hour of flying.
pub(crate) const PREVIEW_EVERY: usize = 30;
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
    /// Latest summary of this flight: closes it correctly even when the summary passed in
    /// already belongs to the next flight.
    summary: FlightSummary,
    /// Touchdowns whose insert failed; retried with the next sample.
    pending_touchdowns: Vec<TouchdownReport>,
    /// The flight ended with this state, but writing it has not succeeded yet.
    ending: Option<&'static str>,
}

/// The dispatch plan the next flight should be attached to, shared with the app
/// so loading an OFP before engine start just works.
pub type PlannedSlot = Arc<Mutex<Option<PlannedFlight>>>;

pub struct FlightRecorder {
    store: Store,
    ctx: FlightContext,
    current: Option<Current>,
    /// A `FlightStarted` whose flight row could not be written; retried with the next sample.
    pending_start: bool,
    live: LiveTrack,
    resolver: Option<Arc<dyn AirportResolver>>,
    planned: PlannedSlot,
}

/// Keeps the first error of a batch, logs the others.
#[derive(Default)]
struct Errors(Option<StoreError>);

impl Errors {
    fn note(&mut self, what: &str, r: Result<()>) {
        if let Err(e) = r {
            log::error!("logbook: {what} failed: {e}");
            self.0.get_or_insert(e);
        }
    }

    fn into_result(self) -> Result<()> {
        self.0.map_or(Ok(()), Err)
    }
}

impl FlightRecorder {
    pub fn new(store: Store, ctx: FlightContext) -> Self {
        Self {
            store,
            ctx,
            current: None,
            pending_start: false,
            live: LiveTrack::default(),
            resolver: None,
            planned: PlannedSlot::default(),
        }
    }

    pub fn with_planned(mut self, planned: PlannedSlot) -> Self {
        self.planned = planned;
        self
    }

    /// Use an externally owned live-track buffer (the app gives each provider session its own).
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

    /// Id of the flight currently being recorded (and not yet ended), if any.
    pub fn current_flight_id(&self) -> Option<&str> {
        self.current.as_ref().filter(|c| c.ending.is_none()).map(|c| c.id.as_str())
    }

    /// Id of the flight whose end could not be written yet, if any.
    pub fn ending_flight_id(&self) -> Option<&str> {
        self.current.as_ref().filter(|c| c.ending.is_some()).map(|c| c.id.as_str())
    }

    /// Aircraft identity usually arrives after connect, sometimes after the flight already started.
    pub fn set_aircraft(&mut self, aircraft: AircraftInfo) -> Result<()> {
        self.ctx.aircraft = Some(aircraft.clone());
        if let Some(id) = self.current_flight_id().map(str::to_owned) {
            self.store.update_flight_aircraft(&id, &aircraft)?;
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
        let mut errs = Errors::default();
        self.retry(summary, events, now, &mut errs);
        if let Err(e) = self.on_events(summary, events, now) {
            errs.0.get_or_insert(e);
        }

        if let Some(c) = self.current.as_mut().filter(|c| c.ending.is_none()) {
            if c.last_sample_ms.is_none_or(|last| now.saturating_sub(last) >= SAMPLE_INTERVAL_MS) {
                c.last_sample_ms = Some(now);
                self.live.lock().unwrap_or_else(|e| e.into_inner()).push(TrackSample::from(t));
            }
            if now.saturating_sub(c.last_flush_ms) >= FLUSH_INTERVAL_MS {
                let r = self.flush(summary, now);
                errs.note("track flush", r);
            }
        }
        errs.into_result()
    }

    /// Flight events that did not come with a sample (sim events, provider stop).
    /// Every event is handled even if an earlier one fails; returns the first error.
    pub fn on_events(&mut self, summary: &FlightSummary, events: &[FlightEvent], now: u64) -> Result<()> {
        let mut errs = Errors::default();
        // a FlightStarted in this batch means `summary` already describes the new flight
        let new_flight_here = events.iter().any(|e| matches!(e, FlightEvent::FlightStarted { .. }));
        if !new_flight_here && let Some(c) = self.current.as_mut().filter(|c| c.ending.is_none()) {
            c.summary = summary.clone();
        }
        for ev in events {
            match ev {
                FlightEvent::FlightStarted { .. } => {
                    let r = self.start(summary, now);
                    errs.note("flight start", r);
                }
                FlightEvent::PhaseChanged(tr) => {
                    let Some(id) = self.current_flight_id().map(str::to_owned) else { continue };
                    errs.note("phase event", self.store.insert_phase_event(&id, tr.from, tr.to, tr.timestamp_ms));
                    errs.note("flight update", self.store.update_flight(&id, summary, "active", now));
                    if tr.to == FlightPhase::Landing {
                        let arr = self.resolve(tr.telemetry.latitude, tr.telemetry.longitude);
                        errs.note("arrival airport", self.store.set_arrival_icao(&id, arr.as_deref()));
                    }
                }
                FlightEvent::Touchdown(r) => {
                    let Some(c) = self.current.as_mut() else { continue };
                    if let Err(e) = self.store.insert_touchdown(&c.id, r) {
                        log::error!("logbook: touchdown insert failed, retrying with the next sample: {e}");
                        c.pending_touchdowns.push(r.clone());
                        errs.0.get_or_insert(e);
                    }
                }
                FlightEvent::FlightEnded { interrupted, .. } => {
                    self.pending_start = false;
                    let state = if *interrupted { "interrupted" } else { "completed" };
                    let Some(c) = self.current.as_mut() else { continue };
                    c.ending = Some(state);
                    let s = if new_flight_here { c.summary.clone() } else { summary.clone() };
                    let r = self.finish(&s, now);
                    errs.note("flight end", r);
                }
            }
        }
        errs.into_result()
    }

    /// Decided touchdown outcomes (`FlightSession::take_touchdown_outcomes`). Only a
    /// touch-and-go changes a stored row: the report went in as `touch_and_go = false` when
    /// the roll was longer than the bounce window. A touchdown whose insert is still pending
    /// is corrected in memory instead. Full stop / unknown: the row is already right.
    pub fn on_touchdown_outcomes(&mut self, os: &[TouchdownOutcomeEvent]) -> Result<()> {
        let mut errs = Errors::default();
        let Some(c) = self.current.as_mut() else { return Ok(()) };
        for o in os.iter().filter(|o| o.outcome == TouchdownOutcome::TouchAndGo) {
            if let Some(r) = c.pending_touchdowns.iter_mut().find(|r| r.timestamp_ms == o.touchdown_ms) {
                r.touch_and_go = true;
                continue;
            }
            errs.note("touch-and-go update", self.store.set_touchdown_touch_and_go(&c.id, o.touchdown_ms, true));
        }
        errs.into_result()
    }

    /// Retry what failed before: the end of a flight, its touchdowns, a flight start.
    fn retry(&mut self, summary: &FlightSummary, events: &[FlightEvent], now: u64, errs: &mut Errors) {
        if let Some(c) = self.current.as_ref().filter(|c| c.ending.is_some()) {
            let s = c.summary.clone();
            log::info!("logbook: retrying the end of flight {}", c.id);
            errs.note("flight end (retry)", self.finish(&s, now));
        }
        errs.note("touchdown (retry)", self.retry_touchdowns());
        let starts_now = events.iter().any(|e| matches!(e, FlightEvent::FlightStarted { .. }));
        if self.pending_start && !starts_now && self.current.is_none() && summary.state == FlightState::Active {
            log::info!("logbook: retrying the flight start");
            errs.note("flight start (retry)", self.start(summary, now));
        }
    }

    fn retry_touchdowns(&mut self) -> Result<()> {
        let Some(c) = self.current.as_mut() else { return Ok(()) };
        while let Some(r) = c.pending_touchdowns.first() {
            self.store.insert_touchdown(&c.id, r)?;
            c.pending_touchdowns.remove(0);
        }
        Ok(())
    }

    fn start(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        if let Some(c) = &self.current {
            // a new flight began before the old one was closed – close the old one with its own summary
            let s = c.summary.clone();
            let id = c.id.clone();
            if let Some(c) = self.current.as_mut() {
                c.ending.get_or_insert("interrupted");
            }
            if let Err(e) = self.finish(&s, now) {
                log::error!("logbook: could not close flight {id} before the next one: {e}");
                self.current = None;
            }
        }
        self.pending_start = true;
        let id = uuid::Uuid::new_v4().to_string();
        let dep = summary.departure.and_then(|p| self.resolve(p.latitude, p.longitude));
        self.store.insert_flight(&id, summary, &self.ctx, dep.as_deref(), now)?;
        self.pending_start = false;
        log::info!("recording flight {id} (dep {})", dep.as_deref().unwrap_or("?"));
        self.samples().clear();
        self.current = Some(Current {
            id: id.clone(),
            last_sample_ms: None,
            last_flush_ms: now,
            summary: summary.clone(),
            pending_touchdowns: Vec::new(),
            ending: None,
        });
        // the flight row exists: what follows is nice to have, the flight records regardless
        let mut errs = Errors::default();
        if let Some(plan) = self.planned.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            errs.note("attach plan", self.store.attach_plan(&id, plan).map(|_| ()));
        }
        errs.note("book airframe", self.book_airframe(&id, now));
        errs.into_result()
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

    /// Write the end of the current flight (state from `Current::ending`, default completed).
    /// On failure the flight stays "ending" and the next sample retries.
    fn finish(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        let Some(c) = self.current.as_mut() else { return Ok(()) };
        let state = *c.ending.get_or_insert("completed");
        c.summary = summary.clone();
        if let Err(e) = self.retry_touchdowns() {
            // the end of the flight matters more than a touchdown row
            let lost = self.current.as_ref().map_or(0, |c| c.pending_touchdowns.len());
            log::error!("logbook: {lost} touchdown(s) could not be written before the flight end: {e}");
        }
        self.flush(summary, now)?;
        let Some(c) = self.current.as_ref() else { return Ok(()) };
        self.store.update_flight(&c.id, summary, state, now)?;
        log::info!("flight {} {state} with {} track samples", c.id, self.samples().len());
        self.current = None;
        Ok(())
    }

    /// Continue recording the interrupted flight `flight_id` (the pilot accepted "Flug
    /// fortsetzen?" after a crash). `summary` is the resumed session summary
    /// (`FlightSession::preview_resume`). A flight this recorder opened since the restart is
    /// flushed and merged into the resumed one (`Store::merge_flights`, it goes to the
    /// Papierkorb); the live track becomes the stored track plus what follows. On error
    /// nothing changed and the recorder records as before.
    pub fn resume(&mut self, flight_id: &str, summary: &FlightSummary, now: u64) -> Result<()> {
        if self.current.as_ref().is_some_and(|c| c.ending.is_some()) {
            return Err(StoreError::Invalid("Das Ende des letzten Flugs ist noch nicht gespeichert.".into()));
        }
        if let Some(c) = self.current.as_ref() {
            if c.id == flight_id {
                return Ok(());
            }
            let (new_id, own) = (c.id.clone(), c.summary.clone());
            self.flush(&own, now)?;
            self.store.merge_flights_at(flight_id, &new_id, now)?;
            log::info!("logbook: flight {new_id} (recorded since the restart) folded into resumed flight {flight_id}");
        } else {
            self.store.reopen_flight(flight_id, now)?;
        }
        self.pending_start = false;
        let track = self.store.get_track(flight_id)?.unwrap_or_default();
        let last_sample_ms = track.last().map(|s| s.t_ms);
        *self.samples() = track;
        let pending_touchdowns = self.current.take().map(|c| c.pending_touchdowns).unwrap_or_default();
        self.current = Some(Current {
            id: flight_id.to_string(),
            last_sample_ms,
            last_flush_ms: now,
            summary: summary.clone(),
            pending_touchdowns,
            ending: None,
        });
        self.store.update_flight(flight_id, summary, "active", now)?;
        log::info!("recording flight {flight_id} again (resumed, {} track samples so far)", self.samples().len());
        Ok(())
    }

    /// Persist what we have without ending the flight (call on app shutdown). A flight
    /// whose end is still pending is closed instead.
    pub fn checkpoint(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        match self.current.as_ref() {
            Some(c) if c.ending.is_some() => {
                let s = c.summary.clone();
                self.finish(&s, now)
            }
            _ => self.flush(summary, now),
        }
    }
}
