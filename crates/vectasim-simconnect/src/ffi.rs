//! Minimal hand-written bindings for the handful of SimConnect entry points a
//! tracker needs. The DLL is loaded at runtime with `libloading`, so no MSFS SDK
//! import library is required at build time and no Microsoft binary is bundled
//! (the redistribution terms of SimConnect.dll are not clearly granted, see
//! DEVELOPMENT.md, "SimConnect"). On the user's request the app
//! fetches the DLL from Microsoft's SDK server into [`downloaded_dll_path`].
//!
//! Struct layouts follow SimConnect.h, which is `#pragma pack(push, 1)`.

#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub type HANDLE = *mut c_void;
pub type HRESULT = i32;
pub type DWORD = u32;

pub const S_OK: HRESULT = 0;
/// Returned by `SimConnect_GetNextDispatch` when the queue is empty. Every other
/// negative HRESULT from it means the connection is broken (e.g. 0xC000014B
/// STATUS_PIPE_BROKEN after a simulator crash).
pub const E_FAIL: HRESULT = 0x8000_4005_u32 as i32;
pub const SIMCONNECT_UNUSED: DWORD = 0xFFFF_FFFF;
pub const SIMCONNECT_OBJECT_ID_USER: DWORD = 0;

/// Win32 `ERROR_MOD_NOT_FOUND`.
pub const ERROR_MOD_NOT_FOUND: i32 = 126;
/// Win32 `ERROR_BAD_EXE_FORMAT`: the DLL has the wrong bitness (e.g. a 32-bit FSX/P3D SimConnect.dll).
pub const ERROR_BAD_EXE_FORMAT: i32 = 193;

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

/// `SIMCONNECT_TEXT_TYPE`: scrolling lines 0x00–0x07, printed (static) lines 0x100–0x107, menu 0x200.
pub mod text_type {
    pub const SCROLL_WHITE: u32 = 0x0001;
    pub const PRINT_WHITE: u32 = 0x0101;
    pub const PRINT_GREEN: u32 = 0x0103;
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
    pub const WEATHER_OBSERVATION: u32 = 10;
    pub const CLOUD_STATE: u32 = 11;
    pub const ASSIGNED_OBJECT_ID: u32 = 12;
    pub const RESERVED_KEY: u32 = 13;
    pub const CUSTOM_ACTION: u32 = 14;
    pub const SYSTEM_STATE: u32 = 15;
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

/// Answer to `SimConnect_RequestSystemState`.
#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct SIMCONNECT_RECV_SYSTEM_STATE {
    pub base: SIMCONNECT_RECV,
    pub dw_request_id: DWORD,
    pub dw_integer: DWORD,
    pub f_float: f32,
    pub sz_string: [u8; 260],
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
type FnClearDataDefinition = unsafe extern "system" fn(h: HANDLE, define_id: DWORD) -> HRESULT;
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
type FnRequestSystemState = unsafe extern "system" fn(h: HANDLE, request_id: DWORD, state: *const c_char) -> HRESULT;
type FnGetLastSentPacketId = unsafe extern "system" fn(h: HANDLE, pdw_send_id: *mut DWORD) -> HRESULT;
type FnText = unsafe extern "system" fn(
    h: HANDLE,
    text_type: u32,
    time_seconds: f32,
    event_id: DWORD,
    cb_unit_size: DWORD,
    p_data_set: *const c_void,
) -> HRESULT;
type FnGetNextDispatch =
    unsafe extern "system" fn(h: HANDLE, pp_data: *mut *mut SIMCONNECT_RECV, pcb_data: *mut DWORD) -> HRESULT;

/// Resolved entry points. Keeps the library alive for as long as the fn pointers are used.
pub struct SimConnectLib {
    _lib: libloading::Library,
    pub path: PathBuf,
    pub open: FnOpen,
    pub close: FnClose,
    pub add_to_data_definition: FnAddToDataDefinition,
    pub clear_data_definition: FnClearDataDefinition,
    pub request_data_on_sim_object: FnRequestDataOnSimObject,
    pub subscribe_to_system_event: FnSubscribeToSystemEvent,
    pub request_system_state: FnRequestSystemState,
    pub get_last_sent_packet_id: FnGetLastSentPacketId,
    pub get_next_dispatch: FnGetNextDispatch,
    /// `SimConnect_Text`; optional – a DLL without it still records (no in-sim messages then).
    pub text: Option<FnText>,
}

/// One failed candidate of the DLL search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadAttempt {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug)]
pub struct LoadError {
    /// Every candidate in search order (kept for callers that only want the list).
    pub tried: Vec<PathBuf>,
    /// Why each candidate failed.
    pub attempts: Vec<LoadAttempt>,
    pub last_error: String,
    /// Candidates that exist but have the wrong bitness (LoadLibrary error 193).
    pub wrong_architecture: Vec<PathBuf>,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.wrong_architecture.is_empty() {
            write!(
                f,
                "SimConnect.dll not found or unloadable – download it in Einstellungen → Simulator, \
                 install the MSFS SDK or set VECTASIM_SIMCONNECT_DLL"
            )?;
        } else {
            write!(
                f,
                "SimConnect.dll found but it is a 32-bit build (FSX/P3D legacy?) and cannot be loaded into 64-bit VectaSim: {} – \
                 use the x64 SimConnect.dll from the MSFS SDK",
                self.wrong_architecture.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
            )?;
        }
        write!(
            f,
            " (searched: {})",
            self.attempts.iter().map(|a| format!("{} [{}]", a.path.display(), a.reason)).collect::<Vec<_>>().join("; ")
        )
    }
}

