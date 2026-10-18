//! Interpretation of raw SimConnect values: definitions, unit conversion into
//! [`Telemetry`]/[`AircraftInfo`], system events → [`ProviderEvent`], exception messages.
//!
//! Shared by the live [`Session`](crate) (fed from `GetNextDispatch`) and the
//! [`ReplayProvider`](crate::replay::ReplayProvider) (fed from a `.vsdump`), so a replay
//! exercises exactly the conversions the live provider runs. No FFI, no I/O, no clock: the
//! caller passes timestamps. Also keeps the raw-value diagnostics up to date.

use crate::decode::{STRING256_LEN, as_flag, bcd16_to_squawk, expand_f64, expand_str};
use crate::ffi::{self, period};
use std::collections::BTreeMap;
use std::sync::MutexGuard;
use vectasim_core::diag::{DefDiag, DiagEvent, HrDiag, RawDiag, SharedRawDiag, VarDiag};
use vectasim_core::telemetry::LBS_TO_KG;
use vectasim_core::{AircraftInfo, ProviderEvent, SimEvent, Telemetry};

pub const DEF_FAST: u32 = 1;
pub const DEF_SLOW: u32 = 2;
pub const DEF_STATIC: u32 = 3;
pub const REQ_FAST: u32 = 1;
pub const REQ_SLOW: u32 = 2;
pub const REQ_STATIC: u32 = 3;
/// Request id for `RequestSystemState("Sim")` (initial state query and watchdog probes).
pub const REQ_STATE_SIM: u32 = 100;

pub const EVT_PAUSE: u32 = 1;
pub const EVT_SIM: u32 = 2;
pub const EVT_CRASHED: u32 = 3;
pub const EVT_AIRCRAFT_LOADED: u32 = 4;
pub const EVT_FLIGHT_LOADED: u32 = 5;

pub const SYSTEM_EVENTS: &[(u32, &str)] = &[
    (EVT_PAUSE, "Pause"),
    (EVT_SIM, "Sim"),
    (EVT_CRASHED, "Crashed"),
    (EVT_AIRCRAFT_LOADED, "AircraftLoaded"),
    (EVT_FLIGHT_LOADED, "FlightLoaded"),
];

/// (SimVar name, unit) – all requested as FLOAT64 so the payload is a plain f64 array.
///
/// `SIM ON GROUND` can flicker for single frames (bounces, some add-on gear models,
/// frame hitches). It is passed through raw; debouncing (AGL ≤ 50 ft corroboration,
/// minimum ground samples) is the core's job (`vectasim-core` touchdown/phase).
///
/// `SIMULATION RATE` and `IS SLEW ACTIVE` live here (per sim frame) rather than in SLOW,
/// so slew/time-acceleration samples are flagged from the very first frame.
pub const FAST_VARS: &[(&str, &str)] = &[
    ("PLANE LATITUDE", "degrees"),
    ("PLANE LONGITUDE", "degrees"),
    ("PLANE ALTITUDE", "feet"),
    ("PLANE ALT ABOVE GROUND", "feet"),
    ("AIRSPEED INDICATED", "knots"),
    ("AIRSPEED TRUE", "knots"),
    ("GROUND VELOCITY", "knots"),
    ("VERTICAL SPEED", "feet per minute"),
    ("PLANE HEADING DEGREES MAGNETIC", "degrees"),
    ("PLANE HEADING DEGREES TRUE", "degrees"),
    ("PLANE PITCH DEGREES", "degrees"),
    ("PLANE BANK DEGREES", "degrees"),
    ("G FORCE", "gforce"),
    ("SIM ON GROUND", "bool"),
    ("PLANE TOUCHDOWN NORMAL VELOCITY", "feet per second"),
    ("SIMULATION RATE", "number"),
    ("IS SLEW ACTIVE", "bool"),
];
/// Unit of the converted value (Telemetry field) per FAST variable.
const FAST_OUT: [&str; 17] = ["°", "°", "ft", "ft", "kt", "kt", "kt", "fpm", "°", "°", "°", "°", "g", "bool", "fpm", "×", "bool"];

