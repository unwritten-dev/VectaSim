//! Turns the live `FlightSession` stream into database rows.
//!
//! Cadence is driven by telemetry timestamps, not wall-clock, so the recorder
//! behaves identically under test and in the app. The 1 Hz sampling and the flush interval
//! run on a [`MonoClock`] over those timestamps: a system clock set back does not stop
//! either. Track samples carry the wall-clock `t_ms`, and the live track (so the stored one) is
//! strictly increasing in it – the live map's incremental reload cursors on `t_ms`, replay and
//! time axes need the order. After a backward step of the system clock a sample at or before
//! the last one is
//! - set 1 ms after the last one when the step is small (≤ [`MAX_TRACK_CLAMP_MS`], an NTP
//!   correction): a second or two of samples a millisecond apart, then wall clock again;
//! - left out of the track when the step is larger (the clock set back by hand): the track
//!   resumes when the wall clock has passed its last sample again. Squeezing an hour into
//!   milliseconds, or shifting the rest of the track away from the event timestamps
//!   (touchdowns, phases, which stay wall clock), would make the track wrong; the hole only
//!   makes it shorter.
//!
//! Sampling cadence and flushes go on regardless. The whole track of the
//! current flight stays in memory (a 10 h flight at 1 Hz is ~4 MB) and is upserted every
//! `FLUSH_INTERVAL_MS` and on flight end; each flush only encodes the samples added since the
//! last one ([`TrackEncoder`]) and compresses the stream again.
//!
//! Failure handling: every event of a sample is handled on its own, so a failed
//! write (database locked, disk full) never swallows the events after it – least of
//! all `FlightEnded`. What failed and matters is kept and retried with the next sample:
//! the flight row of a `FlightStarted`, touchdowns, and the end of a flight (the
//! flight stays "ending" until its final state is written). The first error of a
//! call is returned after everything else was attempted; the rest are logged.
//!
//! Ground sessions (`FlightState::Discarded`, see `vectasim_core::flight`): a flight that ends
//! without having flown is stored with state `discarded` and goes straight to the Papierkorb.
//! The `FlightEnded` of such a flight is written that way when its summary says so; in any case
//! the caller passes the session's [`FlightDiscardedEvent`]s to [`FlightRecorder::on_discarded`]
//! (the summary may already describe the next flight when it starts in the same sample).

use crate::airframe::{AirframeHint, icao_from_atc_model, merge_hint, normalize_registration, resolve_registration};
use crate::store::{FlightContext, PlannedFlight};
use crate::track::{TrackEncoder, TrackSample};
use crate::{AirportResolver, Result, Store, StoreError};
use std::sync::{Arc, Mutex, MutexGuard};
use vectasim_core::flight::{FlightDiscardedEvent, TouchdownOutcomeEvent};
use vectasim_core::touchdown::TouchdownOutcome;
use vectasim_core::{AircraftInfo, FlightEvent, FlightPhase, FlightState, FlightSummary, MonoClock, Telemetry, TouchdownReport, now_ms};

const SAMPLE_INTERVAL_MS: u64 = 1_000;
/// Track upsert cadence: bounds what a crash or a hard close loses to 15 s of track
/// (one `UPDATE tracks` + `UPDATE flights` per 15 s is negligible store load).
const FLUSH_INTERVAL_MS: u64 = 15_000;
/// 1/30 Hz preview: ~120 points for an hour of flying.
pub(crate) const PREVIEW_EVERY: usize = 30;
/// Flights closed by this recorder that a later [`FlightDiscardedEvent`] may still refer to.
const RECENTLY_CLOSED: usize = 4;
/// How far from the nearest airport a start/landing position may be to still count as "at" it.
const AIRPORT_MATCH_NM: f64 = 3.0;

/// Backward clock steps up to this size keep the samples (1 ms after the last one); larger ones
/// leave a hole in the track (see the module doc), ms.
pub const MAX_TRACK_CLAMP_MS: u64 = 10_000;

