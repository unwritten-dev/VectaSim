//! SimConnect provider: connects to MSFS 2020/2024 (P3D/FSX share the API),
//! registers three data definitions (fast / slow / static), subscribes to the
//! system events a tracker cares about, and pushes `ProviderEvent`s.
//!
//! Runs on a dedicated thread because SimConnect clients are not thread-safe.
//! Reconnects with exponential back-off when the sim is not running or quits.

pub mod ffi;

use ffi::{SimConnectLib, datatype, period, recv_id, request_flag};
use std::ffi::CString;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;
use std::time::Duration;
use vectasim_core::telemetry::LBS_TO_KG;
use vectasim_core::{AircraftInfo, Lights, ProviderEvent, SimEvent, SimProvider, Telemetry, now_ms, sleep_interruptible};

const DEF_FAST: u32 = 1;
const DEF_SLOW: u32 = 2;
const DEF_STATIC: u32 = 3;
const REQ_FAST: u32 = 1;
const REQ_SLOW: u32 = 2;
const REQ_STATIC: u32 = 3;

const EVT_PAUSE: u32 = 1;
const EVT_SIM: u32 = 2;
const EVT_CRASHED: u32 = 3;
const EVT_AIRCRAFT_LOADED: u32 = 4;
const EVT_FLIGHT_LOADED: u32 = 5;

/// (SimVar name, unit) – all requested as FLOAT64 so the payload is a plain f64 array.
const FAST_VARS: &[(&str, &str)] = &[
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
];

const SLOW_VARS: &[(&str, &str)] = &[
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
    ("SIMULATION RATE", "number"),
    ("IS SLEW ACTIVE", "bool"),
    ("LIGHT BEACON", "bool"),
    ("LIGHT NAV", "bool"),
    ("LIGHT STROBE", "bool"),
    ("LIGHT LANDING", "bool"),
    ("LIGHT TAXI", "bool"),
    ("TRANSPONDER CODE:1", "bco16"),
    ("ZULU TIME", "seconds"),
];

/// Requested as STRING256 each (ATC MODEL/TYPE may come back as `TT:` localisation tokens).
const STATIC_VARS: &[&str] = &["TITLE", "ATC MODEL", "ATC TYPE", "ATC ID", "ATC AIRLINE", "ATC FLIGHT NUMBER"];

pub struct SimConnectProvider {
    pub client_name: String,
    /// Index into SimConnect.cfg ([SimConnect.N]) for remote-PC setups; 0 = default/local.
    pub config_index: u32,
    /// Set by the consumer while a flight is being recorded. Without one the reconnect
    /// backoff stays short (≤ 10 s) so VectaSim picks up a freshly started sim quickly.
    pub flight_active: Arc<AtomicBool>,
}

impl Default for SimConnectProvider {
    fn default() -> Self {
        Self { client_name: "VectaSim".into(), config_index: 0, flight_active: Arc::new(AtomicBool::new(false)) }
    }
}

const INITIAL_BACKOFF: Duration = Duration::from_secs(2);
/// Longest wait between connection attempts while no flight is open.
const MAX_BACKOFF_IDLE: Duration = Duration::from_secs(10);
/// Longest wait while a flight is open (the sim was closed mid-flight; no hurry).
const MAX_BACKOFF_FLIGHT: Duration = Duration::from_secs(30);

fn max_backoff(flight_active: bool) -> Duration {
    if flight_active { MAX_BACKOFF_FLIGHT } else { MAX_BACKOFF_IDLE }
}

/// Doubling backoff, capped by whether a flight is open.
fn next_backoff(current: Duration, flight_active: bool) -> Duration {
    (current * 2).min(max_backoff(flight_active))
}

impl SimProvider for SimConnectProvider {
    fn name(&self) -> &'static str {
        "simconnect"
    }

    fn start(self: Box<Self>, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
        std::thread::Builder::new()
            .name("simconnect-provider".into())
            .spawn(move || run(*self, tx, stop))
            .expect("spawn simconnect provider")
    }
}

#[derive(Debug)]
enum SessionEnd {
    Quit,
    Stopped,
    ChannelClosed,
}

