//! Discord Rich Presence (Settings → Integrations, opt-in: setting `discord_presence` = "1").
//!
//! A thread of its own looks at the manager's status every [`TICK`]: with the setting off it
//! clears the activity and closes the pipe; with it on it connects to the local Discord client
//! (not running → quiet, the next try [`RECONNECT_EVERY`] later) and sets the activity built by
//! [`presence_for`] – route and type as details, the phase as state, off-block as start time.
//! The activity is sent only when it changed and at most every [`MIN_UPDATE`] (Discord's own
//! limit is 5 updates per 20 s). After a completed flight "Gelandet · −155 fpm" stays for
//! [`LANDED_FOR`], then the idle text. Streamer-Modus (`privacy_mode`): no callsign.
//!
//! Discord needs an application id with uploaded art assets (key `vectasim`): the built-in
//! [`DISCORD_APP_ID`], or the user's own one from setting `discord_app_id`.

use crate::lang::Lang;
use crate::manager::{ProviderManager, StatusSnapshot};
use discord_rich_presence::activity::{Activity, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use vectasim_core::{FlightPhase, FlightState};
use vectasim_data::AirportIndex;
use vectasim_store::{PlannedFlight, Store};

pub const SETTING_DISCORD: &str = "discord_presence";
/// The user's own Discord application id (Developer Portal → Applications); empty = built-in.
pub const SETTING_DISCORD_APP_ID: &str = "discord_app_id";
/// Id of the VectaSim application in the Discord Developer Portal (art asset `vectasim` under
/// Rich Presence → Art Assets). A public identifier, not a secret: it only tells the user's own
/// Discord client which application name and images to show. Setting `discord_app_id`
/// overrides it for people who run their own application.
pub const DISCORD_APP_ID: &str = "1561395013965844671";
/// Art asset key shown next to the activity.
const ASSET_KEY: &str = "vectasim";

const TICK: Duration = Duration::from_secs(5);
const RECONNECT_EVERY: Duration = Duration::from_secs(30);
const MIN_UPDATE: Duration = Duration::from_secs(15);
const LANDED_FOR: Duration = Duration::from_secs(60);
/// Departure airport looked up around the off-block position.
const DEP_SEARCH_NM: f64 = 5.0;

/// What Settings → Integrations shows.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    /// off | no_app_id | not_running | connected
    pub state: String,
    /// Text currently shown in Discord (details · state), when connected.
    pub showing: Option<String>,
}

#[derive(Default)]
pub struct DiscordState(Mutex<DiscordStatus>);

impl DiscordState {
    pub fn status(&self) -> DiscordStatus {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, s: DiscordStatus) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = s;
    }
}

/// One activity as sent to Discord.
#[derive(Clone, Debug, PartialEq)]
pub struct Presence {
    pub details: String,
    pub state: String,
    /// Unix ms (off-block).
    pub start_ms: Option<u64>,
}

/// Everything [`presence_for`] needs, gathered from manager, plan and airport index.
#[derive(Clone, Debug, Default)]
pub struct PresenceInput {
    pub provider: String,
    pub connection: String,
    pub flight_state: FlightState,
    pub phase: FlightPhase,
    pub off_block_ms: Option<u64>,
    pub dep: Option<String>,
    pub arr: Option<String>,
    pub aircraft_type: Option<String>,
    pub callsign: Option<String>,
    pub altitude_ft: Option<f64>,
    /// Great circle to the destination.
    pub to_go_nm: Option<f64>,
    pub privacy: bool,
    /// "Gelandet · −155 fpm" while this is set.
    pub landed_fpm: Option<f64>,
    /// Language of the texts (backend language).
    pub lang: Lang,
}

fn is_demo(provider: &str) -> bool {
    provider == "mock" || provider == "replay" || provider.starts_with("replay:")
}

fn level(ft: f64) -> String {
    if ft >= 10_000.0 { format!("FL{:03.0}", (ft / 100.0).round()) } else { format!("{:.0} ft", (ft / 100.0).round() * 100.0) }
}

/// Signed like the UI: real minus sign in German, hyphen in English.
fn fpm(lang: Lang, v: f64) -> String {
    let n = v.round();
    let minus = lang.tr("\u{2212}", "-");
    if n < 0.0 { format!("{minus}{:.0} fpm", -n) } else { format!("{n:.0} fpm") }
}

fn route(i: &PresenceInput) -> String {
    let dep = i.dep.as_deref().unwrap_or("····");
    let mut parts = Vec::new();
    if !i.privacy
        && let Some(cs) = i.callsign.as_deref().filter(|c| !c.is_empty())
    {
        parts.push(cs.to_owned());
    }
    parts.push(match i.arr.as_deref() {
        Some(arr) => format!("{dep} \u{2192} {arr}"),
        None => format!("{} {dep}", i.lang.tr("ab", "from")),
    });
    if let Some(t) = i.aircraft_type.as_deref().filter(|t| !t.is_empty()) {
        parts.push(t.to_owned());
    }
    parts.join(" · ")
}