impl std::error::Error for LoadError {}

/// Path of SimConnect.dll inside an MSFS SDK root (same layout for the 2020 and 2024 SDK).
fn sdk_dll(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join("SimConnect SDK").join("lib").join("SimConnect.dll")
}

/// Folder below `%LOCALAPPDATA%` that Tauri uses for the app (bundle identifier).
pub const APP_LOCAL_DIR: &str = "io.vectasim.app";

/// Where the in-app download ("SimConnect herunterladen") puts the DLL:
/// `%LOCALAPPDATA%\io.vectasim.app\simconnect\SimConnect.dll`.
pub fn downloaded_dll_path() -> Option<PathBuf> {
    downloaded_dll_path_from(&|k| std::env::var(k).ok())
}

/// `downloaded_dll_path` with injectable environment (for tests).
pub fn downloaded_dll_path_from(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    env("LOCALAPPDATA")
        .filter(|s| !s.trim().is_empty())
        .map(|d| PathBuf::from(d.trim()).join(APP_LOCAL_DIR).join("simconnect").join("SimConnect.dll"))
}

/// Where a SimConnect.dll candidate comes from, for the diagnostics ("Quelle").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DllSource {
    /// `%VECTASIM_SIMCONNECT_DLL%` or the file chosen in Einstellungen → Simulator.
    Override,
    /// Fetched by VectaSim from Microsoft's SDK server (in-app download).
    Downloaded,
    /// Next to the VectaSim executable (copied there by the user).
    ExeDir,
    /// An installed MSFS 2020/2024 SDK.
    Sdk,
    /// Resolved through the Windows DLL search path (System32, PATH, …).
    SearchPath,
}

impl DllSource {
    /// German label for Einstellungen → Diagnose.
    pub fn label(self) -> &'static str {
        match self {
            DllSource::Override => "manuell gewählt",
            DllSource::Downloaded => "von VectaSim heruntergeladen (MSFS SDK)",
            DllSource::ExeDir => "neben vectasim.exe",
            DllSource::Sdk => "MSFS SDK",
            DllSource::SearchPath => "Windows-Suchpfad",
        }
    }
}

/// Classify a found/loaded DLL path by the search rule that produced it.
pub fn dll_source(path: &Path) -> DllSource {
    dll_source_from(path, &|k| std::env::var(k).ok(), std::env::current_exe().ok())
}

/// `dll_source` with injectable environment (for tests).
pub fn dll_source_from(path: &Path, env: &dyn Fn(&str) -> Option<String>, exe: Option<PathBuf>) -> DllSource {
    let same = |a: &Path, b: &Path| a.as_os_str().eq_ignore_ascii_case(b.as_os_str());
    if env("VECTASIM_SIMCONNECT_DLL").is_some_and(|p| !p.trim().is_empty() && same(Path::new(p.trim()), path)) {
        return DllSource::Override;
    }
    if downloaded_dll_path_from(env).is_some_and(|p| same(&p, path)) {
        return DllSource::Downloaded;
    }
    if exe.as_deref().and_then(Path::parent).is_some_and(|d| same(&d.join("SimConnect.dll"), path)) {
        return DllSource::ExeDir;
    }
    let in_sdk = path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .is_some_and(|n| n.eq_ignore_ascii_case("SimConnect SDK"));
    if in_sdk { DllSource::Sdk } else { DllSource::SearchPath }
}