/// A flight started in the air below this AGL near an airport is arriving there (see
/// [`low_airborne_start`]), ft.
const LOW_AIRBORNE_START_AGL_FT: f64 = 3_000.0;

/// The `FlightStarted` in `events` is a start in the air (Preflight/Shutdown straight into an
/// airborne phase) below [`LOW_AIRBORNE_START_AGL_FT`]: a flight loaded on the approach. The
/// airport within [`AIRPORT_MATCH_NM`] of that point is then its arrival candidate, not its
/// departure (a flight loaded on a 2 nm final otherwise "departed" from its destination). A
/// later landing sets the arrival as usual.
fn low_airborne_start(events: &[FlightEvent]) -> bool {
    events.iter().any(|e| {
        matches!(e, FlightEvent::PhaseChanged(tr)
            if matches!(tr.from, FlightPhase::Preflight | FlightPhase::Shutdown)
                && tr.to.is_airborne_phase()
                && tr.telemetry.altitude_agl_ft < LOW_AIRBORNE_START_AGL_FT)
    })
}

/// The current flight's 1 Hz samples, shared with the UI so the live map can draw
/// the whole track without a round trip through SQLite.
pub type LiveTrack = Arc<Mutex<Vec<TrackSample>>>;

pub use crate::store::FlightContext as RecorderContext;

struct Current {
    id: String,
    /// [`FlightRecorder::clock`] time of the last 1 Hz sample (`None`: take the next one).
    last_sample_mono: Option<u64>,
    /// [`FlightRecorder::clock`] time of the last flush (`None`: the next sample starts the interval).
    last_flush_mono: Option<u64>,
    /// Latest summary of this flight: closes it correctly even when the summary passed in
    /// already belongs to the next flight.
    summary: FlightSummary,
    /// Touchdowns whose insert failed; retried with the next sample.
    pending_touchdowns: Vec<TouchdownReport>,
    /// The flight ended with this state, but writing it has not succeeded yet.
    ending: Option<&'static str>,
    /// The track encoded so far (see [`Encoded`]).
    encoded: Encoded,
}

impl Current {
    fn new(id: String, summary: FlightSummary, pending_touchdowns: Vec<TouchdownReport>) -> Self {
        Self {
            id,
            last_sample_mono: None,
            last_flush_mono: None,
            summary,
            pending_touchdowns,
            ending: None,
            encoded: Encoded::default(),
        }
    }
}

/// Incremental encoding of the live track for the flush: the samples up to `upto` are in the
/// encoders, a flush only adds the ones after it (copied out of the lock) instead of cloning
/// and re-encoding the whole buffer every 15 s. The zstd pass over the whole stream remains.
#[derive(Default)]
struct Encoded {
    track: TrackEncoder,
    /// Every [`PREVIEW_EVERY`]th sample, like [`crate::track::subsample`]; its moving last
    /// sample is added per flush.
    preview: TrackEncoder,
    upto: usize,
    /// `t_ms` of the first sample and of the last one in `preview`.
    first_t_ms: Option<u64>,
    preview_last_t_ms: Option<u64>,
}

