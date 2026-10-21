//! Session tests against a fake SimConnect backend: no simulator, no DLL.
//! Messages are built byte-for-byte like SimConnect.h lays them out.

use super::*;
use crate::decode::{STRING256_LEN, decode_f64_def};
use crate::decoder::{
    DEF_APPROACH, DEF_DESIGN, DEF_FAST, DEF_SLOW, DEF_STATIC, EVT_SIM, IDX_APPROACH, IDX_SLOW, REQ_APPROACH, REQ_DESIGN, REQ_FAST, REQ_SLOW, REQ_STATIC,
};
use crate::ffi::period;
use std::sync::mpsc::{Receiver, channel};
use vectasim_core::Telemetry;

#[derive(Debug, Clone, PartialEq)]
enum Call {
    Add { def: u32, name: String },
    Clear { def: u32 },
    Request { req: u32, def: u32, period: u32 },
    Subscribe { name: String },
    SystemState { req: u32, state: String },
    Text { text_type: u32, seconds: f32, text: String },
}

/// Scripted backend. Every call gets the next SendID (starting at 1).
#[derive(Default)]
struct FakeApi {
    calls: Vec<(u32, Call)>,
    next_id: u32,
    queue: VecDeque<Result<Vec<u8>, ffi::HRESULT>>,
    /// Names whose AddToDataDefinition returns a failure HRESULT.
    fail_add: Vec<&'static str>,
    fail_request: bool,
    /// Timeouts passed to `wait_for_dispatch` (the pump's idle waits).
    waits: Vec<Duration>,
    /// Raised by the n-th idle wait (n = `stop_after_waits`), to end a `pump` run.
    stop: Option<(Arc<AtomicBool>, usize)>,
}

impl FakeApi {
    fn record(&mut self, c: Call) -> ffi::HRESULT {
        self.next_id += 1;
        self.calls.push((self.next_id, c));
        ffi::S_OK
    }
    fn send_id_of(&self, pred: impl Fn(&Call) -> bool) -> u32 {
        self.calls.iter().rev().find(|(_, c)| pred(c)).map(|(i, _)| *i).expect("call recorded")
    }
}

