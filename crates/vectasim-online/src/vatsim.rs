//! VATSIM v3 data feed: parser and data-URL discovery (the poller is `feed.rs`).
//!
//! The data file (~5 MB, a few MB less with gzip) lists every connected pilot,
//! controller, ATIS and prefile. We keep only the fields the map needs and
//! drop observers and controllers that are not on a frequency, so a snapshot
//! stays well under a megabyte in memory. VATSIM regenerates it every 15 s.

use serde::Deserialize;

use crate::feed::Inner;
use crate::model::{Controller, Facility, Network, OnlineSnapshot, Pilot, Prefile};
use crate::{OnlineError, now_ms};

const STATUS_URL: &str = "https://status.vatsim.net/status.json";
const DEFAULT_DATA_URL: &str = "https://data.vatsim.net/v3/vatsim-data.json";
/// VATSIM's placeholder frequency for controllers who are logged in but not on a position.
const NO_FREQUENCY: &str = "199.998";

fn facility_from_code(code: i64) -> Option<Facility> {
    Some(match code {
        1 => Facility::Fss,
        2 => Facility::Del,
        3 => Facility::Gnd,
        4 => Facility::Twr,
        5 => Facility::App,
        6 => Facility::Ctr,
        _ => return None, // 0 = observer
    })
}

// ---- raw v3 shapes --------------------------------------------------------------------
// Everything defaulted: VATSIM adds fields freely and leaves flight plans null.

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawData {
    general: RawGeneral,
    pilots: Vec<RawPilot>,
    controllers: Vec<RawController>,
    atis: Vec<RawController>,
    prefiles: Vec<RawPrefile>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawGeneral {
    update_timestamp: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPilot {
    cid: u64,
    name: String,
    callsign: String,
    logon_time: String,
    latitude: f64,
    longitude: f64,
    altitude: f64,
    groundspeed: f64,
    heading: f64,
    transponder: String,
    flight_plan: Option<RawFlightPlan>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawFlightPlan {
    flight_rules: String,
    aircraft_short: String,
    departure: String,
    arrival: String,
    route: String,
    altitude: String,
    remarks: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawController {
    cid: u64,
    callsign: String,
    frequency: String,
    facility: i64,
    visual_range: f64,
    text_atis: Option<Vec<String>>,
    atis_code: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPrefile {
    cid: u64,
    callsign: String,
    flight_plan: Option<RawFlightPlan>,
}

fn controller_from_raw(c: RawController, is_atis: bool) -> Option<Controller> {
    let facility = if is_atis { Facility::Atis } else { facility_from_code(c.facility)? };
    if c.frequency.is_empty() || c.frequency == NO_FREQUENCY {
        return None;
    }
    Some(Controller {
        network: Network::Vatsim,
        cid: c.cid,
        callsign: c.callsign,
        frequency: c.frequency,
        facility,
        visual_range_nm: c.visual_range.max(0.0) as u32,
        text_atis: c.text_atis.unwrap_or_default(),
        atis_code: c.atis_code.filter(|s| !s.is_empty()),
    })
}

/// Parse a v3 data file into a snapshot (fetch time set to now).
pub fn parse_vatsim_json(bytes: &[u8]) -> Result<OnlineSnapshot, OnlineError> {
    let raw: RawData = serde_json::from_slice(bytes).map_err(|e| OnlineError::Parse(e.to_string()))?;
    let pilots = raw
        .pilots
        .into_iter()
        .map(|p| {
            let fp = p.flight_plan.unwrap_or_default();
            Pilot {
                network: Network::Vatsim,
                cid: p.cid,
                callsign: p.callsign,
                latitude: p.latitude,
                longitude: p.longitude,
                altitude_ft: p.altitude.round() as i32,
                ground_speed_kt: p.groundspeed.round() as i32,
                heading_deg: p.heading.round() as i32,
                transponder: p.transponder,
                aircraft_short: fp.aircraft_short,
                departure: fp.departure,
                arrival: fp.arrival,
                route: fp.route,
                flight_rules: fp.flight_rules,
                on_ground: None,
                name: p.name.trim().to_string(),
                logon_time: p.logon_time,
                planned_altitude: fp.altitude.trim().to_string(),
                remarks: fp.remarks.trim().to_string(),
                aircraft_model: String::new(),
            }
        })
        .collect();
    let controllers = raw
        .controllers
        .into_iter()
        .filter_map(|c| controller_from_raw(c, false))
        .chain(raw.atis.into_iter().filter_map(|c| controller_from_raw(c, true)))
        .collect();
    let prefiles = raw
        .prefiles
        .into_iter()
        .map(|p| {
            let fp = p.flight_plan.unwrap_or_default();
            Prefile { cid: p.cid, callsign: p.callsign, aircraft_short: fp.aircraft_short, departure: fp.departure, arrival: fp.arrival }
        })
        .collect();
    Ok(OnlineSnapshot { network: Network::Vatsim, update_timestamp: raw.general.update_timestamp, fetched_ms: now_ms(), pilots, controllers, prefiles })
}

/// The data URL from status.json (VATSIM's documented discovery), cached; the
/// well-known URL if discovery fails so an outage of the status host is harmless.
pub(crate) async fn data_url(inner: &Inner) -> String {
    if let Some(u) = inner.data_url.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return u;
    }
    #[derive(Deserialize)]
    struct Status {
        data: StatusData,
    }
    #[derive(Deserialize)]
    struct StatusData {
        v3: Vec<String>,
    }
    let discovered = async {
        let resp = inner.client.get(STATUS_URL).send().await.ok()?;
        let body = crate::read_limited(resp, crate::MAX_SMALL_BYTES).await.ok()?;
        let s: Status = serde_json::from_slice(&body).ok()?;
        s.data.v3.into_iter().find(|u| u.starts_with("https://"))
    }
    .await;
    let url = discovered.unwrap_or_else(|| DEFAULT_DATA_URL.to_string());
    *inner.data_url.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.clone());
    url
}