pub const SLOW_VARS: &[(&str, &str)] = &[
    ("GEAR TOTAL PCT EXTENDED", "percent"),
    ("FLAPS HANDLE INDEX", "number"),
    ("NUMBER OF ENGINES", "number"),
    ("GENERAL ENG COMBUSTION:1", "bool"),
    ("GENERAL ENG COMBUSTION:2", "bool"),
    ("GENERAL ENG COMBUSTION:3", "bool"),
    ("GENERAL ENG COMBUSTION:4", "bool"),
    ("FUEL TOTAL QUANTITY WEIGHT", "pounds"),
    ("TOTAL WEIGHT", "pounds"),
    ("BRAKE PARKING POSITION", "bool"),
    ("LIGHT BEACON", "bool"),
    ("LIGHT NAV", "bool"),
    ("LIGHT STROBE", "bool"),
    ("LIGHT LANDING", "bool"),
    ("LIGHT TAXI", "bool"),
    // raw BCD word (squawk 2000 → 0x2000); decoded with `bcd16_to_squawk`
    ("TRANSPONDER CODE:1", "bco16"),
    ("ZULU TIME", "seconds"),
];
const SLOW_OUT: [&str; 17] =
    ["%", "Index", "Anzahl", "bool", "bool", "bool", "bool", "kg", "kg", "bool", "bool", "bool", "bool", "bool", "bool", "Squawk", "s"];

/// Requested as STRING256 each (ATC MODEL/TYPE may come back as `TT:` localisation tokens).
pub const STATIC_VARS: &[&str] = &["TITLE", "ATC MODEL", "ATC TYPE", "ATC ID", "ATC AIRLINE", "ATC FLIGHT NUMBER"];

pub const IDX_FAST: usize = 0;
pub const IDX_SLOW: usize = 1;
pub const IDX_STATIC: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefKind {
    F64,
    Str256,
}

/// One data definition and which of its declared variables are currently registered.
#[derive(Debug, Clone)]
pub struct DefState {
    pub label: &'static str,
    pub id: u32,
    pub req: u32,
    pub period: u32,
    pub kind: DefKind,
    pub vars: Vec<(&'static str, Option<&'static str>)>,
    /// `false` once the sim rejected the variable; it is then left out of the definition.
    pub active: Vec<bool>,
    /// A short payload has been reported for this definition (once per session).
    pub warned_short: bool,
}

impl DefState {
    fn new(label: &'static str, id: u32, req: u32, period: u32, kind: DefKind, vars: Vec<(&'static str, Option<&'static str>)>) -> Self {
        let n = vars.len();
        Self { label, id, req, period, kind, vars, active: vec![true; n], warned_short: false }
    }

    pub fn n_active(&self) -> usize {
        self.active.iter().filter(|a| **a).count()
    }
}

pub fn definitions() -> Vec<DefState> {
    vec![
        DefState::new("FAST", DEF_FAST, REQ_FAST, period::SIM_FRAME, DefKind::F64, FAST_VARS.iter().map(|(v, u)| (*v, Some(*u))).collect()),
        DefState::new("SLOW", DEF_SLOW, REQ_SLOW, period::SECOND, DefKind::F64, SLOW_VARS.iter().map(|(v, u)| (*v, Some(*u))).collect()),
        DefState::new("STATIC", DEF_STATIC, REQ_STATIC, period::ONCE, DefKind::Str256, STATIC_VARS.iter().map(|v| (*v, None)).collect()),
    ]
}

/// Key of a definition in the dump header (`fast`/`slow`/`static`).
pub fn def_key(idx: usize) -> &'static str {
    ["fast", "slow", "static"].get(idx).copied().unwrap_or("?")
}

pub fn def_by_key(key: &str) -> Option<usize> {
    ["fast", "slow", "static"].iter().position(|k| k.eq_ignore_ascii_case(key))
}

pub fn event_name(id: u32) -> Option<&'static str> {
    SYSTEM_EVENTS.iter().find(|(i, _)| *i == id).map(|(_, n)| *n)
}

pub fn event_id(name: &str) -> Option<u32> {
    SYSTEM_EVENTS.iter().find(|(_, n)| *n == name).map(|(i, _)| *i)
}

