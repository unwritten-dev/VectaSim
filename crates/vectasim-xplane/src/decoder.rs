//! Interpretation of raw X-Plane dataref values: merge the delta updates into the current
//! state, convert units into [`Telemetry`] / [`AircraftInfo`], derive sim events (pause,
//! crash, aircraft change) and keep the raw-value diagnostics up to date.
//!
//! Shared by the live session and the replay of an X-Plane `.vsdump`; no I/O, no clock.
//!
//! * The Web API pushes only changed datarefs, so every slot keeps its last value; a slot
//!   that never arrived is NaN and the field stays at its default (`None` for the optional
//!   approach fields).
//! * X-Plane has no "touchdown normal velocity"; `touchdown_vs_fpm` stays 0 and the core's
//!   touchdown detector uses its fallback (the last airborne V/S, see `vectasim_core::touchdown`).

use crate::datarefs::*;
use vectasim_core::diag::{DefDiag, DiagEvent, RawDiag, SharedRawDiag, VarDiag};
use vectasim_core::{AircraftInfo, ProviderEvent, SimEvent, Telemetry};

pub const M_TO_FT: f64 = 3.280_839_895;
pub const MS_TO_KT: f64 = 1.943_844_492;

const DIAG_NUM: usize = 0;
const DIAG_STR: usize = 1;

pub struct XpDecoder {
    /// Merged numeric slots (NaN = never received).
    pub vals: Vec<f64>,
    /// Numeric datarefs that resolved/subscribed (by [`NUMERIC`] index).
    pub active: Vec<bool>,
    /// Merged strings (`None` = never received).
    pub strs: Vec<Option<String>>,
    pub str_active: Vec<bool>,
    current: Telemetry,
    aircraft: Option<AircraftInfo>,
    /// Identity (ICAO, tail number, .acf path) of the aircraft last reported.
    identity: Option<(String, String, String)>,
    paused: Option<bool>,
    crashed: bool,
    has_position: bool,
    diag: SharedRawDiag,
}

fn finite(x: f64) -> Option<f64> {
    x.is_finite().then_some(x)
}

fn flag(x: f64) -> Option<bool> {
    finite(x).map(|v| v.abs() > 0.5)
}

impl XpDecoder {
    pub fn new(diag: SharedRawDiag) -> Self {
        let s = Self {
            vals: vec![f64::NAN; N_SLOTS],
            active: vec![true; NUMERIC.len()],
            strs: vec![None; STRINGS.len()],
            str_active: vec![true; STRINGS.len()],
            current: Telemetry::default(),
            aircraft: None,
            identity: None,
            paused: None,
            crashed: false,
            has_position: false,
            diag,
        };
        s.init_diag();
        s
    }

