//! Lenient mirror of the SimBrief JSON document. Only the fields we read are
//! declared; everything else is ignored. Every numeric field goes through
//! `Num`, which accepts numbers, numeric strings and empty strings.

use crate::model::{NavFix, Ofp, OfpFuel, OfpTimes, OfpWeights};
use serde::Deserialize;

const LBS_TO_KG: f64 = 0.453_592_37;

/// A number that may arrive as `123`, `"123"`, `"123.4"` or `""`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Num(pub f64);

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum V {
            N(f64),
            S(String),
            Null,
        }
        Ok(match V::deserialize(d)? {
            V::N(n) => Num(n),
            V::S(s) => Num(s.trim().parse().unwrap_or(0.0)),
            V::Null => Num(0.0),
        })
    }
}

/// SimBrief emits one-element lists as a bare object in some layouts.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum OneOrMany<T> {
    Many(Vec<T>),
    One(T),
}

impl<T> OneOrMany<T> {
    fn into_vec(self) -> Vec<T> {
        match self {
            OneOrMany::Many(v) => v,
            OneOrMany::One(t) => vec![t],
        }
    }
}

fn s(v: &Option<String>) -> String {
    v.clone().unwrap_or_default()
}

#[derive(Debug, Default, Deserialize)]
pub struct RawOfp {
    pub fetch: Option<Fetch>,
    pub params: Option<Params>,
    pub general: Option<General>,
    pub origin: Option<Airport>,
    pub destination: Option<Airport>,
    pub alternate: Option<OneOrMany<Airport>>,
    pub aircraft: Option<Aircraft>,
    pub fuel: Option<Fuel>,
    pub times: Option<Times>,
    pub weights: Option<Weights>,
    pub navlog: Option<NavlogDoc>,
    pub atc: Option<Atc>,
}

/// `navlog` is a bare list of fixes in JSON v2 and `{ "fix": [...] }` (or a single fix) in v1.
/// `List` must come first: a derived struct also accepts a sequence (fields by position) and
/// would swallow the first fix and then fail on the rest with "trailing characters".
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum NavlogDoc {
    List(Vec<Fix>),
    Object(Box<Navlog>),
}