/// Definitions as the dump header lists them.
pub fn dump_defs() -> vectasim_dump::Defs {
    vectasim_dump::Defs {
        fast: FAST_VARS.iter().map(|(n, u)| (n.to_string(), u.to_string())).collect(),
        slow: SLOW_VARS.iter().map(|(n, u)| (n.to_string(), u.to_string())).collect(),
        statics: STATIC_VARS.iter().map(|s| s.to_string()).collect(),
    }
}

pub fn dump_reqs() -> BTreeMap<String, u32> {
    [("fast".to_string(), REQ_FAST), ("slow".to_string(), REQ_SLOW), ("static".to_string(), REQ_STATIC)].into_iter().collect()
}

/// Text of the error a failed call is reported with.
pub fn hr_failed_message(call: &str, hr: ffi::HRESULT) -> String {
    format!("{call} failed hr=0x{hr:08X}")
}

fn period_name(p: u32) -> &'static str {
    match p {
        period::SIM_FRAME => "SIM_FRAME",
        period::SECOND => "SECOND",
        period::ONCE => "ONCE",
        period::VISUAL_FRAME => "VISUAL_FRAME",
        _ => "NEVER",
    }
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

fn flag(b: bool) -> f64 {
    if b { 1.0 } else { 0.0 }
}

/// The Telemetry value a FAST variable ends up as.
fn fast_value(t: &Telemetry, i: usize) -> f64 {
    match i {
        0 => t.latitude,
        1 => t.longitude,
        2 => t.altitude_msl_ft,
        3 => t.altitude_agl_ft,
        4 => t.ias_kt,
        5 => t.tas_kt,
        6 => t.ground_speed_kt,
        7 => t.vertical_speed_fpm,
        8 => t.heading_mag_deg,
        9 => t.heading_true_deg,
        10 => t.pitch_deg,
        11 => t.bank_deg,
        12 => t.g_force,
        13 => flag(t.on_ground),
        14 => t.touchdown_vs_fpm,
        15 => t.sim_rate,
        16 => flag(t.slew),
        _ => f64::NAN,
    }
}

fn slow_value(t: &Telemetry, i: usize, raw: f64) -> f64 {
    match i {
        0 => t.gear_pct,
        1 => f64::from(t.flaps_index),
        2 => f64::from(t.num_engines),
        // per-engine flag; Telemetry keeps the count of running engines
        3..=6 => as_flag(raw).map_or(f64::NAN, flag),
        7 => t.fuel_total_kg,
        8 => t.total_weight_kg,
        9 => flag(t.parking_brake),
        10 => flag(t.lights.beacon),
        11 => flag(t.lights.nav),
        12 => flag(t.lights.strobe),
        13 => flag(t.lights.landing),
        14 => flag(t.lights.taxi),
        15 => f64::from(t.transponder_code),
        16 => t.sim_zulu_time_s,
        _ => f64::NAN,
    }
}

/// See module doc.
pub struct Decoder {
    pub defs: Vec<DefState>,
    current: Telemetry,
    aircraft: AircraftInfo,
    diag: SharedRawDiag,
}

impl Decoder {
    /// A fresh session: all variables registered, telemetry at its defaults. The diagnostics
    /// keep their connection info and event log across sessions.
    pub fn new(diag: SharedRawDiag) -> Self {
        let defs = definitions();
        {
            let mut d = diag.lock().unwrap_or_else(|e| e.into_inner());
            d.defs = defs
                .iter()
                .enumerate()
                .map(|(idx, def)| DefDiag {
                    label: def.label.into(),
                    req: def.req,
                    period: period_name(def.period).into(),
                    vars: def
                        .vars
                        .iter()
                        .enumerate()
                        .map(|(i, (name, unit))| VarDiag {
                            name: (*name).into(),
                            unit: unit.map(str::to_owned),
                            active: true,
                            value_unit: match idx {
                                IDX_FAST => FAST_OUT.get(i).copied().unwrap_or(""),
                                IDX_SLOW => SLOW_OUT.get(i).copied().unwrap_or(""),
                                _ => "Text",
                            }
                            .into(),
                            ..Default::default()
                        })
                        .collect(),
                    ..Default::default()
                })
                .collect();
        }
        Self { defs, current: Telemetry::default(), aircraft: AircraftInfo::default(), diag }
    }

