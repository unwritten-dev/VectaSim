//! Playback of an X-Plane `.vsdump` (header `source: "xplane"`) through the same
//! [`XpDecoder`] the live session uses. Called by the app's replay provider
//! (`vectasim_simconnect::replay`) for X-Plane dumps. A dump written with another slot
//! layout (an older/newer build) is mapped by dataref name.

use crate::XpDecoder;
use crate::datarefs::{KEY_NUM, KEY_STR, N_SLOTS, NUMERIC, REQ_NUM, REQ_STR, STRINGS, slot_names, slot_owner};
use vectasim_core::ProviderEvent;
use vectasim_core::diag::SharedRawDiag;
use vectasim_dump::{Body, Header, Line, f64_vec};

pub struct XpPlayer {
    decoder: XpDecoder,
    diag: SharedRawDiag,
    sim_name: String,
    req_num: u32,
    req_str: u32,
    /// Dump slot → current slot.
    num_map: Vec<Option<usize>>,
    /// Dump string → current string.
    str_map: Vec<Option<usize>>,
    differ: bool,
    header: Header,
}

impl XpPlayer {
    pub fn new(header: &Header, sim_name: String, diag: SharedRawDiag) -> Self {
        let ours = slot_names();
        let num_map: Vec<Option<usize>> = header.defs.fast.iter().map(|(n, _)| ours.iter().position(|(o, _)| o == n)).collect();
        let str_map: Vec<Option<usize>> = header.defs.statics.iter().map(|n| STRINGS.iter().position(|s| s == n)).collect();
        let differ = header.defs.fast != ours || header.defs.statics.iter().map(String::as_str).ne(STRINGS.iter().copied());
        let req = |k: &str, d: u32| header.reqs.get(k).copied().unwrap_or(d);
        let mut p = Self {
            decoder: XpDecoder::new(diag.clone()),
            diag,
            sim_name,
            req_num: req(KEY_NUM, REQ_NUM),
            req_str: req(KEY_STR, REQ_STR),
            num_map,
            str_map,
            differ,
            header: header.clone(),
        };
        p.apply_header_inactive();
        p
    }

    /// The dump's layout differs from this build (values are mapped by name).
    pub fn definitions_differ(&self) -> bool {
        self.differ
    }

    pub fn decoder(&self) -> &XpDecoder {
        &self.decoder
    }

    fn apply_header_inactive(&mut self) {
        for slot in self.header.inactive.get(KEY_NUM).cloned().unwrap_or_default() {
            if let Some((var, _)) = self.num_map.get(slot).copied().flatten().and_then(slot_owner) {
                self.decoder.mark_inactive(var);
            }
        }
        for i in self.header.inactive.get(KEY_STR).cloned().unwrap_or_default() {
            if let Some(ours) = self.str_map.get(i).copied().flatten() {
                self.decoder.mark_str_inactive(ours);
            }
        }
    }

    /// Events for one line; `ts_ms` stamps telemetry, `wall_ms` the diagnostics.
    pub fn apply(&mut self, line: &Line, ts_ms: u64, wall_ms: u64) -> Vec<ProviderEvent> {
        match &line.body {
            Body::Data { req, v, .. } if *req == self.req_num => {
                let mut ours = vec![f64::NAN; N_SLOTS];
                for (i, x) in f64_vec(v).into_iter().enumerate() {
                    if let Some(Some(j)) = self.num_map.get(i) {
                        ours[*j] = x;
                    }
                }
                self.decoder.on_slots(&ours, ts_ms, line.t, wall_ms)
            }
            Body::Data { req, s, .. } if *req == self.req_str => {
                let mut ours = vec![None; STRINGS.len()];
                for (i, x) in s.iter().enumerate() {
                    if let Some(Some(j)) = self.str_map.get(i) {
                        ours[*j] = Some(x.clone());
                    }
                }
                self.decoder.on_strings(&ours, line.t, wall_ms)
            }
            Body::Exception { def, var, dropped: true, .. } => {
                let name = var.as_deref().unwrap_or_default();
                match def.as_deref() {
                    Some(KEY_NUM) => {
                        if let Some(i) = NUMERIC.iter().position(|v| v.name == name) {
                            self.decoder.mark_inactive(i);
                        }
                    }
                    Some(KEY_STR) => {
                        if let Some(i) = STRINGS.iter().position(|s| *s == name) {
                            self.decoder.mark_str_inactive(i);
                        }
                    }
                    _ => {}
                }
                Vec::new()
            }
            Body::Open { sim_version, simconnect, .. } => {
                self.decoder = XpDecoder::new(self.diag.clone());
                self.apply_header_inactive();
                vec![self.decoder.on_open(self.sim_name.clone(), sim_version.clone(), simconnect.clone(), None, wall_ms)]
            }
            Body::End { reason } => {
                self.decoder.on_end(reason, wall_ms);
                vec![ProviderEvent::Disconnected { reason: reason.clone() }]
            }
            _ => Vec::new(),
        }
    }
}
