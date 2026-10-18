//! Thin seam between the session logic and the SimConnect C API, so the session can be
//! exercised in tests with a fake backend (no simulator, no DLL).

use crate::decode::{DispatchKind, classify_dispatch};
use crate::ffi::{self, HRESULT, SimConnectLib};
use std::ffi::CString;
use std::time::Duration;

/// Sleep between `GetNextDispatch` polls when no wake event is available.
pub const POLL_INTERVAL: Duration = Duration::from_millis(2);

/// The SimConnect calls a session makes. All methods return the raw HRESULT.
pub trait SimApi {
    fn add_to_data_definition(&mut self, def: u32, name: &str, unit: Option<&str>, datatype: u32) -> HRESULT;
    fn clear_data_definition(&mut self, def: u32) -> HRESULT;
    fn request_data_on_sim_object(&mut self, req: u32, def: u32, period: u32) -> HRESULT;
    fn subscribe_to_system_event(&mut self, event_id: u32, name: &str) -> HRESULT;
    fn request_system_state(&mut self, req: u32, state: &str) -> HRESULT;
    /// SendID of the packet sent by the last call (`SimConnect_GetLastSentPacketID`).
    fn last_sent_packet_id(&mut self) -> Option<u32>;
    /// Fetch the next message and copy it into `buf` (only touched for `Message`).
    fn next_dispatch(&mut self, buf: &mut Vec<u8>) -> DispatchKind;
    /// The queue was empty: block until the next message may be there, at most `timeout`.
    /// Default (no wake event): a short poll sleep.
    fn wait_for_dispatch(&mut self, timeout: Duration) {
        std::thread::sleep(POLL_INTERVAL.min(timeout));
    }
}

/// The real backend: an open SimConnect handle on the process-wide DLL.
pub struct LiveApi {
    lib: &'static SimConnectLib,
    handle: ffi::HANDLE,
    /// Signalled by SimConnect when a message is queued; None = polling fallback.
    /// Dropped after `handle` is closed (see `Drop`).
    event: Option<ffi::WakeEvent>,
}

fn cstring(s: &str) -> CString {
    // SimVar/event names are compile-time constants without interior NULs
    CString::new(s).unwrap_or_default()
}

impl LiveApi {
    pub fn open(lib: &'static SimConnectLib, client_name: &str, config_index: u32) -> Result<Self, HRESULT> {
        let name = CString::new(client_name).unwrap_or_else(|_| cstring("VectaSim"));
        let mut handle: ffi::HANDLE = std::ptr::null_mut();
        let event = ffi::WakeEvent::new();
        if event.is_none() {
            log::warn!("CreateEventW failed; polling SimConnect every {} ms instead", POLL_INTERVAL.as_millis());
        }
        let event_handle = event.as_ref().map_or(std::ptr::null_mut(), ffi::WakeEvent::handle);
        // SAFETY: valid out-pointer and NUL-terminated name; no window; the event (if any) outlives
        // the SimConnect handle (closed first in Drop).
        let hr = unsafe { (lib.open)(&mut handle, name.as_ptr(), std::ptr::null_mut(), 0, event_handle, config_index) };
        if hr < 0 || handle.is_null() {
            return Err(hr);
        }
        Ok(Self { lib, handle, event })
    }
}

impl SimApi for LiveApi {
    fn add_to_data_definition(&mut self, def: u32, name: &str, unit: Option<&str>, datatype: u32) -> HRESULT {
        let name_c = cstring(name);
        let unit_c = unit.map(cstring);
        // SAFETY: strings outlive the call; handle is open.
        unsafe {
            (self.lib.add_to_data_definition)(
                self.handle,
                def,
                name_c.as_ptr(),
                unit_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                datatype,
                0.0,
                ffi::SIMCONNECT_UNUSED,
            )
        }
    }

    fn clear_data_definition(&mut self, def: u32) -> HRESULT {
        // SAFETY: handle is open.
        unsafe { (self.lib.clear_data_definition)(self.handle, def) }
    }

    fn request_data_on_sim_object(&mut self, req: u32, def: u32, period: u32) -> HRESULT {
        // SAFETY: handle is open; ids are our own constants.
        unsafe {
            (self.lib.request_data_on_sim_object)(
                self.handle,
                req,
                def,
                ffi::SIMCONNECT_OBJECT_ID_USER,
                period,
                ffi::request_flag::DEFAULT,
                0,
                0,
                0,
            )
        }
    }

    fn subscribe_to_system_event(&mut self, event_id: u32, name: &str) -> HRESULT {
        let c = cstring(name);
        // SAFETY: string outlives the call; handle is open.
        unsafe { (self.lib.subscribe_to_system_event)(self.handle, event_id, c.as_ptr()) }
    }

    fn request_system_state(&mut self, req: u32, state: &str) -> HRESULT {
        let c = cstring(state);
        // SAFETY: string outlives the call; handle is open.
        unsafe { (self.lib.request_system_state)(self.handle, req, c.as_ptr()) }
    }

    fn last_sent_packet_id(&mut self) -> Option<u32> {
        let mut id: u32 = 0;
        // SAFETY: valid out-pointer; handle is open.
        let hr = unsafe { (self.lib.get_last_sent_packet_id)(self.handle, &mut id) };
        (hr >= 0).then_some(id)
    }

    fn next_dispatch(&mut self, buf: &mut Vec<u8>) -> DispatchKind {
        let mut p: *mut ffi::SIMCONNECT_RECV = std::ptr::null_mut();
        let mut cb: u32 = 0;
        // SAFETY: valid out-pointers; the returned buffer is owned by SimConnect and valid until the next call.
        let hr = unsafe { (self.lib.get_next_dispatch)(self.handle, &mut p, &mut cb) };
        let kind = classify_dispatch(hr, p.is_null(), cb);
        if kind == DispatchKind::Message {
            // SAFETY: SimConnect guarantees `p` points to at least `cb` bytes; copied before the next call.
            let bytes = unsafe { std::slice::from_raw_parts(p as *const u8, cb as usize) };
            buf.clear();
            buf.extend_from_slice(bytes);
        }
        kind
    }

    fn wait_for_dispatch(&mut self, timeout: Duration) {
        match &self.event {
            // auto-reset: a message queued while we were draining leaves it signalled, so no wake-up is lost
            Some(ev) => {
                ev.wait(timeout);
            }
            None => std::thread::sleep(POLL_INTERVAL.min(timeout)),
        }
    }
}

impl Drop for LiveApi {
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