fn phase_text(i: &PresenceInput) -> String {
    let arr = i.arr.as_deref();
    let at = |what: &str| match arr {
        Some(a) => format!("{what} {a}"),
        None => what.to_owned(),
    };
    let l = i.lang;
    let to_go = i
        .to_go_nm
        .filter(|d| *d >= 1.0)
        .map(|d| match l {
            Lang::De => format!(" · noch {d:.0} nm"),
            Lang::En => format!(" · {d:.0} nm to go"),
        })
        .unwrap_or_default();
    let alt = i.altitude_ft.map(|a| format!(" {}", level(a))).unwrap_or_default();
    // German: descriptive phrases as before; English: the UI's (English) phase names
    match i.phase {
        FlightPhase::Preflight => l.tr("Vorbereitung am Gate", "Preflight at the gate").into(),
        FlightPhase::Pushback => "Pushback".into(),
        FlightPhase::TaxiOut => l.tr("Rollen zum Start", "Taxi out").into(),
        FlightPhase::Takeoff => l.tr("Start", "Takeoff").into(),
        FlightPhase::Climb => format!("{}{alt}", l.tr("Steigflug", "Climb")),
        FlightPhase::Cruise => format!("{}{alt}{to_go}", l.tr("Reiseflug", "Cruise")),
        FlightPhase::Descent => format!("{}{alt}{to_go}", l.tr("Sinkflug", "Descent")),
        FlightPhase::Approach | FlightPhase::Final => at(l.tr("Anflug", "Approach")),
        FlightPhase::Landing => at(l.tr("Landung", "Landing")),
        FlightPhase::TaxiIn => at(l.tr("Rollen zum Gate", "Taxi in")),
        FlightPhase::Shutdown => at(l.tr("Am Gate", "At the gate")),
    }
}

/// The activity for the current state (pure; see the module doc).
pub fn presence_for(i: &PresenceInput) -> Presence {
    let demo = is_demo(&i.provider);
    let l = i.lang;
    if let Some(v) = i.landed_fpm {
        let details = if demo { "Demo".to_owned() } else { route(i) };
        return Presence { details, state: format!("{} · {}", l.tr("Gelandet", "Landed"), fpm(l, v)), start_ms: None };
    }
    if i.flight_state == FlightState::Active {
        return if demo {
            Presence { details: "Demo".into(), state: format!("{} · {}", l.tr("Demo-Flug", "Demo flight"), phase_text(i)), start_ms: i.off_block_ms }
        } else {
            Presence { details: route(i), state: phase_text(i), start_ms: i.off_block_ms }
        };
    }
    if demo {
        return Presence { details: "Demo".into(), state: l.tr("Demo-Flug bereit", "Demo flight ready").into(), start_ms: None };
    }
    let state = if i.connection == "connected" {
        l.tr("Bereit – Aufzeichnung startet mit Off-Block", "Ready – recording starts at off-block")
    } else {
        l.tr("Bereit – wartet auf MSFS", "Ready – waiting for MSFS")
    };
    Presence { details: "VectaSim".into(), state: state.into(), start_ms: None }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_owned())
}

/// Gather [`PresenceInput`] from the status snapshot, the dispatch plan and the airport index.
pub fn input_from(snap: &StatusSnapshot, plan: Option<&PlannedFlight>, airports: Option<&AirportIndex>, privacy: bool) -> PresenceInput {
    let flight = snap.flight.as_ref();
    let t = snap.last_telemetry.as_ref();
    let ac = snap.aircraft.as_ref();
    let dep = plan.and_then(|p| non_empty(&p.dep_icao)).or_else(|| {
        let d = flight?.departure?;
        Some(airports?.nearest(d.latitude, d.longitude, DEP_SEARCH_NM)?.airport.ident)
    });
    let arr = plan.and_then(|p| non_empty(&p.arr_icao));
    let to_go_nm = match (&arr, t, airports) {
        (Some(a), Some(t), Some(idx)) => {
            idx.get(a).map(|ap| vectasim_data::haversine_nm(t.latitude, t.longitude, ap.latitude, ap.longitude))
        }
        _ => None,
    };
    let aircraft_type = plan
        .and_then(|p| non_empty(&p.aircraft_icao))
        .or_else(|| ac.and_then(|a| vectasim_store::airframe::icao_from_atc_model(&a.atc_model)));
    let callsign = plan.and_then(|p| non_empty(&p.callsign)).or_else(|| {
        let a = ac?;
        non_empty(&format!("{}{}", a.atc_airline.trim(), a.atc_flight_number.trim())).filter(|_| !a.atc_flight_number.trim().is_empty())
    });
    PresenceInput {
        provider: snap.provider.clone(),
        connection: snap.state.clone(),
        flight_state: flight.map(|f| f.state).unwrap_or_default(),
        phase: flight.map(|f| f.phase).unwrap_or_default(),
        off_block_ms: flight.and_then(|f| f.off_block_ms),
        dep,
        arr,
        aircraft_type,
        callsign,
        altitude_ft: t.map(|t| t.altitude_msl_ft),
        to_go_nm,
        privacy,
        landed_fpm: None,
        lang: crate::lang::current(),
    }
}

