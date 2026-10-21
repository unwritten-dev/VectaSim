//! Compact track storage.
//!
//! Why not JSON: a 1 Hz sample is ~200 bytes as JSON; a ten-hour flight would be
//! 7 MB per flight. Columnar + delta + varint + zstd gets that to 10–30 bytes per
//! sample. Every field is quantised to a
//! fixed resolution (1e-7 deg, 0.1 ft, 0.1 kt, 0.01 deg, 0.001 g) that is well
//! below what any sim reports meaningfully, so the roundtrip is lossless for our
//! purposes.
//!
//! Layout (before zstd): magic `VSTK`, version u8, sample count u32 LE, then one
//! column per field, each a sequence of zigzag-varint deltas:
//! - v1: the 16 [`COLUMNS`].
//! - v2: the 16 [`COLUMNS`], then a presence column (bit *i* set = optional column *i*
//!   holds a value in this sample), then the [`OPT_COLUMNS`] (approach data: TAS, wind,
//!   ILS deviations and flags, autopilot bits, N1, spoilers, alpha, …). An absent value is
//!   stored as 0 and decodes to `None`. Slowly changing columns delta to 0 and cost
//!   almost nothing after zstd.
//!
//! The encoder always writes v2; the decoder reads v1 (all optional fields `None`) and v2.

use serde::{Deserialize, Serialize};
use std::io::Read;
use vectasim_core::Telemetry;
use vectasim_core::approach::nav_flags;

const MAGIC: &[u8; 4] = b"VSTK";
/// Version the encoder writes.
pub const VERSION: u8 = 2;
const ZSTD_LEVEL: i32 = 3;
/// Upper bound for one decoded track: 200 000 samples are 55 h at the recorder's 1 Hz.
pub const MAX_SAMPLES: usize = 200_000;
/// Columns of a v2 blob: the base columns, the presence column and the optional ones.
const V2_COLUMNS: usize = COLUMNS.len() + 1 + OPT_COLUMNS.len();
/// Largest raw (decompressed) blob accepted: header plus a 10-byte varint per column and sample.
const MAX_RAW_BYTES: usize = 9 + MAX_SAMPLES * V2_COLUMNS * 10;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSample {
    pub t_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_msl_ft: f64,
    pub altitude_agl_ft: f64,
    pub ground_speed_kt: f64,
    pub ias_kt: f64,
    pub vertical_speed_fpm: f64,
    pub heading_true_deg: f64,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub g_force: f64,
    pub on_ground: bool,
    pub flaps_index: i32,
    pub gear_pct: f64,
    pub fuel_total_kg: f64,

    // ---- track v2: `None` = not recorded (v1 track, or the sim did not deliver it) ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tas_kt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_mag_deg: Option<f64>,
    /// Wind at the aircraft (true direction it blows from), kt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wind_dir_true_deg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wind_kt: Option<f64>,
    /// ILS on NAV 1: glideslope error in degrees, CDI needle (raw, plus/minus 127) and
    /// radial error in degrees, only while the station has the component; published
    /// glideslope angle and localizer course.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gs_error_deg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loc_cdi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loc_error_deg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ils_gs_angle_deg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ils_course_deg: Option<f64>,
    /// Bits of `vectasim_core::approach::nav_flags` (ILS and automation state).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_flags: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n1_pct: Option<f64>,
    /// Deployed spoiler surface and the handle, percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoilers_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoilers_handle_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha_deg: Option<f64>,
    /// `FLAPS NUM HANDLE POSITIONS` and `DESIGN SPEED VS0/VS1` (aircraft constants; a
    /// column of equal values costs almost nothing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flap_positions: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_vs0_kt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_vs1_kt: Option<f64>,
}

/// The ILS/automation bits of a telemetry sample; `None` when the sim delivered none of them.
pub fn nav_flags_of(t: &Telemetry) -> Option<u8> {
    let bits = [
        (t.nav_has_localizer, nav_flags::HAS_LOCALIZER),
        (t.nav_has_glide_slope, nav_flags::HAS_GLIDE_SLOPE),
        (t.nav_gs_flag, nav_flags::GLIDE_SLOPE_VALID),
        (t.autopilot_master, nav_flags::AUTOPILOT_MASTER),
        (t.autopilot_approach_hold, nav_flags::APPROACH_HOLD),
        (t.autopilot_glideslope_hold, nav_flags::GLIDE_SLOPE_HOLD),
        (t.autothrottle_active, nav_flags::AUTOTHRUST),
        (t.spoilers_armed, nav_flags::SPOILERS_ARMED),
    ];
    bits.iter().any(|(v, _)| v.is_some()).then(|| bits.iter().filter(|(v, _)| *v == Some(true)).fold(0, |a, (_, b)| a | b))
}

