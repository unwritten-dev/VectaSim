//! `.vsdump`: raw SimConnect traffic, recorded *before* any interpretation, so that unit,
//! index and BCD bugs in the decoder can be reproduced on a machine without a simulator.
//!
//! Format (version [`FORMAT`]): newline-delimited JSON, zstd-compressed (one or more
//! concatenated zstd frames; plain NDJSON is accepted by the reader as well).
//!
//! ```text
//! {"type":"header","format":1,"app":"0.1.0","source":"simconnect","sim":"KittyHawk",
//!  "simVersion":"11.0.282174.999","simconnect":"11.0.62651.3","dll":"C:\\…\\SimConnect.dll",
//!  "defs":{"fast":[["PLANE LATITUDE","degrees"],…],"slow":[…],"static":["TITLE",…],
//!          "approach":[["AMBIENT WIND VELOCITY","knots"],…],"design":[["DESIGN SPEED VS0","knots"],…]},
//!  "reqs":{"approach":4,"design":5,"fast":1,"slow":2,"static":3},"inactive":{"fast":[14]},"startedWallMs":1760700000000}
//! {"t":1234,"w":1760700001234,"k":"data","req":1,"v":[50.0451,8.58698,…]}
//! {"t":1250,"w":…,"k":"data","req":3,"s":["Airbus A320neo","TT:ATCCOM.AC_MODEL_A20N.0.text",…]}
//! {"t":1300,"w":…,"k":"event","id":"Pause","data":1}
//! {"t":1301,"w":…,"k":"filename","id":"FlightLoaded","path":"…\\flights\\….FLT"}
//! {"t":1302,"w":…,"k":"exception","code":7,"sendId":12,"index":1,"call":"AddToDataDefinition(SLOW, \"LIGHT TAXI\")","def":"slow","var":"LIGHT TAXI","dropped":true}
//! {"t":9000,"w":…,"k":"open","sim":"KittyHawk","simVersion":"…","simconnect":"…"}
//! {"t":…,"w":…,"k":"quit"}
//! {"t":…,"w":…,"k":"hr","fn":"GetNextDispatch","hr":"0xC000014B"}
//! {"t":…,"w":…,"k":"systemState","req":100,"int":1}
//! {"t":…,"w":…,"k":"end","reason":"simulator quit"}
//! ```
//!
//! * `t`: monotonic ms since the recorder started (`startedWallMs` is the wall clock at
//!   `t = 0`); `w`: wall clock (ms since the Unix epoch) when the message was handled.
//! * `data.v`: the FLOAT64 payload exactly as received (only the variables that are
//!   currently registered, in order; a short payload is short here too). NaN/±inf are
//!   written as `null` and read back as NaN. `bytes` is present only when the payload
//!   length was not a whole number of values.
//! * `data.dv`: instead of `v` between keyframes – difference of the IEEE-754 bit patterns
//!   to the previous `data` line of the same `req` (see [`delta`]); keyframes (`v`) start
//!   every file and follow at least once per second. Readers always return `v`.
//! * `data.s`: STRING256 payload, one string per received slot.
//! * `inactive` (header): variables already dropped from a definition when the file
//!   starts; later drops are `exception` lines with `dropped: true`. Every `open` starts a
//!   fresh SimConnect session with all variables registered again.
//! * `end`: the session ended (the provider reports `Disconnected { reason }`).
//! * `defs.approach` / `defs.design` (additive, still format 1): the 1-Hz approach
//!   definition and the once-per-aircraft design speeds. Older dumps lack them; a reader
//!   that does not know them ignores the keys and their `data` lines (unknown `req`).

pub mod delta;
mod reader;
mod recorder;

pub use reader::{DumpReader, read_all};
pub use recorder::{DumpRecorder, DumpStatus, FileTarget, RingConfig};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

/// Current format version (header field `format`).
pub const FORMAT: u32 = 1;
/// File extension, without the dot.
pub const EXTENSION: &str = "vsdump";

/// First line of every dump.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    /// Always `"header"`.
    #[serde(rename = "type")]
    pub kind: String,
    pub format: u32,
    /// VectaSim version that wrote the file.
    pub app: String,
    /// Who produced the data: `simconnect`, or `mock` for files generated from the mock flight.
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simconnect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dll: Option<String>,
    pub defs: Defs,
    /// Request id of each definition (`fast`, `slow`, `static`).
    #[serde(default)]
    pub reqs: BTreeMap<String, u32>,
    /// Declared-variable indices that were not registered when the file starts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub inactive: BTreeMap<String, Vec<usize>>,
    pub started_wall_ms: u64,
}

impl Header {
    pub fn new(app: impl Into<String>, source: impl Into<String>, defs: Defs, reqs: BTreeMap<String, u32>) -> Self {
        Self {
            kind: "header".into(),
            format: FORMAT,
            app: app.into(),
            source: source.into(),
            sim: None,
            sim_version: None,
            simconnect: None,
            dll: None,
            defs,
            reqs,
            inactive: BTreeMap::new(),
            started_wall_ms: 0,
        }
    }
}