fn app_id(store: &Store) -> Option<String> {
    store.get_setting(SETTING_DISCORD_APP_ID).ok().flatten().and_then(|s| non_empty(&s)).or_else(|| non_empty(DISCORD_APP_ID))
}

fn enabled(store: &Store) -> bool {
    store.get_setting(SETTING_DISCORD).ok().flatten().as_deref() == Some("1")
}

struct Link {
    client: DiscordIpcClient,
    app_id: String,
    sent: Option<Presence>,
    sent_at: Instant,
}

/// Starts the presence thread (once, from `setup`).
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("discord-presence".into()).spawn(move || run(app));
    if let Err(e) = spawned {
        log::error!("discord presence thread not started: {e}");
    }
}

fn run(app: AppHandle) {
    let mut link: Option<Link> = None;
    let mut last_try: Option<Instant> = None;
    let mut tried_id = String::new();
    let mut prev_state = FlightState::Idle;
    let mut landed: Option<(f64, Instant)> = None;
    loop {
        std::thread::sleep(TICK);
        let Some(store) = app.try_state::<Store>().map(|s| s.inner().clone()) else { continue };
        let state = app.state::<DiscordState>();
        let manager = app.state::<ProviderManager>();
        let snap = manager.snapshot();

        // flight just completed: "Gelandet" for a minute (followed even while presence is off)
        let now_state = snap.flight.as_ref().map(|f| f.state).unwrap_or_default();
        if prev_state == FlightState::Active && now_state == FlightState::Completed {
            landed = snap.flight.as_ref().and_then(|f| f.landing_rate_fpm).map(|v| (v, Instant::now()));
        }
        if now_state == FlightState::Active || landed.is_some_and(|(_, at)| at.elapsed() >= LANDED_FOR) {
            landed = None;
        }
        prev_state = now_state;

        if !enabled(&store) {
            if let Some(mut l) = link.take() {
                let _ = l.client.clear_activity();
                let _ = l.client.close();
                log::info!("discord presence off");
            }
            state.set(DiscordStatus { state: "off".into(), showing: None });
            continue;
        }
        let Some(id) = app_id(&store) else {
            link = None;
            state.set(DiscordStatus { state: "no_app_id".into(), showing: None });
            continue;
        };
        if link.as_ref().is_some_and(|l| l.app_id != id) {
            if let Some(mut l) = link.take() {
                let _ = l.client.close();
            }
            last_try = None;
        }
        if link.is_none() {
            if last_try.is_some_and(|t| t.elapsed() < RECONNECT_EVERY) && tried_id == id {
                continue;
            }
            last_try = Some(Instant::now());
            tried_id = id.clone();
            let mut client = DiscordIpcClient::new(&id);
            match client.connect() {
                Ok(()) => {
                    log::info!("discord presence connected");
                    link = Some(Link { client, app_id: id, sent: None, sent_at: Instant::now() - MIN_UPDATE });
                }
                Err(e) => {
                    // Discord not running is the normal case: debug only
                    log::debug!("discord not reachable: {e}");
                    state.set(DiscordStatus { state: "not_running".into(), showing: None });
                    continue;
                }
            }
        }
        let Some(l) = link.as_mut() else { continue };

        let plan = manager.planned.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let airports = app.try_state::<Arc<AirportIndex>>().map(|a| a.inner().clone());
        let mut input = input_from(&snap, plan.as_ref(), airports.as_deref(), crate::privacy::privacy_mode_on(&store));
        input.landed_fpm = landed.map(|(v, _)| v);
        let p = presence_for(&input);
        if l.sent.as_ref() == Some(&p) || l.sent_at.elapsed() < MIN_UPDATE {
            state
                .set(DiscordStatus {
                    state: "connected".into(), showing: l.sent.as_ref().map(|s| format!("{} · {}", s.details, s.state))
                });
            continue;
        }
        let mut activity = Activity::new()
            .details(p.details.as_str())
            .state(p.state.as_str())
            .assets(Assets::new().large_image(ASSET_KEY).large_text("VectaSim"));
        if let Some(ms) = p.start_ms {
            activity = activity.timestamps(Timestamps::new().start(ms as i64));
        }
        match l.client.set_activity(activity) {
            Ok(()) => {
                l.sent_at = Instant::now();
                state.set(DiscordStatus { state: "connected".into(), showing: Some(format!("{} · {}", p.details, p.state)) });
                l.sent = Some(p);
            }
            Err(e) => {
                // Discord closed: back to quiet retries
                log::info!("discord presence lost: {e}");
                link = None;
                last_try = Some(Instant::now());
                state.set(DiscordStatus { state: "not_running".into(), showing: None });
            }
        }
    }
}

