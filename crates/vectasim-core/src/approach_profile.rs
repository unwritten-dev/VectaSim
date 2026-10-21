//! Assessment profiles for the approach analysis: a small set of parameters laid over
//! [`ApproachConfig::default`] (the "generic" FSF/EASA profile). Only the parameters that
//! differ are stored. Every built-in value traces to a row in
//! `docs/approach-profiles-sources.md`; the format users can import is described in
//! `docs/approach-profiles.md` and is the same as [`CustomProfileDoc`].
//!
//! Which profile assesses a flight: the airframe's choice in the fleet, else the ICAO type
//! ([`profile_for_type`]), else the engine type the sim reported (piston → GA piston,
//! turboprop → turboprop, jet → generic), else generic ([`resolve`]).
//!
//! Reference speed: D4S defines its speed levels against VREF; VectaSim applies every speed
//! threshold to Vapp (≈ VREF + 5 kt). That convention is the same in every profile.

use crate::Lang;
use crate::approach::ApproachConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const GENERIC: &str = "generic";
pub const AIRBUS: &str = "airbus";
pub const BOEING: &str = "boeing";
pub const TURBOPROP: &str = "turboprop";
pub const GA_PISTON: &str = "ga_piston";

/// Most custom profiles kept in the settings.
pub const CUSTOM_MAX: usize = 50;
/// Largest custom profile file accepted, bytes.
pub const CUSTOM_MAX_BYTES: usize = 16 * 1024;
pub const NAME_MAX_CHARS: usize = 60;
pub const SOURCE_MAX_CHARS: usize = 500;

/// One overridden value: a number, or a switch (`thrustCheck`).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OverrideValue {
    Bool(bool),
    Number(f64),
}

/// What kind of value a key takes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KeyKind {
    Number { min: f64, max: f64, unit: &'static str },
    Bool,
}

/// One parameter a profile may override (the JSON key is the `ApproachConfig` field in camelCase).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideKey {
    pub key: &'static str,
    #[serde(flatten)]
    pub kind: KeyKind,
}

const fn num(key: &'static str, min: f64, max: f64, unit: &'static str) -> OverrideKey {
    OverrideKey { key, kind: KeyKind::Number { min, max, unit } }
}

/// Every key a profile may set, with its allowed range. Anything else is refused.
pub const OVERRIDE_KEYS: &[OverrideKey] = &[
    // gates (1000 / 500 ft)
    num("gateSpeedAboveKt", 0.0, 40.0, "kt"),
    num("gateSpeedBelowKt", 0.0, 20.0, "kt"),
    num("gateMaxVsFpm", 500.0, 2000.0, "fpm"),
    num("gateMaxBankDeg", 5.0, 45.0, "°"),
    num("gateDots", 0.25, 3.0, "dots"),
    // continuous checks S1/S2 with their minimum durations
    num("speedS1AboveKt", 3.0, 50.0, "kt"),
    num("speedS1BelowKt", 0.0, 20.0, "kt"),
    num("speedS2AboveKt", 5.0, 60.0, "kt"),
    num("speedS2BelowKt", 0.0, 30.0, "kt"),
    num("speedDurationS", 1.0, 30.0, "s"),
    num("vsS1Fpm", 500.0, 2500.0, "fpm"),
    num("vsS2Fpm", 500.0, 3000.0, "fpm"),
    num("vsS1DurationS", 1.0, 30.0, "s"),
    num("vsS2DurationS", 1.0, 30.0, "s"),
    num("bankS1Deg", 5.0, 45.0, "°"),
    num("bankS2Deg", 10.0, 60.0, "°"),
    num("bankDurationS", 1.0, 30.0, "s"),
    num("gsS1Dots", 0.25, 3.0, "dots"),
    num("gsS2Dots", 0.5, 4.0, "dots"),
    num("gsDurationS", 1.0, 30.0, "s"),
    num("locS1Dots", 0.25, 3.0, "dots"),
    num("locS2Dots", 0.5, 4.0, "dots"),
    num("locDurationS", 1.0, 30.0, "s"),
    num("momentaryS", 0.0, 10.0, "s"),
    // heights
    num("configGateFt", 300.0, 1500.0, "ft"),
    num("hardGateFt", 100.0, 1000.0, "ft"),
    num("windowTopFt", 500.0, 1500.0, "ft"),
    // thrust, spoilers, statistics
    OverrideKey { key: "thrustCheck", kind: KeyKind::Bool },
    num("thrustMinN1Pct", 10.0, 80.0, "%"),
    num("thrustDurationS", 1.0, 30.0, "s"),
    num("spoilersMaxPct", 0.0, 50.0, "%"),
    num("statsSpeedAboveKt", 3.0, 30.0, "kt"),
    num("statsSpeedBelowKt", 0.0, 20.0, "kt"),
];

