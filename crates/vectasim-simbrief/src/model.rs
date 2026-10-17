use serde::{Deserialize, Serialize};

/// The parts of an OFP VectaSim uses. Everything in kg, ft, nm, Unix seconds.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ofp {
    pub request_id: String,
    pub generated_at_s: u64,
    pub airac: String,
    /// "kgs" or "lbs" as SimBrief reported it (we convert, this is informational).
    pub source_units: String,

    pub airline_icao: String,
    pub flight_number: String,
    pub callsign: String,

    pub origin_icao: String,
    pub origin_name: String,
    pub origin_runway: String,
    pub destination_icao: String,
    pub destination_name: String,
    pub destination_runway: String,
    pub alternate_icao: String,
    pub alternate_name: String,

    pub aircraft_icao: String,
    pub aircraft_name: String,
    pub registration: String,

    pub route: String,
    pub cruise_altitude_ft: f64,
    pub route_distance_nm: f64,
    pub great_circle_distance_nm: f64,
    pub cost_index: String,
    pub passengers: u32,

    pub times: OfpTimes,
    pub fuel: OfpFuel,
    pub weights: OfpWeights,
    pub navlog: Vec<NavFix>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfpTimes {
    pub sched_out_s: u64,
    pub sched_off_s: u64,
    pub sched_on_s: u64,
    pub sched_in_s: u64,
    pub est_out_s: u64,
    pub est_off_s: u64,
    pub est_on_s: u64,
    pub est_in_s: u64,
    /// Planned block time (out → in), seconds.
    pub block_s: u64,
    /// Planned air time (off → on), seconds.
    pub enroute_s: u64,
    pub taxi_out_s: u64,
    pub taxi_in_s: u64,
    pub endurance_s: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfpFuel {
    pub taxi_kg: f64,
    pub trip_kg: f64,
    pub contingency_kg: f64,
    pub alternate_kg: f64,
    pub reserve_kg: f64,
    pub extra_kg: f64,
    pub min_takeoff_kg: f64,
    pub plan_takeoff_kg: f64,
    pub plan_ramp_kg: f64,
    pub plan_landing_kg: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfpWeights {
    pub oew_kg: f64,
    pub payload_kg: f64,
    pub cargo_kg: f64,
    pub pax_count: u32,
    pub est_zfw_kg: f64,
    pub max_zfw_kg: f64,
    pub est_tow_kg: f64,
    pub max_tow_kg: f64,
    pub est_ldw_kg: f64,
    pub max_ldw_kg: f64,
    pub est_ramp_kg: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavFix {
    pub ident: String,
    pub name: String,
    /// wpt | vor | ndb | apt | ltlg …
    pub kind: String,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_ft: f64,
    pub via_airway: String,
    pub is_sid_star: bool,
    /// CLB | CRZ | DSC
    pub stage: String,
    pub distance_nm: f64,
    pub time_total_s: u64,
    pub fuel_remaining_kg: f64,
}

impl Ofp {
    pub fn route_label(&self) -> String {
        format!("{} → {}", self.origin_icao, self.destination_icao)
    }
}