impl SimApi for FakeApi {
    fn add_to_data_definition(&mut self, def: u32, name: &str, _unit: Option<&str>, _datatype: u32) -> ffi::HRESULT {
        self.record(Call::Add { def, name: name.into() });
        if self.fail_add.contains(&name) { ffi::E_FAIL } else { ffi::S_OK }
    }
    fn clear_data_definition(&mut self, def: u32) -> ffi::HRESULT {
        self.record(Call::Clear { def })
    }
    fn request_data_on_sim_object(&mut self, req: u32, def: u32, period: u32) -> ffi::HRESULT {
        self.record(Call::Request { req, def, period });
        if self.fail_request { 0x8007_0057_u32 as i32 } else { ffi::S_OK }
    }
    fn subscribe_to_system_event(&mut self, _event_id: u32, name: &str) -> ffi::HRESULT {
        self.record(Call::Subscribe { name: name.into() })
    }
    fn request_system_state(&mut self, req: u32, state: &str) -> ffi::HRESULT {
        self.record(Call::SystemState { req, state: state.into() })
    }
    fn text(&mut self, text_type: u32, seconds: f32, _event_id: u32, text: &str) -> ffi::HRESULT {
        self.record(Call::Text { text_type, seconds, text: text.into() })
    }
    fn last_sent_packet_id(&mut self) -> Option<u32> {
        (self.next_id > 0).then_some(self.next_id)
    }
    fn next_dispatch(&mut self, buf: &mut Vec<u8>) -> DispatchKind {
        match self.queue.pop_front() {
            None => DispatchKind::Empty,
            Some(Ok(bytes)) => {
                *buf = bytes;
                DispatchKind::Message
            }
            Some(Err(hr)) => decode::classify_dispatch(hr, true, 0),
        }
    }
    fn wait_for_dispatch(&mut self, timeout: Duration) {
        self.waits.push(timeout);
        if let Some((flag, n)) = &self.stop
            && self.waits.len() >= *n
        {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

// ---- message builders (little-endian, packed like SimConnect.h) ----

fn header(id: u32, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&((12 + body.len()) as u32).to_le_bytes()); // dwSize
    v.extend_from_slice(&6u32.to_le_bytes()); // dwVersion
    v.extend_from_slice(&id.to_le_bytes()); // dwID
    v.extend_from_slice(body);
    v
}

fn dwords(d: &[u32]) -> Vec<u8> {
    d.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn msg_data(req: u32, define: u32, payload: &[u8], define_count: u32) -> Vec<u8> {
    let mut body = dwords(&[req, ffi::SIMCONNECT_OBJECT_ID_USER, define, 0, 1, 1, define_count]);
    body.extend_from_slice(payload);
    header(recv_id::SIMOBJECT_DATA, &body)
}

fn msg_f64(req: u32, define: u32, values: &[f64]) -> Vec<u8> {
    let p: Vec<u8> = values.iter().flat_map(|x| x.to_le_bytes()).collect();
    msg_data(req, define, &p, values.len() as u32)
}

fn msg_exception(code: u32, send_id: u32, index: u32) -> Vec<u8> {
    header(recv_id::EXCEPTION, &dwords(&[code, send_id, index]))
}

fn msg_event(event: u32, data: u32) -> Vec<u8> {
    header(recv_id::EVENT, &dwords(&[ffi::SIMCONNECT_UNUSED, event, data]))
}

fn msg_system_state(req: u32, int: u32) -> Vec<u8> {
    let mut body = dwords(&[req, int]);
    body.extend_from_slice(&0f32.to_le_bytes());
    body.extend_from_slice(&[0u8; 260]);
    header(recv_id::SYSTEM_STATE, &body)
}

fn msg_open(name: &str) -> Vec<u8> {
    let mut n = [0u8; 256];
    n[..name.len()].copy_from_slice(name.as_bytes());
    let mut body = n.to_vec();
    body.extend_from_slice(&dwords(&[11, 0, 282174, 999, 11, 0, 62651, 3, 0, 0]));
    header(recv_id::OPEN, &body)
}

fn fast_values() -> Vec<f64> {
    vec![
        50.0379, 8.5622, 364.0, 9.7, 0.0, 0.0, 0.0, 0.0, 250.0, 252.0, 1.5, 0.0, 1.0, 1.0, 0.0, // 0..14
        1.0, 0.0, // SIMULATION RATE, IS SLEW ACTIVE
    ]
}

fn slow_values() -> Vec<f64> {
    vec![
        100.0, 0.0, 2.0, 1.0, 1.0, 0.0, 0.0, // gear, flaps, n engines, combustion 1..4
        13227.736, 141096.0, 1.0, // fuel lb, weight lb, parking brake
        1.0, 1.0, 0.0, 0.0, 1.0, // lights beacon, nav, strobe, landing, taxi
        f64::from(0x7000), // transponder BCD → 7000
        43200.0, // zulu
    ]
}

fn session() -> (Session<FakeApi>, Sender<ProviderEvent>, Receiver<ProviderEvent>, Instant) {
    let t0 = Instant::now();
    let mut s = Session::new(FakeApi::default(), WatchdogConfig::default(), t0);
    // own queue: tests must not race on the process-wide one
    s.texts = text::TextQueue::default();
    s.register();
    let (tx, rx) = channel();
    (s, tx, rx, t0)
}

fn drain(rx: &Receiver<ProviderEvent>) -> Vec<ProviderEvent> {
    rx.try_iter().collect()
}

fn errors(ev: &[ProviderEvent]) -> Vec<String> {
    ev.iter()
        .filter_map(|e| match e {
            ProviderEvent::Error { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

fn last_telemetry(ev: &[ProviderEvent]) -> Telemetry {
    ev.iter()
        .rev()
        .find_map(|e| match e {
            ProviderEvent::Telemetry(t) => Some((**t).clone()),
            _ => None,
        })
        .expect("telemetry sample")
}

/// Run steps until the queue is drained (bounded).
fn run_queue(s: &mut Session<FakeApi>, tx: &Sender<ProviderEvent>, now: Instant) -> Result<(), SessionEnd> {
    for _ in 0..100 {
        if !s.step(now, tx)? {
            return Ok(());
        }
    }
    Ok(())
}

// ---- layout / constants ----

#[test]
fn payload_offset_matches_simconnect_h() {
    // SIMCONNECT_RECV (3 DWORD) + 7 DWORD header fields = 40 bytes before dwData
    assert_eq!(ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET, 40);
}

#[test]
fn definitions_have_expected_sizes() {
    assert_eq!(FAST_VARS.len(), 17);
    assert_eq!(SLOW_VARS.len(), 17);
    assert_eq!(STATIC_VARS.len(), 6);
    // slew and sim rate are per-frame now, not 1 Hz
    assert_eq!(FAST_VARS[15].0, "SIMULATION RATE");
    assert_eq!(FAST_VARS[16].0, "IS SLEW ACTIVE");
    assert!(!SLOW_VARS.iter().any(|(v, _)| *v == "IS SLEW ACTIVE" || *v == "SIMULATION RATE"));
    assert_eq!(SLOW_VARS[15].0, "TRANSPONDER CODE:1");
    assert_eq!(APPROACH_VARS.len(), 23);
    assert_eq!(DESIGN_VARS.len(), 3);
    // AIRSPEED TRUE stays in FAST; the approach definition does not duplicate it
    assert!(FAST_VARS.iter().any(|(v, _)| *v == "AIRSPEED TRUE"));
    assert!(!APPROACH_VARS.iter().any(|(v, _)| *v == "AIRSPEED TRUE" || *v == "AUTOTHROTTLE ACTIVE"));
    // every NAV variable names its receiver index
    assert!(APPROACH_VARS.iter().filter(|(v, _)| v.starts_with("NAV ")).all(|(v, _)| v.ends_with(":1")));
}

#[test]
fn golden_simobject_data_bytes() {
    // SIMOBJECT_DATA, request 1, define 1, two FLOAT64 (1.0, -2.5) — hand-assembled reference bytes.
    #[rustfmt::skip]
    let golden: [u8; 56] = [
        0x38, 0, 0, 0,   6, 0, 0, 0,   8, 0, 0, 0,          // dwSize=56, dwVersion=6, dwID=SIMOBJECT_DATA
        1, 0, 0, 0,   0, 0, 0, 0,   1, 0, 0, 0,             // dwRequestID, dwObjectID, dwDefineID
        0, 0, 0, 0,   1, 0, 0, 0,   1, 0, 0, 0,   2, 0, 0, 0, // dwFlags, dwentrynumber, dwoutof, dwDefineCount
        0, 0, 0, 0, 0, 0, 0xF0, 0x3F,                        // 1.0
        0, 0, 0, 0, 0, 0, 0x04, 0xC0,                        // -2.5
    ];
    assert_eq!(msg_f64(1, 1, &[1.0, -2.5]), golden.to_vec());
    let hdr = unsafe { std::ptr::read_unaligned(golden.as_ptr() as *const ffi::SIMCONNECT_RECV_SIMOBJECT_DATA) };
    assert_eq!({ hdr.dw_request_id }, 1);
    assert_eq!({ hdr.dw_define_count }, 2);
    let d = decode_f64_def(&golden[ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET..], &[true, true]);
    assert_eq!(d.values, vec![1.0, -2.5]);
}

#[test]
fn backoff_is_capped_at_10s_without_a_flight() {
    let mut b = INITIAL_BACKOFF;
    let mut seen = Vec::new();
    for _ in 0..6 {
        b = next_backoff(b, false);
        seen.push(b.as_secs());
    }
    assert_eq!(seen, vec![4, 8, 10, 10, 10, 10]);
    let mut b = INITIAL_BACKOFF;
    for _ in 0..6 {
        b = next_backoff(b, true);
    }
    assert_eq!(b, Duration::from_secs(30));
    assert_eq!(Duration::from_secs(30).min(max_backoff(false)), Duration::from_secs(10));
}

// ---- registration ----

#[test]
fn register_adds_all_vars_requests_subscribes_and_queries_state() {
    let (s, _tx, _rx, _) = session();
    let calls: Vec<&Call> = s.api.calls.iter().map(|(_, c)| c).collect();
    let adds = calls.iter().filter(|c| matches!(c, Call::Add { .. })).count();
    assert_eq!(adds, FAST_VARS.len() + SLOW_VARS.len() + STATIC_VARS.len() + APPROACH_VARS.len() + DESIGN_VARS.len());
    assert!(calls.contains(&&Call::Request { req: REQ_FAST, def: DEF_FAST, period: period::SIM_FRAME }));
    assert!(calls.contains(&&Call::Request { req: REQ_SLOW, def: DEF_SLOW, period: period::SECOND }));
    assert!(calls.contains(&&Call::Request { req: REQ_STATIC, def: DEF_STATIC, period: period::ONCE }));
    assert!(calls.contains(&&Call::Request { req: REQ_APPROACH, def: DEF_APPROACH, period: period::SECOND }));
    assert!(calls.contains(&&Call::Request { req: REQ_DESIGN, def: DEF_DESIGN, period: period::ONCE }));
    assert_eq!(calls.iter().filter(|c| matches!(c, Call::Subscribe { .. })).count(), SYSTEM_EVENTS.len());
    assert_eq!(calls.last(), Some(&&Call::SystemState { req: REQ_STATE_SIM, state: "Sim".into() }));
    assert!(s.notices.is_empty());
}

#[test]
fn failed_hresults_are_reported() {
    let api = FakeApi { fail_add: vec!["G FORCE"], fail_request: true, ..Default::default() };
    let mut s = Session::new(api, WatchdogConfig::default(), Instant::now());
    s.register();
    let (tx, rx) = channel();
    s.step(Instant::now(), &tx).unwrap();
    let errs = errors(&drain(&rx));
    assert!(errs.iter().any(|e| e.contains("AddToDataDefinition(FAST, \"G FORCE\") failed hr=0x80004005")), "{errs:?}");
    assert!(errs.iter().any(|e| e.contains("RequestDataOnSimObject(SLOW) failed hr=0x80070057")), "{errs:?}");
}

// ---- telemetry decoding ----

#[test]
fn full_fast_and_slow_payloads_fill_telemetry() {
    let (mut s, tx, rx, t0) = session();
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &slow_values())));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    assert!(errors(&ev).is_empty(), "{:?}", errors(&ev));
    let t = last_telemetry(&ev);
    assert_eq!(t.latitude, 50.0379);
    assert_eq!(t.altitude_agl_ft, 9.7);
    assert!(t.on_ground);
    assert_eq!(t.sim_rate, 1.0);
    assert!(!t.slew);
    assert_eq!(t.gear_pct, 100.0);
    assert_eq!(t.num_engines, 2);
    assert_eq!(t.engines_running, 2);
    assert!((t.fuel_total_kg - 6000.0).abs() < 0.01);
    assert!(t.parking_brake);
    assert!(t.lights.beacon && t.lights.nav && !t.lights.strobe && !t.lights.landing && t.lights.taxi);
    assert_eq!(t.transponder_code, 7000);
    assert_eq!(t.sim_zulu_time_s, 43200.0);
}

#[test]
fn slew_and_sim_rate_arrive_with_the_fast_frame() {
    let (mut s, tx, rx, t0) = session();
    let mut v = fast_values();
    v[15] = 4.0;
    v[16] = 1.0;
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &v)));
    run_queue(&mut s, &tx, t0).unwrap();
    let t = last_telemetry(&drain(&rx));
    assert_eq!(t.sim_rate, 4.0);
    assert!(t.slew);
}

#[test]
fn short_fast_payload_still_yields_telemetry_and_warns_once() {
    let (mut s, tx, rx, t0) = session();
    let v = fast_values();
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &v)));
    // two frames that lack the last 3 values (e.g. a datum dropped by the sim)
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &[51.0, 9.0])));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &v[..14])));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    let tele: Vec<&Telemetry> = ev
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::Telemetry(t) => Some(&**t),
            _ => None,
        })
        .collect();
    assert_eq!(tele.len(), 3, "every frame produces a sample");
    // the frame with only lat/lon updates those and keeps the rest
    assert_eq!(tele[1].latitude, 51.0);
    assert_eq!(tele[1].altitude_msl_ft, 364.0);
    assert!(tele[1].on_ground, "missing SIM ON GROUND keeps the previous value instead of NaN→true");
    let short_warnings = errors(&ev).iter().filter(|e| e.contains("too short")).count();
    assert_eq!(short_warnings, 1);
}