    pub fn diag(&self) -> &SharedRawDiag {
        &self.diag
    }

    pub fn telemetry(&self) -> &Telemetry {
        &self.current
    }

    fn lock_diag(&self) -> MutexGuard<'_, RawDiag> {
        self.diag.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn note(&self, wall_ms: u64, kind: &str, name: &str, data: Option<u32>, detail: String) {
        self.lock_diag().push_event(DiagEvent {
            wall_ms,
            kind: kind.into(),
            name: name.into(),
            data_hex: data.map(|d| format!("0x{d:08X}")),
            detail,
        });
    }

    /// Mark a declared variable as not registered (dump header `inactive`).
    pub fn mark_inactive(&mut self, def: usize, var: usize) {
        if let Some(a) = self.defs.get_mut(def).and_then(|d| d.active.get_mut(var)) {
            *a = false;
            if let Some(v) = self.lock_diag().defs.get_mut(def).and_then(|d| d.vars.get_mut(var)) {
                v.active = false;
            }
        }
    }

    pub fn def_by_req(&self, req: u32) -> Option<usize> {
        self.defs.iter().position(|d| d.req == req)
    }

    /// `SIMCONNECT_RECV_OPEN`.
    pub fn on_open(&mut self, sim_name: String, sim_version: String, simconnect_version: String, dll: Option<String>, wall_ms: u64) -> ProviderEvent {
        {
            let mut d = self.lock_diag();
            let c = &mut d.connection;
            c.sessions += 1;
            c.reconnects = c.sessions.saturating_sub(1);
            c.sim_name = Some(sim_name.clone());
            c.sim_version = Some(sim_version.clone());
            c.simconnect_version = Some(simconnect_version.clone());
            c.connected_wall_ms = Some(wall_ms);
            if dll.is_some() {
                c.dll = dll;
            }
        }
        self.note(wall_ms, "open", &sim_name, None, format!("{sim_name} {sim_version}, SimConnect {simconnect_version}"));
        ProviderEvent::Connected { sim_name, sim_version }
    }

    pub fn on_quit(&mut self, wall_ms: u64) {
        self.note(wall_ms, "quit", "Quit", None, "simulator quit".into());
    }

    /// The session is over (`reason` = what the provider reports with `Disconnected`).
    pub fn on_end(&mut self, reason: &str, wall_ms: u64) {
        self.note(wall_ms, "end", "Sitzungsende", None, reason.into());
    }

    /// A call returned a failure HRESULT (diagnostics only; the session reports it).
    pub fn on_hr(&mut self, call: &str, hr: ffi::HRESULT, wall_ms: u64) {
        let hr = format!("0x{hr:08X}");
        self.note(wall_ms, "hr", call, None, hr.clone());
        self.lock_diag().push_hr(HrDiag { wall_ms, call: call.into(), hr });
    }

    pub fn on_system_state(&mut self, req: u32, int: u32, wall_ms: u64) {
        if req == REQ_STATE_SIM {
            let mut d = self.lock_diag();
            let changed = d.connection.sim_state != Some(int);
            d.connection.sim_state = Some(int);
            drop(d);
            if changed {
                self.note(wall_ms, "systemState", "Sim", Some(int), format!("Sim={int}"));
            }
        }
    }

    /// FLOAT64 payload of request `req` as received (`payload_bytes`: its length).
    /// `ts_ms` stamps the telemetry; `src_ms` is the monotonic source time (rate).
    pub fn on_data_f64(&mut self, req: u32, raw: &[f64], payload_bytes: usize, ts_ms: u64, src_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        let Some(idx) = self.def_by_req(req) else { return Vec::new() };
        if self.defs[idx].kind != DefKind::F64 {
            return Vec::new();
        }
        let d = expand_f64(raw, &self.defs[idx].active);
        let mut out = Vec::new();
        if d.short {
            let expected = self.defs[idx].n_active() * 8;
            self.warn_short(idx, payload_bytes, expected, wall_ms, &mut out);
        }
        self.apply_values(idx, &d.values, ts_ms, src_ms, wall_ms, &mut out);
        out
    }