impl From<&Telemetry> for TrackSample {
    fn from(t: &Telemetry) -> Self {
        Self {
            t_ms: t.timestamp_ms,
            latitude: t.latitude,
            longitude: t.longitude,
            altitude_msl_ft: t.altitude_msl_ft,
            altitude_agl_ft: t.altitude_agl_ft,
            ground_speed_kt: t.ground_speed_kt,
            ias_kt: t.ias_kt,
            vertical_speed_fpm: t.vertical_speed_fpm,
            heading_true_deg: t.heading_true_deg,
            pitch_deg: t.pitch_deg,
            bank_deg: t.bank_deg,
            g_force: t.g_force,
            on_ground: t.on_ground,
            flaps_index: t.flaps_index,
            gear_pct: t.gear_pct,
            fuel_total_kg: t.fuel_total_kg,
            // FAST always carries TAS and the magnetic heading
            tas_kt: Some(t.tas_kt),
            heading_mag_deg: Some(t.heading_mag_deg),
            wind_dir_true_deg: t.wind_dir_true_deg,
            wind_kt: t.wind_kt,
            gs_error_deg: t.nav_gs_error_deg,
            loc_cdi: t.nav_cdi,
            loc_error_deg: t.nav_radial_error_deg,
            ils_gs_angle_deg: t.nav_gs_angle_deg,
            ils_course_deg: t.nav_loc_course_deg,
            nav_flags: nav_flags_of(t),
            n1_pct: t.n1_pct,
            spoilers_pct: t.spoilers_pct,
            spoilers_handle_pct: t.spoilers_handle_pct,
            alpha_deg: t.alpha_deg,
            flap_positions: t.flap_positions,
            design_vs0_kt: t.design_vs0_kt,
            design_vs1_kt: t.design_vs1_kt,
        }
    }
}

impl TrackSample {
    /// The approach analysis' view of this sample (v1 tracks record none of the optional values).
    pub fn to_approach_sample(&self) -> vectasim_core::approach::ApproachSample {
        let flags = self.nav_flags.unwrap_or(0);
        vectasim_core::approach::ApproachSample {
            t_ms: self.t_ms,
            latitude: self.latitude,
            longitude: self.longitude,
            altitude_msl_ft: self.altitude_msl_ft,
            altitude_agl_ft: self.altitude_agl_ft,
            ground_speed_kt: self.ground_speed_kt,
            ias_kt: self.ias_kt,
            vertical_speed_fpm: self.vertical_speed_fpm,
            heading_true_deg: self.heading_true_deg,
            pitch_deg: self.pitch_deg,
            bank_deg: self.bank_deg,
            g_force: self.g_force,
            on_ground: self.on_ground,
            flaps_index: self.flaps_index,
            gear_pct: self.gear_pct,
            tas_kt: self.tas_kt,
            wind_dir_true_deg: self.wind_dir_true_deg,
            wind_kt: self.wind_kt,
            // deviations only with the station component (the decoder stores them only then)
            gs_error_deg: self.gs_error_deg.filter(|_| flags & nav_flags::HAS_GLIDE_SLOPE != 0),
            loc_cdi: self.loc_cdi.filter(|_| flags & nav_flags::HAS_LOCALIZER != 0),
            gs_angle_deg: self.ils_gs_angle_deg.filter(|_| flags & nav_flags::HAS_GLIDE_SLOPE != 0),
            nav_flags: flags,
            nav_recorded: self.nav_flags.is_some(),
            n1_pct: self.n1_pct,
            spoilers_pct: self.spoilers_pct,
            alpha_deg: self.alpha_deg,
        }
    }