#[test]
fn nan_fields_keep_previous_values() {
    let (mut s, tx, rx, t0) = session();
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    let mut v = fast_values();
    v[2] = f64::NAN;
    v[13] = f64::NAN;
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &v)));
    let mut sv = slow_values();
    sv[15] = f64::NAN;
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &slow_values())));
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &sv)));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &v)));
    run_queue(&mut s, &tx, t0).unwrap();
    let t = last_telemetry(&drain(&rx));
    assert_eq!(t.altitude_msl_ft, 364.0);
    assert!(t.on_ground);
    assert_eq!(t.transponder_code, 7000);
}

#[test]
fn transponder_bcd_is_decoded_in_slow() {
    let (mut s, tx, rx, t0) = session();
    let mut sv = slow_values();
    sv[15] = 8192.0; // 0x2000
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &sv)));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    run_queue(&mut s, &tx, t0).unwrap();
    assert_eq!(last_telemetry(&drain(&rx)).transponder_code, 2000);
}

#[test]
fn static_strings_decode_and_tolerate_short_payload() {
    let (mut s, tx, rx, t0) = session();
    let mut p = vec![0u8; STRING256_LEN * 4]; // only 4 of 6 strings
    p[..8].copy_from_slice(b"A320 Neo");
    let model = b"TT:ATCCOM.AC_MODEL_A20N.0.text";
    p[STRING256_LEN..STRING256_LEN + model.len()].copy_from_slice(model);
    p[3 * STRING256_LEN..3 * STRING256_LEN + 5].copy_from_slice(b"D-AIN");
    s.api.queue.push_back(Ok(msg_data(REQ_STATIC, DEF_STATIC, &p, 4)));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    let info = ev
        .iter()
        .find_map(|e| match e {
            ProviderEvent::Aircraft(a) => Some(a.clone()),
            _ => None,
        })
        .expect("aircraft");
    assert_eq!(info.title, "A320 Neo");
    assert_eq!(info.atc_model, "TT:ATCCOM.AC_MODEL_A20N.0.text");
    assert_eq!(info.atc_id, "D-AIN");
    assert_eq!(info.atc_flight_number, "");
    assert_eq!(errors(&ev).iter().filter(|e| e.contains("STATIC too short")).count(), 1);
}

// ---- exceptions ----

