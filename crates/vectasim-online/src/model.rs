//! The network-neutral model both feeds (VATSIM, IVAO) parse into, and the queries the map runs
//! on a snapshot. Every pilot and controller carries its [`Network`], so the UI can show both
//! networks side by side and say where an entry comes from.

use serde::{Deserialize, Serialize};

/// Which online network an entry or feed belongs to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    #[default]
    Vatsim,
    Ivao,
}

impl Network {
    pub const ALL: [Network; 2] = [Network::Vatsim, Network::Ivao];

    /// Lower-case id used in settings keys, commands and events ("vatsim", "ivao").
    pub fn id(self) -> &'static str {
        match self {
            Network::Vatsim => "vatsim",
            Network::Ivao => "ivao",
        }
    }

    /// Display name ("VATSIM", "IVAO").
    pub fn label(self) -> &'static str {
        match self {
            Network::Vatsim => "VATSIM",
            Network::Ivao => "IVAO",
        }
    }

    pub fn from_id(id: &str) -> Option<Network> {
        Network::ALL.into_iter().find(|n| n.id().eq_ignore_ascii_case(id))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pilot {
    #[serde(default)]
    pub network: Network,
    /// Network member id: VATSIM CID or IVAO VID (only unique together with `network`).
    pub cid: u64,
    pub callsign: String,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_ft: i32,
    pub ground_speed_kt: i32,
    pub heading_deg: i32,
    pub transponder: String,
    /// ICAO type designator from the flight plan ("B738"); empty without a flight plan.
    pub aircraft_short: String,
    pub departure: String,
    pub arrival: String,
    pub route: String,
    /// "I" or "V" from the flight plan.
    pub flight_rules: String,
    /// IVAO reports it; VATSIM does not (None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_ground: Option<bool>,
    /// Real name as the network publishes it: VATSIM `name`; IVAO's public feed has none (empty).
    /// Only the detail query (`online_pilot`) carries it, see [`Pilot::lean`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// Session start (ISO 8601, UTC): VATSIM `logon_time`, IVAO `createdAt`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub logon_time: String,
    /// Planned cruise level as filed: VATSIM "36000" (feet), IVAO "F340" / "A045" / "VFR".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub planned_altitude: String,
    /// Flight-plan remarks (field 18, e.g. "PBN/A1B1 REG/DAINA"); detail query only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub remarks: String,
    /// Aircraft model in words when the feed has it (IVAO `aircraft.model`, "A320neo").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub aircraft_model: String,
}

impl Pilot {
    /// The pilot without the fields only the detail card needs (name, remarks): what the map's
    /// bulk query sends, so a pan over 1500 pilots stays small and names are not spread around.
    pub fn lean(mut self) -> Pilot {
        self.name.clear();
        self.remarks.clear();
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Facility {
    Fss,
    Del,
    Gnd,
    Twr,
    App,
    Ctr,
    Atis,
}

impl Facility {
    /// Centre and flight-service stations cover a FIR, not an airport. We have no
    /// FIR polygons, so the UI lists these instead of placing them on the map.
    pub fn is_enroute(self) -> bool {
        matches!(self, Facility::Fss | Facility::Ctr)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    #[serde(default)]
    pub network: Network,
    pub cid: u64,
    pub callsign: String,
    pub frequency: String,
    pub facility: Facility,
    /// VATSIM only (IVAO has no visual range in the public feed: 0).
    pub visual_range_nm: u32,
    pub text_atis: Vec<String>,
    /// Current ATIS letter: VATSIM ATIS stations; IVAO airport positions (their ATIS revision).
    pub atis_code: Option<String>,
}

impl Controller {
    /// The part before the first underscore: "EDDF" for "EDDF_N_APP", "EDGG" for "EDGG_CTR".
    /// Usually an ICAO code, sometimes a 3-letter IATA/FAA id ("JFK_TWR", "NY_CTR").
    pub fn station_prefix(&self) -> &str {
        self.callsign.split('_').next().unwrap_or(&self.callsign)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefile {
    pub cid: u64,
    pub callsign: String,
    pub aircraft_short: String,
    pub departure: String,
    pub arrival: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyPilot {
    #[serde(flatten)]
    pub pilot: Pilot,
    pub distance_nm: f64,
}

/// One parsed data file of one network.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSnapshot {
    pub network: Network,
    /// Feed timestamp as the network wrote it (ISO 8601, UTC): VATSIM `general.update_timestamp`,
    /// IVAO `updatedAt`.
    pub update_timestamp: String,
    /// Local wall clock when we received it (Unix ms).
    pub fetched_ms: u64,
    pub pilots: Vec<Pilot>,
    /// Controllers and ATIS stations on a frequency.
    pub controllers: Vec<Controller>,
    /// VATSIM prefiles; IVAO's public feed has none.
    pub prefiles: Vec<Prefile>,
}

/// The former name, from when VATSIM was the only network.
pub type VatsimSnapshot = OnlineSnapshot;

impl OnlineSnapshot {
    pub fn pilot(&self, cid: u64) -> Option<&Pilot> {
        self.pilots.iter().find(|p| p.cid == cid)
    }

    /// Pilots inside the box, see [`pilots_in_bbox`].
    pub fn pilots_in_bbox(&self, min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64, limit: usize) -> Vec<&Pilot> {
        pilots_in_bbox(self.pilots.iter(), min_lon, min_lat, max_lon, max_lat, limit)
    }

    /// The `n` pilots closest to a point, nearest first.
    pub fn nearest_pilots(&self, lat: f64, lon: f64, n: usize) -> Vec<NearbyPilot> {
        nearest_pilots(self.pilots.iter(), lat, lon, n)
    }
}

/// Pilots inside the box (from any number of snapshots). Handles boxes crossing the antimeridian
/// (`min_lon > max_lon`). When more than `limit` match, the ones closest to the box centre win so
/// a zoomed-out view still shows the traffic the user is looking at.
pub fn pilots_in_bbox<'a>(
    pilots: impl Iterator<Item = &'a Pilot>,
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    limit: usize,
) -> Vec<&'a Pilot> {
    let in_lon = |lon: f64| if min_lon <= max_lon { lon >= min_lon && lon <= max_lon } else { lon >= min_lon || lon <= max_lon };
    let mut found: Vec<&Pilot> = pilots.filter(|p| p.latitude >= min_lat && p.latitude <= max_lat && in_lon(p.longitude)).collect();
    if found.len() > limit {
        let clat = (min_lat + max_lat) / 2.0;
        let mut clon = (min_lon + max_lon) / 2.0;
        if min_lon > max_lon {
            clon = if clon > 0.0 { clon - 180.0 } else { clon + 180.0 };
        }
        found.sort_by(|a, b| haversine_nm(clat, clon, a.latitude, a.longitude).total_cmp(&haversine_nm(clat, clon, b.latitude, b.longitude)));
        found.truncate(limit);
    }
    found
}

/// The `n` pilots (from any number of snapshots) closest to a point, nearest first.
pub fn nearest_pilots<'a>(pilots: impl Iterator<Item = &'a Pilot>, lat: f64, lon: f64, n: usize) -> Vec<NearbyPilot> {
    let mut all: Vec<(f64, &Pilot)> = pilots.map(|p| (haversine_nm(lat, lon, p.latitude, p.longitude), p)).collect();
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    all.into_iter().take(n).map(|(d, p)| NearbyPilot { pilot: p.clone(), distance_nm: d }).collect()
}

/// Great-circle distance in nautical miles.
pub fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * 3440.065 * a.sqrt().asin()
}
