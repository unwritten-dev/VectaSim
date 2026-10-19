//! IVAO Whazzup v2: parser into the shared model (the poller is `feed.rs`).
//!
//! Source: <https://api.ivao.aero/v2/tracker/whazzup> – public JSON, no login and no API key.
//! IVAO's rules for it (wiki.ivao.aero → DevOps → API → "How to retrieve Whazzup v2 Files?",
//! <https://wiki.ivao.aero/en/home/devops/api/whazuup/how-to-retrieve-v2>, read 2026-10-18):
//!
//! > The whazzup file may only be downloaded once every 15 seconds, which means 4 times during
//! > one minute. Using a more frequent download rate will result in an IP ban. You don't have to
//! > obtain an additional clearance to use the public files.
//!
//! [`crate::feed::MIN_POLL_INTERVAL`] (15 s, kept across stop/start, longer on errors) enforces
//! exactly that. The file format page also warns: "Never rely on the fact that a line has X
//! fields … IVAO can extend the number of fields at any time" – hence every field below is
//! optional or defaulted, and `null` is accepted everywhere.
//!
//! Field mapping (checked against a live download on 2026-10-18, ~800 pilots, ~110 ATC):
//! * pilots[]: `userId` → cid, `callsign`, `lastTrack.{latitude, longitude, altitude,
//!   groundSpeed, heading, onGround, transponder}`, `flightPlan.{aircraftId (else
//!   aircraft.icaoCode), departureId, arrivalId, route, flightRules, remarks, level, aircraft.model}`, `createdAt` → logon time (no names in
//!   the public file, only the VID). Pilots without
//!   `lastTrack` have no position yet and are skipped.
//! * atcs[]: `userId`, `callsign`, `atcSession.frequency` (number, MHz) → "118.100",
//!   `atcSession.position` (DEL/GND/TWR/APP/DEP/CTR/FSS; missing → callsign suffix),
//!   `atis.lines` → text, `atis.revision` → ATIS letter of airport positions. IVAO has no
//!   separate ATIS stations: every position carries its own ATIS.
//! * observers[] and followMe[] are ignored; there are no prefiles in the public file.

use serde::{Deserialize, Deserializer};

use crate::model::{Controller, Facility, Network, OnlineSnapshot, Pilot};
use crate::{OnlineError, now_ms};

pub const DATA_URL: &str = "https://api.ivao.aero/v2/tracker/whazzup";