pub fn override_key(key: &str) -> Option<&'static OverrideKey> {
    OVERRIDE_KEYS.iter().find(|k| k.key == key)
}

/// The numeric field behind a key (None: unknown key or `thrustCheck`).
fn slot<'a>(cfg: &'a mut ApproachConfig, key: &str) -> Option<&'a mut f64> {
    Some(match key {
        "gateSpeedAboveKt" => &mut cfg.gate_speed_above_kt,
        "gateSpeedBelowKt" => &mut cfg.gate_speed_below_kt,
        "gateMaxVsFpm" => &mut cfg.gate_max_vs_fpm,
        "gateMaxBankDeg" => &mut cfg.gate_max_bank_deg,
        "gateDots" => &mut cfg.gate_dots,
        "speedS1AboveKt" => &mut cfg.speed_s1_above_kt,
        "speedS1BelowKt" => &mut cfg.speed_s1_below_kt,
        "speedS2AboveKt" => &mut cfg.speed_s2_above_kt,
        "speedS2BelowKt" => &mut cfg.speed_s2_below_kt,
        "speedDurationS" => &mut cfg.speed_duration_s,
        "vsS1Fpm" => &mut cfg.vs_s1_fpm,
        "vsS2Fpm" => &mut cfg.vs_s2_fpm,
        "vsS1DurationS" => &mut cfg.vs_s1_duration_s,
        "vsS2DurationS" => &mut cfg.vs_s2_duration_s,
        "bankS1Deg" => &mut cfg.bank_s1_deg,
        "bankS2Deg" => &mut cfg.bank_s2_deg,
        "bankDurationS" => &mut cfg.bank_duration_s,
        "gsS1Dots" => &mut cfg.gs_s1_dots,
        "gsS2Dots" => &mut cfg.gs_s2_dots,
        "gsDurationS" => &mut cfg.gs_duration_s,
        "locS1Dots" => &mut cfg.loc_s1_dots,
        "locS2Dots" => &mut cfg.loc_s2_dots,
        "locDurationS" => &mut cfg.loc_duration_s,
        "momentaryS" => &mut cfg.momentary_s,
        "configGateFt" => &mut cfg.config_gate_ft,
        "hardGateFt" => &mut cfg.hard_gate_ft,
        "windowTopFt" => &mut cfg.window_top_ft,
        "thrustMinN1Pct" => &mut cfg.thrust_min_n1_pct,
        "thrustDurationS" => &mut cfg.thrust_duration_s,
        "spoilersMaxPct" => &mut cfg.spoilers_max_pct,
        "statsSpeedAboveKt" => &mut cfg.stats_speed_above_kt,
        "statsSpeedBelowKt" => &mut cfg.stats_speed_below_kt,
        _ => return None,
    })
}

/// Write one (validated) value into `cfg`; false for an unknown key or the wrong type.
fn apply(cfg: &mut ApproachConfig, key: &str, v: OverrideValue) -> bool {
    match v {
        OverrideValue::Bool(b) if key == "thrustCheck" => {
            cfg.thrust_check = b;
            true
        }
        OverrideValue::Bool(_) => false,
        OverrideValue::Number(n) => slot(cfg, key).map(|s| *s = n).is_some(),
    }
}

/// A profile: id, display name and the values that differ from its base.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachProfile {
    pub id: String,
    pub name: String,
    /// Custom profiles: the built-in profile the overrides apply over (None = generic).
    /// Built-ins: None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on: Option<String>,
    /// Where the values come from (free text for custom profiles; the source keys of
    /// `docs/approach-profiles-sources.md` for the built-ins).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Overridden parameters (keys of [`OVERRIDE_KEYS`]).
    #[serde(default)]
    pub overrides: BTreeMap<String, OverrideValue>,
    /// Built-ins: the source row per overridden key.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sources: BTreeMap<String, String>,
    #[serde(default)]
    pub builtin: bool,
}

impl ApproachProfile {
    /// The effective thresholds: the default, the base profile's overrides (custom profiles),
    /// then this profile's own; `profile_id` names this profile.
    pub fn config(&self) -> ApproachConfig {
        let mut cfg = ApproachConfig::default();
        if !self.builtin
            && let Some(base) = self.based_on.as_deref().and_then(builtin)
        {
            for (k, v) in &base.overrides {
                apply(&mut cfg, k, *v);
            }
        }
        for (k, v) in &self.overrides {
            apply(&mut cfg, k, *v);
        }
        cfg.profile_id = self.id.clone();
        cfg
    }

    /// The effective values that differ from the generic profile (base included), in the
    /// order of [`OVERRIDE_KEYS`] – what the UI lists.
    pub fn effective_overrides(&self) -> Vec<(&'static str, OverrideValue)> {
        let (cfg, generic) = (self.config(), ApproachConfig::default());
        OVERRIDE_KEYS
            .iter()
            .filter_map(|k| Some((k.key, value_of(&cfg, k.key)?)))
            .filter(|(k, v)| value_of(&generic, k) != Some(*v))
            .collect()
    }
}