#[test]
fn exception_names_the_rejected_simvar_and_rebuilds_the_definition() {
    let (mut s, tx, rx, t0) = session();
    let bad = "PLANE TOUCHDOWN NORMAL VELOCITY";
    let send_id = s.api.send_id_of(|c| matches!(c, Call::Add { name, .. } if name == bad));
    let calls_before = s.api.calls.len();
    s.api.queue.push_back(Ok(msg_exception(7, send_id, 1)));
    run_queue(&mut s, &tx, t0).unwrap();

    let errs = errors(&drain(&rx));
    assert_eq!(errs.len(), 1);
    assert!(errs[0].contains("NAME_UNRECOGNIZED (7)"), "{}", errs[0]);
    assert!(errs[0].contains(&format!("AddToDataDefinition(FAST, \"{bad}\")")), "{}", errs[0]);

    // definition cleared and re-added without the bad variable, request re-issued
    let new: Vec<Call> = s.api.calls[calls_before..].iter().map(|(_, c)| c.clone()).collect();
    assert_eq!(new[0], Call::Clear { def: DEF_FAST });
    let re_added: Vec<&str> = new
        .iter()
        .filter_map(|c| match c {
            Call::Add { def, name } if *def == DEF_FAST => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(re_added.len(), FAST_VARS.len() - 1);
    assert!(!re_added.contains(&bad));
    assert_eq!(new.last(), Some(&Call::Request { req: REQ_FAST, def: DEF_FAST, period: period::SIM_FRAME }));

    // the next frame (one value fewer) maps correctly: values after the gap are not shifted
    let mut v = fast_values();
    v.remove(14);
    *v.last_mut().unwrap() = 1.0; // IS SLEW ACTIVE
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &v)));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    assert!(errors(&ev).is_empty(), "{:?}", errors(&ev));
    let t = last_telemetry(&ev);
    assert_eq!(t.touchdown_vs_fpm, 0.0, "rejected field stays at its default");
    assert_eq!(t.sim_rate, 1.0);
    assert!(t.slew);
}

#[test]
fn repeated_exception_for_the_same_var_does_not_rebuild_twice() {
    let (mut s, tx, _rx, t0) = session();
    let send_id = s.api.send_id_of(|c| matches!(c, Call::Add { name, .. } if name == "LIGHT TAXI"));
    s.api.queue.push_back(Ok(msg_exception(7, send_id, 1)));
    s.api.queue.push_back(Ok(msg_exception(7, send_id, 1)));
    run_queue(&mut s, &tx, t0).unwrap();
    let clears = s.api.calls.iter().filter(|(_, c)| *c == Call::Clear { def: DEF_SLOW }).count();
    assert_eq!(clears, 1);
    assert!(!s.decoder.defs[IDX_SLOW].active[14]);
}

#[test]
fn exception_for_a_request_or_unknown_send_id_is_logged_only() {
    let (mut s, tx, rx, t0) = session();
    let req_id = s.api.send_id_of(|c| matches!(c, Call::Request { req, .. } if *req == REQ_SLOW));
    let n = s.api.calls.len();
    s.api.queue.push_back(Ok(msg_exception(20, req_id, 0)));
    s.api.queue.push_back(Ok(msg_exception(1, 99_999, 0)));
    run_queue(&mut s, &tx, t0).unwrap();
    let errs = errors(&drain(&rx));
    assert!(errs[0].contains("DATA_ERROR (20) on RequestDataOnSimObject(SLOW)"), "{}", errs[0]);
    assert!(errs[1].contains("ERROR (1) on an untracked call"), "{}", errs[1]);
    assert_eq!(s.api.calls.len(), n, "no re-registration");
}

#[test]
fn static_var_rejection_rebuilds_and_rerequests_static() {
    let (mut s, tx, _rx, t0) = session();
    let send_id = s.api.send_id_of(|c| matches!(c, Call::Add { name, .. } if name == "ATC AIRLINE"));
    s.api.queue.push_back(Ok(msg_exception(7, send_id, 1)));
    run_queue(&mut s, &tx, t0).unwrap();
    assert!(!s.decoder.defs[IDX_STATIC].active[4]);
    assert_eq!(
        s.api.calls.last().map(|(_, c)| c.clone()),
        Some(Call::Request { req: REQ_STATIC, def: DEF_STATIC, period: period::ONCE })
    );
}

// ---- approach definition (track v2) ----

fn approach_values() -> Vec<f64> {
    vec![
        12.0, 245.0, // wind kt, direction (true)
        1.0, 1.0, 1.0, // has localizer, has glide slope, GS flag
        -0.12, 34.0, 0.68, // GS error °, CDI, radial error °
        3.0, 246.0, // raw glide slope °, localizer course °
        1.0, 1.0, 0.0, // AP master, approach hold, glideslope hold
        0.0, 1.0, // managed throttle, throttle arm
        48.0, 52.0, 41.5, // N1 1, N1 2, throttle lever 1
        0.0, 1.0, 0.0, // spoiler handle, armed, left surface
        4.2, 5.0, // alpha °, flap positions
    ]
}

#[test]
fn approach_payload_fills_the_optional_telemetry() {
    let (mut s, tx, rx, t0) = session();
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &slow_values())));
    s.api.queue.push_back(Ok(msg_f64(REQ_APPROACH, DEF_APPROACH, &approach_values())));
    s.api.queue.push_back(Ok(msg_f64(REQ_DESIGN, DEF_DESIGN, &[112.0, 128.0, 590.0])));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    assert!(errors(&ev).is_empty(), "{:?}", errors(&ev));
    let t = last_telemetry(&ev);
    assert_eq!((t.wind_kt, t.wind_dir_true_deg), (Some(12.0), Some(245.0)));
    assert_eq!((t.nav_has_localizer, t.nav_has_glide_slope, t.nav_gs_flag), (Some(true), Some(true), Some(true)));
    assert_eq!((t.nav_gs_error_deg, t.nav_cdi, t.nav_radial_error_deg), (Some(-0.12), Some(34.0), Some(0.68)));
    assert_eq!((t.nav_gs_angle_deg, t.nav_loc_course_deg), (Some(3.0), Some(246.0)));
    assert_eq!((t.autopilot_master, t.autopilot_approach_hold, t.autopilot_glideslope_hold), (Some(true), Some(true), Some(false)));
    assert_eq!(t.autothrottle_active, Some(true), "throttle arm counts");
    assert_eq!(t.n1_pct, Some(50.0), "mean of both engines");
    assert_eq!((t.throttle_lever_pct, t.spoilers_handle_pct, t.spoilers_armed, t.spoilers_pct), (Some(41.5), Some(0.0), Some(true), Some(0.0)));
    assert_eq!((t.alpha_deg, t.flap_positions), (Some(4.2), Some(5)));
    assert_eq!((t.design_vs0_kt, t.design_vs1_kt), (Some(112.0), Some(128.0)));
    assert!((t.design_vc_kt.unwrap() - 349.57).abs() < 0.01, "VC from ft/s: {:?}", t.design_vc_kt);
}

