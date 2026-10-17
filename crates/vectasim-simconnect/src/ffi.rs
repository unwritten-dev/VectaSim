//! Minimal hand-written bindings for the handful of SimConnect entry points a
//! tracker needs. The DLL is loaded at runtime with `libloading`, so no MSFS SDK
//! import library is required at build time and no Microsoft binary is bundled
//! (the redistribution terms of SimConnect.dll are not clearly granted).
//!
//! Struct layouts follow SimConnect.h, which is `#pragma pack(push, 1)`.

#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_void};
use std::path::PathBuf;

pub type HANDLE = *mut c_void;
pub type HRESULT = i32;
pub type DWORD = u32;

pub const S_OK: HRESULT = 0;
pub const E_FAIL: HRESULT = 0x8000_4005_u32 as i32;
pub const SIMCONNECT_UNUSED: DWORD = 0xFFFF_FFFF;
pub const SIMCONNECT_OBJECT_ID_USER: DWORD = 0;

pub mod datatype {
    pub const INT32: u32 = 1;
    pub const INT64: u32 = 2;
    pub const FLOAT32: u32 = 3;
    pub const FLOAT64: u32 = 4;
    pub const STRING8: u32 = 5;
    pub const STRING32: u32 = 6;
    pub const STRING64: u32 = 7;
    pub const STRING128: u32 = 8;
    pub const STRING256: u32 = 9;
    pub const STRING260: u32 = 10;
}

pub mod period {
    pub const NEVER: u32 = 0;
    pub const ONCE: u32 = 1;
    pub const VISUAL_FRAME: u32 = 2;
    pub const SIM_FRAME: u32 = 3;
    pub const SECOND: u32 = 4;
}

pub mod request_flag {
    pub const DEFAULT: u32 = 0;
    pub const CHANGED: u32 = 1;
    pub const TAGGED: u32 = 2;
}

pub mod recv_id {
    pub const NULL: u32 = 0;
    pub const EXCEPTION: u32 = 1;
    pub const OPEN: u32 = 2;
    pub const QUIT: u32 = 3;
    pub const EVENT: u32 = 4;
    pub const EVENT_OBJECT_ADDREMOVE: u32 = 5;
    pub const EVENT_FILENAME: u32 = 6;
    pub const EVENT_FRAME: u32 = 7;
    pub const SIMOBJECT_DATA: u32 = 8;
    pub const SIMOBJECT_DATA_BYTYPE: u32 = 9;
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV {
    pub dw_size: DWORD,
    pub dw_version: DWORD,
    pub dw_id: DWORD,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV_EXCEPTION {
    pub base: SIMCONNECT_RECV,
    pub dw_exception: DWORD,
    pub dw_send_id: DWORD,
    pub dw_index: DWORD,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV_OPEN {
    pub base: SIMCONNECT_RECV,
    pub sz_application_name: [u8; 256],
    pub dw_application_version_major: DWORD,
    pub dw_application_version_minor: DWORD,
    pub dw_application_build_major: DWORD,
    pub dw_application_build_minor: DWORD,
    pub dw_simconnect_version_major: DWORD,
    pub dw_simconnect_version_minor: DWORD,
    pub dw_simconnect_build_major: DWORD,
    pub dw_simconnect_build_minor: DWORD,
    pub dw_reserved1: DWORD,
    pub dw_reserved2: DWORD,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV_EVENT {
    pub base: SIMCONNECT_RECV,
    pub u_group_id: DWORD,
    pub u_event_id: DWORD,
    pub dw_data: DWORD,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV_EVENT_FILENAME {
    pub event: SIMCONNECT_RECV_EVENT,
    pub sz_file_name: [u8; 260],
    pub dw_flags: DWORD,
}

#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV_SIMOBJECT_DATA {
    pub base: SIMCONNECT_RECV,
    pub dw_request_id: DWORD,
    pub dw_object_id: DWORD,
    pub dw_define_id: DWORD,
    pub dw_flags: DWORD,
    pub dwentrynumber: DWORD,
    pub dwoutof: DWORD,
    pub dw_define_count: DWORD,
    /// First DWORD of the payload; the payload continues past the struct.
    pub dw_data: DWORD,
}

/// Byte offset of the payload inside a SIMOBJECT_DATA message.
pub const SIMOBJECT_DATA_PAYLOAD_OFFSET: usize = std::mem::offset_of!(SIMCONNECT_RECV_SIMOBJECT_DATA, dw_data);

type FnOpen = unsafe extern "system" fn(
    ph_sim_connect: *mut HANDLE,
    sz_name: *const c_char,
    h_wnd: *mut c_void,
    user_event_win32: DWORD,
    h_event_handle: HANDLE,
    config_index: DWORD,
) -> HRESULT;
type FnClose = unsafe extern "system" fn(h: HANDLE) -> HRESULT;
type FnAddToDataDefinition = unsafe extern "system" fn(
    h: HANDLE,
    define_id: DWORD,
    datum_name: *const c_char,
    units_name: *const c_char,
    datum_type: u32,
    f_epsilon: f32,
    datum_id: DWORD,
) -> HRESULT;
type FnRequestDataOnSimObject = unsafe extern "system" fn(
    h: HANDLE,
    request_id: DWORD,
    define_id: DWORD,
    object_id: DWORD,
    period: u32,
    flags: u32,
    origin: DWORD,
    interval: DWORD,
    limit: DWORD,
) -> HRESULT;
type FnSubscribeToSystemEvent =
    unsafe extern "system" fn(h: HANDLE, event_id: DWORD, system_event_name: *const c_char) -> HRESULT;
type FnGetNextDispatch =
    unsafe extern "system" fn(h: HANDLE, pp_data: *mut *mut SIMCONNECT_RECV, pcb_data: *mut DWORD) -> HRESULT;

/// Resolved entry points. Keeps the library alive for as long as the fn pointers are used.
pub struct SimConnectLib {
    _lib: libloading::Library,
    pub path: PathBuf,
    pub open: FnOpen,
    pub close: FnClose,
    pub add_to_data_definition: FnAddToDataDefinition,
    pub request_data_on_sim_object: FnRequestDataOnSimObject,
    pub subscribe_to_system_event: FnSubscribeToSystemEvent,
    pub get_next_dispatch: FnGetNextDispatch,
}

#[derive(Debug)]
pub struct LoadError {
    pub tried: Vec<PathBuf>,
    pub last_error: String,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SimConnect.dll not found or unloadable (tried: {}); last error: {}",
            self.tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "),
            self.last_error
        )
    }
}

impl std::error::Error for LoadError {}

/// Where to look for SimConnect.dll, in order. The MSFS SDK installs it under
/// `<SDK>\SimConnect SDK\lib\`; users without the SDK can point
/// `VECTASIM_SIMCONNECT_DLL` at a copy from the official MSFS SDK installer.
pub fn candidate_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(p) = std::env::var("VECTASIM_SIMCONNECT_DLL") {
        v.push(PathBuf::from(p));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.to_path_buf())) {
        v.push(dir.join("SimConnect.dll"));
    }
    for var in ["MSFS2024_SDK", "MSFS_SDK"] {
        if let Ok(p) = std::env::var(var) {
            v.push(PathBuf::from(p).join("SimConnect SDK").join("lib").join("SimConnect.dll"));
        }
    }
    // plain name → Windows DLL search path (System32, PATH, …)
    v.push(PathBuf::from("SimConnect.dll"));
    v
}