/// Where to look for SimConnect.dll, in order:
///
/// 1. `%VECTASIM_SIMCONNECT_DLL%` (explicit override, always first)
/// 2. the in-app download, `%LOCALAPPDATA%\io.vectasim.app\simconnect\SimConnect.dll`
/// 3. next to the VectaSim executable
/// 4. `%MSFS2024_SDK%` / `%MSFS_SDK%` (set by the SDK installers; a running process
///    only sees them after a restart / re-login)
/// 5. the SDK installers' default folders `%SystemDrive%\MSFS 2024 SDK` and
///    `%SystemDrive%\MSFS SDK`
/// 6. the bare name, i.e. the Windows DLL search order (EXE dir, System32, PATH, …)
///
/// The sim installations themselves (Steam/Store, incl. the
/// `%LOCALAPPDATA%\Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache` tree)
/// do not ship a loadable client SimConnect.dll in a documented place, so they are
/// deliberately not probed.
pub fn candidate_paths() -> Vec<PathBuf> {
    candidate_paths_from(&|k| std::env::var(k).ok(), std::env::current_exe().ok())
}

/// `candidate_paths` with injectable environment (for tests).
pub fn candidate_paths_from(env: &dyn Fn(&str) -> Option<String>, exe: Option<PathBuf>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !v.iter().any(|q| q.as_os_str().eq_ignore_ascii_case(p.as_os_str())) {
            v.push(p);
        }
    };
    if let Some(p) = env("VECTASIM_SIMCONNECT_DLL").filter(|s| !s.trim().is_empty()) {
        push(PathBuf::from(p.trim()));
    }
    if let Some(p) = downloaded_dll_path_from(env) {
        push(p);
    }
    if let Some(dir) = exe.as_deref().and_then(Path::parent) {
        push(dir.join("SimConnect.dll"));
    }
    for var in ["MSFS2024_SDK", "MSFS_SDK"] {
        if let Some(p) = env(var).filter(|s| !s.trim().is_empty()) {
            push(sdk_dll(p.trim()));
        }
    }
    let drive = env("SystemDrive").filter(|s| !s.is_empty()).unwrap_or_else(|| "C:".into());
    for folder in ["MSFS 2024 SDK", "MSFS SDK"] {
        push(sdk_dll(format!("{drive}\\{folder}")));
    }
    // plain name → Windows DLL search path (System32, PATH, …)
    push(PathBuf::from("SimConnect.dll"));
    v
}

/// Win32 error code behind a libloading error, if any.
fn os_error_code(e: &libloading::Error) -> Option<i32> {
    std::error::Error::source(e).and_then(|s| s.downcast_ref::<std::io::Error>()).and_then(std::io::Error::raw_os_error)
}

/// Human-readable reason for a failed LoadLibrary, with the bitness case spelled out.
pub fn describe_load_failure(os_code: Option<i32>, fallback: &str) -> String {
    match os_code {
        Some(ERROR_BAD_EXE_FORMAT) => "wrong architecture (32-bit DLL, error 193)".into(),
        Some(ERROR_MOD_NOT_FOUND) => "not found (error 126)".into(),
        Some(c) => format!("{fallback} (error {c})"),
        None => fallback.to_string(),
    }
}

static SHARED: OnceLock<SimConnectLib> = OnceLock::new();

