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
//! column per field in `COLUMNS` order, each a sequence of zigzag-varint deltas.

use serde::{Deserialize, Serialize};
use std::io::Read;
use vectasim_core::Telemetry;

const MAGIC: &[u8; 4] = b"VSTK";
const VERSION: u8 = 1;
const ZSTD_LEVEL: i32 = 3;

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
        }
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
    #[error("zstd: {0}")]
    Zstd(#[from] std::io::Error),
}

/// Field accessors with their quantisation scale, in storage order.
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

pub fn encode_track(samples: &[TrackSample]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(16 + samples.len() * 24);
    raw.extend_from_slice(MAGIC);
    raw.push(VERSION);
    raw.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    for (scale, get, _) in COLUMNS {
        let mut prev: i64 = 0;
        for s in samples {
            let q = (get(s) * scale).round() as i64;
            write_varint(&mut raw, zigzag(q.wrapping_sub(prev)));
            prev = q;
        }
    }
    zstd::encode_all(raw.as_slice(), ZSTD_LEVEL).expect("zstd encode into Vec cannot fail")
}

pub fn decode_track(blob: &[u8]) -> Result<Vec<TrackSample>, TrackError> {
    let mut raw = Vec::new();
    zstd::Decoder::new(blob)?.read_to_end(&mut raw)?;
    if raw.len() < 9 {
        return Err(TrackError::Truncated);
    }
    if &raw[..4] != MAGIC {
        return Err(TrackError::BadMagic);
    }
    if raw[4] != VERSION {
        return Err(TrackError::Version(raw[4]));
    }
    let count = u32::from_le_bytes([raw[5], raw[6], raw[7], raw[8]]) as usize;
    let mut samples = vec![TrackSample::default(); count];
    let mut pos = 9;
    for (scale, _, set) in COLUMNS {
        let mut prev: i64 = 0;
        for s in samples.iter_mut() {
            let (d, next) = read_varint(&raw, pos)?;
            pos = next;
            let q = prev.wrapping_add(unzigzag(d));
            prev = q;
            set(s, q as f64 / scale);
        }
    }
    Ok(samples)
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
}