#[test]
fn ils_deviations_need_the_station_component() {
    let (mut s, tx, rx, t0) = session();
    let mut v = approach_values();
    v[2] = 1.0; // localizer only (e.g. LOC approach)
    v[3] = 0.0;
    v[22] = 0.0; // FLAPS NUM HANDLE POSITIONS 0 = not set
    s.api.queue.push_back(Ok(msg_f64(REQ_APPROACH, DEF_APPROACH, &v)));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    run_queue(&mut s, &tx, t0).unwrap();
    let t = last_telemetry(&drain(&rx));
    assert_eq!(t.nav_cdi, Some(34.0));
    assert_eq!((t.nav_gs_error_deg, t.nav_gs_angle_deg), (None, None), "no glideslope: no deviation, not a centred needle");
    assert_eq!(t.flap_positions, None);
    // nothing tuned at all
    v[2] = 0.0;
    s.api.queue.push_back(Ok(msg_f64(REQ_APPROACH, DEF_APPROACH, &v)));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    run_queue(&mut s, &tx, t0).unwrap();
    let t = last_telemetry(&drain(&rx));
    assert_eq!((t.nav_cdi, t.nav_radial_error_deg, t.nav_loc_course_deg), (None, None, None));
    assert_eq!(t.wind_kt, Some(12.0), "the rest is unaffected");
}

#[test]
fn an_unknown_approach_variable_costs_only_itself() {
    let (mut s, tx, rx, t0) = session();
    let bad = "NAV RAW GLIDE SLOPE:1";
    let send_id = s.api.send_id_of(|c| matches!(c, Call::Add { name, .. } if name == bad));
    let calls_before = s.api.calls.len();
    s.api.queue.push_back(Ok(msg_exception(7, send_id, 1)));
    run_queue(&mut s, &tx, t0).unwrap();
    let errs = errors(&drain(&rx));
    assert!(errs[0].contains(&format!("AddToDataDefinition(APPROACH, \"{bad}\")")), "{}", errs[0]);
    let new: Vec<Call> = s.api.calls[calls_before..].iter().map(|(_, c)| c.clone()).collect();
    assert_eq!(new[0], Call::Clear { def: DEF_APPROACH });
    assert!(new.iter().all(|c| !matches!(c, Call::Clear { def } if *def != DEF_APPROACH)), "FAST/SLOW untouched: {new:?}");
    assert_eq!(new.last(), Some(&Call::Request { req: REQ_APPROACH, def: DEF_APPROACH, period: period::SECOND }));
    assert!(!s.decoder.defs[IDX_APPROACH].active[8]);

    // the next payload is one value shorter; the values after the gap stay in place
    let mut v = approach_values();
    v.remove(8);
    s.api.queue.push_back(Ok(msg_f64(REQ_APPROACH, DEF_APPROACH, &v)));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    assert!(errors(&ev).is_empty(), "{:?}", errors(&ev));
    let t = last_telemetry(&ev);
    assert_eq!(t.nav_gs_angle_deg, None, "rejected: not recorded");
    assert_eq!((t.nav_loc_course_deg, t.flap_positions, t.alpha_deg), (Some(246.0), Some(5), Some(4.2)));
    assert_eq!(t.latitude, 50.0379, "FAST unaffected");
}

#[test]
fn aircraft_loaded_rerequests_static_and_design() {
    let (mut s, tx, _rx, t0) = session();
    let n = s.api.calls.len();
    s.api.queue.push_back(Ok(msg_filename(decoder::EVT_AIRCRAFT_LOADED, "SimObjects/Airplanes/A320/aircraft.cfg")));
    run_queue(&mut s, &tx, t0).unwrap();
    let new: Vec<Call> = s.api.calls[n..].iter().map(|(_, c)| c.clone()).collect();
    assert_eq!(
        new,
        [Call::Request { req: REQ_STATIC, def: DEF_STATIC, period: period::ONCE }, Call::Request { req: REQ_DESIGN, def: DEF_DESIGN, period: period::ONCE }]
    );
}

#[test]
fn approach_encoding_is_the_inverse_of_the_decoder() {
    let mut flight = vectasim_core::MockFlight::new();
    for t_s in [5.0, 200.0, 330.0, 345.0, 380.0] {
        let m = flight.sample(t_s, 1_000);
        let mut d = Decoder::new(RawDiag::shared("test"));
        d.on_values_f64(decoder::IDX_SLOW, &decoder::encode_slow(&m), 0, 0, 0);
        d.on_values_f64(IDX_APPROACH, &decoder::encode_approach(&m), 0, 0, 0);
        d.on_values_f64(decoder::IDX_DESIGN, &decoder::encode_design(&m), 0, 0, 0);
        let t = d.telemetry();
        assert_eq!((t.wind_kt, t.nav_gs_error_deg, t.nav_cdi, t.nav_gs_flag), (m.wind_kt, m.nav_gs_error_deg, m.nav_cdi, m.nav_gs_flag), "t={t_s}");
        assert_eq!((t.autopilot_master, t.autothrottle_active, t.n1_pct, t.spoilers_pct), (m.autopilot_master, m.autothrottle_active, m.n1_pct, m.spoilers_pct));
        assert_eq!((t.alpha_deg, t.flap_positions, t.design_vs0_kt), (m.alpha_deg, m.flap_positions, m.design_vs0_kt));
        assert!((t.design_vc_kt.unwrap() - m.design_vc_kt.unwrap()).abs() < 1e-9);
    }
}

// ---- connection lifecycle ----

#[test]
fn quit_ends_the_session() {
    let (mut s, tx, _rx, t0) = session();
    s.api.queue.push_back(Ok(header(recv_id::QUIT, &[])));
    assert_eq!(run_queue(&mut s, &tx, t0), Err(SessionEnd::Quit));
}