impl NavlogDoc {
    fn into_vec(self) -> Vec<Fix> {
        match self {
            NavlogDoc::List(v) => v,
            NavlogDoc::Object(n) => n.fix.map(|f| f.into_vec()).unwrap_or_default(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct Fetch {
    pub status: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Params {
    pub request_id: Option<Num>,
    pub time_generated: Option<Num>,
    pub airac: Option<Num>,
    pub units: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct General {
    pub icao_airline: Option<String>,
    pub flight_number: Option<String>,
    pub initial_altitude: Option<Num>,
    pub route: Option<String>,
    pub route_distance: Option<Num>,
    pub gc_distance: Option<Num>,
    pub costindex: Option<Num>,
    pub passengers: Option<Num>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Airport {
    pub icao_code: Option<String>,
    pub name: Option<String>,
    pub plan_rwy: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Aircraft {
    pub icaocode: Option<String>,
    pub icao_code: Option<String>,
    pub name: Option<String>,
    pub reg: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Fuel {
    pub taxi: Option<Num>,
    pub enroute_burn: Option<Num>,
    pub contingency: Option<Num>,
    pub alternate_burn: Option<Num>,
    pub reserve: Option<Num>,
    pub extra: Option<Num>,
    pub min_takeoff: Option<Num>,
    pub plan_takeoff: Option<Num>,
    pub plan_ramp: Option<Num>,
    pub plan_landing: Option<Num>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Times {
    pub sched_out: Option<Num>,
    pub sched_off: Option<Num>,
    pub sched_on: Option<Num>,
    pub sched_in: Option<Num>,
    pub est_out: Option<Num>,
    pub est_off: Option<Num>,
    pub est_on: Option<Num>,
    pub est_in: Option<Num>,
    pub sched_block: Option<Num>,
    pub est_block: Option<Num>,
    pub est_time_enroute: Option<Num>,
    pub taxi_out: Option<Num>,
    pub taxi_in: Option<Num>,
    pub endurance: Option<Num>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Weights {
    pub oew: Option<Num>,
    pub payload: Option<Num>,
    pub cargo: Option<Num>,
    pub pax_count: Option<Num>,
    pub est_zfw: Option<Num>,
    pub max_zfw: Option<Num>,
    pub est_tow: Option<Num>,
    pub max_tow: Option<Num>,
    pub est_ldw: Option<Num>,
    pub max_ldw: Option<Num>,
    pub est_ramp: Option<Num>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Navlog {
    pub fix: Option<OneOrMany<Fix>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Fix {
    pub ident: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub pos_lat: Option<Num>,
    pub pos_long: Option<Num>,
    pub altitude_feet: Option<Num>,
    pub via_airway: Option<String>,
    pub is_sid_star: Option<Num>,
    pub stage: Option<String>,
    pub distance: Option<Num>,
    pub time_total: Option<Num>,
    pub fuel_plan_onboard: Option<Num>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Atc {
    pub callsign: Option<String>,
}

impl From<RawOfp> for Ofp {
    fn from(r: RawOfp) -> Self {
        let params = r.params.unwrap_or_default();
        let units = params.units.clone().unwrap_or_else(|| "kgs".into());
        let to_kg = if units.to_ascii_lowercase().starts_with("lb") { LBS_TO_KG } else { 1.0 };
        let kg = |n: &Option<Num>| n.map_or(0.0, |v| v.0 * to_kg);
        let num = |n: &Option<Num>| n.map_or(0.0, |v| v.0);
        let secs = |n: &Option<Num>| n.map_or(0, |v| v.0.max(0.0) as u64);

        let general = r.general.unwrap_or_default();
        let origin = r.origin.unwrap_or_default();
        let destination = r.destination.unwrap_or_default();
        let alternate = r.alternate.map(|a| a.into_vec()).unwrap_or_default().into_iter().next().unwrap_or_default();
        let aircraft = r.aircraft.unwrap_or_default();
        let fuel = r.fuel.unwrap_or_default();
        let times = r.times.unwrap_or_default();
        let weights = r.weights.unwrap_or_default();
        let atc = r.atc.unwrap_or_default();

        let airline = s(&general.icao_airline);
        let flight_number = s(&general.flight_number);
        let callsign = match s(&atc.callsign) {
            c if !c.is_empty() => c,
            _ => format!("{airline}{flight_number}"),
        };

        let navlog = r
            .navlog
            .map(|n| n.into_vec())
            .unwrap_or_default()
            .into_iter()
            .map(|f| NavFix {
                ident: s(&f.ident),
                name: s(&f.name),
                kind: s(&f.kind),
                latitude: num(&f.pos_lat),
                longitude: num(&f.pos_long),
                altitude_ft: num(&f.altitude_feet),
                via_airway: s(&f.via_airway),
                is_sid_star: num(&f.is_sid_star) != 0.0,
                stage: s(&f.stage),
                distance_nm: num(&f.distance),
                time_total_s: secs(&f.time_total),
                fuel_remaining_kg: kg(&f.fuel_plan_onboard),
            })
            .collect();

        Ofp {
            request_id: format!("{}", num(&params.request_id) as u64),
            generated_at_s: secs(&params.time_generated),
            airac: format!("{}", num(&params.airac) as u64),
            source_units: units,
            airline_icao: airline,
            flight_number,
            callsign,
            origin_icao: s(&origin.icao_code),
            origin_name: s(&origin.name),
            origin_runway: s(&origin.plan_rwy),
            destination_icao: s(&destination.icao_code),
            destination_name: s(&destination.name),
            destination_runway: s(&destination.plan_rwy),
            alternate_icao: s(&alternate.icao_code),
            alternate_name: s(&alternate.name),
            aircraft_icao: match s(&aircraft.icaocode) {
                c if !c.is_empty() => c,
                _ => s(&aircraft.icao_code),
            },
            aircraft_name: s(&aircraft.name),
            registration: s(&aircraft.reg),
            route: s(&general.route),
            cruise_altitude_ft: num(&general.initial_altitude),
            route_distance_nm: num(&general.route_distance),
            great_circle_distance_nm: num(&general.gc_distance),
            cost_index: format!("{}", num(&general.costindex) as i64),
            passengers: num(&general.passengers) as u32,
            times: OfpTimes {
                sched_out_s: secs(&times.sched_out),
                sched_off_s: secs(&times.sched_off),
                sched_on_s: secs(&times.sched_on),
                sched_in_s: secs(&times.sched_in),
                est_out_s: secs(&times.est_out),
                est_off_s: secs(&times.est_off),
                est_on_s: secs(&times.est_on),
                est_in_s: secs(&times.est_in),
                block_s: match secs(&times.est_block) {
                    0 => secs(&times.sched_block),
                    b => b,
                },
                enroute_s: secs(&times.est_time_enroute),
                taxi_out_s: secs(&times.taxi_out),
                taxi_in_s: secs(&times.taxi_in),
                endurance_s: secs(&times.endurance),
            },
            fuel: OfpFuel {
                taxi_kg: kg(&fuel.taxi),
                trip_kg: kg(&fuel.enroute_burn),
                contingency_kg: kg(&fuel.contingency),
                alternate_kg: kg(&fuel.alternate_burn),
                reserve_kg: kg(&fuel.reserve),
                extra_kg: kg(&fuel.extra),
                min_takeoff_kg: kg(&fuel.min_takeoff),
                plan_takeoff_kg: kg(&fuel.plan_takeoff),
                plan_ramp_kg: kg(&fuel.plan_ramp),
                plan_landing_kg: kg(&fuel.plan_landing),
            },
            weights: OfpWeights {
                oew_kg: kg(&weights.oew),
                payload_kg: kg(&weights.payload),
                cargo_kg: kg(&weights.cargo),
                pax_count: num(&weights.pax_count) as u32,
                est_zfw_kg: kg(&weights.est_zfw),
                max_zfw_kg: kg(&weights.max_zfw),
                est_tow_kg: kg(&weights.est_tow),
                max_tow_kg: kg(&weights.max_tow),
                est_ldw_kg: kg(&weights.est_ldw),
                max_ldw_kg: kg(&weights.max_ldw),
                est_ramp_kg: kg(&weights.est_ramp),
            },
            navlog,
        }
    }
}