fn run(cfg: SimConnectProvider, tx: Sender<ProviderEvent>, stop: Arc<AtomicBool>) {
    let mut backoff = INITIAL_BACKOFF;

    while !stop.load(Ordering::Relaxed) {
        let _ = tx.send(ProviderEvent::Connecting);

        let lib = match SimConnectLib::load() {
            Ok(l) => l,
            Err(e) => {
                let _ = tx.send(ProviderEvent::Error { message: e.to_string() });
                if !sleep_interruptible(max_backoff(cfg.flight_active.load(Ordering::Relaxed)), &stop) {
                    break;
                }
                continue;
            }
        };

        match Session::open(&lib, &cfg) {
            Err(hr) => {
                // a flight may have ended since the last attempt: never wait longer than the cap
                backoff = backoff.min(max_backoff(cfg.flight_active.load(Ordering::Relaxed)));
                let _ = tx.send(ProviderEvent::Disconnected {
                    reason: format!("sim not reachable (SimConnect_Open hr=0x{hr:08X}); retry in {}s", backoff.as_secs()),
                });
                if !sleep_interruptible(backoff, &stop) {
                    break;
                }
                backoff = next_backoff(backoff, cfg.flight_active.load(Ordering::Relaxed));
            }
            Ok(mut session) => {
                backoff = INITIAL_BACKOFF;
                let end = session.pump(&tx, &stop);
                let reason = match end {
                    SessionEnd::Quit => "simulator quit".to_string(),
                    SessionEnd::Stopped => "stopped".to_string(),
                    SessionEnd::ChannelClosed => "consumer gone".to_string(),
                };
                let _ = tx.send(ProviderEvent::Disconnected { reason });
                if matches!(end, SessionEnd::Stopped | SessionEnd::ChannelClosed) {
                    break;
                }
            }
        }
    }
}

struct Session<'a> {
    lib: &'a SimConnectLib,
    handle: ffi::HANDLE,
    current: Telemetry,
    aircraft: AircraftInfo,
    connected_announced: bool,
}

impl<'a> Session<'a> {
    fn open(lib: &'a SimConnectLib, cfg: &SimConnectProvider) -> Result<Self, ffi::HRESULT> {
        let name = CString::new(cfg.client_name.as_str()).unwrap_or_else(|_| CString::new("VectaSim").unwrap());
        let mut handle: ffi::HANDLE = std::ptr::null_mut();
        // SAFETY: valid out-pointer and NUL-terminated name; no window/event handle used (polling).
        let hr = unsafe {
            (lib.open)(&mut handle, name.as_ptr(), std::ptr::null_mut(), 0, std::ptr::null_mut(), cfg.config_index)
        };
        if hr < 0 || handle.is_null() {
            return Err(hr);
        }
        let mut s = Session { lib, handle, current: Telemetry::default(), aircraft: AircraftInfo::default(), connected_announced: false };
        s.register();
        Ok(s)
    }

    fn add_def(&self, def: u32, var: &str, unit: Option<&str>, ty: u32) {
        let var_c = CString::new(var).expect("simvar name");
        let unit_c = unit.map(|u| CString::new(u).expect("unit name"));
        // SAFETY: strings outlive the call; handle is open.
        let hr = unsafe {
            (self.lib.add_to_data_definition)(
                self.handle,
                def,
                var_c.as_ptr(),
                unit_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                ty,
                0.0,
                ffi::SIMCONNECT_UNUSED,
            )
        };
        if hr < 0 {
            log::warn!("AddToDataDefinition({def}, {var}) failed hr=0x{hr:08X}");
        }
    }

    fn register(&mut self) {
        for (v, u) in FAST_VARS {
            self.add_def(DEF_FAST, v, Some(u), datatype::FLOAT64);
        }
        for (v, u) in SLOW_VARS {
            self.add_def(DEF_SLOW, v, Some(u), datatype::FLOAT64);
        }
        for v in STATIC_VARS {
            self.add_def(DEF_STATIC, v, None, datatype::STRING256);
        }
        // SAFETY: handle is open; ids are our own constants.
        unsafe {
            (self.lib.request_data_on_sim_object)(
                self.handle, REQ_FAST, DEF_FAST, ffi::SIMCONNECT_OBJECT_ID_USER, period::SIM_FRAME, request_flag::DEFAULT, 0, 0, 0,
            );
            (self.lib.request_data_on_sim_object)(
                self.handle, REQ_SLOW, DEF_SLOW, ffi::SIMCONNECT_OBJECT_ID_USER, period::SECOND, request_flag::DEFAULT, 0, 0, 0,
            );
        }
        self.request_static();
        for (id, name) in [
            (EVT_PAUSE, "Pause"),
            (EVT_SIM, "Sim"),
            (EVT_CRASHED, "Crashed"),
            (EVT_AIRCRAFT_LOADED, "AircraftLoaded"),
            (EVT_FLIGHT_LOADED, "FlightLoaded"),
        ] {
            let c = CString::new(name).unwrap();
            // SAFETY: as above.
            let hr = unsafe { (self.lib.subscribe_to_system_event)(self.handle, id, c.as_ptr()) };
            if hr < 0 {
                log::warn!("SubscribeToSystemEvent({name}) failed hr=0x{hr:08X}");
            }
        }
    }