impl SimConnectLib {
    /// The process-wide SimConnect library. Loaded on the first successful call and
    /// then kept for the lifetime of the process (no LoadLibrary/FreeLibrary churn on
    /// reconnects). A failed load is retried on the next call, so installing the SDK
    /// while VectaSim runs still works once the DLL is reachable.
    pub fn shared() -> Result<&'static SimConnectLib, LoadError> {
        if let Some(l) = SHARED.get() {
            return Ok(l);
        }
        let lib = Self::load()?;
        log::info!("SimConnect.dll loaded from {}", lib.path.display());
        // a concurrent loader may have won the race; either instance is equivalent
        let _ = SHARED.set(lib);
        Ok(SHARED.get().expect("set above"))
    }

    /// Path of the DLL held by [`SimConnectLib::shared`], if it has been loaded.
    pub fn loaded_path() -> Option<&'static Path> {
        SHARED.get().map(|l| l.path.as_path())
    }

    pub fn load() -> Result<Self, LoadError> {
        let mut tried = Vec::new();
        let mut attempts = Vec::new();
        let mut wrong_architecture = Vec::new();
        let mut last_error = String::from("no candidates");
        for path in candidate_paths() {
            tried.push(path.clone());
            if path.is_absolute() && !path.is_file() {
                attempts.push(LoadAttempt { path, reason: "not found".into() });
                continue;
            }
            // SAFETY: loading SimConnect.dll runs its DllMain; this is the intended use of the library.
            match unsafe { libloading::Library::new(&path) } {
                Ok(lib) => match Self::resolve(lib, path.clone()) {
                    Ok(s) => return Ok(s),
                    Err(e) => {
                        last_error = e.clone();
                        attempts.push(LoadAttempt { path, reason: format!("missing export {e}") });
                    }
                },
                Err(e) => {
                    let code = os_error_code(&e);
                    if code == Some(ERROR_BAD_EXE_FORMAT) {
                        wrong_architecture.push(path.clone());
                    }
                    let reason = describe_load_failure(code, &e.to_string());
                    last_error = reason.clone();
                    attempts.push(LoadAttempt { path, reason });
                }
            }
        }
        Err(LoadError { tried, attempts, last_error, wrong_architecture })
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
            let clear_data_definition: FnClearDataDefinition =
                sym!("SimConnect_ClearDataDefinition", FnClearDataDefinition);
            let request_data_on_sim_object: FnRequestDataOnSimObject =
                sym!("SimConnect_RequestDataOnSimObject", FnRequestDataOnSimObject);
            let subscribe_to_system_event: FnSubscribeToSystemEvent =
                sym!("SimConnect_SubscribeToSystemEvent", FnSubscribeToSystemEvent);
            let request_system_state: FnRequestSystemState = sym!("SimConnect_RequestSystemState", FnRequestSystemState);
            let get_last_sent_packet_id: FnGetLastSentPacketId =
                sym!("SimConnect_GetLastSentPacketID", FnGetLastSentPacketId);
            let get_next_dispatch: FnGetNextDispatch = sym!("SimConnect_GetNextDispatch", FnGetNextDispatch);
            let text: Option<FnText> = lib.get::<FnText>(b"SimConnect_Text\0").ok().map(|s| *s);
            Ok(Self {
                _lib: lib,
                path,
                open,
                close,
                add_to_data_definition,
                clear_data_definition,
                request_data_on_sim_object,
                subscribe_to_system_event,
                request_system_state,
                get_last_sent_packet_id,
                get_next_dispatch,
                text,
            })
        }
    }
}

/// `SIMCONNECT_EXCEPTION` names, complete as of the MSFS 2020/2024 SDK
/// (values 0–43; 13–17 are the legacy WEATHER_* codes).
pub fn exception_name(code: DWORD) -> &'static str {
    const NAMES: [&str; 44] = [
        "NONE",
        "ERROR",
        "SIZE_MISMATCH",
        "UNRECOGNIZED_ID",
        "UNOPENED",
        "VERSION_MISMATCH",
        "TOO_MANY_GROUPS",
        "NAME_UNRECOGNIZED",
        "TOO_MANY_EVENT_NAMES",
        "EVENT_ID_DUPLICATE",
        "TOO_MANY_MAPS",
        "TOO_MANY_OBJECTS",
        "TOO_MANY_REQUESTS",
        "WEATHER_INVALID_PORT",
        "WEATHER_INVALID_METAR",
        "WEATHER_UNABLE_TO_GET_OBSERVATION",
        "WEATHER_UNABLE_TO_CREATE_STATION",
        "WEATHER_UNABLE_TO_REMOVE_STATION",
        "INVALID_DATA_TYPE",
        "INVALID_DATA_SIZE",
        "DATA_ERROR",
        "INVALID_ARRAY",
        "CREATE_OBJECT_FAILED",
        "LOAD_FLIGHTPLAN_FAILED",
        "OPERATION_INVALID_FOR_OBJECT_TYPE",
        "ILLEGAL_OPERATION",
        "ALREADY_SUBSCRIBED",
        "INVALID_ENUM",
        "DEFINITION_ERROR",
        "DUPLICATE_ID",
        "DATUM_ID",
        "OUT_OF_BOUNDS",
        "ALREADY_CREATED",
        "OBJECT_OUTSIDE_REALITY_BUBBLE",
        "OBJECT_CONTAINER",
        "OBJECT_AI",
        "OBJECT_ATC",
        "OBJECT_SCHEDULE",
        "JETWAY_DATA",
        "ACTION_NOT_FOUND",
        "NOT_AN_ACTION",
        "INCORRECT_ACTION_PARAMS",
        "GET_INPUT_EVENT_FAILED",
        "SET_INPUT_EVENT_FAILED",
    ];
    NAMES.get(code as usize).copied().unwrap_or("UNKNOWN")
}