    /// FLOAT64 values already in declared order (replay of a dump with other definitions).
    pub fn on_values_f64(&mut self, idx: usize, values: &[f64], ts_ms: u64, src_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        let mut out = Vec::new();
        if self.defs.get(idx).is_some_and(|d| d.kind == DefKind::F64) {
            let mut v = values.to_vec();
            v.resize(self.defs[idx].vars.len(), f64::NAN);
            self.apply_values(idx, &v, ts_ms, src_ms, wall_ms, &mut out);
        }
        out
    }

    fn apply_values(&mut self, idx: usize, v: &[f64], ts_ms: u64, src_ms: u64, wall_ms: u64, out: &mut Vec<ProviderEvent>) {
        match idx {
            IDX_FAST => {
                self.apply_fast(v, ts_ms);
                out.push(ProviderEvent::Telemetry(self.current.clone()));
            }
            IDX_SLOW => self.apply_slow(v),
            _ => return,
        }
        let t = &self.current;
        let mut d = self.diag.lock().unwrap_or_else(|e| e.into_inner());
        let Some(def) = d.defs.get_mut(idx) else { return };
        def.updates += 1;
        def.last_wall_ms = Some(wall_ms);
        def.rate.push(src_ms);
        for (i, var) in def.vars.iter_mut().enumerate() {
            let raw = v.get(i).copied().unwrap_or(f64::NAN);
            var.raw = finite(raw);
            var.value = finite(if idx == IDX_FAST { fast_value(t, i) } else { slow_value(t, i, raw) });
        }
    }

    /// STRING256 payload of request `req`, one string per received slot.
    pub fn on_data_str(&mut self, req: u32, raw: &[String], payload_bytes: usize, src_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        let Some(idx) = self.def_by_req(req) else { return Vec::new() };
        if self.defs[idx].kind != DefKind::Str256 {
            return Vec::new();
        }
        let (s, short) = expand_str(raw, &self.defs[idx].active);
        let mut out = Vec::new();
        if short {
            let expected = self.defs[idx].n_active() * STRING256_LEN;
            self.warn_short(idx, payload_bytes, expected, wall_ms, &mut out);
        }
        self.apply_strings(idx, s, src_ms, wall_ms, &mut out);
        out
    }

    /// Strings already in declared order (replay of a dump with other definitions).
    pub fn on_values_str(&mut self, idx: usize, values: Vec<Option<String>>, src_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        let mut out = Vec::new();
        if self.defs.get(idx).is_some_and(|d| d.kind == DefKind::Str256) {
            self.apply_strings(idx, values, src_ms, wall_ms, &mut out);
        }
        out
    }

    fn apply_strings(&mut self, idx: usize, s: Vec<Option<String>>, src_ms: u64, wall_ms: u64, out: &mut Vec<ProviderEvent>) {
        if idx != IDX_STATIC {
            return;
        }
        let get = |i: usize| s.get(i).cloned().flatten().unwrap_or_default();
        let info = AircraftInfo {
            title: get(0),
            atc_model: get(1),
            atc_type: get(2),
            atc_id: get(3),
            atc_airline: get(4),
            atc_flight_number: get(5),
        };
        {
            let mut d = self.lock_diag();
            if let Some(def) = d.defs.get_mut(idx) {
                def.updates += 1;
                def.last_wall_ms = Some(wall_ms);
                def.rate.push(src_ms);
                for (i, var) in def.vars.iter_mut().enumerate() {
                    var.raw_text = s.get(i).cloned().flatten();
                    var.value_text = var.raw_text.clone();
                }
            }
        }
        if info != self.aircraft {
            self.aircraft = info.clone();
            out.push(ProviderEvent::Aircraft(info));
        }
    }

    fn warn_short(&mut self, idx: usize, got: usize, expected: usize, wall_ms: u64, out: &mut Vec<ProviderEvent>) {
        let d = &mut self.defs[idx];
        if d.warned_short {
            return;
        }
        d.warned_short = true;
        let msg = format!(
            "SimConnect payload for {} too short ({got} < {expected} bytes); missing fields read as NaN (reported once)",
            d.label
        );
        log::warn!("{msg}");
        self.note(wall_ms, "warning", self.defs[idx].label, None, msg.clone());
        out.push(ProviderEvent::Error { message: msg });
    }