#[test]
fn broken_pipe_ends_the_session_but_e_fail_does_not() {
    let (mut s, tx, _rx, t0) = session();
    s.api.queue.push_back(Err(ffi::E_FAIL));
    assert_eq!(s.step(t0, &tx), Ok(false));
    let pipe_broken = 0xC000_014B_u32 as i32;
    s.api.queue.push_back(Err(pipe_broken));
    let end = s.step(t0, &tx).unwrap_err();
    assert_eq!(end, SessionEnd::ConnectionLost(pipe_broken));
    assert!(end.reason().contains("0xC000014B"));
}

#[test]
fn open_message_announces_connection() {
    let (mut s, tx, rx, t0) = session();
    s.api.queue.push_back(Ok(msg_open("KittyHawk")));
    run_queue(&mut s, &tx, t0).unwrap();
    let ev = drain(&rx);
    assert!(ev.iter().any(|e| matches!(e, ProviderEvent::Connected { sim_name, sim_version }
        if sim_name == "KittyHawk" && sim_version == "11.0.282174.999")));
}

#[test]
fn watchdog_probes_a_silent_sim_and_disconnects_after_two_misses() {
    let (mut s, tx, _rx, t0) = session();
    s.api.queue.push_back(Ok(msg_event(EVT_SIM, 1))); // flight running → 5 s threshold
    assert_eq!(s.step(t0, &tx), Ok(true));
    assert!(s.sim_running);
    let probes = |s: &Session<FakeApi>| s.api.calls.iter().filter(|(_, c)| matches!(c, Call::SystemState { .. })).count();
    let initial = probes(&s);
    let at = |secs: u64| t0 + Duration::from_secs(secs);
    assert_eq!(s.step(at(4), &tx), Ok(false));
    assert_eq!(probes(&s), initial);
    assert_eq!(s.step(at(5), &tx), Ok(false));
    assert_eq!(probes(&s), initial + 1);
    assert_eq!(s.step(at(10), &tx), Ok(false));
    assert_eq!(probes(&s), initial + 2);
    assert_eq!(s.step(at(15), &tx), Err(SessionEnd::Unresponsive(Duration::from_secs(15))));
}

#[test]
fn watchdog_answer_keeps_a_paused_sim_alive() {
    let (mut s, tx, _rx, t0) = session();
    s.api.queue.push_back(Ok(msg_system_state(REQ_STATE_SIM, 1)));
    assert_eq!(s.step(t0, &tx), Ok(true));
    assert!(s.sim_running, "state answer sets sim_running");
    let at = |secs: u64| t0 + Duration::from_secs(secs);
    assert_eq!(s.step(at(5), &tx), Ok(false)); // probe
    s.api.queue.push_back(Ok(msg_system_state(REQ_STATE_SIM, 1))); // answer
    assert_eq!(s.step(at(6), &tx), Ok(true));
    assert_eq!(s.step(at(10), &tx), Ok(false));
    assert_eq!(s.step(at(11), &tx), Ok(false)); // probe again, not dead
    assert_eq!(s.step(at(15), &tx), Ok(false));
    assert_eq!(s.step(at(16), &tx), Ok(false));
    assert!(s.step(at(21), &tx).is_err(), "dies only once answers stop");
}

#[test]
fn menu_uses_the_longer_threshold() {
    let (mut s, tx, _rx, t0) = session();
    s.api.queue.push_back(Ok(msg_system_state(REQ_STATE_SIM, 0)));
    s.step(t0, &tx).unwrap();
    let n = s.api.calls.len();
    assert_eq!(s.step(t0 + Duration::from_secs(29), &tx), Ok(false));
    assert_eq!(s.api.calls.len(), n);
    assert_eq!(s.step(t0 + Duration::from_secs(30), &tx), Ok(false));
    assert_eq!(s.api.calls.len(), n + 1);
}

#[test]
fn channel_closed_ends_the_session() {
    let (mut s, tx, rx, t0) = session();
    drop(rx);
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast_values())));
    assert_eq!(s.step(t0, &tx), Err(SessionEnd::ChannelClosed));
}

// ---- raw dump: recorded before interpretation, replayed through the same decoder ----

fn msg_filename(event: u32, path: &str) -> Vec<u8> {
    let mut body = dwords(&[ffi::SIMCONNECT_UNUSED, event, 0]);
    let mut p = [0u8; 260];
    p[..path.len()].copy_from_slice(path.as_bytes());
    body.extend_from_slice(&p);
    body.extend_from_slice(&0u32.to_le_bytes());
    header(recv_id::EVENT_FILENAME, &body)
}

/// Normalise what legitimately differs between live and replay (the replay names itself).
fn comparable(ev: &[ProviderEvent]) -> Vec<String> {
    ev.iter()
        .map(|e| match e {
            ProviderEvent::Connected { sim_version, .. } => format!("Connected {sim_version}"),
            other => format!("{other:?}"),
        })
        .collect()
}