/// The current value of a key in `cfg` (None: unknown key).
pub fn value_of(cfg: &ApproachConfig, key: &str) -> Option<OverrideValue> {
    if key == "thrustCheck" {
        return Some(OverrideValue::Bool(cfg.thrust_check));
    }
    let mut c = cfg.clone();
    slot(&mut c, key).map(|v| OverrideValue::Number(*v))
}

// ---- built-ins ---------------------------------------------------------------------------

struct Builtin {
    id: &'static str,
    name: &'static str,
    source: &'static str,
    /// (key, value, source row in docs/approach-profiles-sources.md)
    overrides: &'static [(&'static str, OverrideValue, &'static str)],
}

/// The built-in profiles (docs/approach-profiles-sources.md, "Recommended profiles").
const BUILTINS: &[Builtin] = &[
    Builtin {
        id: GENERIC,
        name: "Generic (FSF/EASA)",
        source: "P0: FSF ALAR BN 7.1, EASA AMC1/GM1 CAT.OP.MPA.115, EASA Data4Safety",
        overrides: &[],
    },
    Builtin {
        id: AIRBUS,
        name: "Airbus-style",
        source: "P1: Airbus FOBN Flying Stabilized Approaches (AB-STAB), Table 4",
        // the Airbus 7° bank figure is a callout, not a stabilisation limit: bank stays 15°
        overrides: &[("gateSpeedAboveKt", OverrideValue::Number(10.0), "AB-STAB Table 4: VAPP −5 / +10 kt")],
    },
    Builtin {
        id: BOEING,
        name: "Boeing-style",
        source: "P2: no public Boeing values (BOE-AERO defers to the FSF ALAR tool kit); identical to generic",
        overrides: &[],
    },
    Builtin {
        id: TURBOPROP,
        name: "Turboprop / regional",
        source: "P3: ATR Flight Safety 2021 (±5 kt); thrust check off (VectaSim convention)",
        overrides: &[
            ("gateSpeedAboveKt", OverrideValue::Number(5.0), "ATR 2021: ±5 kt"),
            ("thrustCheck", OverrideValue::Bool(false), "VectaSim convention: turboprop gas-generator N1 stays high at flight idle"),
        ],
    },
    Builtin {
        id: GA_PISTON,
        name: "GA piston",
        source: "P4: FAA Airplane Flying Handbook ch. 9 (AFH9), FSF go-around study 2017",
        overrides: &[
            ("gateSpeedAboveKt", OverrideValue::Number(10.0), "AFH9 p. 9-6: +10 / −5 KIAS"),
            ("speedS1AboveKt", OverrideValue::Number(10.0), "AFH9 tolerance (S1 = AFH limit, VectaSim convention)"),
            ("speedS2AboveKt", OverrideValue::Number(20.0), "VectaSim convention: 2 × S1"),
            ("vsS1Fpm", OverrideValue::Number(1000.0), "AFH9: 500–1000 fpm (VectaSim convention)"),
            ("vsS2Fpm", OverrideValue::Number(1200.0), "VectaSim convention"),
            ("configGateFt", OverrideValue::Number(500.0), "AFH9: 500 ft VMC gate, full flaps once on final (VMC assumed)"),
            ("hardGateFt", OverrideValue::Number(300.0), "AFH9 / FSF-GA: go around if unstable below 300 ft AGL"),
        ],
    },
];

fn to_profile(b: &Builtin) -> ApproachProfile {
    ApproachProfile {
        id: b.id.to_string(),
        name: b.name.to_string(),
        based_on: None,
        source: Some(b.source.to_string()),
        overrides: b.overrides.iter().map(|(k, v, _)| (k.to_string(), *v)).collect(),
        sources: b.overrides.iter().map(|(k, _, s)| (k.to_string(), s.to_string())).collect(),
        builtin: true,
    }
}

/// All built-in profiles, generic first.
pub fn builtins() -> Vec<ApproachProfile> {
    BUILTINS.iter().map(to_profile).collect()
}

/// One built-in profile by id.
pub fn builtin(id: &str) -> Option<ApproachProfile> {
    BUILTINS.iter().find(|b| b.id == id).map(to_profile)
}

pub fn is_builtin(id: &str) -> bool {
    BUILTINS.iter().any(|b| b.id == id)
}

/// The generic profile (= `ApproachConfig::default()`).
pub fn generic() -> ApproachProfile {
    builtin(GENERIC).unwrap_or_else(|| to_profile(&BUILTINS[0]))
}

// ---- type mapping --------------------------------------------------------------------------

/// Engine type as the sim reports it (`ENGINE TYPE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineClass {
    Piston,
    Turboprop,
    Jet,
}