    /// `SIMCONNECT_RECV_EVENT` of a subscribed system event.
    pub fn on_event(&mut self, event_id: u32, data: u32, wall_ms: u64) -> Vec<ProviderEvent> {
        let name = event_name(event_id).map_or_else(|| format!("#{event_id}"), str::to_owned);
        let ev = match event_id {
            EVT_PAUSE => {
                self.current.paused = data != 0;
                Some(SimEvent::Paused { paused: data != 0 })
            }
            EVT_SIM => Some(SimEvent::SimRunning { running: data != 0 }),
            EVT_CRASHED => Some(SimEvent::Crashed),
            _ => None,
        };
        let detail = ev.as_ref().map_or_else(|| "nicht abonniert".into(), |e| format!("{e:?}"));
        self.note(wall_ms, "event", &name, Some(data), detail);
        ev.map(ProviderEvent::Sim).into_iter().collect()
    }

    /// `SIMCONNECT_RECV_EVENT_FILENAME`. The caller re-requests STATIC on `AircraftLoaded`.
    pub fn on_filename(&mut self, event_id: u32, path: String, wall_ms: u64) -> Vec<ProviderEvent> {
        let name = event_name(event_id).map_or_else(|| format!("#{event_id}"), str::to_owned);
        self.note(wall_ms, "filename", &name, None, path.clone());
        match event_id {
            EVT_AIRCRAFT_LOADED => vec![ProviderEvent::Sim(SimEvent::AircraftLoaded { path })],
            EVT_FLIGHT_LOADED => vec![ProviderEvent::Sim(SimEvent::FlightLoaded { path })],
            _ => Vec::new(),
        }
    }

    /// `SIMCONNECT_RECV_EXCEPTION`. `call`: what the SendID belonged to; `added`: the
    /// (definition, variable) when that call was `AddToDataDefinition`. Returns the error
    /// event and whether the variable was dropped (the caller then rebuilds the definition).
    pub fn on_exception(
        &mut self,
        code: u32,
        send_id: u32,
        index: u32,
        call: Option<&str>,
        added: Option<(usize, usize)>,
        wall_ms: u64,
    ) -> (Vec<ProviderEvent>, bool) {
        let what = call.unwrap_or("an untracked call");
        let name = ffi::exception_name(code);
        let msg = format!("SimConnect exception {name} ({code}) on {what} (sendId={send_id} index={index})");
        log::warn!("{msg}");
        let mut dropped = false;
        if let Some((def, var)) = added
            && self.defs.get(def).is_some_and(|d| d.active.get(var).copied().unwrap_or(false))
        {
            self.defs[def].active[var] = false;
            dropped = true;
            log::warn!(
                "dropping SimVar \"{}\" from definition {} and re-registering it; the field keeps its previous/default value",
                self.defs[def].vars[var].0,
                self.defs[def].label
            );
            if let Some(v) = self.lock_diag().defs.get_mut(def).and_then(|d| d.vars.get_mut(var)) {
                v.active = false;
            }
        }
        let var = added.and_then(|(d, v)| self.defs.get(d).and_then(|d| d.vars.get(v))).map(|v| v.0);
        let detail = match (var, dropped) {
            (Some(v), true) => format!("{msg} → SimVar \"{v}\" entfernt"),
            _ => msg.clone(),
        };
        self.note(wall_ms, "exception", name, Some(code), detail);
        (vec![ProviderEvent::Error { message: msg }], dropped)
    }