/// Convert a fixed-size NUL-terminated C buffer to a trimmed String.
pub fn cstr_buf(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exception_names_match_sdk_enum() {
        assert_eq!(exception_name(0), "NONE");
        assert_eq!(exception_name(7), "NAME_UNRECOGNIZED");
        assert_eq!(exception_name(12), "TOO_MANY_REQUESTS");
        assert_eq!(exception_name(13), "WEATHER_INVALID_PORT");
        assert_eq!(exception_name(17), "WEATHER_UNABLE_TO_REMOVE_STATION");
        assert_eq!(exception_name(18), "INVALID_DATA_TYPE");
        assert_eq!(exception_name(19), "INVALID_DATA_SIZE");
        assert_eq!(exception_name(20), "DATA_ERROR");
        assert_eq!(exception_name(26), "ALREADY_SUBSCRIBED");
        assert_eq!(exception_name(28), "DEFINITION_ERROR");
        assert_eq!(exception_name(32), "ALREADY_CREATED");
        assert_eq!(exception_name(33), "OBJECT_OUTSIDE_REALITY_BUBBLE");
        assert_eq!(exception_name(37), "OBJECT_SCHEDULE");
        assert_eq!(exception_name(43), "SET_INPUT_EVENT_FAILED");
        assert_eq!(exception_name(44), "UNKNOWN");
        assert_eq!(exception_name(u32::MAX), "UNKNOWN");
    }

    #[test]
    fn struct_sizes_match_simconnect_h() {
        assert_eq!(std::mem::size_of::<SIMCONNECT_RECV>(), 12);
        assert_eq!(std::mem::size_of::<SIMCONNECT_RECV_EXCEPTION>(), 24);
        assert_eq!(std::mem::size_of::<SIMCONNECT_RECV_EVENT>(), 24);
        assert_eq!(std::mem::size_of::<SIMCONNECT_RECV_EVENT_FILENAME>(), 24 + 260 + 4);
        assert_eq!(std::mem::size_of::<SIMCONNECT_RECV_OPEN>(), 12 + 256 + 10 * 4);
        assert_eq!(std::mem::size_of::<SIMCONNECT_RECV_SYSTEM_STATE>(), 12 + 12 + 260);
    }

    #[test]
    fn candidate_order_env_exe_sdk_defaults_searchpath() {
        let env = |k: &str| match k {
            "VECTASIM_SIMCONNECT_DLL" => Some(r"D:\x\SimConnect.dll".to_string()),
            "LOCALAPPDATA" => Some(r"C:\Users\p\AppData\Local".to_string()),
            "MSFS2024_SDK" => Some(r"E:\SDK24".to_string()),
            "MSFS_SDK" => Some(r"C:\MSFS SDK".to_string()), // duplicate of a default folder
            "SystemDrive" => Some("C:".to_string()),
            _ => None,
        };
        let p = candidate_paths_from(&env, Some(PathBuf::from(r"C:\Apps\VectaSim\vectasim.exe")));
        let s: Vec<String> = p.iter().map(|p| p.display().to_string()).collect();
        assert_eq!(
            s,
            vec![
                r"D:\x\SimConnect.dll",
                r"C:\Users\p\AppData\Local\io.vectasim.app\simconnect\SimConnect.dll",
                r"C:\Apps\VectaSim\SimConnect.dll",
                r"E:\SDK24\SimConnect SDK\lib\SimConnect.dll",
                r"C:\MSFS SDK\SimConnect SDK\lib\SimConnect.dll",
                r"C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll",
                "SimConnect.dll",
            ]
        );
    }

    #[test]
    fn candidates_without_env_still_include_defaults() {
        let p = candidate_paths_from(&|_| None, None);
        let s: Vec<String> = p.iter().map(|p| p.display().to_string()).collect();
        assert_eq!(
            s,
            vec![
                r"C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll",
                r"C:\MSFS SDK\SimConnect SDK\lib\SimConnect.dll",
                "SimConnect.dll"
            ]
        );
    }

    #[test]
    fn dll_source_follows_the_search_rules() {
        let env = |k: &str| match k {
            "VECTASIM_SIMCONNECT_DLL" => Some(r"D:\x\SimConnect.dll".to_string()),
            "LOCALAPPDATA" => Some(r"C:\Users\p\AppData\Local".to_string()),
            _ => None,
        };
        let exe = Some(PathBuf::from(r"C:\Apps\VectaSim\vectasim.exe"));
        let src = |p: &str| dll_source_from(Path::new(p), &env, exe.clone());
        assert_eq!(src(r"d:\X\simconnect.dll"), DllSource::Override);
        assert_eq!(src(r"C:\Users\p\AppData\Local\io.vectasim.app\simconnect\SimConnect.dll"), DllSource::Downloaded);
        assert_eq!(src(r"C:\Apps\VectaSim\SimConnect.dll"), DllSource::ExeDir);
        assert_eq!(src(r"E:\SDK24\SimConnect SDK\lib\SimConnect.dll"), DllSource::Sdk);
        assert_eq!(src(r"C:\Windows\System32\SimConnect.dll"), DllSource::SearchPath);
        assert_eq!(src("SimConnect.dll"), DllSource::SearchPath);
        assert!(DllSource::Downloaded.label().contains("heruntergeladen"));
    }

    #[test]
    fn downloaded_path_needs_localappdata() {
        assert_eq!(downloaded_dll_path_from(&|_| None), None);
        assert_eq!(downloaded_dll_path_from(&|_| Some("  ".into())), None);
    }

    #[test]
    fn load_failure_reasons() {
        assert!(describe_load_failure(Some(193), "x").contains("32-bit"));
        assert!(describe_load_failure(Some(126), "x").contains("not found"));
        assert_eq!(describe_load_failure(Some(5), "LoadLibraryExW failed"), "LoadLibraryExW failed (error 5)");
        let e = LoadError {
            tried: vec![],
            attempts: vec![LoadAttempt { path: PathBuf::from(r"C:\P3D\SimConnect.dll"), reason: describe_load_failure(Some(193), "") }],
            last_error: String::new(),
            wrong_architecture: vec![PathBuf::from(r"C:\P3D\SimConnect.dll")],
        };
        let msg = e.to_string();
        assert!(msg.contains("32-bit"), "{msg}");
        assert!(msg.contains(r"C:\P3D\SimConnect.dll"), "{msg}");
    }
}

