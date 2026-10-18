//! Pure helpers that turn raw SimConnect bytes/values into VectaSim units.
//! Kept free of FFI so they can be tested against golden bytes.

use crate::ffi::{self, E_FAIL, HRESULT};

/// Width of one STRING256 datum.
pub const STRING256_LEN: usize = 256;

/// What a `SimConnect_GetNextDispatch` call produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchKind {
    /// A message of at least `SIMCONNECT_RECV` size is available.
    Message,
    /// Queue empty (`E_FAIL`), or a success code without a usable buffer.
    Empty,
    /// Any other failure: the connection is gone (e.g. 0xC000014B STATUS_PIPE_BROKEN after a CTD).
    Fatal(HRESULT),
}

/// Classify the result of `GetNextDispatch`. Only `E_FAIL` means "no message";
/// every other negative HRESULT ends the session.
pub fn classify_dispatch(hr: HRESULT, ptr_is_null: bool, cb: u32) -> DispatchKind {
    if hr >= 0 {
        if ptr_is_null || (cb as usize) < std::mem::size_of::<ffi::SIMCONNECT_RECV>() {
            DispatchKind::Empty
        } else {
            DispatchKind::Message
        }
    } else if hr == E_FAIL {
        DispatchKind::Empty
    } else {
        DispatchKind::Fatal(hr)
    }
}

/// Result of decoding one FLOAT64 definition payload.
#[derive(Debug, Clone, PartialEq)]
pub struct F64Decode {
    /// One value per *declared* variable (full definition order). Variables that are not
    /// registered (rejected by the sim) or missing from a short payload are `NaN`.
    pub values: Vec<f64>,
    /// The payload held fewer values than registered variables.
    pub short: bool,
}

/// The FLOAT64 values of a payload as received (a trailing partial value is ignored).
pub fn raw_f64(payload: &[u8]) -> Vec<f64> {
    payload.as_chunks::<8>().0.iter().map(|c| f64::from_le_bytes(*c)).collect()
}

/// The STRING256 slots of a payload as received (a trailing partial slot is ignored).
pub fn raw_str256(payload: &[u8]) -> Vec<String> {
    payload.as_chunks::<STRING256_LEN>().0.iter().map(|c| ffi::cstr_buf(c)).collect()
}

/// Map received values (active variables only, in order) onto the declared variables.
/// Inactive variables and the missing tail of a short payload are `NaN`.
pub fn expand_f64(raw: &[f64], active: &[bool]) -> F64Decode {
    let mut it = raw.iter().copied();
    let n_active = active.iter().filter(|a| **a).count();
    let values = active.iter().map(|&a| if a { it.next().unwrap_or(f64::NAN) } else { f64::NAN }).collect();
    F64Decode { values, short: raw.len() < n_active }
}

/// [`expand_f64`] for strings; missing entries are `None`.
pub fn expand_str(raw: &[String], active: &[bool]) -> (Vec<Option<String>>, bool) {
    let mut it = raw.iter().cloned();
    let n_active = active.iter().filter(|a| **a).count();
    (active.iter().map(|&a| if a { it.next() } else { None }).collect(), raw.len() < n_active)
}

/// Decode a FLOAT64 payload. `active[i]` says whether declared variable `i` is part of the
/// registered definition; the payload contains the active ones in order. A short payload
/// is tolerated: the missing tail reads as `NaN`.
pub fn decode_f64_def(payload: &[u8], active: &[bool]) -> F64Decode {
    expand_f64(&raw_f64(payload), active)
}

/// Decode a STRING256 payload laid out like [`decode_f64_def`]. Missing entries are `None`.
pub fn decode_str256_def(payload: &[u8], active: &[bool]) -> (Vec<Option<String>>, bool) {
    expand_str(&raw_str256(payload), active)
}

/// `TRANSPONDER CODE:n` in unit `bco16` arrives as the raw BCD word (squawk 2000 → 0x2000
/// = 8192.0). Decode it to the decimal digits a pilot reads (2000). `None` for NaN,
/// out-of-range or non-BCD values (a nibble > 9).
pub fn bcd16_to_squawk(raw: f64) -> Option<u32> {
    if !raw.is_finite() || raw < 0.0 || raw > f64::from(u16::MAX) {
        return None;
    }
    let word = raw.round() as u32;
    let mut out = 0;
    for shift in [12, 8, 4, 0] {
        let digit = (word >> shift) & 0xF;
        if digit > 9 {
            return None;
        }
        out = out * 10 + digit;
    }
    Some(out)
}