    fn apply_fast(&mut self, v: &[f64], ts_ms: u64) {
        let t = &mut self.current;
        t.timestamp_ms = ts_ms;
        set(&mut t.latitude, v[0]);
        set(&mut t.longitude, v[1]);
        set(&mut t.altitude_msl_ft, v[2]);
        set(&mut t.altitude_agl_ft, v[3]);
        set(&mut t.ias_kt, v[4]);
        set(&mut t.tas_kt, v[5]);
        set(&mut t.ground_speed_kt, v[6]);
        set(&mut t.vertical_speed_fpm, v[7]);
        set(&mut t.heading_mag_deg, v[8]);
        set(&mut t.heading_true_deg, v[9]);
        set(&mut t.pitch_deg, v[10]);
        set(&mut t.bank_deg, v[11]);
        set(&mut t.g_force, v[12]);
        set_flag(&mut t.on_ground, v[13]);
        set(&mut t.touchdown_vs_fpm, v[14] * 60.0);
        set(&mut t.sim_rate, v[15]);
        set_flag(&mut t.slew, v[16]);
    }

    fn apply_slow(&mut self, v: &[f64]) {
        let t = &mut self.current;
        set(&mut t.gear_pct, v[0]);
        if v[1].is_finite() {
            t.flaps_index = v[1] as i32;
        }
        if v[2].is_finite() {
            t.num_engines = v[2].clamp(0.0, 4.0) as u8;
        }
        t.engines_running =
            v[3..7].iter().take(t.num_engines as usize).filter(|x| as_flag(**x).unwrap_or(false)).count() as u8;
        set(&mut t.fuel_total_kg, v[7] * LBS_TO_KG);
        set(&mut t.total_weight_kg, v[8] * LBS_TO_KG);
        set_flag(&mut t.parking_brake, v[9]);
        let mut lights = t.lights;
        set_flag(&mut lights.beacon, v[10]);
        set_flag(&mut lights.nav, v[11]);
        set_flag(&mut lights.strobe, v[12]);
        set_flag(&mut lights.landing, v[13]);
        set_flag(&mut lights.taxi, v[14]);
        t.lights = lights;
        if let Some(sq) = bcd16_to_squawk(v[15]) {
            t.transponder_code = sq;
        }
        set(&mut t.sim_zulu_time_s, v[16]);
    }
}

/// Update a field only with a real value; NaN (rejected/missing SimVar) keeps the previous/default one.
fn set(dst: &mut f64, v: f64) {
    if v.is_finite() {
        *dst = v;
    }
}

fn set_flag(dst: &mut bool, v: f64) {
    if let Some(b) = as_flag(v) {
        *dst = b;
    }
}

/// Inverse of the FAST conversion: the raw values a sim would send for `t` (used to turn
/// the mock flight into a `.vsdump`).
pub fn encode_fast(t: &Telemetry) -> Vec<f64> {
    vec![
        t.latitude,
        t.longitude,
        t.altitude_msl_ft,
        t.altitude_agl_ft,
        t.ias_kt,
        t.tas_kt,
        t.ground_speed_kt,
        t.vertical_speed_fpm,
        t.heading_mag_deg,
        t.heading_true_deg,
        t.pitch_deg,
        t.bank_deg,
        t.g_force,
        flag(t.on_ground),
        t.touchdown_vs_fpm / 60.0,
        t.sim_rate,
        flag(t.slew),
    ]
}

/// Inverse of the SLOW conversion (squawk back to its BCD word).
pub fn encode_slow(t: &Telemetry) -> Vec<f64> {
    let digits = t.transponder_code.min(7777);
    let bcd = ((digits / 1000 % 10) << 12) | ((digits / 100 % 10) << 8) | ((digits / 10 % 10) << 4) | (digits % 10);
    let mut v = vec![t.gear_pct, f64::from(t.flaps_index), f64::from(t.num_engines)];
    v.extend((0..4u8).map(|i| flag(i < t.engines_running)));
    v.extend([
        t.fuel_total_kg / LBS_TO_KG,
        t.total_weight_kg / LBS_TO_KG,
        flag(t.parking_brake),
        flag(t.lights.beacon),
        flag(t.lights.nav),
        flag(t.lights.strobe),
        flag(t.lights.landing),
        flag(t.lights.taxi),
        f64::from(bcd),
        t.sim_zulu_time_s,
    ]);
    v
}

pub fn encode_static(a: &AircraftInfo) -> Vec<String> {
    vec![a.title.clone(), a.atc_model.clone(), a.atc_type.clone(), a.atc_id.clone(), a.atc_airline.clone(), a.atc_flight_number.clone()]
}