impl Encoded {
    /// Blobs of the whole buffer `live`; starts over when it is not the buffer encoded so far
    /// (cleared, replaced).
    fn update(&mut self, live: &Mutex<Vec<TrackSample>>) -> (usize, Vec<u8>, Vec<u8>) {
        let (new, last) = {
            let samples = live.lock().unwrap_or_else(|e| e.into_inner());
            if samples.len() < self.upto || (self.upto > 0 && samples.first().map(|s| s.t_ms) != self.first_t_ms) {
                *self = Encoded::default();
            }
            (samples[self.upto..].to_vec(), samples.last().cloned())
        };
        for s in &new {
            if self.upto == 0 {
                self.first_t_ms = Some(s.t_ms);
            }
            self.track.push(s);
            if self.upto.is_multiple_of(PREVIEW_EVERY) {
                self.preview.push(s);
                self.preview_last_t_ms = Some(s.t_ms);
            }
            self.upto += 1;
        }
        let extra = last.filter(|l| self.preview_last_t_ms != Some(l.t_ms));
        (self.upto, self.track.encode(None), self.preview.encode(extra.as_ref()))
    }
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
    /// The flight being started began in the air low over the ground (see [`low_airborne_start`]).
    start_low: bool,
    live: LiveTrack,
    resolver: Option<Arc<dyn AirportResolver>>,
    planned: PlannedSlot,
    /// Monotonic time over the telemetry timestamps, for sampling and flush cadence.
    clock: MonoClock,
    /// (id, off-block) of the last flights this recorder closed, newest last.
    recently_closed: Vec<(String, Option<u64>)>,
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
            start_low: false,
            live: LiveTrack::default(),
            resolver: None,
            planned: PlannedSlot::default(),
            clock: MonoClock::new(),
            recently_closed: Vec::new(),
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
        // the registration only at DEBUG (Streamer-Modus: the app masks it in the Diagnosepaket)
        log::info!("flight {id} booked onto its airframe");
        log::debug!("flight {id} booked onto airframe {reg}");
        self.store.book_flight_airframe(id, &reg, &hint, now)
    }

    pub fn set_sim_name(&mut self, sim_name: Option<String>) {
        self.ctx.sim_name = sim_name;
    }

    /// Feed the sample that produced `events` together with the session's current summary.
    pub fn on_telemetry(&mut self, t: &Telemetry, summary: &FlightSummary, events: &[FlightEvent]) -> Result<()> {
        let now = t.timestamp_ms;
        let mono = self.clock.advance(now);
        let mut errs = Errors::default();
        self.retry(summary, events, now, &mut errs);
        if let Err(e) = self.on_events(summary, events, now) {
            errs.0.get_or_insert(e);
        }

        if let Some(c) = self.current.as_mut().filter(|c| c.ending.is_none()) {
            if c.last_sample_mono.is_none_or(|last| mono.saturating_sub(last) >= SAMPLE_INTERVAL_MS) {
                let mut sample = TrackSample::from(t);
                let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
                // never backwards (see the module doc)
                let keep = match live.last() {
                    Some(last) if sample.t_ms <= last.t_ms => {
                        if last.t_ms - sample.t_ms <= MAX_TRACK_CLAMP_MS {
                            sample.t_ms = last.t_ms + 1;
                            true
                        } else {
                            false
                        }
                    }
                    _ => true,
                };
                if keep {
                    live.push(sample);
                }
                c.last_sample_mono = Some(mono);
            }
            let due = match c.last_flush_mono {
                Some(last) => mono.saturating_sub(last) >= FLUSH_INTERVAL_MS,
                None => {
                    c.last_flush_mono = Some(mono);
                    false
                }
            };
            if due {
                let r = self.flush(summary, now);
                if r.is_ok()
                    && let Some(c) = self.current.as_mut()
                {
                    c.last_flush_mono = Some(mono);
                }
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
                    self.start_low = low_airborne_start(events);
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
                    let Some(c) = self.current.as_mut() else { continue };
                    let s = if new_flight_here { c.summary.clone() } else { summary.clone() };
                    let state = match (s.state, *interrupted) {
                        (FlightState::Discarded, _) => "discarded",
                        (_, true) => "interrupted",
                        (_, false) => "completed",
                    };
                    c.ending = Some(state);
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
        let here = summary.departure.and_then(|p| self.resolve(p.latitude, p.longitude));
        // started in the air low near an airport (loaded on the final): that airport is where the
        // flight is going, not where it came from
        let (dep, arr) = if self.start_low { (None, here) } else { (here, None) };
        self.store.insert_flight(&id, summary, &self.ctx, dep.as_deref(), now)?;
        self.pending_start = false;
        log::info!("recording flight {id} (dep {})", dep.as_deref().unwrap_or("?"));
        self.samples().clear();
        self.current = Some(Current::new(id.clone(), summary.clone(), Vec::new()));
        // the flight row exists: what follows is nice to have, the flight records regardless
        let mut errs = Errors::default();
        if let Some(arr) = arr {
            log::info!("flight {id} started in the air low near {arr}: arrival candidate, no departure airport");
            errs.note("arrival airport", self.store.set_arrival_icao(&id, Some(&arr)));
        }
        if let Some(plan) = self.planned.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            errs.note("attach plan", self.store.attach_plan(&id, plan).map(|_| ()));
        }
        errs.note("book airframe", self.book_airframe(&id, now));
        errs.into_result()
    }

    fn flush(&mut self, summary: &FlightSummary, now: u64) -> Result<()> {
        let Some(c) = self.current.as_mut() else { return Ok(()) };
        // only the samples since the last flush are copied out of the lock and encoded; the live
        // map and `live_track` readers never wait for the zstd pass
        let (count, data, preview) = c.encoded.update(&self.live);
        self.store.upsert_track(&c.id, count, &data, &preview, now)?;
        self.store.update_flight(&c.id, summary, "active", now)?;
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
        if state == "discarded" {
            self.store.discard_flight_at(&c.id, now)?;
        }
        log::info!("flight {} {state} with {} track samples", c.id, self.samples().len());
        let closed = (c.id.clone(), c.summary.off_block_ms);
        if self.recently_closed.len() >= RECENTLY_CLOSED {
            self.recently_closed.remove(0);
        }
        self.recently_closed.push(closed);
        self.current = None;
        Ok(())
    }

    /// The session's discarded ground sessions (`FlightSession::take_discarded_flights`, after
    /// the events of the same call went through [`Self::on_telemetry`] / [`Self::on_events`]):
    /// each flight goes to the Papierkorb with state `discarded`. A flight whose end is still
    /// pending is marked so its end writes it that way. Returns the ids of the flights it
    /// discarded (or will, for a pending end).
    pub fn on_discarded(&mut self, discarded: &[FlightDiscardedEvent], now: u64) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        let mut errs = Errors::default();
        for d in discarded {
            if let Some(c) = self.current.as_mut().filter(|c| c.ending.is_some() && c.summary.off_block_ms == d.off_block_ms) {
                c.ending = Some("discarded");
                ids.push(c.id.clone());
                continue;
            }
            let pos = self
                .recently_closed
                .iter()
                .rposition(|(_, off)| *off == d.off_block_ms)
                .or_else(|| d.off_block_ms.is_none().then(|| self.recently_closed.len().checked_sub(1)).flatten());
            let Some(pos) = pos else {
                log::warn!("logbook: discarded ground session (off-block {:?}) matches no recorded flight", d.off_block_ms);
                continue;
            };
            let (id, _) = self.recently_closed.remove(pos);
            match self.store.discard_flight_at(&id, now) {
                Ok(_) => {
                    log::info!("flight {id} discarded (ground session, in the Papierkorb)");
                    ids.push(id);
                }
                Err(e) => errs.note("discard", Err(e)),
            }
        }
        errs.into_result().map(|()| ids)
    }

    /// Continue recording the interrupted flight `flight_id` (the pilot accepted "Flug
    /// fortsetzen?" after a crash). `summary` is the resumed session summary
    /// (`FlightSession::preview_resume`). A flight this recorder opened since the restart is
    /// flushed and merged into the resumed one (`Store::merge_flights`, it goes to the
    /// Papierkorb); the live track becomes the stored track plus what follows. On error
    /// nothing changed and the recorder records as before.
    pub fn resume(&mut self, flight_id: &str, summary: &FlightSummary, now: u64) -> Result<()> {
        if self.current.as_ref().is_some_and(|c| c.ending.is_some()) {
            return Err(StoreError::Invalid(crate::Invalid::LastFlightNotSaved));
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
        *self.samples() = track;
        let pending_touchdowns = self.current.take().map(|c| c.pending_touchdowns).unwrap_or_default();
        self.current = Some(Current::new(flight_id.to_string(), summary.clone(), pending_touchdowns));
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