    /// Any approach value of track v2 besides TAS/heading (which every v2 sample has).
    pub fn has_approach_data(&self) -> bool {
        OPT_COLUMNS.iter().skip(2).any(|(_, get, _)| get(self).is_some())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TrackError {
    #[error("not a VectaSim track blob")]
    BadMagic,
    #[error("unsupported track version {0}")]
    Version(u8),
    #[error("truncated track data")]
    Truncated,
    #[error("track blob larger than {MAX_SAMPLES} samples")]
    TooLarge,
    #[error("zstd: {0}")]
    Zstd(#[from] std::io::Error),
}

/// Field accessors with their quantisation scale, in storage order (v1 and v2).
type Getter = fn(&TrackSample) -> f64;
type Setter = fn(&mut TrackSample, f64);
const COLUMNS: &[(f64, Getter, Setter)] = &[
    (1.0, |s| s.t_ms as f64, |s, v| s.t_ms = v as u64),
    (1e7, |s| s.latitude, |s, v| s.latitude = v),
    (1e7, |s| s.longitude, |s, v| s.longitude = v),
    (10.0, |s| s.altitude_msl_ft, |s, v| s.altitude_msl_ft = v),
    (10.0, |s| s.altitude_agl_ft, |s, v| s.altitude_agl_ft = v),
    (10.0, |s| s.ground_speed_kt, |s, v| s.ground_speed_kt = v),
    (10.0, |s| s.ias_kt, |s, v| s.ias_kt = v),
    (1.0, |s| s.vertical_speed_fpm, |s, v| s.vertical_speed_fpm = v),
    (100.0, |s| s.heading_true_deg, |s, v| s.heading_true_deg = v),
    (100.0, |s| s.pitch_deg, |s, v| s.pitch_deg = v),
    (100.0, |s| s.bank_deg, |s, v| s.bank_deg = v),
    (1000.0, |s| s.g_force, |s, v| s.g_force = v),
    (1.0, |s| if s.on_ground { 1.0 } else { 0.0 }, |s, v| s.on_ground = v != 0.0),
    (1.0, |s| s.flaps_index as f64, |s, v| s.flaps_index = v as i32),
    (10.0, |s| s.gear_pct, |s, v| s.gear_pct = v),
    (10.0, |s| s.fuel_total_kg, |s, v| s.fuel_total_kg = v),
];

/// Optional v2 columns (bit *i* of the presence column = column *i*). Append only: the
/// order is the file format.
type OptGetter = fn(&TrackSample) -> Option<f64>;
type OptSetter = fn(&mut TrackSample, f64);
const OPT_COLUMNS: &[(f64, OptGetter, OptSetter)] = &[
    (10.0, |s| s.tas_kt, |s, v| s.tas_kt = Some(v)),
    (100.0, |s| s.heading_mag_deg, |s, v| s.heading_mag_deg = Some(v)),
    (10.0, |s| s.wind_dir_true_deg, |s, v| s.wind_dir_true_deg = Some(v)),
    (10.0, |s| s.wind_kt, |s, v| s.wind_kt = Some(v)),
    (1000.0, |s| s.gs_error_deg, |s, v| s.gs_error_deg = Some(v)),
    (10.0, |s| s.loc_cdi, |s, v| s.loc_cdi = Some(v)),
    (1000.0, |s| s.loc_error_deg, |s, v| s.loc_error_deg = Some(v)),
    (100.0, |s| s.ils_gs_angle_deg, |s, v| s.ils_gs_angle_deg = Some(v)),
    (10.0, |s| s.ils_course_deg, |s, v| s.ils_course_deg = Some(v)),
    (1.0, |s| s.nav_flags.map(f64::from), |s, v| s.nav_flags = Some(v.clamp(0.0, 255.0) as u8)),
    (10.0, |s| s.n1_pct, |s, v| s.n1_pct = Some(v)),
    (10.0, |s| s.spoilers_pct, |s, v| s.spoilers_pct = Some(v)),
    (10.0, |s| s.spoilers_handle_pct, |s, v| s.spoilers_handle_pct = Some(v)),
    (100.0, |s| s.alpha_deg, |s, v| s.alpha_deg = Some(v)),
    (1.0, |s| s.flap_positions.map(f64::from), |s, v| s.flap_positions = Some(v as i32)),
    (10.0, |s| s.design_vs0_kt, |s, v| s.design_vs0_kt = Some(v)),
    (10.0, |s| s.design_vs1_kt, |s, v| s.design_vs1_kt = Some(v)),
];
const _: () = assert!(OPT_COLUMNS.len() <= 32, "presence bits are a u32");

fn quantise(v: f64, scale: f64) -> i64 {
    (v * scale).round() as i64
}

/// The optional value of column `i`, only when it is a real number.
fn opt_value(s: &TrackSample, i: usize) -> Option<f64> {
    (OPT_COLUMNS[i].1)(s).filter(|v| v.is_finite())
}

pub fn encode_track(samples: &[TrackSample]) -> Vec<u8> {
    let mut e = TrackEncoder::new();
    for s in samples {
        e.push(s);
    }
    e.encode(None)
}

/// The uncompressed v2 stream (also what the golden tests pin down).
#[cfg(test)]
fn raw_track(samples: &[TrackSample]) -> Vec<u8> {
    let mut e = TrackEncoder::new();
    for s in samples {
        e.push(s);
    }
    e.raw(None)
}

/// The quantised values of one sample in storage order: base columns, presence, optional ones.
fn quantised(s: &TrackSample) -> [i64; V2_COLUMNS] {
    let mut q = [0i64; V2_COLUMNS];
    for (i, (scale, get, _)) in COLUMNS.iter().enumerate() {
        q[i] = quantise(get(s), *scale);
    }
    let mut present = 0u32;
    for (i, (scale, _, _)) in OPT_COLUMNS.iter().enumerate() {
        if let Some(v) = opt_value(s, i) {
            present |= 1 << i;
            q[COLUMNS.len() + 1 + i] = quantise(v, *scale);
        }
    }
    q[COLUMNS.len()] = i64::from(present);
    q
}

/// Builds the v2 stream sample by sample: each column's deltas are written once, when the
/// sample comes in, so the recorder's 15 s flush only adds the samples since the last one and
/// concatenates the columns (plus the zstd pass) instead of quantising the whole track again.
/// The output is byte for byte what [`encode_track`] writes for the same samples.
#[derive(Clone, Debug)]
pub struct TrackEncoder {
    cols: Vec<Vec<u8>>,
    prev: [i64; V2_COLUMNS],
    count: usize,
}

impl Default for TrackEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl TrackEncoder {
    pub fn new() -> Self {
        Self { cols: vec![Vec::new(); V2_COLUMNS], prev: [0; V2_COLUMNS], count: 0 }
    }

    /// Samples pushed so far.
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn push(&mut self, s: &TrackSample) {
        let q = quantised(s);
        for (i, col) in self.cols.iter_mut().enumerate() {
            write_varint(col, zigzag(q[i].wrapping_sub(self.prev[i])));
        }
        self.prev = q;
        self.count += 1;
    }

    /// The uncompressed stream of the pushed samples, plus `extra` as one more last sample
    /// (not kept: the track preview's "last sample" that moves on with every flush).
    fn raw(&self, extra: Option<&TrackSample>) -> Vec<u8> {
        let extra = extra.map(quantised);
        let n = self.count + usize::from(extra.is_some());
        let mut raw = Vec::with_capacity(9 + self.cols.iter().map(Vec::len).sum::<usize>() + V2_COLUMNS * 10);
        raw.extend_from_slice(MAGIC);
        raw.push(VERSION);
        raw.extend_from_slice(&(n as u32).to_le_bytes());
        for (i, col) in self.cols.iter().enumerate() {
            raw.extend_from_slice(col);
            if let Some(q) = &extra {
                write_varint(&mut raw, zigzag(q[i].wrapping_sub(self.prev[i])));
            }
        }
        raw
    }

    /// The zstd blob ([`encode_track`] format) of the pushed samples plus `extra`.
    pub fn encode(&self, extra: Option<&TrackSample>) -> Vec<u8> {
        zstd::encode_all(self.raw(extra).as_slice(), ZSTD_LEVEL).expect("zstd encode into Vec cannot fail")
    }
}

/// Reads one column; `apply` gets each sample and its quantised value.
fn read_column(raw: &[u8], pos: &mut usize, samples: &mut [TrackSample], mut apply: impl FnMut(&mut TrackSample, i64)) -> Result<(), TrackError> {
    let mut prev: i64 = 0;
    for s in samples.iter_mut() {
        let (d, next) = read_varint(raw, *pos)?;
        *pos = next;
        prev = prev.wrapping_add(unzigzag(d));
        apply(s, prev);
    }
    Ok(())
}

pub fn decode_track(blob: &[u8]) -> Result<Vec<TrackSample>, TrackError> {
    let mut raw = Vec::new();
    // bounded read: a corrupt or hostile blob must not decompress into gigabytes
    zstd::Decoder::new(blob)?.take(MAX_RAW_BYTES as u64 + 1).read_to_end(&mut raw)?;
    if raw.len() > MAX_RAW_BYTES {
        return Err(TrackError::TooLarge);
    }
    decode_raw(&raw)
}

fn decode_raw(raw: &[u8]) -> Result<Vec<TrackSample>, TrackError> {
    if raw.len() < 9 {
        return Err(TrackError::Truncated);
    }
    if &raw[..4] != MAGIC {
        return Err(TrackError::BadMagic);
    }
    let version = raw[4];
    let columns = match version {
        1 => COLUMNS.len(),
        2 => V2_COLUMNS,
        v => return Err(TrackError::Version(v)),
    };
    let count = u32::from_le_bytes([raw[5], raw[6], raw[7], raw[8]]) as usize;
    // The header is untrusted: every sample needs at least one byte per column, and no
    // real track comes near MAX_SAMPLES – check before allocating `count` samples.
    if count > MAX_SAMPLES {
        return Err(TrackError::TooLarge);
    }
    if count > (raw.len() - 9) / columns {
        return Err(TrackError::Truncated);
    }
    let mut samples = vec![TrackSample::default(); count];
    let mut pos = 9;
    for (scale, _, set) in COLUMNS {
        read_column(raw, &mut pos, &mut samples, |s, q| set(s, q as f64 / scale))?;
    }
    if version >= 2 {
        let mut present = vec![0u32; count];
        let mut it = present.iter_mut();
        read_column(raw, &mut pos, &mut samples, |_, q| {
            if let Some(p) = it.next() {
                *p = q as u32;
            }
        })?;
        for (i, (scale, _, set)) in OPT_COLUMNS.iter().enumerate() {
            let mut k = 0;
            read_column(raw, &mut pos, &mut samples, |s, q| {
                if present[k] & (1 << i) != 0 {
                    set(s, q as f64 / scale);
                }
                k += 1;
            })?;
        }
    }
    Ok(samples)
}

/// What a v2 track recorded in the final approach to a point in time (the debrief's
/// measurement log lists it): the last recorded TAS/wind/ILS values and which ILS
/// components were received. Values only, no assessment.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedApproachData {
    pub tas_kt: Option<f64>,
    pub wind_dir_true_deg: Option<f64>,
    pub wind_kt: Option<f64>,
    /// The ILS/automation bits were recorded at all in the window.
    pub nav_flags_recorded: bool,
    /// Seen in any sample of the window.
    pub has_localizer: bool,
    pub has_glide_slope: bool,
    pub glide_slope_valid: bool,
    pub autopilot_seen: bool,
    pub ils_gs_angle_deg: Option<f64>,
    pub ils_course_deg: Option<f64>,
    pub flap_positions: Option<i32>,
    pub design_vs0_kt: Option<f64>,
}

/// Window before the touchdown that [`recorded_approach_data`] looks at.
pub const RECORDED_WINDOW_MS: u64 = 180_000;

/// [`RecordedApproachData`] of the samples in the 3 minutes up to `until_ms`; `None` for a
/// v1 track (nothing recorded).
pub fn recorded_approach_data(samples: &[TrackSample], until_ms: u64) -> Option<RecordedApproachData> {
    let from = until_ms.saturating_sub(RECORDED_WINDOW_MS);
    let w: Vec<&TrackSample> = samples.iter().filter(|s| s.t_ms >= from && s.t_ms <= until_ms).collect();
    if !w.iter().any(|s| s.tas_kt.is_some() || s.has_approach_data()) {
        return None;
    }
    let last = |f: fn(&TrackSample) -> Option<f64>| w.iter().rev().find_map(|s| f(s));
    let any = |bit: u8| w.iter().any(|s| s.nav_flags.is_some_and(|f| f & bit != 0));
    Some(RecordedApproachData {
        tas_kt: last(|s| s.tas_kt),
        wind_dir_true_deg: last(|s| s.wind_dir_true_deg),
        wind_kt: last(|s| s.wind_kt),
        nav_flags_recorded: w.iter().any(|s| s.nav_flags.is_some()),
        has_localizer: any(nav_flags::HAS_LOCALIZER),
        has_glide_slope: any(nav_flags::HAS_GLIDE_SLOPE),
        glide_slope_valid: any(nav_flags::GLIDE_SLOPE_VALID),
        autopilot_seen: any(nav_flags::AUTOPILOT_MASTER),
        ils_gs_angle_deg: last(|s| s.ils_gs_angle_deg),
        ils_course_deg: last(|s| s.ils_course_deg),
        flap_positions: w.iter().rev().find_map(|s| s.flap_positions),
        design_vs0_kt: last(|s| s.design_vs0_kt),
    })
}

/// Every n-th sample, always including the last one – enough for a map thumbnail.
pub fn subsample(samples: &[TrackSample], every: usize) -> Vec<TrackSample> {
    let every = every.max(1);
    let mut out: Vec<TrackSample> = samples.iter().step_by(every).cloned().collect();
    if let Some(last) = samples.last()
        && out.last().is_none_or(|l| l.t_ms != last.t_ms)
    {
        out.push(last.clone());
    }
    out
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn read_varint(buf: &[u8], mut pos: usize) -> Result<(u64, usize), TrackError> {
    let mut result: u64 = 0;
    let mut shift = 0;
    loop {
        let b = *buf.get(pos).ok_or(TrackError::Truncated)?;
        pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok((result, pos));
        }
        shift += 7;
        if shift > 63 {
            return Err(TrackError::Truncated);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_roundtrip() {
        for v in [0i64, 1, -1, 2, -2, i64::MAX / 2, i64::MIN / 2] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
    }

    #[test]
    fn empty_track_roundtrips() {
        let blob = encode_track(&[]);
        assert!(decode_track(&blob).unwrap().is_empty());
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_track(b"nope").is_err());
        let blob = zstd::encode_all(&b"XXXX\x01\0\0\0\0"[..], 1).unwrap();
        assert!(matches!(decode_track(&blob), Err(TrackError::BadMagic)));
    }

    fn raw_blob(count: u32, body: &[u8]) -> Vec<u8> {
        let mut raw = Vec::from(&MAGIC[..]);
        raw.push(VERSION);
        raw.extend_from_slice(&count.to_le_bytes());
        raw.extend_from_slice(body);
        zstd::encode_all(raw.as_slice(), 1).unwrap()
    }

    #[test]
    fn incremental_encoder_writes_what_encode_track_writes() {
        let samples: Vec<TrackSample> = (0..95)
            .map(|i| TrackSample {
                t_ms: 1_000_000 + i * 1_000,
                latitude: 50.0 + i as f64 * 1e-4,
                altitude_msl_ft: 400.0 + i as f64 * 10.0,
                tas_kt: (i % 3 != 0).then_some(140.0 + i as f64),
                n1_pct: (i > 40).then_some(80.0),
                on_ground: i < 10,
                ..Default::default()
            })
            .collect();
        let mut e = TrackEncoder::new();
        for (i, s) in samples.iter().enumerate() {
            e.push(s);
            if i % 17 == 0 {
                assert_eq!(e.encode(None), encode_track(&samples[..=i]), "after {i}");
            }
        }
        assert_eq!(e.len(), samples.len());
        assert_eq!(decode_track(&e.encode(None)).unwrap(), decode_track(&encode_track(&samples)).unwrap());
        // an extra last sample, as the preview's moving end
        let (head, last) = samples.split_at(samples.len() - 1);
        let mut e = TrackEncoder::new();
        head.iter().for_each(|s| e.push(s));
        assert_eq!(e.raw(Some(&last[0])), raw_track(&samples));
        assert_eq!(e.len(), head.len(), "the extra sample is not kept");
    }

    #[test]
    fn manipulated_count_is_an_error_not_an_allocation() {
        // u32::MAX samples announced, a handful of bytes behind it
        assert!(matches!(decode_track(&raw_blob(u32::MAX, &[0; 32])), Err(TrackError::TooLarge)));
        // plausible count, but the columns cannot hold that many samples
        assert!(matches!(decode_track(&raw_blob(1_000, &[0; 64])), Err(TrackError::Truncated)));
        // just above the cap with enough zero bytes is still refused
        let n = MAX_SAMPLES as u32 + 1;
        assert!(matches!(decode_track(&raw_blob(n, &[])), Err(TrackError::TooLarge)));
        // exactly count × columns zero bytes: all-zero samples (nothing optional present), accepted
        let ok = decode_track(&raw_blob(3, &[0; 3 * V2_COLUMNS])).unwrap();
        assert_eq!(ok, vec![TrackSample::default(); 3]);
        // a v1 blob needs only its 16 columns
        let mut v1 = Vec::from(&MAGIC[..]);
        v1.push(1);
        v1.extend_from_slice(&3u32.to_le_bytes());
        v1.extend_from_slice(&[0; 3 * 16]);
        assert_eq!(decode_track(&zstd::encode_all(v1.as_slice(), 1).unwrap()).unwrap(), vec![TrackSample::default(); 3]);
        // unknown versions are refused
        let mut v3 = v1.clone();
        v3[4] = 3;
        assert!(matches!(decode_track(&zstd::encode_all(v3.as_slice(), 1).unwrap()), Err(TrackError::Version(3))));
    }

    /// Two hand-checkable samples (small integers, so every delta is one varint byte).
    fn golden_samples() -> Vec<TrackSample> {
        let a = TrackSample {
            t_ms: 1_000,
            latitude: 0.000_000_1,
            altitude_msl_ft: 0.5,
            ground_speed_kt: 1.0,
            on_ground: true,
            flaps_index: 2,
            fuel_total_kg: 0.1,
            ..Default::default()
        };
        let b = TrackSample { t_ms: 2_000, vertical_speed_fpm: -3.0, on_ground: false, ..a.clone() };
        vec![a, b]
    }

    /// v1 stream: header, then 16 columns × 2 samples of zigzag-varint deltas.
    #[rustfmt::skip]
    const GOLDEN_V1: &[u8] = &[
        b'V', b'S', b'T', b'K', 1, 2, 0, 0, 0,
        0xD0, 0x0F, 0xD0, 0x0F, // t_ms 1000 → +1000 (zigzag 2000 = 0xD0 0x0F)
        2, 0,                   // latitude 1e-7 → 1
        0, 0,                   // longitude
        10, 0,                  // altitude_msl_ft 0.5 → 5
        0, 0,                   // altitude_agl_ft
        20, 0,                  // ground_speed_kt 1.0 → 10
        0, 0,                   // ias_kt
        0, 5,                   // vertical_speed_fpm 0, −3 (zigzag 5)
        0, 0, 0, 0, 0, 0,       // heading, pitch, bank
        0, 0,                   // g
        2, 1,                   // on_ground 1, 0 (delta −1 → 1)
        4, 0,                   // flaps 2
        0, 0,                   // gear
        2, 0,                   // fuel 0.1 → 1
    ];

    #[test]
    fn golden_v1_blob_decodes() {
        let blob = zstd::encode_all(GOLDEN_V1, 1).unwrap();
        assert_eq!(decode_track(&blob).unwrap(), golden_samples());
    }

    #[test]
    fn golden_v2_stream() {
        let mut s = golden_samples();
        // first sample: TAS and flags only; second: TAS, wind, glideslope error
        s[0].tas_kt = Some(1.0);
        s[0].nav_flags = Some(nav_flags::HAS_LOCALIZER | nav_flags::AUTOPILOT_MASTER);
        s[1].tas_kt = Some(1.5);
        s[1].wind_dir_true_deg = Some(0.2);
        s[1].wind_kt = Some(0.3);
        s[1].gs_error_deg = Some(-0.002);
        let raw = raw_track(&s);
        let mut expected = GOLDEN_V1.to_vec();
        expected[4] = 2;
        // presence: sample 0 = bit 0 | bit 9 (tas, flags) = 513, sample 1 = bits 0, 2, 3, 4 = 29
        let mut tail = Vec::new();
        for v in [zigzag(513), zigzag(29 - 513)] {
            write_varint(&mut tail, v);
        }
        assert_eq!(tail, [0x82, 0x08, 0xC7, 0x07]);
        #[rustfmt::skip]
        tail.extend_from_slice(&[
            20, 10,          // tas 1.0 → 10, 1.5 → 15 (+5)
            0, 0,            // heading_mag
            0, 4,            // wind dir 0.2 → 2
            0, 6,            // wind kt 0.3 → 3
            0, 3,            // gs error −0.002 → −2 (zigzag 3)
            0, 0, 0, 0, 0, 0, // loc cdi, loc error, gs angle
            0, 0,            // ils course
            18, 17,          // flags 9 → absent (0): delta −9 → 17
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // n1 … vs1 (7 columns)
        ]);
        expected.extend_from_slice(&tail);
        assert_eq!(raw, expected);
        let back = decode_track(&encode_track(&s)).unwrap();
        assert_eq!(back, s);
        assert!(back[1].has_approach_data() && back[0].has_approach_data());
        assert!(!golden_samples()[0].has_approach_data());
    }

    #[test]
    fn oversized_decompressed_blob_is_refused() {
        let blob = raw_blob(1, &vec![0; MAX_RAW_BYTES]);
        assert!(matches!(decode_track(&blob), Err(TrackError::TooLarge)));
    }

    /// xorshift64*: deterministic pseudo-random numbers without a dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        /// Uniform in [lo, hi).
        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (hi - lo)
        }
    }

    fn random_track(rng: &mut Rng, n: usize) -> Vec<TrackSample> {
        let mut t_ms = 1_792_137_600_000 + rng.next() % 1_000_000;
        (0..n)
            .map(|i| {
                t_ms += 200 + rng.next() % 2_000;
                // every 50th sample an extreme value: antimeridian, poles, negative altitude
                let extreme = i % 50 == 49;
                let mut s = TrackSample {
                    t_ms,
                    latitude: if extreme { if i % 100 == 99 { 90.0 } else { -90.0 } } else { rng.range(-89.0, 89.0) },
                    longitude: if extreme { if i % 100 == 99 { 180.0 } else { -180.0 } } else { rng.range(-180.0, 180.0) },
                    altitude_msl_ft: if extreme { -1_400.0 } else { rng.range(-100.0, 51_000.0) },
                    altitude_agl_ft: rng.range(0.0, 45_000.0),
                    ground_speed_kt: rng.range(0.0, 650.0),
                    ias_kt: rng.range(0.0, 400.0),
                    vertical_speed_fpm: rng.range(-8_000.0, 8_000.0),
                    heading_true_deg: rng.range(0.0, 360.0),
                    pitch_deg: rng.range(-30.0, 30.0),
                    bank_deg: rng.range(-90.0, 90.0),
                    g_force: rng.range(-1.0, 4.0),
                    on_ground: rng.next().is_multiple_of(2),
                    flaps_index: (rng.next() % 6) as i32,
                    gear_pct: rng.range(0.0, 100.0),
                    fuel_total_kg: rng.range(0.0, 150_000.0),
                    ..Default::default()
                };
                // v2 values: each one present in ~2/3 of the samples, in runs and gaps
                let mut some = |lo: f64, hi: f64| (!rng.next().is_multiple_of(3)).then(|| rng.range(lo, hi));
                s.tas_kt = some(0.0, 650.0);
                s.heading_mag_deg = some(0.0, 360.0);
                s.wind_dir_true_deg = some(0.0, 360.0);
                s.wind_kt = some(0.0, 150.0);
                s.gs_error_deg = some(-10.0, 10.0);
                s.loc_cdi = some(-127.0, 127.0);
                s.loc_error_deg = some(-180.0, 180.0);
                s.ils_gs_angle_deg = some(2.5, 5.5);
                s.ils_course_deg = some(0.0, 360.0);
                s.n1_pct = some(0.0, 110.0);
                s.spoilers_pct = some(0.0, 100.0);
                s.spoilers_handle_pct = some(0.0, 100.0);
                s.alpha_deg = some(-20.0, 30.0);
                s.design_vs0_kt = some(40.0, 160.0);
                s.design_vs1_kt = some(40.0, 180.0);
                s.flap_positions = some(1.0, 9.0).map(|v| v as i32);
                s.nav_flags = some(0.0, 256.0).map(|v| v as u8);
                if extreme {
                    // a NaN from the sim must not become a recorded value
                    s.alpha_deg = Some(f64::NAN);
                }
                s
            })
            .collect()
    }

    #[test]
    fn roundtrip_fuzz_within_quantisation() {
        let mut rng = Rng(0x5EED_CAFE_F00D_0001);
        for round in 0..40 {
            let n = if round == 0 { 70_000 } else { (rng.next() % 600) as usize };
            let track = random_track(&mut rng, n);
            let back = decode_track(&encode_track(&track)).unwrap();
            assert_eq!(back.len(), track.len());
            for (a, b) in track.iter().zip(&back) {
                for (scale, get, _) in COLUMNS {
                    let tol = 0.5 / scale + 1e-9;
                    assert!((get(a) - get(b)).abs() <= tol, "round {round}: {a:?} vs {b:?}");
                }
                for (scale, get, _) in OPT_COLUMNS {
                    let tol = 0.5 / scale + 1e-9;
                    match (get(a).filter(|v| v.is_finite()), get(b)) {
                        (None, None) => {}
                        (Some(x), Some(y)) => assert!((x - y).abs() <= tol, "round {round}: {x} vs {y}"),
                        (x, y) => panic!("round {round}: presence {x:?} vs {y:?}"),
                    }
                }
            }
        }
    }

    #[test]
    fn corrupt_blobs_never_panic() {
        let mut rng = Rng(0xBAD_B10B);
        let good = encode_track(&random_track(&mut rng, 300));
        let mut raw = Vec::new();
        zstd::Decoder::new(good.as_slice()).unwrap().read_to_end(&mut raw).unwrap();
        for _ in 0..300 {
            // truncate, flip bytes or overwrite the header of the raw stream, then recompress
            let mut r = raw.clone();
            match rng.next() % 3 {
                0 => r.truncate((rng.next() as usize) % r.len()),
                1 => {
                    for _ in 0..1 + rng.next() % 8 {
                        let i = (rng.next() as usize) % r.len();
                        r[i] ^= (rng.next() & 0xff) as u8 | 1;
                    }
                }
                _ => {
                    let c = (rng.next() as u32).to_le_bytes();
                    r[5..9].copy_from_slice(&c);
                }
            }
            let blob = zstd::encode_all(r.as_slice(), 1).unwrap();
            let _ = decode_track(&blob); // Ok or Err, never a panic or an OOM
            // and the compressed bytes themselves, cut or garbled
            let mut b = good.clone();
            let i = (rng.next() as usize) % b.len();
            b[i] ^= 0x5a;
            let _ = decode_track(&b);
            let _ = decode_track(&good[..(rng.next() as usize) % good.len()]);
        }
    }
}