#[test]
fn a_recorded_session_replays_to_the_same_provider_events() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.vsdump");
    let rec = Arc::new(DumpRecorder::new("test", vectasim_dump::RingConfig::default()));
    rec.set_target(vectasim_dump::FileTarget::Path(path.clone()));
    let api = FakeApi { fail_add: vec!["G FORCE"], ..Default::default() };
    let t0 = Instant::now();
    let mut s = Session::new(api, WatchdogConfig::default(), t0).with_recorder(rec.clone());
    s.register();
    let (tx, rx) = channel();

    let bad = "PLANE TOUCHDOWN NORMAL VELOCITY";
    let send_id = s.api.send_id_of(|c| matches!(c, Call::Add { name, .. } if name == bad));
    let mut fast = fast_values();
    fast[14] = -2.5; // fps, positive-down in the sim → −150 fpm after ×60
    let mut short_static = vec![0u8; STRING256_LEN * 4];
    short_static[..4].copy_from_slice(b"C172");
    let mut without_td = fast_values();
    without_td.remove(14);
    let msgs = vec![
        msg_open("KittyHawk"),
        msg_system_state(REQ_STATE_SIM, 1),
        msg_f64(REQ_SLOW, DEF_SLOW, &slow_values()),
        msg_f64(REQ_FAST, DEF_FAST, &fast),
        msg_event(decoder::EVT_PAUSE, 1),
        msg_f64(REQ_FAST, DEF_FAST, &fast),
        msg_event(decoder::EVT_PAUSE, 0),
        msg_exception(7, send_id, 1),
        msg_f64(REQ_FAST, DEF_FAST, &without_td),
        msg_f64(REQ_FAST, DEF_FAST, &[51.0, 9.0]),
        msg_data(REQ_STATIC, DEF_STATIC, &short_static, 4),
        msg_filename(decoder::EVT_AIRCRAFT_LOADED, r"SimObjects\Airplanes\C172\aircraft.cfg"),
        msg_filename(decoder::EVT_FLIGHT_LOADED, r"flights\other.FLT"),
        msg_event(decoder::EVT_CRASHED, 0),
        msg_exception(1, 99_999, 0),
        msg_event(EVT_SIM, 0),
        header(recv_id::QUIT, &[]),
    ];
    s.api.queue.extend(msgs.into_iter().map(Ok));
    assert_eq!(run_queue(&mut s, &tx, t0), Err(SessionEnd::Quit));
    s.finish(SessionEnd::Quit);
    rec.flush_and_close();
    let live = drain(&rx);
    assert!(live.iter().any(|e| matches!(e, ProviderEvent::Aircraft(a) if a.title == "C172")));
    assert!(errors(&live).iter().any(|e| e.contains("G FORCE")), "registration failure is part of the stream");

    let (h, lines, err) = vectasim_dump::read_all(&path).unwrap();
    assert!(err.is_none());
    assert_eq!(h.sim.as_deref(), Some("KittyHawk"), "header written after OPEN carries the sim");
    assert_eq!(h.sim_version.as_deref(), Some("11.0.282174.999"));
    assert_eq!(h.simconnect.as_deref(), Some("11.0.62651.3"));
    assert!(lines.iter().any(|l| matches!(&l.body, Body::Exception { dropped: true, var: Some(v), .. } if v == bad)));
    assert!(matches!(lines.last().unwrap().body, Body::End { .. }));

    let mut player = replay::Player::new(&h, "Replay session.vsdump".into(), RawDiag::shared("replay"));
    let replayed: Vec<ProviderEvent> = lines.iter().flat_map(|l| player.apply(l, l.w, l.w)).collect();
    let (live_c, mut replay_c) = (comparable(&live), comparable(&replayed));
    assert_eq!(replay_c.pop().as_deref(), Some("Disconnected { reason: \"simulator quit\" }"), "the end line");
    // the live session reports registration failures before the first message
    let mut live_sorted = live_c.clone();
    let mut replay_sorted = replay_c.clone();
    live_sorted.sort();
    replay_sorted.sort();
    assert_eq!(live_sorted, replay_sorted);
    let telemetry = |c: &[String]| c.iter().filter(|e| e.starts_with("Telemetry")).cloned().collect::<Vec<_>>();
    assert_eq!(telemetry(&live_c), telemetry(&replay_c), "telemetry in the same order with the same values");
    assert_eq!(telemetry(&live_c).len(), 4);
}

#[test]
fn diagnostics_show_raw_and_converted_values_and_named_events() {
    let (mut s, tx, _rx, t0) = session();
    let mut fast = fast_values();
    fast[14] = -2.5;
    s.api.queue.push_back(Ok(msg_open("KittyHawk")));
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &slow_values())));
    for i in 0..30u64 {
        s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast)));
        run_queue(&mut s, &tx, t0 + Duration::from_millis(i * 1000 / 30)).unwrap();
    }
    let send_id = s.api.send_id_of(|c| matches!(c, Call::Add { name, .. } if name == "LIGHT TAXI"));
    s.api.queue.push_back(Ok(msg_exception(7, send_id, 1)));
    s.api.queue.push_back(Ok(msg_event(decoder::EVT_PAUSE, 1)));
    run_queue(&mut s, &tx, t0 + Duration::from_secs(1)).unwrap();

    let d = s.decoder.diag().lock().unwrap().snapshot(now_ms());
    assert_eq!(d.connection.sim_name.as_deref(), Some("KittyHawk"));
    assert_eq!(d.connection.simconnect_version.as_deref(), Some("11.0.62651.3"));
    assert_eq!(d.connection.sessions, 1);
    let fast_def = &d.defs[0];
    assert_eq!((fast_def.label.as_str(), fast_def.period.as_str(), fast_def.updates), ("FAST", "SIM_FRAME", 30));
    assert!((fast_def.rate_hz - 30.0).abs() < 1.5, "{}", fast_def.rate_hz);
    assert!(fast_def.age_ms.unwrap() < 5_000);
    let td = &fast_def.vars[14];
    assert_eq!((td.raw, td.value, td.value_unit.as_str()), (Some(-2.5), Some(-150.0), "fpm"));
    let slow_def = &d.defs[1];
    assert_eq!(slow_def.vars[7].raw, Some(13227.736));
    assert!((slow_def.vars[7].value.unwrap() - 6000.0).abs() < 0.01, "lb → kg");
    assert_eq!((slow_def.vars[15].raw, slow_def.vars[15].value), (Some(f64::from(0x7000)), Some(7000.0)), "BCD → squawk");
    assert!(!slow_def.vars[14].active, "rejected SimVar marked");
    let ex = d.events.iter().find(|e| e.kind == "exception").expect("exception logged");
    assert_eq!(ex.name, "NAME_UNRECOGNIZED");
    assert!(ex.detail.contains("LIGHT TAXI"), "{}", ex.detail);
    let pause = d.events.iter().find(|e| e.kind == "event").expect("event logged");
    assert_eq!((pause.name.as_str(), pause.data_hex.as_deref()), ("Pause", Some("0x00000001")));
}

// ---- golden events and hostile buffers ----

#[test]
fn system_events_and_filenames_map_to_sim_events() {
    let (mut s, tx, rx, t0) = session();
    for m in [
        msg_event(decoder::EVT_PAUSE, 1),
        msg_event(decoder::EVT_PAUSE, 0),
        msg_event(EVT_SIM, 0),
        msg_event(EVT_SIM, 1),
        msg_event(decoder::EVT_CRASHED, 0),
        msg_event(99, 1), // not subscribed: logged only
        msg_filename(decoder::EVT_AIRCRAFT_LOADED, "SimObjects/Airplanes/A320/aircraft.cfg"),
        msg_filename(decoder::EVT_FLIGHT_LOADED, "flights/EDDF.FLT"),
    ] {
        s.api.queue.push_back(Ok(m));
    }
    run_queue(&mut s, &tx, t0).unwrap();
    let sims: Vec<SimEvent> = drain(&rx)
        .into_iter()
        .filter_map(|e| if let ProviderEvent::Sim(e) = e { Some(e) } else { None })
        .collect();
    let got: Vec<String> = sims.iter().map(|e| format!("{e:?}")).collect();
    assert_eq!(
        got,
        [
            "Paused { paused: true }",
            "Paused { paused: false }",
            "SimRunning { running: false }",
            "SimRunning { running: true }",
            "Crashed",
            "AircraftLoaded { path: \"SimObjects/Airplanes/A320/aircraft.cfg\" }",
            "FlightLoaded { path: \"flights/EDDF.FLT\" }",
        ]
    );
}

