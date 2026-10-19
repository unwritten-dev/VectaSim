//! The datarefs VectaSim subscribes to, and their layout in the raw record ("slots").
//!
//! Numeric datarefs are flattened into a fixed vector of `f64` slots: a scalar takes one
//! slot, an array dataref its first `n` elements (`name[0]` … `name[n-1]`). The vector is
//! what a `.vsdump` line of an X-Plane session holds (`data` with `req` [`REQ_NUM`]), with
//! NaN (`null`) for every slot the update message did not contain – X-Plane sends only the
//! datarefs whose value changed. String datarefs (`data` type, base64 in the Web API) are
//! kept separately ([`STRINGS`], `req` [`REQ_STR`]).
//!
//! Names follow the X-Plane 12 dataref list (`DataRefs.txt`); a dataref the running
//! X-Plane does not know is reported once and its fields stay `None`/unchanged.

/// Dump request id of the numeric slot vector.
pub const REQ_NUM: u32 = 1;
/// Dump request id of the strings.
pub const REQ_STR: u32 = 3;
/// Dump header keys.
pub const KEY_NUM: &str = "fast";
pub const KEY_STR: &str = "static";

/// One numeric dataref.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Var {
    pub name: &'static str,
    /// 1 = scalar; otherwise the number of array elements used (from index 0).
    pub n: usize,
    /// Unit of the raw value as X-Plane delivers it.
    pub unit: &'static str,
    /// Unit of the converted value (Telemetry field), for the diagnostics.
    pub out: &'static str,
}

const fn v(name: &'static str, unit: &'static str, out: &'static str) -> Var {
    Var { name, n: 1, unit, out }
}

const fn arr(name: &'static str, n: usize, unit: &'static str, out: &'static str) -> Var {
    Var { name, n, unit, out }
}

pub const LAT: usize = 0;
pub const LON: usize = 1;
pub const ELEV: usize = 2;
pub const AGL: usize = 3;
pub const IAS: usize = 4;
pub const TAS: usize = 5;
pub const GS: usize = 6;
pub const VS: usize = 7;
pub const HDG_MAG: usize = 8;
pub const HDG_TRUE: usize = 9;
pub const PITCH: usize = 10;
pub const BANK: usize = 11;
pub const G: usize = 12;
pub const ON_GROUND: usize = 13;
pub const GEAR: usize = 14;
pub const FLAP_HANDLE: usize = 15;
pub const FLAP_DETENTS: usize = 16;
pub const PARK_BRAKE: usize = 17;
pub const FUEL: usize = 18;
pub const WEIGHT: usize = 19;
pub const NUM_ENGINES: usize = 20;
pub const ENG_RUNNING: usize = 21;
pub const XPDR: usize = 22;
pub const ZULU: usize = 23;
pub const PAUSED: usize = 24;
pub const SIM_SPEED: usize = 25;
pub const GROUND_SPEED_MULT: usize = 26;
pub const L_BEACON: usize = 27;
pub const L_NAV: usize = 28;
pub const L_STROBE: usize = 29;
pub const L_LANDING: usize = 30;
pub const L_TAXI: usize = 31;
pub const WIND_SPEED: usize = 32;
pub const WIND_DIR: usize = 33;
pub const ALPHA: usize = 34;
pub const N1: usize = 35;
pub const THROTTLE: usize = 36;
pub const SPEEDBRAKE: usize = 37;
pub const AUTOPILOT: usize = 38;
pub const VSO: usize = 39;
pub const VS1: usize = 40;
pub const CRASHED: usize = 41;
pub const DATE_DAYS: usize = 42;

/// Engines / gear legs taken from the array datarefs.
pub const MAX_ENGINES: usize = 8;
pub const MAX_GEAR: usize = 10;

pub const NUMERIC: &[Var] = &[
    v("sim/flightmodel/position/latitude", "deg", "°"),
    v("sim/flightmodel/position/longitude", "deg", "°"),
    v("sim/flightmodel/position/elevation", "m", "ft"),
    v("sim/flightmodel/position/y_agl", "m", "ft"),
    v("sim/flightmodel/position/indicated_airspeed", "kias", "kt"),
    v("sim/flightmodel/position/true_airspeed", "m/s", "kt"),
    v("sim/flightmodel/position/groundspeed", "m/s", "kt"),
    v("sim/flightmodel/position/vh_ind_fpm", "fpm", "fpm"),
    v("sim/flightmodel/position/mag_psi", "deg", "°"),
    v("sim/flightmodel/position/psi", "deg", "°"),
    v("sim/flightmodel/position/theta", "deg", "°"),
    v("sim/flightmodel/position/phi", "deg", "°"),
    v("sim/flightmodel/forces/g_nrml", "g", "g"),
    v("sim/flightmodel/failures/onground_any", "bool", "bool"),
    arr("sim/flightmodel2/gear/deploy_ratio", MAX_GEAR, "ratio", "%"),
    v("sim/flightmodel2/controls/flap_handle_deploy_ratio", "ratio", "Index"),
    v("sim/aircraft/controls/acf_flap_detents", "count", "Anzahl"),
    v("sim/cockpit2/controls/parking_brake_ratio", "ratio", "bool"),
    v("sim/flightmodel/weight/m_fuel_total", "kg", "kg"),
    v("sim/flightmodel/weight/m_total", "kg", "kg"),
    v("sim/aircraft/engine/acf_num_engines", "count", "Anzahl"),
    arr("sim/flightmodel/engine/ENGN_running", MAX_ENGINES, "bool", "bool"),
    v("sim/cockpit/radios/transponder_code", "code", "Squawk"),
    v("sim/time/zulu_time_sec", "s", "s"),
    v("sim/time/paused", "bool", "bool"),
    v("sim/time/sim_speed", "x", "×"),
    v("sim/time/ground_speed", "x", "×"),
    v("sim/cockpit2/switches/beacon_on", "bool", "bool"),
    v("sim/cockpit2/switches/navigation_lights_on", "bool", "bool"),
    v("sim/cockpit2/switches/strobe_lights_on", "bool", "bool"),
    v("sim/cockpit2/switches/landing_lights_on", "bool", "bool"),
    v("sim/cockpit2/switches/taxi_light_on", "bool", "bool"),
    v("sim/weather/aircraft/wind_speed_msc", "m/s", "kt"),
    v("sim/weather/aircraft/wind_direction_degt", "deg", "°"),
    v("sim/flightmodel/position/alpha", "deg", "°"),
    arr("sim/flightmodel/engine/ENGN_N1_", MAX_ENGINES, "%", "%"),
    v("sim/cockpit2/engine/actuators/throttle_ratio_all", "ratio", "%"),
    v("sim/cockpit2/controls/speedbrake_ratio", "ratio", "%"),
    v("sim/cockpit2/autopilot/servos_on", "bool", "bool"),
    v("sim/aircraft/view/acf_Vso", "kias", "kt"),
    v("sim/aircraft/view/acf_Vs", "kias", "kt"),
    v("sim/flightmodel2/misc/has_crashed", "bool", "bool"),
    v("sim/time/local_date_days", "days", "Tag"),
];