/// Settings → Integrations → Discord.
#[tauri::command]
pub fn discord_status(state: tauri::State<'_, DiscordState>) -> DiscordStatus {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cruise() -> PresenceInput {
        PresenceInput {
            provider: "simconnect".into(),
            connection: "connected".into(),
            flight_state: FlightState::Active,
            phase: FlightPhase::Cruise,
            off_block_ms: Some(1_700_000_000_000),
            dep: Some("EDDF".into()),
            arr: Some("EGLL".into()),
            aircraft_type: Some("A20N".into()),
            callsign: Some("DLH4YA".into()),
            altitude_ft: Some(36_010.0),
            to_go_nm: Some(420.4),
            privacy: false,
            landed_fpm: None,
            lang: Lang::De,
        }
    }

    #[test]
    fn cruise_shows_route_level_and_distance() {
        let p = presence_for(&cruise());
        assert_eq!(p.details, "DLH4YA · EDDF → EGLL · A20N");
        assert_eq!(p.state, "Reiseflug FL360 · noch 420 nm");
        assert_eq!(p.start_ms, Some(1_700_000_000_000));
    }

    #[test]
    fn english_texts() {
        let en = |i: PresenceInput| presence_for(&PresenceInput { lang: Lang::En, ..i });
        assert_eq!(en(cruise()).state, "Cruise FL360 · 420 nm to go");
        assert_eq!(en(PresenceInput { phase: FlightPhase::TaxiIn, ..cruise() }).state, "Taxi in EGLL");
        assert_eq!(en(PresenceInput { landed_fpm: Some(-155.4), ..cruise() }).state, "Landed · -155 fpm");
        assert_eq!(en(PresenceInput { connection: "connecting".into(), ..Default::default() }).state, "Ready – waiting for MSFS");
        assert_eq!(en(PresenceInput { arr: None, ..cruise() }).details, "DLH4YA · from EDDF · A20N");
    }

    #[test]
    fn streamer_mode_drops_the_callsign() {
        let p = presence_for(&PresenceInput { privacy: true, ..cruise() });
        assert_eq!(p.details, "EDDF → EGLL · A20N");
    }

    #[test]
    fn phases_and_idle() {
        assert_eq!(presence_for(&PresenceInput { phase: FlightPhase::Approach, ..cruise() }).state, "Anflug EGLL");
        assert_eq!(
            presence_for(&PresenceInput { phase: FlightPhase::Climb, altitude_ft: Some(5_040.0), ..cruise() }).state,
            "Steigflug 5000 ft"
        );
        let idle = presence_for(&PresenceInput { connection: "connecting".into(), ..Default::default() });
        assert_eq!(idle.state, "Bereit – wartet auf MSFS");
        assert_eq!(idle.start_ms, None);
    }

    #[test]
    fn landed_and_demo() {
        let p = presence_for(&PresenceInput { landed_fpm: Some(-155.4), flight_state: FlightState::Completed, ..cruise() });
        assert_eq!(p.state, "Gelandet · −155 fpm");
        let d = presence_for(&PresenceInput { provider: "mock".into(), ..cruise() });
        assert_eq!(d.details, "Demo");
        assert!(d.state.starts_with("Demo-Flug"), "{}", d.state);
        assert!(!d.state.contains("DLH"));
    }

    #[test]
    fn input_without_plan_uses_the_aircraft() {
        let snap = StatusSnapshot {
            provider: "simconnect".into(),
            state: "connected".into(),
            aircraft: Some(vectasim_core::AircraftInfo {
                atc_model: "TT:ATCCOM.AC_MODEL_A20N.0.text".into(),
                atc_airline: "DLH".into(),
                atc_flight_number: "4YA".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let i = input_from(&snap, None, None, false);
        assert_eq!(i.aircraft_type.as_deref(), Some("A20N"));
        assert_eq!(i.callsign.as_deref(), Some("DLH4YA"));
        assert_eq!(i.dep, None);
    }
}