// ---- Win32 event used to wake the pump (instead of polling GetNextDispatch) ----

/// `WaitForSingleObject` results.
pub const WAIT_OBJECT_0: DWORD = 0;
pub const WAIT_TIMEOUT: DWORD = 0x0000_0102;

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateEventW(attributes: *mut c_void, manual_reset: i32, initial_state: i32, name: *const u16) -> HANDLE;
    fn WaitForSingleObject(handle: HANDLE, milliseconds: DWORD) -> DWORD;
    fn CloseHandle(handle: HANDLE) -> i32;
}

/// An unnamed auto-reset Win32 event that SimConnect signals whenever a message is queued
/// (`hEventHandle` of `SimConnect_Open`). Closed on drop.
#[derive(Debug)]
pub struct WakeEvent(HANDLE);

// SAFETY: a Win32 event handle may be used and closed from any thread.
unsafe impl Send for WakeEvent {}

impl WakeEvent {
    /// None if the event cannot be created (or off Windows): the caller falls back to polling.
    pub fn new() -> Option<Self> {
        #[cfg(windows)]
        {
            // SAFETY: no security attributes, auto-reset, initially unsignalled, unnamed.
            let h = unsafe { CreateEventW(std::ptr::null_mut(), 0, 0, std::ptr::null()) };
            (!h.is_null()).then_some(Self(h))
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    pub fn handle(&self) -> HANDLE {
        self.0
    }

    /// Block until SimConnect signals or `timeout` passes. True = signalled.
    pub fn wait(&self, timeout: std::time::Duration) -> bool {
        #[cfg(windows)]
        {
            let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: the handle is a live event owned by self.
            unsafe { WaitForSingleObject(self.0, ms) == WAIT_OBJECT_0 }
        }
        #[cfg(not(windows))]
        {
            std::thread::sleep(timeout);
            false
        }
    }
}

impl Drop for WakeEvent {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: created by CreateEventW, closed exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