    fn request_static(&self) {
        // SAFETY: handle is open.
        unsafe {
            (self.lib.request_data_on_sim_object)(
                self.handle, REQ_STATIC, DEF_STATIC, ffi::SIMCONNECT_OBJECT_ID_USER, period::ONCE, request_flag::DEFAULT, 0, 0, 0,
            );
        }
    }

    /// Poll GetNextDispatch until the sim quits, we are stopped, or the consumer is gone.
    fn pump(&mut self, tx: &Sender<ProviderEvent>, stop: &AtomicBool) -> SessionEnd {
        loop {
            if stop.load(Ordering::Relaxed) {
                return SessionEnd::Stopped;
            }
            let mut p: *mut ffi::SIMCONNECT_RECV = std::ptr::null_mut();
            let mut cb: u32 = 0;
            // SAFETY: valid out-pointers; the returned buffer is owned by SimConnect and valid until the next call.
            let hr = unsafe { (self.lib.get_next_dispatch)(self.handle, &mut p, &mut cb) };
            if hr < 0 || p.is_null() || cb < std::mem::size_of::<ffi::SIMCONNECT_RECV>() as u32 {
                // E_FAIL simply means "no message right now"
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            // SAFETY: SimConnect guarantees `p` points to at least `cb` bytes starting with SIMCONNECT_RECV.
            let header = unsafe { std::ptr::read_unaligned(p) };
            let bytes = unsafe { std::slice::from_raw_parts(p as *const u8, cb as usize) };
            let outcome = self.handle_message(header.dw_id, bytes, tx);
            match outcome {
                Ok(true) => return SessionEnd::Quit,
                Ok(false) => {}
                Err(()) => return SessionEnd::ChannelClosed,
            }
        }
    }

    /// Returns Ok(true) when the sim announced QUIT, Err(()) when the channel is closed.
    fn handle_message(&mut self, id: u32, bytes: &[u8], tx: &Sender<ProviderEvent>) -> Result<bool, ()> {
        let send = |e: ProviderEvent| tx.send(e).map_err(|_| ());
        match id {
            recv_id::OPEN => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_OPEN>() {
                    // SAFETY: length checked; packed struct read unaligned.
                    let open = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_OPEN) };
                    let (maj, min, bmaj, bmin) = (
                        open.dw_application_version_major,
                        open.dw_application_version_minor,
                        open.dw_application_build_major,
                        open.dw_application_build_minor,
                    );
                    self.connected_announced = true;
                    send(ProviderEvent::Connected {
                        sim_name: ffi::cstr_buf(&open.sz_application_name),
                        sim_version: format!("{maj}.{min}.{bmaj}.{bmin}"),
                    })?;
                }
                Ok(false)
            }
            recv_id::QUIT => Ok(true),
            recv_id::EXCEPTION => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_EXCEPTION>() {
                    // SAFETY: length checked.
                    let ex = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_EXCEPTION) };
                    let (code, send_id, index) = (ex.dw_exception, ex.dw_send_id, ex.dw_index);
                    let msg = format!("SimConnect exception {} ({code}) sendId={send_id} index={index}", ffi::exception_name(code));
                    log::warn!("{msg}");
                    send(ProviderEvent::Error { message: msg })?;
                }
                Ok(false)
            }
            recv_id::EVENT => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_EVENT>() {
                    // SAFETY: length checked.
                    let ev = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_EVENT) };
                    let (eid, data) = (ev.u_event_id, ev.dw_data);
                    match eid {
                        EVT_PAUSE => {
                            self.current.paused = data != 0;
                            send(ProviderEvent::Sim(SimEvent::Paused { paused: data != 0 }))?;
                        }
                        EVT_SIM => send(ProviderEvent::Sim(SimEvent::SimRunning { running: data != 0 }))?,
                        EVT_CRASHED => send(ProviderEvent::Sim(SimEvent::Crashed))?,
                        _ => {}
                    }
                }
                Ok(false)
            }
            recv_id::EVENT_FILENAME => {
                if bytes.len() >= std::mem::size_of::<ffi::SIMCONNECT_RECV_EVENT_FILENAME>() {
                    // SAFETY: length checked.
                    let ev = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_EVENT_FILENAME) };
                    let path = ffi::cstr_buf(&ev.sz_file_name);
                    match ev.event.u_event_id {
                        EVT_AIRCRAFT_LOADED => {
                            self.request_static();
                            send(ProviderEvent::Sim(SimEvent::AircraftLoaded { path }))?;
                        }
                        EVT_FLIGHT_LOADED => send(ProviderEvent::Sim(SimEvent::FlightLoaded { path }))?,
                        _ => {}
                    }
                }
                Ok(false)
            }
            recv_id::SIMOBJECT_DATA => {
                if bytes.len() < ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET {
                    return Ok(false);
                }
                // SAFETY: length checked for the header part.
                let hdr = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const ffi::SIMCONNECT_RECV_SIMOBJECT_DATA) };
                let payload = &bytes[ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET..];
                match hdr.dw_request_id {
                    REQ_FAST => {
                        if let Some(v) = read_f64s(payload, FAST_VARS.len()) {
                            self.apply_fast(&v);
                            send(ProviderEvent::Telemetry(self.current.clone()))?;
                        }
                    }
                    REQ_SLOW => {
                        if let Some(v) = read_f64s(payload, SLOW_VARS.len()) {
                            self.apply_slow(&v);
                        }
                    }
                    REQ_STATIC if payload.len() >= 256 * STATIC_VARS.len() => {
                        let s = |i: usize| ffi::cstr_buf(&payload[i * 256..(i + 1) * 256]);
                        let info = AircraftInfo {
                            title: s(0),
                            atc_model: s(1),
                            atc_type: s(2),
                            atc_id: s(3),
                            atc_airline: s(4),
                            atc_flight_number: s(5),
                        };
                        if info != self.aircraft {
                            self.aircraft = info.clone();
                            send(ProviderEvent::Aircraft(info))?;
                        }
                    }
                    _ => {}
                }
                Ok(false)
            }
            _ => Ok(false),
        }
    }

    fn apply_fast(&mut self, v: &[f64]) {
        let t = &mut self.current;
        t.timestamp_ms = now_ms();
        t.latitude = v[0];
        t.longitude = v[1];
        t.altitude_msl_ft = v[2];
        t.altitude_agl_ft = v[3];
        t.ias_kt = v[4];
        t.tas_kt = v[5];
        t.ground_speed_kt = v[6];
        t.vertical_speed_fpm = v[7];
        t.heading_mag_deg = v[8];
        t.heading_true_deg = v[9];
        t.pitch_deg = v[10];
        t.bank_deg = v[11];
        t.g_force = v[12];
        t.on_ground = v[13] != 0.0;
        t.touchdown_vs_fpm = v[14] * 60.0;
    }

    fn apply_slow(&mut self, v: &[f64]) {
        let t = &mut self.current;
        t.gear_pct = v[0];
        t.flaps_index = v[1] as i32;
        t.num_engines = v[2].clamp(0.0, 4.0) as u8;
        t.engines_running = v[3..7].iter().take(t.num_engines as usize).filter(|x| **x != 0.0).count() as u8;
        t.fuel_total_kg = v[7] * LBS_TO_KG;
        t.total_weight_kg = v[8] * LBS_TO_KG;
        t.parking_brake = v[9] != 0.0;
        t.sim_rate = v[10];
        t.slew = v[11] != 0.0;
        t.lights = Lights { beacon: v[12] != 0.0, nav: v[13] != 0.0, strobe: v[14] != 0.0, landing: v[15] != 0.0, taxi: v[16] != 0.0 };
        t.transponder_code = v[17] as u32;
        t.sim_zulu_time_s = v[18];
    }
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: handle came from SimConnect_Open and is closed exactly once.
            unsafe {
                (self.lib.close)(self.handle);
            }
            self.handle = std::ptr::null_mut();
        }
    }
}