    fn lock_diag(&self) -> std::sync::MutexGuard<'_, RawDiag> {
        self.diag.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn init_diag(&self) {
        let num = DefDiag {
            label: "DATAREFS".into(),
            req: REQ_NUM,
            period: "10 Hz, nur Änderungen".into(),
            vars: slot_names()
                .into_iter()
                .enumerate()
                .map(|(i, (name, unit))| VarDiag {
                    name,
                    unit: Some(unit),
                    active: true,
                    value_unit: slot_owner(i).map_or("", |(v, _)| NUMERIC[v].out).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let strs = DefDiag {
            label: "STAMMDATEN".into(),
            req: REQ_STR,
            period: "bei Änderung".into(),
            vars: STRINGS.iter().map(|n| VarDiag { name: (*n).into(), active: true, ..Default::default() }).collect(),
            ..Default::default()
        };
        self.lock_diag().defs = vec![num, strs];
    }

    pub fn note(&self, wall_ms: u64, kind: &str, name: &str, detail: String) {
        self.lock_diag().push_event(DiagEvent { wall_ms, kind: kind.into(), name: name.into(), data_hex: None, detail });
    }

    /// A new session is up: `source` names the endpoint (`X-Plane Web API localhost:8086`).
    pub fn on_open(&mut self, sim_name: String, sim_version: String, api: String, source: Option<String>, wall_ms: u64) -> ProviderEvent {
        {
            let mut d = self.lock_diag();
            let c = &mut d.connection;
            if c.sessions > 0 {
                c.reconnects += 1;
            }
            c.sessions += 1;
            c.sim_name = Some(sim_name.clone());
            c.sim_version = Some(sim_version.clone());
            c.simconnect_version = Some(api.clone());
            c.connected_wall_ms = Some(wall_ms);
            if source.is_some() {
                c.dll = source;
            }
        }
        self.note(wall_ms, "open", &sim_name, format!("{sim_name} {sim_version}, {api}"));
        ProviderEvent::Connected { sim_name, sim_version }
    }

    pub fn on_end(&mut self, reason: &str, wall_ms: u64) {
        self.note(wall_ms, "end", "Sitzungsende", reason.into());
    }

    /// A numeric dataref could not be resolved or subscribed: its fields stay unset.
    pub fn mark_inactive(&mut self, var: usize) {
        if let Some(a) = self.active.get_mut(var) {
            *a = false;
        }
        let (from, n) = (offset(var), NUMERIC.get(var).map_or(0, |v| v.n));
        for s in from..from + n {
            self.vals[s] = f64::NAN;
        }
        let mut d = self.lock_diag();
        if let Some(def) = d.defs.get_mut(DIAG_NUM) {
            for s in from..from + n {
                if let Some(v) = def.vars.get_mut(s) {
                    v.active = false;
                }
            }
        }
    }

    pub fn mark_str_inactive(&mut self, i: usize) {
        if let Some(a) = self.str_active.get_mut(i) {
            *a = false;
        }
        if let Some(v) = self.lock_diag().defs.get_mut(DIAG_STR).and_then(|d| d.vars.get_mut(i)) {
            v.active = false;
        }
    }

    /// One update message's numeric part: `slots[i]` NaN = not in this message.
    /// Returns a telemetry sample (once a position is known) plus any sim events.
    pub fn on_slots(&mut self, slots: &[f64], ts_ms: u64, src_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        let mut any = false;
        for (i, x) in slots.iter().enumerate().take(N_SLOTS) {
            if x.is_finite() && slot_owner(i).is_some_and(|(v, _)| self.active[v]) {
                self.vals[i] = *x;
                any = true;
            }
        }
        if !any {
            return Vec::new();
        }
        let mut out = Vec::new();
        self.apply(ts_ms, wall_ms, &mut out);
        self.update_diag(slots, src_ms, wall_ms);
        if self.has_position {
            out.insert(0, ProviderEvent::Telemetry(Box::new(self.current.clone())));
        }
        out
    }

    fn apply(&mut self, ts_ms: u64, wall_ms: u64, out: &mut Vec<ProviderEvent>) {
        let vals = std::mem::take(&mut self.vals);
        let val = |var: usize| vals[offset(var)];
        let elems = |var: usize| &vals[offset(var)..offset(var) + NUMERIC[var].n];
        let g = |var: usize| finite(val(var));
        let mut t = std::mem::take(&mut self.current);
        t.timestamp_ms = ts_ms;
        let set = |dst: &mut f64, x: Option<f64>| {
            if let Some(x) = x {
                *dst = x;
            }
        };
        let set_flag = |dst: &mut bool, x: f64| {
            if let Some(b) = flag(x) {
                *dst = b;
            }
        };
        if let (Some(lat), Some(lon)) = (g(LAT), g(LON)) {
            t.latitude = lat;
            t.longitude = lon;
            self.has_position = true;
        }
        set(&mut t.altitude_msl_ft, g(ELEV).map(|m| m * M_TO_FT));
        set(&mut t.altitude_agl_ft, g(AGL).map(|m| m * M_TO_FT));
        set(&mut t.ias_kt, g(IAS));
        set(&mut t.tas_kt, g(TAS).map(|v| v * MS_TO_KT));
        set(&mut t.ground_speed_kt, g(GS).map(|v| v * MS_TO_KT));
        set(&mut t.vertical_speed_fpm, g(VS));
        set(&mut t.heading_mag_deg, g(HDG_MAG).map(|d| d.rem_euclid(360.0)));
        set(&mut t.heading_true_deg, g(HDG_TRUE).map(|d| d.rem_euclid(360.0)));
        // X-Plane: theta nose-up positive, phi right-wing-down positive (VectaSim's convention)
        set(&mut t.pitch_deg, g(PITCH));
        set(&mut t.bank_deg, g(BANK));
        set(&mut t.g_force, g(G));
        set_flag(&mut t.on_ground, val(ON_GROUND));

        let gear: Vec<f64> = elems(GEAR).iter().copied().filter(|x| x.is_finite()).collect();
        if !gear.is_empty() {
            t.gear_pct = gear.iter().copied().fold(0.0, f64::max).clamp(0.0, 1.0) * 100.0;
        }
        let detents = g(FLAP_DETENTS).filter(|d| (1.0..=31.0).contains(d)).map(|d| d.round());
        if let Some(d) = detents {
            t.flap_positions = Some(d as i32 + 1);
        }
        if let Some(r) = g(FLAP_HANDLE) {
            // handle ratio 0…1 over the detents; without detents: 0 = up, anything else = 1
            t.flaps_index = match detents {
                Some(d) => (r.clamp(0.0, 1.0) * d).round() as i32,
                None => i32::from(r > 0.01),
            };
        }
        if let Some(p) = g(PARK_BRAKE) {
            t.parking_brake = p > 0.5;
        }
        set(&mut t.fuel_total_kg, g(FUEL).map(|k| k.max(0.0)));
        set(&mut t.total_weight_kg, g(WEIGHT).map(|k| k.max(0.0)));
        if let Some(n) = g(NUM_ENGINES) {
            t.num_engines = n.clamp(0.0, MAX_ENGINES as f64) as u8;
        }
        let engines = if t.num_engines > 0 { t.num_engines as usize } else { MAX_ENGINES };
        let running = &elems(ENG_RUNNING)[..engines];
        if running.iter().any(|x| x.is_finite()) {
            t.engines_running = running.iter().filter(|x| flag(**x).unwrap_or(false)).count() as u8;
        }
        if let Some(sq) = g(XPDR).filter(|s| (0.0..=7777.0).contains(s)) {
            t.transponder_code = sq.round() as u32;
        }
        set(&mut t.sim_zulu_time_s, g(ZULU));
        if let Some(rate) = g(SIM_SPEED) {
            // `ground_speed` multiplies the distance travelled per frame: counts as acceleration too
            let ground = g(GROUND_SPEED_MULT).filter(|m| *m >= 1.0).unwrap_or(1.0);
            t.sim_rate = rate.max(0.0) * ground;
        }
        let mut lights = t.lights;
        set_flag(&mut lights.beacon, val(L_BEACON));
        set_flag(&mut lights.nav, val(L_NAV));
        set_flag(&mut lights.strobe, val(L_STROBE));
        set_flag(&mut lights.landing, val(L_LANDING));
        set_flag(&mut lights.taxi, val(L_TAXI));
        t.lights = lights;

        t.wind_kt = g(WIND_SPEED).map(|w| (w * MS_TO_KT).max(0.0));
        t.wind_dir_true_deg = g(WIND_DIR).map(|d| d.rem_euclid(360.0));
        t.alpha_deg = g(ALPHA);
        let n1: Vec<f64> = elems(N1)[..engines.min(MAX_ENGINES)].iter().copied().filter(|x| x.is_finite()).collect();
        t.n1_pct = (!n1.is_empty()).then(|| n1.iter().sum::<f64>() / n1.len() as f64);
        t.throttle_lever_pct = g(THROTTLE).map(|r| r.clamp(0.0, 1.0) * 100.0);
        // speedbrake_ratio: −0.5 = armed, 0…1 = handle position
        let sb = g(SPEEDBRAKE);
        t.spoilers_armed = sb.map(|r| r < -0.25);
        t.spoilers_handle_pct = sb.map(|r| r.clamp(0.0, 1.0) * 100.0);
        t.autopilot_master = flag(val(AUTOPILOT));
        let speed = |x: Option<f64>| x.filter(|s| *s > 0.0);
        t.design_vs0_kt = speed(g(VSO));
        t.design_vs1_kt = speed(g(VS1));

        if let Some(p) = flag(val(PAUSED)) {
            t.paused = p;
            if self.paused != Some(p) && (self.paused.is_some() || p) {
                self.note(wall_ms, "event", "Pause", format!("paused={p}"));
                out.push(ProviderEvent::Sim(SimEvent::Paused { paused: p }));
            }
            self.paused = Some(p);
        }
        if let Some(c) = flag(val(CRASHED)) {
            if c && !self.crashed {
                self.note(wall_ms, "event", "Crashed", "has_crashed=1".into());
                out.push(ProviderEvent::Sim(SimEvent::Crashed));
            }
            self.crashed = c;
        }
        self.current = t;
        self.vals = vals;
    }

    fn update_diag(&self, slots: &[f64], src_ms: u64, wall_ms: u64) {
        let t = self.current.clone();
        let vals = self.vals.clone();
        let mut d = self.lock_diag();
        let Some(def) = d.defs.get_mut(DIAG_NUM) else { return };
        def.updates += 1;
        def.last_wall_ms = Some(wall_ms);
        def.rate.push(src_ms);
        for (i, var) in def.vars.iter_mut().enumerate() {
            if slots.get(i).is_some_and(|x| x.is_finite()) || var.raw.is_none() {
                var.raw = vals.get(i).copied().and_then(finite);
            }
            var.value = slot_owner(i).and_then(|(v, e)| converted(&t, v, e, var.raw));
        }
    }

    /// Strings of an update (`None` = not in this message). Emits `Aircraft` once every
    /// active string arrived, and `AircraftLoaded` + `Aircraft` when the identity changes.
    pub fn on_strings(&mut self, s: &[Option<String>], src_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        let mut any = false;
        for (i, x) in s.iter().enumerate().take(STRINGS.len()) {
            if let Some(x) = x
                && self.str_active[i]
            {
                self.strs[i] = Some(x.clone());
                any = true;
            }
        }
        if !any {
            return Vec::new();
        }
        {
            let strs = self.strs.clone();
            let mut d = self.lock_diag();
            if let Some(def) = d.defs.get_mut(DIAG_STR) {
                def.updates += 1;
                def.last_wall_ms = Some(wall_ms);
                def.rate.push(src_ms);
                for (i, var) in def.vars.iter_mut().enumerate() {
                    var.raw_text = strs.get(i).cloned().flatten();
                    var.value_text = var.raw_text.clone();
                }
            }
        }
        let complete = self.strs.iter().zip(&self.str_active).all(|(s, a)| !a || s.is_some());
        if !complete {
            return Vec::new();
        }
        let get = |i: usize| self.strs[i].clone().unwrap_or_default();
        let title = Some(get(S_UI_NAME)).filter(|t| !t.is_empty()).unwrap_or_else(|| get(S_DESCRIP));
        let info = AircraftInfo {
            title,
            atc_model: get(S_ICAO),
            atc_type: String::new(),
            atc_id: get(S_TAILNUM),
            atc_airline: String::new(),
            atc_flight_number: String::new(),
        };
        let identity = (get(S_ICAO), get(S_TAILNUM), get(S_PATH));
        let mut out = Vec::new();
        if self.identity.as_ref().is_some_and(|old| *old != identity) {
            let path = identity.2.clone();
            self.note(wall_ms, "event", "AircraftLoaded", format!("{} {} {}", identity.0, identity.1, path));
            out.push(ProviderEvent::Sim(SimEvent::AircraftLoaded { path }));
        }
        self.identity = Some(identity);
        if self.aircraft.as_ref() != Some(&info) {
            self.aircraft = Some(info.clone());
            out.push(ProviderEvent::Aircraft(info));
        }
        out
    }

    pub fn telemetry(&self) -> &Telemetry {
        &self.current
    }
}

/// Converted value of slot (`var`, element) for the diagnostics.
fn converted(t: &Telemetry, var: usize, elem: usize, raw: Option<f64>) -> Option<f64> {
    let b = |x: bool| if x { 1.0 } else { 0.0 };
    match var {
        LAT => Some(t.latitude),
        LON => Some(t.longitude),
        ELEV => Some(t.altitude_msl_ft),
        AGL => Some(t.altitude_agl_ft),
        IAS => Some(t.ias_kt),
        TAS => Some(t.tas_kt),
        GS => Some(t.ground_speed_kt),
        VS => Some(t.vertical_speed_fpm),
        HDG_MAG => Some(t.heading_mag_deg),
        HDG_TRUE => Some(t.heading_true_deg),
        PITCH => Some(t.pitch_deg),
        BANK => Some(t.bank_deg),
        G => Some(t.g_force),
        ON_GROUND => Some(b(t.on_ground)),
        GEAR => raw.map(|r| r * 100.0),
        FLAP_HANDLE => Some(f64::from(t.flaps_index)),
        FLAP_DETENTS => t.flap_positions.map(f64::from),
        PARK_BRAKE => Some(b(t.parking_brake)),
        FUEL => Some(t.fuel_total_kg),
        WEIGHT => Some(t.total_weight_kg),
        NUM_ENGINES => Some(f64::from(t.num_engines)),
        ENG_RUNNING => raw.map(|r| b(r > 0.5)).filter(|_| elem < MAX_ENGINES),
        XPDR => Some(f64::from(t.transponder_code)),
        ZULU => Some(t.sim_zulu_time_s),
        PAUSED => Some(b(t.paused)),
        SIM_SPEED | GROUND_SPEED_MULT => Some(t.sim_rate),
        L_BEACON => Some(b(t.lights.beacon)),
        L_NAV => Some(b(t.lights.nav)),
        L_STROBE => Some(b(t.lights.strobe)),
        L_LANDING => Some(b(t.lights.landing)),
        L_TAXI => Some(b(t.lights.taxi)),
        WIND_SPEED => t.wind_kt,
        WIND_DIR => t.wind_dir_true_deg,
        ALPHA => t.alpha_deg,
        N1 => raw,
        THROTTLE => t.throttle_lever_pct,
        SPEEDBRAKE => t.spoilers_handle_pct,
        AUTOPILOT => t.autopilot_master.map(b),
        VSO => t.design_vs0_kt,
        VS1 => t.design_vs1_kt,
        _ => raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots(pairs: &[(usize, f64)]) -> Vec<f64> {
        let mut v = vec![f64::NAN; N_SLOTS];
        for (var, x) in pairs {
            v[offset(*var)] = *x;
        }
        v
    }

    #[test]
    fn no_sample_before_a_position_and_values_are_merged() {
        let mut d = XpDecoder::new(RawDiag::shared("xplane"));
        assert!(d.on_slots(&slots(&[(IAS, 80.0)]), 1, 1, 1).is_empty(), "no position yet");
        let ev = d.on_slots(&slots(&[(LAT, 1.0), (LON, 2.0)]), 2, 2, 2);
        let Some(ProviderEvent::Telemetry(t)) = ev.first() else { panic!("{ev:?}") };
        assert_eq!((t.ias_kt, t.latitude, t.timestamp_ms), (80.0, 1.0, 2));
        assert!(d.on_slots(&slots(&[]), 3, 3, 3).is_empty(), "an update without numeric values is no sample");
    }

    #[test]
    fn flaps_without_detents_crash_and_sim_rate() {
        let mut d = XpDecoder::new(RawDiag::shared("xplane"));
        let ev = d.on_slots(&slots(&[(LAT, 1.0), (LON, 2.0), (FLAP_HANDLE, 0.3), (SIM_SPEED, 2.0), (GROUND_SPEED_MULT, 1.0)]), 1, 1, 1);
        let t = d.telemetry();
        assert_eq!((t.flaps_index, t.flap_positions, t.sim_rate), (1, None, 2.0));
        assert!(t.time_accelerated());
        assert_eq!(ev.len(), 1, "no pause event for an unpaused start");
        let ev = d.on_slots(&slots(&[(CRASHED, 1.0), (GROUND_SPEED_MULT, 4.0), (SIM_SPEED, 1.0)]), 2, 2, 2);
        assert!(ev.iter().any(|e| matches!(e, ProviderEvent::Sim(SimEvent::Crashed))));
        assert_eq!(d.telemetry().sim_rate, 4.0, "ground-speed multiplier counts as acceleration");
        let ev = d.on_slots(&slots(&[(CRASHED, 1.0)]), 3, 3, 3);
        assert!(!ev.iter().any(|e| matches!(e, ProviderEvent::Sim(SimEvent::Crashed))), "crash reported once");
    }

    #[test]
    fn aircraft_waits_for_all_active_strings() {
        let mut d = XpDecoder::new(RawDiag::shared("xplane"));
        d.mark_str_inactive(S_PATH);
        let mut s = vec![None; STRINGS.len()];
        s[S_ICAO] = Some("B738".to_owned());
        assert!(d.on_strings(&s, 1, 1).is_empty());
        let mut s = vec![None; STRINGS.len()];
        s[S_TAILNUM] = Some("D-ABCD".to_owned());
        s[S_UI_NAME] = Some(String::new());
        s[S_DESCRIP] = Some("Boeing 737-800".to_owned());
        let ev = d.on_strings(&s, 2, 2);
        assert!(matches!(ev.as_slice(), [ProviderEvent::Aircraft(a)] if a.title == "Boeing 737-800" && a.atc_model == "B738"));
    }
}
