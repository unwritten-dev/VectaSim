//! Einstellungen → Overlay & Schnittstelle: the local HTTP/WebSocket server
//! (`crates/vectasim-server`) for OBS overlays, a second screen and the JSON interface.
//!
//! Off by default (setting `server_enabled`). Port `server_port` (default 8095), LAN access
//! `server_lan` (bind 0.0.0.0, other devices need the token `server_token`; this PC never
//! does). Started from `setup` when enabled, restarted when port or LAN access change.
//!
//! [`AppSource`] is what the server reads: the manager's status snapshot (the same state the
//! webview gets), the dispatch plan, the running flight's logbook row (cached for
//! [`ROW_TTL`]), the airport index and the logbook. It is polled at 2 Hz only while a
//! WebSocket client is connected; nothing is added to the live path. Streamer-Modus
//! (`privacy::privacy_mode_on`) is applied by the server crate; paths in the status text lose
//! the Windows user name always (`privacy::mask_user_paths`), the server may be reachable from
//! the network.

use crate::manager::{ProviderManager, StatusSnapshot};
use crate::privacy;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use vectasim_core::{FlightState, now_ms};
use vectasim_data::AirportIndex;
use vectasim_server::api::{self, Aircraft, Flight, Fuel, Landing, LogbookEntry, Snapshot};
use vectasim_server::{Config, DEFAULT_PORT, Server, Source, auth};
use vectasim_store::airframe::{icao_from_atc_model, normalize_registration, resolve_registration};
use vectasim_store::{FlightDetail, FlightRow, PlannedFlight, Store};

pub const SETTING_SERVER_ENABLED: &str = "server_enabled";
pub const SETTING_SERVER_PORT: &str = "server_port";
pub const SETTING_SERVER_LAN: &str = "server_lan";
pub const SETTING_SERVER_TOKEN: &str = "server_token";

/// Ports the settings accept (below 1024 Windows may need admin rights; 0 = random).
pub const PORT_MIN: u16 = 1024;
/// The running flight's logbook row is re-read at most this often.
const ROW_TTL: Duration = Duration::from_secs(10);
/// Departure/arrival airport around the flight's first/last position.
const AIRPORT_SEARCH_NM: f64 = 5.0;
/// Below this ground speed no ETA (same as the HUD, progress.ts → ETA_MIN_GS_KT).
const ETA_MIN_GS_KT: f64 = 50.0;

/// What Einstellungen → Overlay & Schnittstelle shows.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub lan: bool,
    /// For other devices (shown only with LAN access on).
    pub token: String,
    /// IPv4 address of this PC in the home network, if one is found.
    pub lan_address: Option<String>,
    /// Running since (Unix ms).
    pub since_ms: Option<u64>,
    /// Connected WebSocket clients (overlays, tablets).
    pub clients: usize,
    /// Why it does not run (port in use …).
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    server: Option<Server>,
    since_ms: Option<u64>,
    error: Option<String>,
}

#[derive(Default)]
pub struct ServerState(Mutex<Inner>);