/// `null` → default, so a field IVAO sends as null cannot fail the whole file.
fn nullable<'de, D: Deserializer<'de>, T: Default + Deserialize<'de>>(d: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawWhazzup {
    #[serde(deserialize_with = "nullable")]
    updated_at: String,
    #[serde(deserialize_with = "nullable")]
    clients: RawClients,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawClients {
    #[serde(deserialize_with = "nullable")]
    pilots: Vec<RawPilot>,
    #[serde(deserialize_with = "nullable")]
    atcs: Vec<RawAtc>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawPilot {
    #[serde(deserialize_with = "nullable")]
    user_id: u64,
    #[serde(deserialize_with = "nullable")]
    callsign: String,
    #[serde(deserialize_with = "nullable")]
    created_at: String,
    last_track: Option<RawTrack>,
    flight_plan: Option<RawFlightPlan>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawTrack {
    latitude: Option<f64>,
    longitude: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    altitude: f64,
    #[serde(deserialize_with = "nullable")]
    ground_speed: f64,
    #[serde(deserialize_with = "nullable")]
    heading: f64,
    on_ground: Option<bool>,
    transponder: Option<f64>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawFlightPlan {
    #[serde(deserialize_with = "nullable")]
    aircraft_id: String,
    #[serde(deserialize_with = "nullable")]
    departure_id: String,
    #[serde(deserialize_with = "nullable")]
    arrival_id: String,
    #[serde(deserialize_with = "nullable")]
    route: String,
    #[serde(deserialize_with = "nullable")]
    flight_rules: String,
    #[serde(deserialize_with = "nullable")]
    remarks: String,
    #[serde(deserialize_with = "nullable")]
    level: String,
    aircraft: Option<RawAircraft>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawAircraft {
    #[serde(deserialize_with = "nullable")]
    icao_code: String,
    #[serde(deserialize_with = "nullable")]
    model: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawAtc {
    #[serde(deserialize_with = "nullable")]
    user_id: u64,
    #[serde(deserialize_with = "nullable")]
    callsign: String,
    atc_session: Option<RawAtcSession>,
    atis: Option<RawAtis>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawAtcSession {
    frequency: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    position: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawAtis {
    #[serde(deserialize_with = "nullable")]
    lines: Vec<String>,
    #[serde(deserialize_with = "nullable")]
    revision: String,
}

/// IVAO position code (or the callsign suffix) → facility; unknown codes are not placed.
fn facility_of(position: &str, callsign: &str) -> Option<Facility> {
    let code = |s: &str| -> Option<Facility> {
        Some(match s.to_ascii_uppercase().as_str() {
            "DEL" => Facility::Del,
            "GND" => Facility::Gnd,
            "TWR" => Facility::Twr,
            "APP" | "DEP" => Facility::App,
            "CTR" => Facility::Ctr,
            "FSS" => Facility::Fss,
            _ => return None,
        })
    };
    code(position).or_else(|| callsign.rsplit('_').next().and_then(code))
}

/// The first ATIS line is the voice room ("ts-1.eu-west-2.ivao.aero/EDDF_TWR" or
/// "NO VOICE/EDDF_TWR"), not text for the pilot.
fn atis_text(lines: Vec<String>, callsign: &str) -> Vec<String> {
    lines
        .into_iter()
        .enumerate()
        .filter(|(i, l)| !(*i == 0 && l.ends_with(&format!("/{callsign}"))))
        .map(|(_, l)| l)
        .filter(|l| !l.trim().is_empty())
        .collect()
}

/// Parse a Whazzup v2 file into a snapshot (fetch time set to now).
pub fn parse_ivao_json(bytes: &[u8]) -> Result<OnlineSnapshot, OnlineError> {
    let raw: RawWhazzup = serde_json::from_slice(bytes).map_err(|e| OnlineError::Parse(e.to_string()))?;
    let pilots = raw
        .clients
        .pilots
        .into_iter()
        .filter_map(|p| {
            let t = p.last_track?;
            let (latitude, longitude) = (t.latitude?, t.longitude?);
            let fp = p.flight_plan.unwrap_or_default();
            let (icao_code, aircraft_model) = fp.aircraft.map(|a| (a.icao_code, a.model.trim().to_string())).unwrap_or_default();
            let aircraft_short = if fp.aircraft_id.is_empty() { icao_code } else { fp.aircraft_id };
            Some(Pilot {
                network: Network::Ivao,
                cid: p.user_id,
                callsign: p.callsign,
                latitude,
                longitude,
                altitude_ft: t.altitude.round() as i32,
                ground_speed_kt: t.ground_speed.round() as i32,
                heading_deg: t.heading.round() as i32,
                transponder: t.transponder.map(|x| format!("{:04}", x.max(0.0) as u32)).unwrap_or_default(),
                aircraft_short,
                departure: fp.departure_id,
                arrival: fp.arrival_id,
                route: fp.route,
                flight_rules: fp.flight_rules,
                on_ground: t.on_ground,
                // the public Whazzup has no names, only the VID
                name: String::new(),
                logon_time: p.created_at,
                planned_altitude: fp.level.trim().to_string(),
                remarks: fp.remarks.trim().to_string(),
                aircraft_model,
            })
        })
        .collect();
    let controllers = raw
        .clients
        .atcs
        .into_iter()
        .filter_map(|a| {
            let session = a.atc_session.unwrap_or_default();
            let frequency = session.frequency.filter(|f| *f > 0.0)?;
            let facility = facility_of(&session.position, &a.callsign)?;
            let atis = a.atis.unwrap_or_default();
            let atis_code = (!facility.is_enroute())
                .then(|| atis.revision.trim().to_string())
                .filter(|r| r.len() == 1 && r.chars().all(|c| c.is_ascii_alphabetic()));
            Some(Controller {
                network: Network::Ivao,
                cid: a.user_id,
                text_atis: atis_text(atis.lines, &a.callsign),
                callsign: a.callsign,
                frequency: format!("{frequency:.3}"),
                facility,
                visual_range_nm: 0,
                atis_code,
            })
        })
        .collect();
    Ok(OnlineSnapshot {
        network: Network::Ivao,
        update_timestamp: raw.updated_at,
        fetched_ms: now_ms(),
        pilots,
        controllers,
        prefiles: Vec::new(),
    })
}