#[test]
fn touchdown_velocity_and_fuel_units_are_converted() {
    let (mut s, tx, rx, t0) = session();
    let mut fast = fast_values();
    fast[14] = 3.5; // PLANE TOUCHDOWN NORMAL VELOCITY, ft/s
    let mut slow = slow_values();
    slow[7] = 10_000.0; // FUEL TOTAL QUANTITY WEIGHT, lbs
    s.api.queue.push_back(Ok(msg_f64(REQ_SLOW, DEF_SLOW, &slow)));
    s.api.queue.push_back(Ok(msg_f64(REQ_FAST, DEF_FAST, &fast)));
    run_queue(&mut s, &tx, t0).unwrap();
    let t = last_telemetry(&drain(&rx));
    assert_eq!(t.touchdown_vs_fpm, 210.0);
    assert!((t.fuel_total_kg - 4_535.924).abs() < 0.001, "{}", t.fuel_total_kg);
}

#[test]
fn every_message_cut_short_byte_by_byte_never_panics() {
    let fixed = [
        msg_open("MSFS"),
        msg_exception(1, 2, 3),
        msg_event(decoder::EVT_PAUSE, 1),
        msg_filename(decoder::EVT_FLIGHT_LOADED, "x.FLT"),
        msg_system_state(REQ_STATE_SIM, 1),
    ];
    for m in &fixed {
        for len in 0..m.len() {
            let (mut s, tx, rx, t0) = session();
            s.api.queue.push_back(Ok(m[..len].to_vec()));
            run_queue(&mut s, &tx, t0).unwrap();
            // a fixed-size message that is cut off is dropped as a whole
            let ev = drain(&rx);
            assert!(
                !ev.iter().any(|e| matches!(e, ProviderEvent::Sim(_) | ProviderEvent::Connected { .. })),
                "{len}/{} bytes of message {}: {ev:?}",
                m.len(),
                u32::from_le_bytes(m[8..12].try_into().unwrap())
            );
        }
    }
    // data messages: any cut is a (partial) payload, never a panic
    for m in [msg_f64(REQ_FAST, DEF_FAST, &fast_values()), msg_f64(REQ_SLOW, DEF_SLOW, &slow_values())] {
        for len in 0..m.len() {
            let (mut s, tx, _rx, t0) = session();
            s.api.queue.push_back(Ok(m[..len].to_vec()));
            run_queue(&mut s, &tx, t0).unwrap();
        }
    }
    // unknown message id with garbage behind it
    let (mut s, tx, rx, t0) = session();
    s.api.queue.push_back(Ok(header(0xDEAD, &[0xff; 64])));
    run_queue(&mut s, &tx, t0).unwrap();
    assert!(drain(&rx).is_empty());
}

#[test]
fn pump_blocks_on_the_wake_event_only_when_the_queue_is_empty() {
    let stop = Arc::new(AtomicBool::new(false));
    let mut api = FakeApi { stop: Some((stop.clone(), 3)), ..Default::default() };
    api.queue.push_back(Ok(msg_open("MSFS")));
    api.queue.push_back(Ok(msg_event(EVT_SIM, 1)));
    let mut s = Session::new(api, WatchdogConfig::default(), Instant::now());
    let (tx, _rx) = channel();
    assert_eq!(s.pump(&tx, &stop), SessionEnd::Stopped);
    // both queued messages were drained back to back; then exactly three capped idle waits
    // before the stop flag ended the loop (no 2-ms busy spin, stop honoured within one wait)
    assert_eq!(s.api.waits, vec![MAX_WAIT; 3]);
    const { assert!(MAX_WAIT.as_millis() <= 250) };
    assert!(s.api.queue.is_empty());
}

#[cfg(windows)]
#[test]
fn wake_event_times_out_unsignalled() {
    let ev = ffi::WakeEvent::new().expect("CreateEventW");
    assert!(!ev.handle().is_null());
    let t = Instant::now();
    assert!(!ev.wait(Duration::from_millis(30)), "nobody signalled it");
    assert!(t.elapsed() >= Duration::from_millis(20), "{:?}", t.elapsed());
}

#[test]
fn queued_text_is_sent_once_and_its_exception_is_no_error() {
    let (mut s, tx, rx, t0) = session();
    s.texts.push("VectaSim · Landed -142 fpm", 15.0, t0);
    s.step(t0, &tx).unwrap();
    let sent: Vec<_> = s.api.calls.iter().filter(|(_, c)| matches!(c, Call::Text { .. })).cloned().collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, Call::Text { text_type: ffi::text_type::PRINT_WHITE, seconds: 15.0, text: "VectaSim · Landed -142 fpm".into() });
    // nothing left: the next step sends nothing
    s.step(t0, &tx).unwrap();
    assert_eq!(s.api.calls.iter().filter(|(_, c)| matches!(c, Call::Text { .. })).count(), 1);
    // the sim rejects it (MSFS without text support): logged only, no error event
    let id = sent[0].0;
    s.api.queue.push_back(Ok(msg_exception(1, id, 0)));
    s.step(t0, &tx).unwrap();
    assert!(errors(&drain(&rx)).is_empty());
    // the queue tells the "test message" button what happened: sent, then the sim's exception
    assert_eq!(s.texts.last_report_since(t0).map(|r| r.outcome), Some(text::TextOutcome::Exception(1)));
}

#[test]
fn stale_text_is_not_sent() {
    let (mut s, tx, _rx, t0) = session();
    s.texts.push("late", 10.0, t0);
    s.step(t0 + text::MAX_AGE + Duration::from_secs(1), &tx).unwrap();
    assert!(!s.api.calls.iter().any(|(_, c)| matches!(c, Call::Text { .. })));
}