fn read_f64s(payload: &[u8], n: usize) -> Option<Vec<f64>> {
    if payload.len() < n * 8 {
        log::warn!("SimConnect payload too short: {} < {}", payload.len(), n * 8);
        return None;
    }
    Some(payload.as_chunks::<8>().0.iter().take(n).map(|c| f64::from_le_bytes(*c)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_offset_matches_simconnect_h() {
        // SIMCONNECT_RECV (3 DWORD) + 7 DWORD header fields = 40 bytes before dwData
        assert_eq!(ffi::SIMOBJECT_DATA_PAYLOAD_OFFSET, 40);
    }

    #[test]
    fn fast_slow_definitions_have_expected_sizes() {
        assert_eq!(FAST_VARS.len(), 15);
        assert_eq!(SLOW_VARS.len(), 19);
        assert_eq!(STATIC_VARS.len(), 6);
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
        // during a flight it may grow to 30 s
        let mut b = INITIAL_BACKOFF;
        for _ in 0..6 {
            b = next_backoff(b, true);
        }
        assert_eq!(b, Duration::from_secs(30));
        // a flight that ends shrinks the next wait back to the idle cap
        assert_eq!(Duration::from_secs(30).min(max_backoff(false)), Duration::from_secs(10));
    }

    #[test]
    fn reads_little_endian_f64s() {
        let mut buf = Vec::new();
        for x in [1.5f64, -2.0, 3.25] {
            buf.extend_from_slice(&x.to_le_bytes());
        }
        assert_eq!(read_f64s(&buf, 3).unwrap(), vec![1.5, -2.0, 3.25]);
        assert!(read_f64s(&buf, 4).is_none());
    }
}