const AIRBUS_TYPES: &[&str] = &[
    "A318", "A319", "A320", "A321", "A19N", "A20N", "A21N", "A332", "A333", "A337", "A338", "A339", "A342", "A343", "A345", "A346", "A359",
    "A35K", "A388", "A306", "A30B", "A310", "BCS1", "BCS3",
];
const BOEING_TYPES: &[&str] = &[
    "B712", "B37M", "B38M", "B39M", "B3XM", "B741", "B742", "B743", "B744", "B748", "B74S", "B752", "B753", "B762", "B763", "B764", "B772",
    "B773", "B77L", "B77W", "B778", "B779", "B788", "B789", "B78X", "DC10", "MD11", "MD81", "MD82", "MD83", "MD87", "MD88", "MD90",
];
const TURBOPROP_TYPES: &[&str] = &[
    "AT43", "AT44", "AT45", "AT46", "AT72", "AT73", "AT75", "AT76", "DH8A", "DH8B", "DH8C", "DH8D", "SF34", "JS31", "JS32", "JS41", "D328",
    "F50", "B190", "DHC6", "BE20", "BE30", "BE9L",
];
/// Single-engine turboprops: flown like light aircraft, single pilot (sources doc: P4).
const SINGLE_TURBOPROP_TYPES: &[&str] = &["PC12", "TBM7", "TBM8", "TBM9", "C208", "KODI", "M600"];
const GA_PISTON_TYPES: &[&str] = &[
    "C150", "C152", "C172", "C177", "C182", "C206", "C210", "P28A", "P28B", "P28R", "P32R", "PA34", "PA44", "PA46", "SR20", "SR22", "S22T",
    "DA20", "DV20", "DA40", "DA42", "DA62", "BE33", "BE35", "BE36", "BE55", "BE58", "M20P", "M20T", "AA5", "TB20",
];
/// Explicitly generic (E-jets, ERJ, CRJ, business jets): listed so they never fall to the engine fallback.
const GENERIC_TYPES: &[&str] = &[
    "E170", "E75S", "E75L", "E190", "E195", "E290", "E295", "E135", "E35L", "E145", "E45X", "CRJ1", "CRJ2", "CRJ7", "CRJ9", "CRJX", "C25A",
    "C25B", "C25C", "C25M", "C510", "C525", "C550", "C560", "C56X", "C680", "C68A", "C700", "C750", "CL30", "CL35", "CL60", "GLEX", "GL5T",
    "GL7T", "G150", "G280", "GLF4", "GLF5", "GLF6", "LJ35", "LJ45", "LJ60", "E50P", "E55P", "E545", "E550", "FA7X", "FA8X", "F900", "F2TH",
    "PRM1", "HDJT", "PC24", "SF50",
];

/// Profile of an ICAO type designator alone (None: not in the table).
fn profile_of_designator(icao: &str) -> Option<&'static str> {
    let t = icao.trim().to_ascii_uppercase();
    let t = t.as_str();
    let has = |list: &[&str]| list.contains(&t);
    if has(AIRBUS_TYPES) {
        return Some(AIRBUS);
    }
    // Boeing 7x7 (B732…B739 and any other B7xx designator) and the 717
    if has(BOEING_TYPES) || (t.len() == 4 && t.starts_with("B7") && t[2..].chars().all(|c| c.is_ascii_alphanumeric())) {
        return Some(BOEING);
    }
    if has(TURBOPROP_TYPES) {
        return Some(TURBOPROP);
    }
    if has(GA_PISTON_TYPES) || has(SINGLE_TURBOPROP_TYPES) {
        return Some(GA_PISTON);
    }
    if has(GENERIC_TYPES) {
        return Some(GENERIC);
    }
    None
}

/// The built-in profile for an aircraft: its ICAO type designator from the table, else the
/// engine type (piston → GA piston; turboprop → turboprop, a single turboprop → GA piston;
/// jet → generic), else generic.
pub fn profile_for_type(icao_type: Option<&str>, engine: Option<EngineClass>, engine_count: Option<u32>) -> &'static str {
    if let Some(p) = icao_type.and_then(profile_of_designator) {
        return p;
    }
    match engine {
        Some(EngineClass::Piston) => GA_PISTON,
        Some(EngineClass::Turboprop) if engine_count == Some(1) => GA_PISTON,
        Some(EngineClass::Turboprop) => TURBOPROP,
        Some(EngineClass::Jet) | None => GENERIC,
    }
}

/// Where the profile of a flight came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileOrigin {
    /// Chosen for the airframe in the fleet.
    Airframe,
    /// ICAO type designator.
    Type,
    /// Engine type reported by the sim.
    Engine,
    /// Nothing known.
    Default,
}