/// The declared variables of the definitions, in registration order.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Defs {
    /// `[name, unit]`
    pub fast: Vec<(String, String)>,
    pub slow: Vec<(String, String)>,
    #[serde(rename = "static")]
    pub statics: Vec<String>,
    /// Approach data at 1 Hz (for track v2); absent in older dumps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approach: Vec<(String, String)>,
    /// Design speeds, requested once per aircraft; absent in older dumps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub design: Vec<(String, String)>,
}

/// A FLOAT64 as recorded: NaN and ±inf (not representable in JSON) are written as `null`
/// and read back as NaN.
#[derive(Clone, Copy, Debug, Default)]
pub struct Raw(pub f64);

impl PartialEq for Raw {
    /// Bitwise-ish equality so that NaN == NaN (a recorded NaN reads back as NaN).
    fn eq(&self, other: &Self) -> bool {
        (self.0.is_nan() && other.0.is_nan()) || self.0 == other.0
    }
}

impl Serialize for Raw {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if self.0.is_finite() { s.serialize_f64(self.0) } else { s.serialize_none() }
    }
}

impl<'de> Deserialize<'de> for Raw {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Raw(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN)))
    }
}

pub fn raw_vec(v: &[f64]) -> Vec<Raw> {
    v.iter().map(|x| Raw(*x)).collect()
}

pub fn f64_vec(v: &[Raw]) -> Vec<f64> {
    v.iter().map(|x| x.0).collect()
}

/// One recorded message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Body {
    /// `SIMCONNECT_RECV_SIMOBJECT_DATA`
    Data {
        req: u32,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        v: Vec<Raw>,
        /// Delta form of `v` in the file (see [`delta`]); readers return `v` instead.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dv: Vec<i64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        s: Vec<String>,
        /// Payload length in bytes, only when it was not a whole number of values.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bytes: Option<u32>,
    },
    /// `SIMCONNECT_RECV_EVENT` of a subscribed system event (`id` = event name).
    Event { id: String, data: u32 },
    /// `SIMCONNECT_RECV_EVENT_FILENAME`
    Filename { id: String, path: String },
    /// `SIMCONNECT_RECV_EXCEPTION`, with what VectaSim attributed it to.
    Exception {
        code: u32,
        send_id: u32,
        index: u32,
        /// The call the SendID belonged to (`AddToDataDefinition(FAST, "…")`), if tracked.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call: Option<String>,
        /// Definition label (`fast`/`slow`/`static`) and SimVar, when the call added a variable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        def: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        var: Option<String>,
        /// The variable was dropped from its definition (later payloads are one value shorter).
        #[serde(default)]
        dropped: bool,
    },
    /// `SIMCONNECT_RECV_OPEN`: a new session.
    Open {
        sim: String,
        sim_version: String,
        #[serde(default)]
        simconnect: String,
    },
    /// `SIMCONNECT_RECV_QUIT`
    Quit,
    /// A failed call (`fn` = the call, e.g. `GetNextDispatch` or `RequestDataOnSimObject(SLOW)`).
    Hr {
        #[serde(rename = "fn")]
        func: String,
        hr: String,
    },
    /// `SIMCONNECT_RECV_SYSTEM_STATE` (fixed part).
    SystemState { req: u32, int: u32 },
    /// The session ended; `reason` as the provider reports it.
    End { reason: String },
}

impl Body {
    /// A FLOAT64 payload (`bytes`: its length when not a whole number of values).
    pub fn data_f64(req: u32, v: &[f64], bytes: Option<u32>) -> Self {
        Body::Data { req, v: raw_vec(v), dv: Vec::new(), s: Vec::new(), bytes }
    }

    /// A STRING256 payload.
    pub fn data_str(req: u32, s: Vec<String>, bytes: Option<u32>) -> Self {
        Body::Data { req, v: Vec::new(), dv: Vec::new(), s, bytes }
    }
}

/// A recorded line: monotonic and wall time plus the message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub t: u64,
    pub w: u64,
    #[serde(flatten)]
    pub body: Body,
}

/// Format an HRESULT the way the logs do (`0xC000014B`).
pub fn hr_hex(hr: i32) -> String {
    format!("0x{:08X}", hr as u32)
}

/// Parse [`hr_hex`] output back (accepts a decimal number too).
pub fn parse_hr(s: &str) -> Option<i32> {
    let s = s.trim();
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u32::from_str_radix(h, 16).ok().map(|v| v as i32),
        None => s.parse::<i64>().ok().map(|v| v as i32),
    }
}

/// `20261017-140322Z` for a wall-clock time (UTC), used in dump file names.
pub fn file_stamp(wall_ms: u64) -> String {
    let secs = wall_ms / 1000;
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    let (y, mo, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}Z")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (H. Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests;