fn lock(m: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Settings {
    enabled: bool,
    port: u16,
    lan: bool,
    token: String,
}

fn setting(store: &Store, key: &str) -> Option<String> {
    store.get_setting(key).ok().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Port from the setting; anything unusable falls back to [`DEFAULT_PORT`].
fn parse_port(raw: Option<&str>) -> u16 {
    raw.and_then(|s| s.parse::<u16>().ok()).filter(|p| *p >= PORT_MIN).unwrap_or(DEFAULT_PORT)
}

/// Reads the settings; creates and stores a token the first time one is needed.
fn load(store: &Store) -> Settings {
    let mut token = setting(store, SETTING_SERVER_TOKEN).filter(|t| auth::valid_token(t)).unwrap_or_default();
    if token.is_empty() {
        token = auth::generate_token();
        if let Err(e) = store.set_setting(SETTING_SERVER_TOKEN, &token) {
            log::warn!("overlay server token not saved: {e}");
        }
    }
    Settings {
        enabled: setting(store, SETTING_SERVER_ENABLED).as_deref() == Some("1"),
        port: parse_port(setting(store, SETTING_SERVER_PORT).as_deref()),
        lan: setting(store, SETTING_SERVER_LAN).as_deref() == Some("1"),
        token,
    }
}

/// This PC's address in the home network: the source address the OS would pick for an
/// outside destination (a UDP `connect` sends nothing).
fn lan_address() -> Option<String> {
    let s = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    s.connect(("192.0.2.1", 80)).ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

fn status_of(inner: &Inner, s: &Settings) -> ServerStatus {
    ServerStatus {
        enabled: s.enabled,
        running: inner.server.is_some(),
        port: inner.server.as_ref().map(|srv| srv.local_addr().port()).unwrap_or(s.port),
        lan: s.lan,
        token: s.token.clone(),
        lan_address: s.lan.then(lan_address).flatten(),
        since_ms: inner.since_ms,
        clients: inner.server.as_ref().map_or(0, Server::clients),
        error: inner.error.clone(),
    }
}

/// Bring the server in line with the settings: stop it, then start it again if enabled.
fn apply(app: &AppHandle, store: &Store, s: &Settings) {
    let state = app.state::<ServerState>();
    let mut inner = lock(&state.0);
    if let Some(old) = inner.server.take() {
        old.stop();
    }
    inner.since_ms = None;
    inner.error = None;
    if !s.enabled {
        return;
    }
    let source = Arc::new(AppSource::new(app.clone(), store.clone()));
    match Server::start(Config { port: s.port, lan: s.lan, token: s.token.clone() }, source) {
        Ok(srv) => {
            log::info!("overlay server on {} ({})", srv.local_addr(), if s.lan { "LAN with token" } else { "this PC only" });
            inner.server = Some(srv);
            inner.since_ms = Some(now_ms());
        }
        Err(e) => {
            log::warn!("overlay server not started: {e}");
            inner.error = Some(e);
        }
    }
}

/// From `setup`: start the server if it was left on.
pub fn restore(app: &AppHandle, store: &Store) {
    let s = load(store);
    if s.enabled {
        apply(app, store, &s);
    }
}

fn store_of(app: &AppHandle) -> Result<Store, String> {
    app.try_state::<Store>().map(|s| s.inner().clone()).ok_or_else(|| crate::lang::tr("Logbuch nicht geöffnet", "Logbook not opened").to_string())
}

#[tauri::command]
pub async fn server_status(app: AppHandle) -> Result<ServerStatus, String> {
    let store = store_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let s = load(&store);
        let state = app.state::<ServerState>();
        let inner = lock(&state.0);
        Ok(status_of(&inner, &s))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn server_set_enabled(enabled: bool, app: AppHandle) -> Result<ServerStatus, String> {
    let store = store_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store.set_setting(SETTING_SERVER_ENABLED, if enabled { "1" } else { "0" }).map_err(|e| e.to_string())?;
        let s = load(&store);
        apply(&app, &store, &s);
        let state = app.state::<ServerState>();
        let inner = lock(&state.0);
        Ok(status_of(&inner, &s))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOptions {
    pub port: Option<u16>,
    pub lan: Option<bool>,
    /// Make a new token (the old URLs on other devices stop working).
    #[serde(default)]
    pub regenerate_token: bool,
}

/// Validates the port the panel sends.
fn check_port(p: u16) -> Result<u16, String> {
    if p < PORT_MIN { Err(trf!("Port {p} geht nicht – bitte {PORT_MIN}–65535.", "Port {p} does not work – please use {PORT_MIN}–65535.")) } else { Ok(p) }
}

#[tauri::command]
pub async fn server_set_options(options: ServerOptions, app: AppHandle) -> Result<ServerStatus, String> {
    let store = store_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let before = load(&store);
        if let Some(p) = options.port {
            store.set_setting(SETTING_SERVER_PORT, &check_port(p)?.to_string()).map_err(|e| e.to_string())?;
        }
        if let Some(lan) = options.lan {
            store.set_setting(SETTING_SERVER_LAN, if lan { "1" } else { "0" }).map_err(|e| e.to_string())?;
        }
        if options.regenerate_token {
            store.set_setting(SETTING_SERVER_TOKEN, &auth::generate_token()).map_err(|e| e.to_string())?;
            log::info!("overlay server: new token");
        }
        let s = load(&store);
        let state = app.state::<ServerState>();
        let running = lock(&state.0).server.is_some();
        // the token only matters to a running LAN server; port and LAN need a new bind
        if s != before && (running || lock(&state.0).error.is_some()) {
            apply(&app, &store, &s);
        }
        let inner = lock(&state.0);
        Ok(status_of(&inner, &s))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- data source ---------------------------------------------------------------------------

struct RowCache {
    flight_id: String,
    read: Instant,
    detail: Option<FlightDetail>,
}

/// Runway facts of the live landing, computed once per touchdown.
struct FactCache {
    key: (String, u64),
    fact: vectasim_store::store::LandingFactCache,
}

pub(crate) struct AppSource {
    app: AppHandle,
    store: Store,
    row: Mutex<Option<RowCache>>,
    fact: Mutex<Option<FactCache>>,
    version: String,
}

impl AppSource {
    fn new(app: AppHandle, store: Store) -> Self {
        let version = app.package_info().version.to_string();
        Self { app, store, row: Mutex::new(None), fact: Mutex::new(None), version }
    }

    fn airports(&self) -> Option<Arc<AirportIndex>> {
        self.app.try_state::<Arc<AirportIndex>>().map(|a| a.inner().clone())
    }

    /// The running flight's stored detail (without re-reading it at 2 Hz).
    fn detail(&self, flight_id: &str) -> Option<FlightDetail> {
        let mut c = self.row.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = c.as_ref().is_some_and(|c| c.flight_id == flight_id && c.read.elapsed() < ROW_TTL);
        if !fresh {
            let detail = self.store.get_flight(flight_id).ok().flatten();
            *c = Some(RowCache { flight_id: flight_id.to_owned(), read: Instant::now(), detail });
        }
        c.as_ref().and_then(|c| c.detail.clone())
    }

    fn live(&self) -> (StatusSnapshot, Option<String>, Option<PlannedFlight>) {
        let manager = self.app.state::<ProviderManager>();
        let plan = manager.planned.lock().unwrap_or_else(|e| e.into_inner()).clone();
        (manager.snapshot(), manager.current_flight_id(), plan)
    }
}

impl Source for AppSource {
    fn snapshot(&self) -> Snapshot {
        let (snap, id, plan) = self.live();
        let detail = id.as_deref().and_then(|id| self.detail(id));
        build_snapshot(&snap, id, detail.as_ref().map(|d| &d.flight), plan.as_ref(), self.airports().as_deref(), now_ms(), &self.version)
    }

    fn landing(&self) -> Option<Landing> {
        let (snap, id, plan) = self.live();
        let airports = self.airports();
        // the running flight's last touchdown, right after it happened
        if let (Some(f), Some(id)) = (snap.flight.as_ref(), id.as_deref())
            && let Some(td) = f.touchdowns.last()
        {
            let index = (f.touchdowns.len() - 1) as u32;
            let detail = self.detail(id);
            let row = detail.as_ref().map(|d| &d.flight);
            let mut l = Landing::from_report(td, index);
            l.flight_id = Some(id.to_owned());
            l.live = true;
            l.aircraft = aircraft_of(&snap, row, plan.as_ref());
            // for the Streamer-Modus mask of the title only (not serialised)
            l.callsign = callsign_of(&snap, row, plan.as_ref());
            if let (Some(d), Some(airports)) = (detail.as_ref(), airports.as_deref())
                && d.touchdowns.len() > index as usize
            {
                let fact = self.fact_for(airports, &d.flight, &d.touchdowns, index, td.timestamp_ms);
                apply_fact(&mut l, &fact);
            }
            apply_approach(&mut l, &self.store, id);
            return Some(l);
        }
        // else the newest full-stop landing in the logbook
        let recent = self.store.recent_landings(1, true).ok()?.into_iter().next()?;
        let mut l = Landing::from_report(&recent.touchdown, recent.touchdown_index);
        l.flight_id = Some(recent.flight.id.clone());
        l.aircraft = aircraft_of_row(&recent.flight);
        l.callsign = opt(&recent.flight.user_callsign).or_else(|| opt(&recent.flight.callsign));
        let fact = match recent.cached {
            Some(c) if c.version == crate::landing::LANDING_FACTS_VERSION => Some(c),
            _ => airports.as_deref().and_then(|a| {
                let touchdowns = self.store.get_flight(&recent.flight.id).ok().flatten()?.touchdowns;
                let c = crate::landing::compute_fact(&self.store, a, &recent.flight, &touchdowns, recent.touchdown_index as usize);
                let _ = self.store.put_landing_fact(&recent.flight.id, recent.touchdown_index, &c);
                Some(c)
            }),
        };
        if let Some(f) = fact {
            apply_fact(&mut l, &f);
        }
        apply_approach(&mut l, &self.store, &recent.flight.id);
        Some(l)
    }

    fn logbook(&self, limit: usize) -> Vec<LogbookEntry> {
        self.store.list_flights(limit as u32, 0).map(|rows| rows.iter().map(logbook_entry).collect()).unwrap_or_default()
    }

    fn privacy(&self) -> bool {
        privacy::privacy_mode_on(&self.store)
    }

    fn lang(&self) -> vectasim_core::Lang {
        crate::lang::current()
    }
}

impl AppSource {
    fn fact_for(&self, airports: &AirportIndex, row: &FlightRow, tds: &[vectasim_core::TouchdownReport], index: u32, ts: u64) -> vectasim_store::store::LandingFactCache {
        let key = (row.id.clone(), ts);
        let mut c = self.fact.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = c.as_ref().filter(|f| f.key == key) {
            return f.fact.clone();
        }
        let fact = crate::landing::compute_fact(&self.store, airports, row, tds, index as usize);
        *c = Some(FactCache { key, fact: fact.clone() });
        fact
    }
}

fn apply_fact(l: &mut Landing, f: &vectasim_store::store::LandingFactCache) {
    if !f.matched {
        return;
    }
    l.airport = f.airport_icao.clone();
    l.runway = f.runway_ident.clone();
    l.touchdown_distance_m = f.touchdown_distance_m;
    l.centerline_offset_m = f.centerline_offset_m;
    l.in_touchdown_zone = Some(f.in_touchdown_zone);
}

/// „stabil ab“ and the approach band, once the approach assessment is cached (after the flight).
fn apply_approach(l: &mut Landing, store: &Store, flight_id: &str) {
    let Ok(rows) = store.approach_facts_for_flight(flight_id) else { return };
    let Some(row) = rows.iter().find(|r| r.touchdown_index == Some(l.touchdown_index)) else { return };
    l.stable_from_ft = row.stable_from_ft;
    l.approach_band = row.detail().and_then(|d| d.band).and_then(|b| serde_json::to_value(b).ok()).and_then(|v| v.as_str().map(str::to_owned));
    if l.airport.is_none() {
        l.airport = row.airport_icao.clone();
        l.runway = row.runway_ident.clone();
    }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_owned())
}

fn opt(s: &Option<String>) -> Option<String> {
    s.as_deref().and_then(non_empty)
}

fn aircraft_of_row(r: &FlightRow) -> Aircraft {
    Aircraft {
        title: opt(&r.user_aircraft_title).or_else(|| non_empty(&r.aircraft.title)),
        icao_type: icao_from_atc_model(&r.aircraft.atc_model),
        registration: opt(&r.user_registration)
            .or_else(|| r.airframe_reg.as_deref().and_then(normalize_registration))
            .or_else(|| resolve_registration(None, Some(&r.aircraft.atc_id))),
        airline: non_empty(&r.aircraft.atc_airline),
    }
}

/// The aircraft as the side panel names it: pilot corrections, then the plan, then the sim.
/// Callsign of the running flight: logbook row, else the plan, else the sim's ATC fields.
fn callsign_of(snap: &StatusSnapshot, row: Option<&FlightRow>, plan: Option<&PlannedFlight>) -> Option<String> {
    row.and_then(|r| opt(&r.user_callsign).or_else(|| opt(&r.callsign))).or_else(|| plan.and_then(|p| non_empty(&p.callsign))).or_else(|| {
        let a = snap.aircraft.as_ref()?;
        non_empty(&a.atc_flight_number)?;
        non_empty(&format!("{}{}", a.atc_airline.trim(), a.atc_flight_number.trim()))
    })
}

fn aircraft_of(snap: &StatusSnapshot, row: Option<&FlightRow>, plan: Option<&PlannedFlight>) -> Aircraft {
    let ac = snap.aircraft.as_ref();
    let from_row = row.map(aircraft_of_row).unwrap_or_default();
    Aircraft {
        title: row.and_then(|r| opt(&r.user_aircraft_title)).or_else(|| ac.and_then(|a| non_empty(&a.title))).or(from_row.title),
        icao_type: plan
            .and_then(|p| non_empty(&p.aircraft_icao))
            .or_else(|| ac.and_then(|a| icao_from_atc_model(&a.atc_model)))
            .or(from_row.icao_type),
        registration: row
            .and_then(|r| opt(&r.user_registration))
            .or_else(|| row.and_then(|r| r.airframe_reg.as_deref().and_then(normalize_registration)))
            .or_else(|| resolve_registration(plan.map(|p| p.registration.as_str()), ac.map(|a| a.atc_id.as_str())))
            .or(from_row.registration),
        airline: ac.and_then(|a| non_empty(&a.atc_airline)).or_else(|| plan.and_then(|p| non_empty(&p.airline_icao))).or(from_row.airline),
    }
}

/// Status + flight + telemetry from the manager's snapshot (pure, see the tests).
pub(crate) fn build_snapshot(
    snap: &StatusSnapshot,
    flight_id: Option<String>,
    row: Option<&FlightRow>,
    plan: Option<&PlannedFlight>,
    airports: Option<&AirportIndex>,
    now: u64,
    version: &str,
) -> Snapshot {
    let t = snap.last_telemetry.as_ref();
    let status = api::Status {
        api_version: api::API_VERSION,
        app: "VectaSim".into(),
        version: version.to_owned(),
        provider: snap.provider.clone(),
        connection: snap.state.clone(),
        detail: privacy::mask_user_paths(&snap.detail),
        sim_name: snap.sim_name.clone(),
        sim_version: snap.sim_version.clone(),
        recording: snap.flight.as_ref().is_some_and(|f| f.state == FlightState::Active),
        streamer_mode: false,
        server_time_ms: now,
        lang: crate::lang::current(),
    };
    let flight = snap.flight.as_ref().map(|f| {
        let active = f.state == FlightState::Active;
        let near = |p: Option<vectasim_core::flight::GeoPoint>| Some(airports?.nearest(p?.latitude, p?.longitude, AIRPORT_SEARCH_NM)?.airport.ident);
        let departure = row
            .and_then(|r| opt(&r.user_dep_icao).or_else(|| opt(&r.dep_icao)).or_else(|| opt(&r.planned_dep)))
            .or_else(|| plan.and_then(|p| non_empty(&p.dep_icao)))
            .or_else(|| near(f.departure));
        let arrival = f.landing_ms.and_then(|_| row.and_then(|r| opt(&r.user_arr_icao).or_else(|| opt(&r.arr_icao))).or_else(|| near(f.arrival)));
        let destination = plan.and_then(|p| non_empty(&p.arr_icao)).or_else(|| row.and_then(|r| opt(&r.planned_arr))).or_else(|| arrival.clone());
        let callsign = callsign_of(snap, row, plan);
        let remaining_nm = match (f.landing_ms, t, destination.as_deref(), airports) {
            (None, Some(t), Some(d), Some(idx)) => idx.get(d).map(|a| vectasim_data::haversine_nm(t.latitude, t.longitude, a.latitude, a.longitude)),
            _ => None,
        };
        let eta_ms = match (remaining_nm, t) {
            (Some(rem), Some(t)) if t.ground_speed_kt >= ETA_MIN_GS_KT => Some(now + (rem / t.ground_speed_kt * 3_600_000.0) as u64),
            _ => None,
        };
        let current_kg = t.map(|t| t.fuel_total_kg).filter(|_| active).or(f.fuel_end_kg);
        Flight {
            id: flight_id,
            state: f.state,
            phase: f.phase,
            off_block_ms: f.off_block_ms,
            takeoff_ms: f.takeoff_ms,
            landing_ms: f.landing_ms,
            on_block_ms: f.on_block_ms,
            block_time_ms: f.block_time_ms().or_else(|| f.off_block_ms.filter(|_| active).map(|o| now.saturating_sub(o))),
            flight_time_ms: f.flight_time_ms().or_else(|| f.takeoff_ms.filter(|_| active).map(|o| now.saturating_sub(o))),
            departure,
            arrival,
            destination,
            callsign,
            aircraft: aircraft_of(snap, row, plan),
            distance_nm: f.distance_nm,
            max_altitude_ft: f.max_altitude_msl_ft,
            remaining_nm,
            eta_ms,
            fuel: Fuel {
                start_kg: f.fuel_start_kg,
                current_kg,
                used_kg: match (f.fuel_start_kg, current_kg) {
                    (Some(s), Some(c)) => Some((s - c).max(0.0)),
                    _ => None,
                },
                planned_ramp_kg: plan.map(|p| p.fuel_ramp_kg).or(row.and_then(|r| r.planned_fuel_ramp_kg)).filter(|v| *v > 0.0),
                planned_landing_kg: plan.map(|p| p.fuel_landing_kg).or(row.and_then(|r| r.planned_fuel_landing_kg)).filter(|v| *v > 0.0),
            },
            landing_rate_fpm: f.landing_rate_fpm,
            touchdowns: f.touchdowns.len() as u32,
        }
    });
    Snapshot { status, flight, telemetry: t.map(api::Telemetry::from) }
}

fn logbook_entry(r: &FlightRow) -> LogbookEntry {
    LogbookEntry {
        id: r.id.clone(),
        state: r.state.clone(),
        departure: opt(&r.user_dep_icao).or_else(|| opt(&r.dep_icao)).or_else(|| opt(&r.planned_dep)),
        arrival: opt(&r.user_arr_icao).or_else(|| opt(&r.arr_icao)).or_else(|| opt(&r.planned_arr)),
        off_block_ms: r.off_block_ms,
        on_block_ms: r.on_block_ms,
        block_time_ms: match (r.off_block_ms, r.on_block_ms) {
            (Some(a), Some(b)) => Some(b.saturating_sub(a)),
            _ => None,
        },
        distance_nm: r.distance_nm,
        callsign: opt(&r.user_callsign).or_else(|| opt(&r.callsign)),
        aircraft: aircraft_of_row(r),
        landing_rate_fpm: r.landing_vs_fpm,
        landings: r.landing_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vectasim_core::flight::GeoPoint;
    use vectasim_core::{AircraftInfo, FlightPhase, FlightSummary, Telemetry};

    fn snap() -> StatusSnapshot {
        StatusSnapshot {
            provider: "simconnect".into(),
            state: "connected".into(),
            detail: r"SimConnect.dll aus C:\Users\Max\AppData\Local\VectaSim".into(),
            sim_name: Some("MSFS 2024".into()),
            aircraft: Some(AircraftInfo {
                title: "Airbus A320neo Lufthansa".into(),
                atc_model: "TT:ATCCOM.AC_MODEL_A20N.0.text".into(),
                atc_id: "D-AINA".into(),
                atc_airline: "Lufthansa".into(),
                atc_flight_number: "4YA".into(),
                ..Default::default()
            }),
            last_telemetry: Some(Telemetry { latitude: 50.0, longitude: 8.0, ground_speed_kt: 400.0, fuel_total_kg: 6000.0, ..Default::default() }),
            flight: Some(FlightSummary {
                state: FlightState::Active,
                phase: FlightPhase::Cruise,
                off_block_ms: Some(1_000),
                takeoff_ms: Some(601_000),
                departure: Some(GeoPoint { latitude: 50.03, longitude: 8.55 }),
                fuel_start_kg: Some(9000.0),
                distance_nm: 120.0,
                ..Default::default()
            }),
            frames: 10,
            ..Default::default()
        }
    }

    #[test]
    fn snapshot_like_the_side_panel() {
        let plan = PlannedFlight { callsign: "DLH4YA".into(), dep_icao: "EDDF".into(), arr_icao: "EGLL".into(), fuel_ramp_kg: 9100.0, ..Default::default() };
        let s = build_snapshot(&snap(), Some("f-1".into()), None, Some(&plan), None, 3_601_000, "0.3.0");
        assert_eq!(s.status.detail, r"SimConnect.dll aus %LOCALAPPDATA%\VectaSim", "paths never leave with the user name");
        assert!(s.status.recording);
        let f = s.flight.unwrap();
        assert_eq!((f.departure.as_deref(), f.destination.as_deref(), f.arrival), (Some("EDDF"), Some("EGLL"), None));
        assert_eq!(f.callsign.as_deref(), Some("DLH4YA"));
        assert_eq!(f.aircraft.icao_type.as_deref(), Some("A20N"));
        assert_eq!(f.aircraft.registration.as_deref(), Some("D-AINA"));
        assert_eq!(f.block_time_ms, Some(3_600_000), "running block time");
        assert_eq!(f.flight_time_ms, Some(3_000_000));
        assert_eq!((f.fuel.current_kg, f.fuel.used_kg, f.fuel.planned_ramp_kg), (Some(6000.0), Some(3000.0), Some(9100.0)));
        // no airport index here: no remaining distance
        assert_eq!(f.remaining_nm, None);
        assert_eq!(s.telemetry.unwrap().ground_speed_kt, 400.0);
    }

    #[test]
    fn without_plan_the_sim_names_the_callsign() {
        let s = build_snapshot(&snap(), None, None, None, None, 0, "0.3.0");
        let f = s.flight.unwrap();
        assert_eq!(f.callsign.as_deref(), Some("Lufthansa4YA"));
        assert_eq!(f.departure, None);
    }

    #[test]
    fn row_corrections_win() {
        let row = FlightRow {
            id: "f-1".into(),
            state: "active".into(),
            user_dep_icao: Some("EDDM".into()),
            user_callsign: Some("EWG1".into()),
            user_registration: Some("D-AEWA".into()),
            ..Default::default()
        };
        let f = build_snapshot(&snap(), Some("f-1".into()), Some(&row), None, None, 0, "0.3.0").flight.unwrap();
        assert_eq!((f.departure.as_deref(), f.callsign.as_deref(), f.aircraft.registration.as_deref()), (Some("EDDM"), Some("EWG1"), Some("D-AEWA")));
    }

    #[test]
    fn settings_parsing() {
        assert_eq!(parse_port(None), DEFAULT_PORT);
        assert_eq!(parse_port(Some("9000")), 9000);
        assert_eq!(parse_port(Some("80")), DEFAULT_PORT);
        assert_eq!(parse_port(Some("x")), DEFAULT_PORT);
        assert!(check_port(1023).is_err());
        assert_eq!(check_port(8095), Ok(8095));
        let store = Store::open_in_memory().unwrap();
        let s = load(&store);
        assert!(!s.enabled && !s.lan);
        assert_eq!(s.port, DEFAULT_PORT);
        assert!(auth::valid_token(&s.token));
        assert_eq!(load(&store).token, s.token, "the token is kept");
    }

    #[test]
    fn logbook_rows() {
        let row = FlightRow {
            id: "f-9".into(),
            state: "completed".into(),
            dep_icao: Some("EDDF".into()),
            planned_arr: Some("EGLL".into()),
            off_block_ms: Some(1_000),
            on_block_ms: Some(7_201_000),
            landing_vs_fpm: Some(-140.0),
            landing_count: 1,
            ..Default::default()
        };
        let e = logbook_entry(&row);
        assert_eq!((e.departure.as_deref(), e.arrival.as_deref(), e.block_time_ms), (Some("EDDF"), Some("EGLL"), Some(7_200_000)));
    }
}