/// The profile a flight is assessed with: the airframe's choice (a built-in or one of
/// `custom`; an id that no longer exists is ignored), else [`profile_for_type`].
pub fn resolve(
    airframe_choice: Option<&str>,
    icao_type: Option<&str>,
    engine: Option<EngineClass>,
    engine_count: Option<u32>,
    custom: &[ApproachProfile],
) -> (ApproachProfile, ProfileOrigin) {
    if let Some(id) = airframe_choice.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(p) = builtin(id) {
            return (p, ProfileOrigin::Airframe);
        }
        if let Some(p) = custom.iter().find(|p| p.id == id) {
            return (p.clone(), ProfileOrigin::Airframe);
        }
    }
    let origin = if icao_type.and_then(profile_of_designator).is_some() {
        ProfileOrigin::Type
    } else if engine.is_some() {
        ProfileOrigin::Engine
    } else {
        ProfileOrigin::Default
    };
    (builtin(profile_for_type(icao_type, engine, engine_count)).unwrap_or_else(generic), origin)
}

// ---- custom profiles -----------------------------------------------------------------------

/// The import format (`docs/approach-profiles.md`). Unknown top-level keys are refused.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomProfileDoc {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub based_on: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub overrides: BTreeMap<String, OverrideValue>,
}

/// Why a custom profile was refused.
#[derive(Clone, Debug, PartialEq)]
pub enum ProfileError {
    /// Not the expected JSON shape (the parser's text).
    Format {
        detail: String,
    },
    TooLarge {
        max_bytes: usize,
    },
    IdInvalid {
        id: String,
    },
    IdReserved {
        id: String,
    },
    NameInvalid {
        max: usize,
    },
    SourceTooLong {
        max: usize,
    },
    BasedOnUnknown {
        based_on: String,
    },
    UnknownKey {
        key: String,
    },
    WrongType {
        key: String,
    },
    OutOfRange {
        key: String,
        value: f64,
        min: f64,
        max: f64,
    },
    /// `key` must not be below / above `other` (S2 at least S1, hard gate at most the window top).
    Inconsistent {
        key: String,
        other: String,
    },
    TooMany {
        max: usize,
    },
}

fn n(lang: Lang, v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{v:.0}") } else { lang.decimal(v, 2) }
}

impl ProfileError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Format { .. } => "format",
            Self::TooLarge { .. } => "tooLarge",
            Self::IdInvalid { .. } => "idInvalid",
            Self::IdReserved { .. } => "idReserved",
            Self::NameInvalid { .. } => "nameInvalid",
            Self::SourceTooLong { .. } => "sourceTooLong",
            Self::BasedOnUnknown { .. } => "basedOnUnknown",
            Self::UnknownKey { .. } => "unknownKey",
            Self::WrongType { .. } => "wrongType",
            Self::OutOfRange { .. } => "outOfRange",
            Self::Inconsistent { .. } => "inconsistent",
            Self::TooMany { .. } => "tooMany",
        }
    }

    /// The reason in `lang`.
    pub fn message(&self, lang: Lang) -> String {
        let de = lang == Lang::De;
        match self {
            Self::Format { detail } => {
                if de {
                    format!("keine gültige Profildatei: {detail}")
                } else {
                    format!("not a valid profile file: {detail}")
                }
            }
            Self::TooLarge { max_bytes } => {
                if de {
                    format!("Datei zu groß (höchstens {} KB)", max_bytes / 1024)
                } else {
                    format!("file too large (at most {} KB)", max_bytes / 1024)
                }
            }
            Self::IdInvalid { id } => {
                if de {
                    format!("„id“ „{id}“ ungültig: 2–40 Zeichen, Kleinbuchstaben, Ziffern, - und _")
                } else {
                    format!("\"id\" \"{id}\" is invalid: 2–40 characters, lower-case letters, digits, - and _")
                }
            }
            Self::IdReserved { id } => {
                if de {
                    format!("„id“ „{id}“ ist ein eingebautes Profil")
                } else {
                    format!("\"id\" \"{id}\" is a built-in profile")
                }
            }
            Self::NameInvalid { max } => {
                if de {
                    format!("„name“ fehlt oder ist länger als {max} Zeichen")
                } else {
                    format!("\"name\" is missing or longer than {max} characters")
                }
            }
            Self::SourceTooLong { max } => {
                if de {
                    format!("„source“ ist länger als {max} Zeichen")
                } else {
                    format!("\"source\" is longer than {max} characters")
                }
            }
            Self::BasedOnUnknown { based_on } => {
                let ids = BUILTINS.iter().map(|b| b.id).collect::<Vec<_>>().join(", ");
                if de {
                    format!("„basedOn“ „{based_on}“ ist kein eingebautes Profil ({ids})")
                } else {
                    format!("\"basedOn\" \"{based_on}\" is not a built-in profile ({ids})")
                }
            }
            Self::UnknownKey { key } => {
                if de {
                    format!("unbekannter Wert „{key}“ in „overrides“")
                } else {
                    format!("unknown key \"{key}\" in \"overrides\"")
                }
            }
            Self::WrongType { key } => {
                if de {
                    format!("„{key}“: falscher Typ (Zahl bzw. true/false erwartet)")
                } else {
                    format!("\"{key}\": wrong type (number or true/false expected)")
                }
            }
            Self::OutOfRange { key, value, min, max } => {
                let (v, a, b) = (n(lang, *value), n(lang, *min), n(lang, *max));
                if de {
                    format!("„{key}“ = {v} liegt außerhalb von {a}–{b}")
                } else {
                    format!("\"{key}\" = {v} is outside {a}–{b}")
                }
            }
            Self::Inconsistent { key, other } => {
                if de {
                    format!("„{key}“ passt nicht zu „{other}“")
                } else {
                    format!("\"{key}\" does not fit \"{other}\"")
                }
            }
            Self::TooMany { max } => {
                if de {
                    format!("höchstens {max} eigene Profile")
                } else {
                    format!("at most {max} custom profiles")
                }
            }
        }
    }
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message(Lang::En))
    }
}