impl SimConnectLib {
    pub fn load() -> Result<Self, LoadError> {
        let mut tried = Vec::new();
        let mut last_error = String::from("no candidates");
        for path in candidate_paths() {
            tried.push(path.clone());
            // SAFETY: loading SimConnect.dll runs its DllMain; this is the intended use of the library.
            match unsafe { libloading::Library::new(&path) } {
                Ok(lib) => match Self::resolve(lib, path) {
                    Ok(s) => return Ok(s),
                    Err(e) => last_error = e,
                },
                Err(e) => last_error = e.to_string(),
            }
        }
        Err(LoadError { tried, last_error })
    }

    fn resolve(lib: libloading::Library, path: PathBuf) -> Result<Self, String> {
        // SAFETY: symbol names and signatures match SimConnect.h for the x64 DLL.
        unsafe {
            macro_rules! sym {
                ($name:literal, $ty:ty) => {
                    *lib.get::<$ty>(concat!($name, "\0").as_bytes())
                        .map_err(|e| format!("{}: {e}", $name))?
                };
            }
            let open: FnOpen = sym!("SimConnect_Open", FnOpen);
            let close: FnClose = sym!("SimConnect_Close", FnClose);
            let add_to_data_definition: FnAddToDataDefinition =
                sym!("SimConnect_AddToDataDefinition", FnAddToDataDefinition);
            let request_data_on_sim_object: FnRequestDataOnSimObject =
                sym!("SimConnect_RequestDataOnSimObject", FnRequestDataOnSimObject);
            let subscribe_to_system_event: FnSubscribeToSystemEvent =
                sym!("SimConnect_SubscribeToSystemEvent", FnSubscribeToSystemEvent);
            let get_next_dispatch: FnGetNextDispatch = sym!("SimConnect_GetNextDispatch", FnGetNextDispatch);
            Ok(Self {
                _lib: lib,
                path,
                open,
                close,
                add_to_data_definition,
                request_data_on_sim_object,
                subscribe_to_system_event,
                get_next_dispatch,
            })
        }
    }
}

/// Human-readable SIMCONNECT_EXCEPTION names (subset that matters for data requests).
pub fn exception_name(code: DWORD) -> &'static str {
    match code {
        0 => "NONE",
        1 => "ERROR",
        2 => "SIZE_MISMATCH",
        3 => "UNRECOGNIZED_ID",
        4 => "UNOPENED",
        5 => "VERSION_MISMATCH",
        6 => "TOO_MANY_GROUPS",
        7 => "NAME_UNRECOGNIZED",
        8 => "TOO_MANY_EVENT_NAMES",
        9 => "EVENT_ID_DUPLICATE",
        10 => "TOO_MANY_MAPS",
        11 => "TOO_MANY_OBJECTS",
        12 => "TOO_MANY_REQUESTS",
        20 => "INVALID_DATA_TYPE",
        21 => "INVALID_DATA_SIZE",
        22 => "DATA_ERROR",
        23 => "INVALID_ARRAY",
        24 => "CREATE_OBJECT_FAILED",
        25 => "LOAD_FLIGHTPLAN_FAILED",
        26 => "OPERATION_INVALID_FOR_OBJECT_TYPE",
        27 => "ILLEGAL_OPERATION",
        28 => "ALREADY_SUBSCRIBED",
        29 => "INVALID_ENUM",
        30 => "DEFINITION_ERROR",
        31 => "DUPLICATE_ID",
        32 => "DATUM_ID",
        33 => "OUT_OF_BOUNDS",
        34 => "ALREADY_CREATED",
        _ => "UNKNOWN",
    }
}

/// Convert a fixed-size NUL-terminated C buffer to a trimmed String.
pub fn cstr_buf(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).trim().to_string()
}
