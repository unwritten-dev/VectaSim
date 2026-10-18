//! Lossless compaction of `data` lines: between keyframes a FLOAT64 payload is written as
//! the difference of the IEEE-754 bit patterns to the previous `data` line of the same
//! request (`dv`, wrapping i64). Slowly changing doubles share sign, exponent and the top
//! of the mantissa, so the difference has far fewer digits than the value – this is what
//! keeps 60 Hz of 17 values below 10 MB/h. The reader restores the exact values; consumers
//! only ever see `v`.
//!
//! Every sink (session file, each ring chunk) has its own [`DeltaEncoder`] and starts with
//! a keyframe; after that a keyframe follows at least every [`KEYFRAME_MS`] per request.
//! NaN and ±inf are canonicalised to NaN first (JSON has neither), so keyframes and deltas
//! agree.

use crate::{Body, Line, Raw};
use std::collections::HashMap;

/// Longest stretch of delta lines per request.
pub const KEYFRAME_MS: u64 = 1_000;

fn canon(x: f64) -> u64 {
    if x.is_finite() { x.to_bits() } else { f64::NAN.to_bits() }
}

#[derive(Debug, Default)]
pub struct DeltaEncoder {
    prev: HashMap<u32, (u64, Vec<u64>)>,
}

impl DeltaEncoder {
    /// The line as written: `data` with `v` turned into `dv` where possible.
    pub fn encode(&mut self, line: &Line) -> Line {
        let Body::Data { req, v, s, bytes, .. } = &line.body else { return line.clone() };
        if v.is_empty() {
            return line.clone();
        }
        let bits: Vec<u64> = v.iter().map(|x| canon(x.0)).collect();
        let body = match self.prev.get(req) {
            Some((key_t, prev)) if prev.len() == bits.len() && line.t.saturating_sub(*key_t) < KEYFRAME_MS => {
                let dv = bits.iter().zip(prev).map(|(a, b)| a.wrapping_sub(*b) as i64).collect();
                let key_t = *key_t;
                self.prev.insert(*req, (key_t, bits));
                Body::Data { req: *req, v: Vec::new(), dv, s: s.clone(), bytes: *bytes }
            }
            _ => {
                self.prev.insert(*req, (line.t, bits));
                return line.clone();
            }
        };
        Line { t: line.t, w: line.w, body }
    }
}

#[derive(Debug, Default)]
pub struct DeltaDecoder {
    prev: HashMap<u32, Vec<u64>>,
}

impl DeltaDecoder {
    /// Restore `v` of a delta line; `Err` for a delta without a preceding keyframe.
    pub fn decode(&mut self, line: Line) -> Result<Line, String> {
        let Line { t, w, body } = line;
        let Body::Data { req, v, dv, s, bytes } = body else { return Ok(Line { t, w, body }) };
        let bits: Vec<u64> = if !dv.is_empty() {
            let prev = self.prev.get(&req).filter(|p| p.len() == dv.len()).ok_or_else(|| format!("delta line for req {req} without keyframe"))?;
            prev.iter().zip(&dv).map(|(p, d)| p.wrapping_add(*d as u64)).collect()
        } else {
            v.iter().map(|x| canon(x.0)).collect()
        };
        let out = bits.iter().map(|b| Raw(f64::from_bits(*b))).collect();
        if !bits.is_empty() {
            self.prev.insert(req, bits);
        }
        Ok(Line { t, w, body: Body::Data { req, v: out, dv: Vec::new(), s, bytes } })
    }
}