fn valid_id(id: &str) -> bool {
    let len = id.chars().count();
    (2..=40).contains(&len)
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Check a parsed custom profile and turn it into a profile (trimmed texts, `basedOn`
/// defaulting to generic). The effective config must be consistent.
pub fn validate(doc: CustomProfileDoc) -> Result<ApproachProfile, ProfileError> {
    let id = doc.id.trim().to_string();
    if !valid_id(&id) {
        return Err(ProfileError::IdInvalid { id });
    }
    if is_builtin(&id) {
        return Err(ProfileError::IdReserved { id });
    }
    let name = doc.name.trim().to_string();
    if name.is_empty() || name.chars().count() > NAME_MAX_CHARS || name.chars().any(char::is_control) {
        return Err(ProfileError::NameInvalid { max: NAME_MAX_CHARS });
    }
    let source = doc.source.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if source.as_ref().is_some_and(|s| s.chars().count() > SOURCE_MAX_CHARS) {
        return Err(ProfileError::SourceTooLong { max: SOURCE_MAX_CHARS });
    }
    let based_on = doc.based_on.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| GENERIC.to_string());
    if !is_builtin(&based_on) {
        return Err(ProfileError::BasedOnUnknown { based_on });
    }
    for (key, v) in &doc.overrides {
        let Some(spec) = override_key(key) else { return Err(ProfileError::UnknownKey { key: key.clone() }) };
        match (spec.kind, v) {
            (KeyKind::Bool, OverrideValue::Bool(_)) => {}
            (KeyKind::Number { min, max, .. }, OverrideValue::Number(x)) => {
                if !x.is_finite() || *x < min || *x > max {
                    return Err(ProfileError::OutOfRange { key: key.clone(), value: *x, min, max });
                }
            }
            _ => return Err(ProfileError::WrongType { key: key.clone() }),
        }
    }
    let p =
        ApproachProfile { id, name, based_on: Some(based_on), source, overrides: doc.overrides, sources: BTreeMap::new(), builtin: false };
    check_consistent(&p.config())?;
    Ok(p)
}

/// S2 levels at least S1, the hard gate not above the band window top.
fn check_consistent(c: &ApproachConfig) -> Result<(), ProfileError> {
    let pairs: [(&str, f64, &str, f64); 7] = [
        ("speedS2AboveKt", c.speed_s2_above_kt, "speedS1AboveKt", c.speed_s1_above_kt),
        ("speedS2BelowKt", c.speed_s2_below_kt, "speedS1BelowKt", c.speed_s1_below_kt),
        ("vsS2Fpm", c.vs_s2_fpm, "vsS1Fpm", c.vs_s1_fpm),
        ("bankS2Deg", c.bank_s2_deg, "bankS1Deg", c.bank_s1_deg),
        ("gsS2Dots", c.gs_s2_dots, "gsS1Dots", c.gs_s1_dots),
        ("locS2Dots", c.loc_s2_dots, "locS1Dots", c.loc_s1_dots),
        ("windowTopFt", c.window_top_ft, "hardGateFt", c.hard_gate_ft),
    ];
    for (key, hi, other, lo) in pairs {
        if hi + 1e-9 < lo {
            return Err(ProfileError::Inconsistent { key: key.into(), other: other.into() });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str) -> ApproachConfig {
        builtin(id).unwrap().config()
    }

    #[test]
    fn generic_and_boeing_are_the_default() {
        let d = ApproachConfig::default();
        assert_eq!(d.profile_id, GENERIC);
        assert_eq!(cfg(GENERIC), d);
        let b = cfg(BOEING);
        assert_eq!(b.profile_id, BOEING);
        assert_eq!(ApproachConfig { profile_id: GENERIC.into(), ..b }, d);
        assert!(builtin(BOEING).unwrap().effective_overrides().is_empty());
    }

    #[test]
    fn airbus_only_narrows_the_gate_speed() {
        let c = cfg(AIRBUS);
        let d = ApproachConfig::default();
        assert_eq!(c.gate_speed_above_kt, 10.0);
        assert_eq!(c.gate_speed_below_kt, 5.0);
        // the Airbus 7° bank callout is not used: bank stays 15°
        assert_eq!(c.gate_max_bank_deg, 15.0);
        assert_eq!(ApproachConfig { gate_speed_above_kt: d.gate_speed_above_kt, profile_id: GENERIC.into(), ..c }, d);
    }

    #[test]
    fn turboprop_disables_the_thrust_check() {
        let c = cfg(TURBOPROP);
        let d = ApproachConfig::default();
        assert_eq!(c.gate_speed_above_kt, 5.0);
        assert!(!c.thrust_check);
        assert_eq!(c.thrust_min_n1_pct, d.thrust_min_n1_pct);
        assert_eq!(ApproachConfig { gate_speed_above_kt: 20.0, thrust_check: true, profile_id: GENERIC.into(), ..c }, d);
    }

    #[test]
    fn ga_piston_values() {
        let c = cfg(GA_PISTON);
        assert_eq!(
            (c.gate_speed_above_kt, c.speed_s1_above_kt, c.speed_s2_above_kt, c.vs_s1_fpm, c.vs_s2_fpm, c.config_gate_ft, c.hard_gate_ft),
            (10.0, 10.0, 20.0, 1000.0, 1200.0, 500.0, 300.0)
        );
        assert_eq!((c.window_top_ft, c.gate_max_bank_deg, c.speed_s1_below_kt, c.speed_s2_below_kt), (1000.0, 15.0, 5.0, 10.0));
        assert!(c.thrust_check);
        let keys: Vec<&str> = builtin(GA_PISTON).unwrap().effective_overrides().iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["gateSpeedAboveKt", "speedS1AboveKt", "speedS2AboveKt", "vsS1Fpm", "vsS2Fpm", "configGateFt", "hardGateFt"]);
    }

    #[test]
    fn every_builtin_value_is_in_range_and_sourced() {
        for p in builtins() {
            for (k, v) in &p.overrides {
                let spec = override_key(k).unwrap_or_else(|| panic!("{}: unknown key {k}", p.id));
                if let (KeyKind::Number { min, max, .. }, OverrideValue::Number(x)) = (spec.kind, v) {
                    assert!((min..=max).contains(x), "{}: {k} = {x}", p.id);
                }
                assert!(p.sources.get(k).is_some_and(|s| !s.is_empty()), "{}: {k} has no source", p.id);
            }
            check_consistent(&p.config()).unwrap();
        }
    }

    #[test]
    fn value_of_reads_every_key() {
        let d = ApproachConfig::default();
        for k in OVERRIDE_KEYS {
            assert!(value_of(&d, k.key).is_some(), "{}", k.key);
        }
        assert_eq!(value_of(&d, "hardGateFt"), Some(OverrideValue::Number(500.0)));
        assert_eq!(value_of(&d, "thrustCheck"), Some(OverrideValue::Bool(true)));
        assert_eq!(value_of(&d, "glidepathDeg"), None);
    }

    #[test]
    fn type_mapping() {
        let t = |icao: &str| profile_for_type(Some(icao), None, None);
        for a in ["A318", "A319", "A320", "A321", "A19N", "A20N", "A21N", "A332", "A339", "A359", "A35K", "A388", "BCS1", "BCS3", "a20n"] {
            assert_eq!(t(a), AIRBUS, "{a}");
        }
        for b in ["B712", "B732", "B738", "B739", "B38M", "B39M", "B744", "B748", "B752", "B763", "B77W", "B788", "B789", "B78X", "MD11"] {
            assert_eq!(t(b), BOEING, "{b}");
        }
        for g in ["E170", "E195", "E145", "CRJ9", "C25A", "GLF6", "PC24", "SF50"] {
            assert_eq!(t(g), GENERIC, "{g}");
        }
        for p in ["AT72", "AT76", "DH8D", "DH8C", "SF34", "B190", "DHC6"] {
            assert_eq!(t(p), TURBOPROP, "{p}");
        }
        for g in ["C172", "C182", "P28A", "SR22", "DA40", "PC12", "TBM9", "C208"] {
            assert_eq!(t(g), GA_PISTON, "{g}");
        }
        // the table wins over the engine type
        assert_eq!(profile_for_type(Some("AT72"), Some(EngineClass::Jet), Some(2)), TURBOPROP);
    }

    #[test]
    fn engine_fallback() {
        assert_eq!(profile_for_type(None, None, None), GENERIC);
        assert_eq!(profile_for_type(Some("ZZZZ"), None, None), GENERIC);
        assert_eq!(profile_for_type(Some("XP12"), Some(EngineClass::Piston), Some(1)), GA_PISTON);
        assert_eq!(profile_for_type(None, Some(EngineClass::Piston), Some(2)), GA_PISTON);
        assert_eq!(profile_for_type(None, Some(EngineClass::Turboprop), Some(2)), TURBOPROP);
        assert_eq!(profile_for_type(None, Some(EngineClass::Turboprop), None), TURBOPROP);
        assert_eq!(profile_for_type(None, Some(EngineClass::Turboprop), Some(1)), GA_PISTON);
        assert_eq!(profile_for_type(None, Some(EngineClass::Jet), Some(2)), GENERIC);
    }

    #[test]
    fn resolution_order() {
        let custom = validate(CustomProfileDoc {
            id: "my-va".into(),
            name: "My VA SOP".into(),
            based_on: Some(AIRBUS.into()),
            source: None,
            overrides: [("vsS1Fpm".to_string(), OverrideValue::Number(1100.0))].into(),
        })
        .unwrap();
        let customs = [custom];
        // airframe choice (built-in or custom) first
        let (p, o) = resolve(Some(GA_PISTON), Some("A320"), None, None, &customs);
        assert_eq!((p.id.as_str(), o), (GA_PISTON, ProfileOrigin::Airframe));
        let (p, o) = resolve(Some("my-va"), Some("C172"), None, None, &customs);
        assert_eq!((p.id.as_str(), o), ("my-va", ProfileOrigin::Airframe));
        let c = p.config();
        assert_eq!((c.profile_id.as_str(), c.gate_speed_above_kt, c.vs_s1_fpm), ("my-va", 10.0, 1100.0));
        // a deleted custom profile falls through to the type
        let (p, o) = resolve(Some("gone"), Some("A320"), None, None, &customs);
        assert_eq!((p.id.as_str(), o), (AIRBUS, ProfileOrigin::Type));
        let (p, o) = resolve(None, None, Some(EngineClass::Piston), None, &customs);
        assert_eq!((p.id.as_str(), o), (GA_PISTON, ProfileOrigin::Engine));
        let (p, o) = resolve(None, None, None, None, &customs);
        assert_eq!((p.id.as_str(), o), (GENERIC, ProfileOrigin::Default));
    }

    fn doc(id: &str, overrides: &[(&str, OverrideValue)]) -> CustomProfileDoc {
        CustomProfileDoc {
            id: id.into(),
            name: "Test".into(),
            based_on: None,
            source: Some("SOP 4.2".into()),
            overrides: overrides.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn validation_rejects_what_it_should() {
        let num = OverrideValue::Number;
        assert!(validate(doc("my-va", &[("gateSpeedAboveKt", num(10.0)), ("thrustCheck", OverrideValue::Bool(false))])).is_ok());
        assert_eq!(validate(doc("My VA", &[])).unwrap_err().code(), "idInvalid");
        assert_eq!(validate(doc("x", &[])).unwrap_err().code(), "idInvalid");
        assert_eq!(validate(doc("airbus", &[])).unwrap_err().code(), "idReserved");
        assert_eq!(
            validate(doc("my-va", &[("glidepathDeg", num(3.0))])).unwrap_err(),
            ProfileError::UnknownKey { key: "glidepathDeg".into() }
        );
        assert_eq!(validate(doc("my-va", &[("thrustCheck", num(0.0))])).unwrap_err().code(), "wrongType");
        assert_eq!(validate(doc("my-va", &[("gateSpeedAboveKt", OverrideValue::Bool(true))])).unwrap_err().code(), "wrongType");
        assert_eq!(
            validate(doc("my-va", &[("hardGateFt", num(50.0))])).unwrap_err(),
            ProfileError::OutOfRange { key: "hardGateFt".into(), value: 50.0, min: 100.0, max: 1000.0 }
        );
        // S2 below S1 (S1 raised over the generic S2 of 35 kt)
        assert_eq!(validate(doc("my-va", &[("speedS1AboveKt", num(40.0))])).unwrap_err().code(), "inconsistent");
        // hard gate above the window top
        assert_eq!(validate(doc("my-va", &[("hardGateFt", num(900.0)), ("windowTopFt", num(800.0))])).unwrap_err().code(), "inconsistent");
        let mut d = doc("my-va", &[]);
        d.based_on = Some("my-other".into());
        assert_eq!(validate(d).unwrap_err().code(), "basedOnUnknown");
        let mut d = doc("my-va", &[]);
        d.name = "  ".into();
        assert_eq!(validate(d).unwrap_err().code(), "nameInvalid");
    }

    #[test]
    fn messages_in_both_languages() {
        let e = ProfileError::OutOfRange { key: "vsS1Fpm".into(), value: 99.5, min: 500.0, max: 2500.0 };
        assert_eq!(e.message(Lang::De), "„vsS1Fpm“ = 99,50 liegt außerhalb von 500–2500");
        assert_eq!(e.message(Lang::En), "\"vsS1Fpm\" = 99.50 is outside 500–2500");
    }
}