pub const S_ICAO: usize = 0;
pub const S_TAILNUM: usize = 1;
pub const S_UI_NAME: usize = 2;
pub const S_DESCRIP: usize = 3;
pub const S_PATH: usize = 4;

/// String datarefs (Web API value type `data`, base64), read once and on every change.
pub const STRINGS: &[&str] = &[
    "sim/aircraft/view/acf_ICAO",
    "sim/aircraft/view/acf_tailnum",
    "sim/aircraft/view/acf_ui_name",
    "sim/aircraft/view/acf_descrip",
    "sim/aircraft/view/acf_relative_path",
];

/// First slot of numeric dataref `var`.
pub const fn offset(var: usize) -> usize {
    let mut o = 0;
    let mut k = 0;
    while k < var {
        o += NUMERIC[k].n;
        k += 1;
    }
    o
}

/// Total number of numeric slots.
pub const N_SLOTS: usize = offset(NUMERIC.len());

/// Slot names in order (`name` for scalars, `name[i]` for array elements).
pub fn slot_names() -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(N_SLOTS);
    for var in NUMERIC {
        if var.n == 1 {
            out.push((var.name.to_owned(), var.unit.to_owned()));
        } else {
            out.extend((0..var.n).map(|i| (format!("{}[{i}]", var.name), var.unit.to_owned())));
        }
    }
    out
}

/// (numeric dataref, element) of each slot.
pub fn slot_owner(slot: usize) -> Option<(usize, usize)> {
    let mut o = 0;
    for (i, var) in NUMERIC.iter().enumerate() {
        if slot < o + var.n {
            return Some((i, slot - o));
        }
        o += var.n;
    }
    None
}

/// Every dataref name VectaSim resolves (numeric first, then strings).
pub fn all_names() -> impl Iterator<Item = &'static str> {
    NUMERIC.iter().map(|v| v.name).chain(STRINGS.iter().copied())
}

/// Dump header definitions of an X-Plane session.
pub fn dump_defs() -> vectasim_dump::Defs {
    vectasim_dump::Defs {
        fast: slot_names(),
        statics: STRINGS.iter().map(|s| (*s).to_owned()).collect(),
        ..Default::default()
    }
}

pub fn dump_reqs() -> std::collections::BTreeMap<String, u32> {
    [(KEY_NUM.to_owned(), REQ_NUM), (KEY_STR.to_owned(), REQ_STR)].into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indices_match_the_table() {
        let names = [
            (LAT, "latitude"),
            (AGL, "y_agl"),
            (ON_GROUND, "onground_any"),
            (GEAR, "deploy_ratio"),
            (ENG_RUNNING, "ENGN_running"),
            (XPDR, "transponder_code"),
            (ZULU, "zulu_time_sec"),
            (L_TAXI, "taxi_light_on"),
            (N1, "ENGN_N1_"),
            (CRASHED, "has_crashed"),
            (DATE_DAYS, "local_date_days"),
        ];
        for (i, n) in names {
            assert!(NUMERIC[i].name.ends_with(n), "{i}: {}", NUMERIC[i].name);
        }
        assert!(STRINGS[S_TAILNUM].ends_with("acf_tailnum"));
        assert!(STRINGS[S_PATH].ends_with("acf_relative_path"));
    }

    #[test]
    fn slots_are_flattened() {
        let names = slot_names();
        assert_eq!(names.len(), N_SLOTS);
        assert_eq!(N_SLOTS, NUMERIC.len() - 3 + MAX_GEAR + 2 * MAX_ENGINES);
        assert_eq!(names[offset(GEAR)].0, "sim/flightmodel2/gear/deploy_ratio[0]");
        assert_eq!(names[offset(GEAR) + 9].0, "sim/flightmodel2/gear/deploy_ratio[9]");
        assert_eq!(names[offset(FLAP_HANDLE)].0, NUMERIC[FLAP_HANDLE].name);
        assert_eq!(slot_owner(offset(ENG_RUNNING) + 3), Some((ENG_RUNNING, 3)));
        assert_eq!(slot_owner(offset(DATE_DAYS)), Some((DATE_DAYS, 0)));
        assert_eq!(slot_owner(N_SLOTS), None);
    }
}