/// SimConnect bools arrive as FLOAT64; NaN (missing variable) is `None`.
pub fn as_flag(v: f64) -> Option<bool> {
    v.is_finite().then_some(v != 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f64_bytes(v: &[f64]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    }

    #[test]
    fn classify_only_e_fail_is_empty() {
        assert_eq!(classify_dispatch(0, false, 12), DispatchKind::Message);
        assert_eq!(classify_dispatch(0, true, 12), DispatchKind::Empty);
        assert_eq!(classify_dispatch(0, false, 4), DispatchKind::Empty);
        assert_eq!(classify_dispatch(E_FAIL, true, 0), DispatchKind::Empty);
        let pipe_broken = 0xC000_014B_u32 as i32;
        assert_eq!(classify_dispatch(pipe_broken, true, 0), DispatchKind::Fatal(pipe_broken));
        let rpc_gone = 0x8007_0006_u32 as i32; // E_HANDLE
        assert_eq!(classify_dispatch(rpc_gone, false, 100), DispatchKind::Fatal(rpc_gone));
    }

    #[test]
    fn full_payload_decodes_in_order() {
        let d = decode_f64_def(&f64_bytes(&[1.5, -2.0, 3.25]), &[true; 3]);
        assert_eq!(d.values, vec![1.5, -2.0, 3.25]);
        assert!(!d.short);
    }

    #[test]
    fn short_payload_fills_tail_with_nan() {
        let d = decode_f64_def(&f64_bytes(&[1.0, 2.0]), &[true; 4]);
        assert_eq!(&d.values[..2], &[1.0, 2.0]);
        assert!(d.values[2].is_nan() && d.values[3].is_nan());
        assert!(d.short);
        // a trailing partial f64 is ignored, not misread
        let mut b = f64_bytes(&[7.0]);
        b.extend_from_slice(&[1, 2, 3]);
        let d = decode_f64_def(&b, &[true, true]);
        assert_eq!(d.values[0], 7.0);
        assert!(d.values[1].is_nan() && d.short);
    }

    #[test]
    fn inactive_variables_are_nan_and_do_not_shift_others() {
        // var 1 was rejected by the sim → the payload only carries vars 0, 2, 3
        let d = decode_f64_def(&f64_bytes(&[10.0, 30.0, 40.0]), &[true, false, true, true]);
        assert_eq!(d.values[0], 10.0);
        assert!(d.values[1].is_nan());
        assert_eq!(&d.values[2..], &[30.0, 40.0]);
        assert!(!d.short);
    }

    #[test]
    fn nan_values_in_payload_pass_through() {
        let d = decode_f64_def(&f64_bytes(&[f64::NAN, 1.0]), &[true, true]);
        assert!(d.values[0].is_nan());
        assert_eq!(d.values[1], 1.0);
        assert_eq!(as_flag(d.values[0]), None);
        assert_eq!(as_flag(0.0), Some(false));
        assert_eq!(as_flag(1.0), Some(true));
    }

    #[test]
    fn strings_decode_with_missing_entries() {
        let mut p = vec![0u8; STRING256_LEN * 2];
        p[..4].copy_from_slice(b"C172");
        p[STRING256_LEN..STRING256_LEN + 5].copy_from_slice(b"D-EAB");
        let (s, short) = decode_str256_def(&p, &[true, false, true, true]);
        assert_eq!(s, vec![Some("C172".into()), None, Some("D-EAB".into()), None]);
        assert!(short);
    }

    #[test]
    fn transponder_bcd_decodes_to_decimal_squawk() {
        assert_eq!(bcd16_to_squawk(f64::from(0x2000)), Some(2000));
        assert_eq!(bcd16_to_squawk(8192.0), Some(2000));
        assert_eq!(bcd16_to_squawk(f64::from(0x7700)), Some(7700));
        assert_eq!(bcd16_to_squawk(f64::from(0x1200)), Some(1200));
        assert_eq!(bcd16_to_squawk(f64::from(0x0042)), Some(42));
        assert_eq!(bcd16_to_squawk(0.0), Some(0));
        assert_eq!(bcd16_to_squawk(f64::from(0x7777)), Some(7777));
        assert_eq!(bcd16_to_squawk(f64::from(0x00AF)), None); // not BCD
        assert_eq!(bcd16_to_squawk(f64::NAN), None);
        assert_eq!(bcd16_to_squawk(-1.0), None);
        assert_eq!(bcd16_to_squawk(70000.0), None);
    }
}
