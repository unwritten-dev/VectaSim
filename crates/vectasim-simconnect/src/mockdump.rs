//! Mock flight → `.vsdump` converter: encodes [`MockFlight`] samples back into the raw
//! values SimConnect would send (inverse of the decoder's conversions), so replay tests
//! run without a simulator. Used by `examples/mock-to-vsdump.rs` and the tests that check
//! the checked-in fixture `crates/vectasim-core/tests/fixtures/mock-circuit.vsdump`.

use crate::decoder::{
    EVT_SIM, REQ_APPROACH, REQ_DESIGN, REQ_FAST, REQ_SLOW, REQ_STATIC, encode_approach, encode_design, encode_fast, encode_slow, encode_static,
};
use std::io::{self, Write};
use std::path::Path;
use vectasim_core::{MockFlight, MockVariant, ProviderEvent};
use vectasim_dump::{Body, Header, Line};

/// What to convert.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MockDumpSpec {
    pub variant: MockVariant,
    /// Mock time span, seconds since the mock's start.
    pub from_s: f64,
    pub to_s: f64,
    /// FAST frames per second (every frame complete, like SIM_FRAME); SLOW and APPROACH at 1 Hz.
    pub hz: f64,
    /// Wall clock of the first line.
    pub start_wall_ms: u64,
}

/// Wall clock the fixture starts at (fixed, so regenerating gives the same lines).
pub const FIXTURE_WALL_MS: u64 = 1_760_000_000_000;

impl MockDumpSpec {
    /// The fixture: 60 s of final before the first touchdown of loop 0, the landing and
    /// 20 s of rollout, at 60 Hz.
    pub fn final_and_landing() -> Self {
        let td = touchdown_seconds(MockVariant::Standard);
        Self { variant: MockVariant::Standard, from_s: td - 60.0, to_s: td + 20.0, hz: 60.0, start_wall_ms: FIXTURE_WALL_MS }
    }
}

/// Mock time of the first ground contact after being airborne (loop 0), seconds.
pub fn touchdown_seconds(variant: MockVariant) -> f64 {
    let mut f = MockFlight::with_variant(variant);
    let mut airborne = false;
    let mut i = 0u64;
    loop {
        let t = i as f64 * 0.05;
        let s = f.sample(t, 0);
        if !s.on_ground && s.altitude_agl_ft > 100.0 {
            airborne = true;
        } else if airborne && s.on_ground {
            return t;
        }
        i += 1;
        assert!(t < variant.loop_seconds(), "mock loop without a touchdown");
    }
}

/// Header and lines of a session as SimConnect would have delivered `spec`.
pub fn mock_lines(spec: &MockDumpSpec) -> (Header, Vec<Line>) {
    let mut header = crate::dump_header();
    header.app = env!("CARGO_PKG_VERSION").into();
    header.source = "mock".into();
    header.dll = None;
    header.sim = Some("VectaSim Mock".into());
    header.sim_version = Some("0.1".into());
    header.simconnect = Some("mock".into());
    header.started_wall_ms = spec.start_wall_ms;

    let mut lines = Vec::new();
    let line = |t: u64, body: Body| Line { t, w: spec.start_wall_ms + t, body };
    lines.push(line(0, Body::Open { sim: "VectaSim Mock".into(), sim_version: "0.1".into(), simconnect: "mock".into() }));
    lines.push(line(0, Body::SystemState { req: crate::decoder::REQ_STATE_SIM, int: 1 }));
    lines.push(line(1, Body::Event { id: crate::decoder::event_name(EVT_SIM).unwrap_or("Sim").into(), data: 1 }));
    lines.push(line(2, Body::data_str(REQ_STATIC, encode_static(&MockFlight::aircraft()), None)));

    let mut flight = MockFlight::with_variant(spec.variant);
    // design speeds: once, right after the aircraft strings (as the sim answers a ONCE request)
    lines.push(line(2, Body::data_f64(REQ_DESIGN, &encode_design(&flight.sample(spec.from_s, spec.start_wall_ms)), None)));
    let frames = ((spec.to_s - spec.from_s) * spec.hz).round() as u64;
    let mut last_slow_s: Option<u64> = None;
    for i in 0..=frames {
        let t = 3 + (i as f64 * 1000.0 / spec.hz).round() as u64;
        let t_s = spec.from_s + i as f64 / spec.hz;
        for ev in flight.step(t_s, spec.start_wall_ms + t) {
            let ProviderEvent::Telemetry(tel) = ev else { continue };
            let sec = t / 1000;
            if last_slow_s != Some(sec) {
                last_slow_s = Some(sec);
                lines.push(line(t, Body::data_f64(REQ_SLOW, &encode_slow(&tel), None)));
                lines.push(line(t, Body::data_f64(REQ_APPROACH, &encode_approach(&tel), None)));
            }
            lines.push(line(t, Body::data_f64(REQ_FAST, &encode_fast(&tel), None)));
        }
    }
    lines.push(line(lines.last().map_or(0, |l| l.t) + 1, Body::End { reason: "mock: end of dump".into() }));
    (header, lines)
}

/// Write header + lines as one zstd frame at `level` (19 for small fixtures).
pub fn write_dump(path: &Path, header: &Header, lines: &[Line], level: i32) -> io::Result<u64> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut enc = zstd::Encoder::new(std::fs::File::create(path)?, level)?;
    let mut raw = 0u64;
    let mut put = |s: String| -> io::Result<()> {
        raw += s.len() as u64 + 1;
        enc.write_all(s.as_bytes())?;
        enc.write_all(b"\n")
    };
    put(serde_json::to_string(header).map_err(io::Error::other)?)?;
    let mut delta = vectasim_dump::delta::DeltaEncoder::default();
    for l in lines {
        put(serde_json::to_string(&delta.encode(l)).map_err(io::Error::other)?)?;
    }
    enc.finish()?.flush()?;
    Ok(raw)
}
