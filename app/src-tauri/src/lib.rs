#[macro_use]
mod lang;
mod airframes;
mod approach;
mod countries;
mod data;
mod diagpack;
mod discord;
mod landing;
mod logging;
mod manager;
mod metrics;
mod notes;
mod notify;
mod online;
mod pirep;
mod privacy;
mod server;
mod simconnect_dl;
mod simselect;
mod simtext;
mod tray;

use manager::{DiagSnapshot, ProviderManager, StatusSnapshot};
use online::OnlineState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use std::sync::Mutex;
use vectasim_data::{Airport, AirportIndex, NearestAirport, Runway};
use vectasim_simbrief::{Ofp, SimbriefError, User};
/// Notices the store collected while opening (a staged restore that could not be applied):
/// fetched once by the UI after start, shown as a toast, then gone.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreNoticeOut {
    code: &'static str,
    message: String,
}

/// Settings → Simulator → "Send test message": a line into MSFS via SimConnect, with the
/// session's verdict (sent / rejected / exception / no session). Waits at most 3 s.
#[tauri::command]
async fn sim_text_test(manager: State<'_, ProviderManager>) -> Result<simtext::TextTestResult, String> {
    let snap = manager.snapshot();
    if snap.provider != "simconnect" || snap.state != "connected" {
        return Ok(simtext::TextTestResult::NoSession);
    }
    let lang = lang::current();
    blocking(move || Ok(simtext::run_test(lang, std::time::Duration::from_secs(3)))).await
}

#[tauri::command]
fn store_notices(store: State<'_, Store>) -> Vec<StoreNoticeOut> {
    let lang = lang::current();
    store.take_notices().into_iter().map(|n| StoreNoticeOut { code: n.code(), message: n.message(lang) }).collect()
}

use vectasim_store::{AirportResolver, ExportFormat, FlightCounts, FlightDetail, FlightRow, MergeCandidate, MergeReport, PlannedFlight, Store, Totals, TrackSample, export};

const SETTING_SIMBRIEF_USER: &str = "simbrief_user";
/// SimConnect.dll chosen in Settings → Simulator; empty = automatic search.
const SETTING_SIMCONNECT_DLL: &str = "simconnect_dll_path";
/// Read by the SimConnect loader first (`vectasim_simconnect::ffi::candidate_paths`).
const ENV_SIMCONNECT_DLL: &str = "VECTASIM_SIMCONNECT_DLL";
/// Settings → Diagnostics → “Record raw dump”: one `.vsdump` per SimConnect session.
const SETTING_RAW_DUMP: &str = "raw_dump";
/// Settings → Diagnostics → “Debug mode”: `debug` for vectasim_*, raw dump and `diag:raw` on,
/// on top of the settings above (which stay untouched, so switching it off restores them).
const SETTING_DEBUG_MODE: &str = "debug_mode";
/// The variable as the user's environment had it at start, restored on "Zurücksetzen".
static ORIGINAL_DLL_ENV: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();

/// Put the DLL setting into `VECTASIM_SIMCONNECT_DLL` before a provider starts.
fn apply_dll_setting(store: &Store) {
    let original = ORIGINAL_DLL_ENV.get_or_init(|| std::env::var_os(ENV_SIMCONNECT_DLL));
    let chosen = store.get_setting(SETTING_SIMCONNECT_DLL).ok().flatten().filter(|p| !p.trim().is_empty());
    // a network path stored by an older version is not loaded
    let chosen = chosen.filter(|p| {
        let unc = data::is_unc(p);
        if unc {
            log::warn!("SimConnect.dll setting ignored: network paths are not loaded ({})", p.trim());
        }
        !unc
    });
    // SAFETY: Windows' environment block is synchronised by the OS; the only other reader is the
    // provider loader, which reads it once per (re)connect attempt.
    unsafe {
        match (&chosen, original) {
            (Some(p), _) => std::env::set_var(ENV_SIMCONNECT_DLL, p.trim()),
            (None, Some(v)) => std::env::set_var(ENV_SIMCONNECT_DLL, v),
            (None, None) => std::env::remove_var(ENV_SIMCONNECT_DLL),
        }
    }
    if let Some(dll) = find_simconnect_dll() {
        let system_root = std::env::var_os("SystemRoot").map(std::path::PathBuf::from);
        // compared as Windows resolves it (8.3 names, trailing dots, junctions)
        let real = data::resolved(&dll);
        if dll_in_shared_folder(&real, system_root.as_deref().map(data::resolved).as_deref()) {
            log::warn!(
                "SimConnect.dll will be loaded from {} ({}): a folder that other Windows accounts may write to \
                 (drive root or PATH). Prefer the in-app download (Settings → Simulator).",
                dll.display(),
                vectasim_simconnect::ffi::dll_source(&dll).label()
            );
        }
    }
}

/// A DLL outside the folders only administrators or the user can write (Windows, Program
/// Files, the user profiles): e.g. `C:\MSFS SDK\…` – any account may create folders at a drive
/// root – or a folder on PATH. VectaSim still loads it, but says so prominently in the log.
fn dll_in_shared_folder(dll: &std::path::Path, system_root: Option<&std::path::Path>) -> bool {
    use std::path::Component;
    if !dll.is_absolute() {
        return true;
    }
    let lower = |p: &std::path::Path| p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    if let Some(root) = system_root.filter(|r| !r.as_os_str().is_empty()) {
        let (d, r) = (lower(dll), lower(root));
        if d.starts_with(&format!("{}\\", r.trim_end_matches('\\'))) {
            return false;
        }
    }
    let first = dll.components().find_map(|c| match c {
        Component::Normal(n) => Some(n.to_string_lossy().to_ascii_lowercase()),
        _ => None,
    });
    !matches!(first.as_deref(), Some("program files" | "program files (x86)" | "windows" | "users"))
}

/// What `set_simconnect_dll` accepts from the webview: an absolute local path without `..` to an
/// existing file named `SimConnect.dll`. The webview cannot write such a file itself, so even a
/// script injected there could not make VectaSim load a DLL of its choosing. Network paths
/// (`\\host\share\SimConnect.dll`, also `\\?\UNC\…`) are refused – as written and as
/// Windows resolves the path.
fn check_dll_choice(raw: &str) -> Result<std::path::PathBuf, String> {
    let file = std::path::Path::new(raw);
    if data::is_unc(raw) {
        return Err(trf!("Netzwerkpfade werden nicht geladen: {raw}", "Network paths are not loaded: {raw}"));
    }
    if !file.is_absolute() || file.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(trf!("Ungültiger Pfad: {raw}", "Invalid path: {raw}"));
    }
    if !file.extension().is_some_and(|e| e.eq_ignore_ascii_case("dll")) {
        return Err(trf!("Keine DLL-Datei: {raw}", "Not a DLL file: {raw}"));
    }
    if !file.file_name().is_some_and(|n| n.eq_ignore_ascii_case("SimConnect.dll")) {
        return Err(trf!("Die Datei muss SimConnect.dll heißen: {raw}", "The file must be named SimConnect.dll: {raw}"));
    }
    if !file.is_file() {
        return Err(trf!("Datei nicht gefunden: {raw}", "File not found: {raw}"));
    }
    // a junction or symbolic link to a share
    if std::fs::canonicalize(file).is_ok_and(|real| data::is_unc(&real.to_string_lossy())) {
        return Err(trf!("Netzwerkpfade werden nicht geladen: {raw}", "Network paths are not loaded: {raw}"));
    }
    Ok(file.to_path_buf())
}

/// The OFP currently loaded for dispatch (not yet necessarily attached to a flight).
#[derive(Default)]
struct DispatchState {
    ofp: Mutex<Option<Ofp>>,
}

fn plan_from_ofp(ofp: &Ofp) -> PlannedFlight {
    PlannedFlight {
        callsign: ofp.callsign.clone(),
        dep_icao: ofp.origin_icao.clone(),
        arr_icao: ofp.destination_icao.clone(),
        block_s: ofp.times.block_s,
        fuel_ramp_kg: ofp.fuel.plan_ramp_kg,
        fuel_landing_kg: ofp.fuel.plan_landing_kg,
        ofp_json: serde_json::to_string(ofp).unwrap_or_default(),
        registration: ofp.registration.clone(),
        aircraft_icao: ofp.aircraft_icao.clone(),
        aircraft_name: ofp.aircraft_name.clone(),
        airline_icao: ofp.airline_icao.clone(),
    }
}

/// Adapter so the store crate can name airports without depending on the data crate.
struct IndexResolver(Arc<AirportIndex>);

impl AirportResolver for IndexResolver {
    fn nearest_ident(&self, latitude: f64, longitude: f64, max_nm: f64) -> Option<String> {
        self.0.nearest(latitude, longitude, max_nm).map(|n| n.airport.ident)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AirportDetail {
    airport: Airport,
    runways: Vec<Runway>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    db_path: String,
    /// First SimConnect.dll on the search path that exists on disk (not loaded).
    simconnect_dll: Option<String>,
    /// Where that DLL comes from ("von VectaSim heruntergeladen (MSFS SDK)", "MSFS SDK", …).
    simconnect_dll_source: Option<&'static str>,
}

/// Same order as the SimConnect provider's loader; the bare name is resolved like the
/// Windows DLL search (System32, then PATH). Only checks that the file exists.
fn find_simconnect_dll() -> Option<std::path::PathBuf> {
    find_simconnect_dll_where(&|p| p.is_file())
}

/// [`find_simconnect_dll`] with a custom test for each absolute candidate (the headless
/// `--install-simconnect --check` also verifies the hash of the downloaded copy).
pub(crate) fn find_simconnect_dll_where(accept: &dyn Fn(&std::path::Path) -> bool) -> Option<std::path::PathBuf> {
    for p in vectasim_simconnect::ffi::candidate_paths() {
        if p.is_absolute() {
            if accept(&p) {
                return Some(p);
            }
            continue;
        }
        let mut dirs: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(root) = std::env::var("SystemRoot") {
            dirs.push(std::path::PathBuf::from(root).join("System32"));
        }
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Some(found) = dirs.into_iter().map(|d| d.join(&p)).find(|f| accept(f)) {
            return Some(found);
        }
    }
    None
}

/// Version, data paths and integration checks for Settings → Diagnostics.
#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let data_dir = app.path().app_data_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let db_path = data::db_path(&app).map(|d| d.display().to_string()).unwrap_or_default();
    let dll = find_simconnect_dll();
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir,
        db_path,
        simconnect_dll_source: dll.as_deref().map(|p| vectasim_simconnect::ffi::dll_source(p).label()),
        simconnect_dll: dll.map(|p| p.display().to_string()),
    }
}

#[tauri::command]
fn get_status(manager: State<ProviderManager>) -> StatusSnapshot {
    manager.snapshot()
}

#[tauri::command]
fn list_providers() -> Vec<&'static str> {
    manager::PROVIDERS.to_vec()
}

#[tauri::command]
fn select_provider(
    kind: String,
    app: AppHandle,
    manager: State<ProviderManager>,
    store: State<Store>,
    airports: State<Arc<AirportIndex>>,
) -> Result<(), String> {
    // demo and replay flights are throwaway; purged only when switching to a real source, so a
    // freshly started demo/replay cannot lose the flight it is already recording
    let is_demo = |p: &str| p == "mock" || p == "replay";
    let leaving_demo = is_demo(&manager.snapshot().provider) && !is_demo(&kind);
    apply_dll_setting(&store);
    // "simconnect" from the UI ("Demo beenden", "Mit Simulator verbinden") means the simulator
    // chosen in Settings → Simulator (automatic, MSFS or X-Plane)
    let kind = if kind == "simconnect" { "sim".to_string() } else { kind };
    manager.start(app.clone(), store.inner().clone(), Arc::new(IndexResolver(airports.inner().clone())), &kind)?;
    if leaving_demo {
        purge_demo(&app, &store);
    }
    Ok(())
}

/// Choose (`Some`) or reset (`None`) the SimConnect.dll. Restarts the SimConnect provider when it
/// is not connected and no flight is open, so the new file is tried right away; returns whether it did.
#[tauri::command]
fn set_simconnect_dll(
    path: Option<String>,
    app: AppHandle,
    manager: State<ProviderManager>,
    store: State<Store>,
    airports: State<Arc<AirportIndex>>,
) -> Result<bool, String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        check_dll_choice(p)?;
    }
    store.set_setting(SETTING_SIMCONNECT_DLL, path.as_deref().unwrap_or("")).map_err(lang::ui_error)?;
    apply_dll_setting(&store);
    log::info!("SimConnect.dll setting: {}", path.as_deref().unwrap_or("<automatic search>"));

    let snap = manager.snapshot();
    let flight_open = manager.current_flight_id().is_some();
    if snap.provider != "simconnect" || snap.state == "connected" || flight_open {
        return Ok(false);
    }
    manager.start(app, store.inner().clone(), Arc::new(IndexResolver(airports.inner().clone())), "sim")?;
    Ok(true)
}

/// Folder with `vectasim.log` (and its rotated predecessors).
#[tauri::command]
fn log_dir(app: AppHandle) -> Result<String, String> {
    app.path().app_log_dir().map(|d| d.display().to_string()).map_err(lang::ui_error)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogLevelInfo {
    /// Level from the setting (`info` by default).
    level: String,
    /// `RUST_LOG`, when set; it decides instead of the setting.
    env_override: Option<String>,
    /// Debug-Modus on: vectasim_* log at least `debug`, whatever `level` says.
    debug_mode: bool,
}

#[tauri::command]
fn get_log_level(store: State<Store>) -> LogLevelInfo {
    log_level_info(&store)
}

fn log_level_info(store: &Store) -> LogLevelInfo {
    let level = store
        .get_setting(logging::SETTING_LOG_LEVEL)
        .ok()
        .flatten()
        .and_then(|s| logging::parse_level(&s))
        .unwrap_or(log::LevelFilter::Info);
    LogLevelInfo { level: level.as_str().to_ascii_lowercase(), env_override: logging::env_override(), debug_mode: debug_mode_on(store) }
}

fn debug_mode_on(store: &Store) -> bool {
    store.get_setting(SETTING_DEBUG_MODE).ok().flatten().as_deref() == Some("1")
}

#[tauri::command]
fn set_log_level(level: String, store: State<Store>) -> Result<(), String> {
    let parsed = logging::parse_level(&level).ok_or_else(|| format!("unbekannte Protokollstufe: {level}"))?;
    store.set_setting(logging::SETTING_LOG_LEVEL, &parsed.as_str().to_ascii_lowercase()).map_err(lang::ui_error)?;
    logging::set_level(parsed);
    log::info!("log level set to {parsed}");
    Ok(())
}

/// `%LOCALAPPDATA%\io.vectasim.app\dumps` (next to `logs`).
fn dumps_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("dumps")).map_err(lang::ui_error)
}

fn apply_dump_setting(app: &AppHandle, store: &Store, manager: &ProviderManager) {
    let on = store.get_setting(SETTING_RAW_DUMP).ok().flatten().as_deref() == Some("1") || debug_mode_on(store);
    let target = match (on, dumps_dir(app)) {
        (true, Ok(dir)) => vectasim_dump::FileTarget::Dir(dir),
        _ => vectasim_dump::FileTarget::Off,
    };
    manager.dump().set_target(target);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DumpInfo {
    /// Switch in Diagnose (setting `raw_dump`).
    enabled: bool,
    /// Debug-Modus on: the dump runs whatever `enabled` says.
    debug_mode: bool,
    dir: String,
    status: vectasim_dump::DumpStatus,
}

fn dump_info_of(app: &AppHandle, store: &Store, manager: &ProviderManager) -> DumpInfo {
    DumpInfo {
        enabled: store.get_setting(SETTING_RAW_DUMP).ok().flatten().as_deref() == Some("1"),
        debug_mode: debug_mode_on(store),
        dir: dumps_dir(app).map(|d| d.display().to_string()).unwrap_or_default(),
        status: manager.dump().status(),
    }
}

#[tauri::command]
fn dump_info(app: AppHandle, store: State<Store>, manager: State<ProviderManager>) -> DumpInfo {
    // so "Dump-Ordner öffnen" works before the first dump
    if let Ok(dir) = dumps_dir(&app) {
        let _ = std::fs::create_dir_all(dir);
    }
    dump_info_of(&app, &store, &manager)
}

/// Switch the per-session raw dump on/off (takes effect immediately; the file starts with
/// the next SimConnect message).
#[tauri::command]
fn set_raw_dump(on: bool, app: AppHandle, store: State<Store>, manager: State<ProviderManager>) -> Result<DumpInfo, String> {
    store.set_setting(SETTING_RAW_DUMP, if on { "1" } else { "0" }).map_err(lang::ui_error)?;
    apply_dump_setting(&app, &store, &manager);
    log::info!("raw dump {}", if on { "on" } else { "off" });
    Ok(dump_info_of(&app, &store, &manager))
}

/// Log floor, dump target and `diag:raw` stream as the `debug_mode` setting says.
fn apply_debug_mode(app: &AppHandle, store: &Store, manager: &ProviderManager) {
    let on = debug_mode_on(store);
    logging::set_debug_mode(on);
    manager.set_diag_debug(on);
    apply_dump_setting(app, store, manager);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugModeInfo {
    on: bool,
    log: LogLevelInfo,
    dump: DumpInfo,
}

#[tauri::command]
fn get_debug_mode(app: AppHandle, store: State<Store>, manager: State<ProviderManager>) -> DebugModeInfo {
    DebugModeInfo { on: debug_mode_on(&store), log: log_level_info(&store), dump: dump_info_of(&app, &store, &manager) }
}

/// Debug-Modus on/off. The log level and raw-dump settings are not changed, so switching it
/// off brings back exactly what was set before.
#[tauri::command]
fn set_debug_mode(on: bool, app: AppHandle, store: State<Store>, manager: State<ProviderManager>) -> Result<DebugModeInfo, String> {
    store.set_setting(SETTING_DEBUG_MODE, if on { "1" } else { "0" }).map_err(lang::ui_error)?;
    apply_debug_mode(&app, &store, &manager);
    log::info!("debug mode {}", if on { "on (vectasim_* at debug, raw dump, diag stream)" } else { "off" });
    Ok(get_debug_mode(app, store, manager))
}

/// „Dump jetzt speichern“: the RAM ring (last ≤ 30 min) as `dumps\ring-<time>.vsdump`.
#[tauri::command]
fn dump_now(app: AppHandle, manager: State<ProviderManager>) -> Result<String, String> {
    let path = dumps_dir(&app)?.join(format!("ring-{}.{}", vectasim_dump::file_stamp(vectasim_core::now_ms()), vectasim_dump::EXTENSION));
    match manager.dump().dump_ring(&path) {
        Ok(lines) => {
            log::info!("raw dump ring saved: {} ({lines} lines)", path.display());
            Ok(path.display().to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(lang::tr(
                "Noch keine Rohdaten aufgezeichnet – der Puffer füllt sich, sobald VectaSim mit dem Simulator verbunden ist.",
                "No raw data recorded yet – the buffer fills as soon as VectaSim is connected to the simulator.",
            )
            .into())
        }
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Settings → Diagnostics → Live raw data (one-shot; `diag:raw` streams the same).
#[tauri::command]
fn diagnostics_snapshot(manager: State<ProviderManager>) -> DiagSnapshot {
    manager.diagnostics()
}

/// The Live-Rohdaten view opened/closed: `diag:raw` at 2 Hz only while it is open.
#[tauri::command]
fn set_diag_stream(on: bool, manager: State<ProviderManager>) {
    manager.set_diag_stream(on);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaySettings {
    path: Option<String>,
    speed: f64,
    repeat: bool,
}

#[tauri::command]
fn get_replay(manager: State<ProviderManager>) -> ReplaySettings {
    let c = manager.replay_config();
    ReplaySettings { path: c.path.map(|p| p.display().to_string()), speed: c.speed, repeat: c.loop_ }
}

/// What `select_provider("replay")` plays next (Settings → Diagnostics → Replay; env `VECTASIM_REPLAY*` is the default).
#[tauri::command]
fn set_replay(path: Option<String>, speed: f64, repeat: bool, manager: State<ProviderManager>) -> Result<(), String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).map(std::path::PathBuf::from);
    if let Some(p) = &path
        && !p.is_file()
    {
        let p = p.display();
        return Err(trf!("Datei nicht gefunden: {p}", "File not found: {p}"));
    }
    if !speed.is_finite() || speed < 0.0 {
        return Err(trf!("ungültige Geschwindigkeit: {speed}", "invalid speed: {speed}"));
    }
    manager.set_replay_config(vectasim_simconnect::ReplayConfig { path, speed, loop_: repeat });
    Ok(())
}

/// Demo and replay flights never outlive the session: gone when it ends and at the next start.
fn purge_demo(app: &AppHandle, store: &Store) {
    match store.delete_demo_flights() {
        Ok(0) => {}
        Ok(n) => {
            log::info!("removed {n} demo flight(s)");
            let _ = app.emit("logbook:changed", ());
            let _ = app.emit("airframes:changed", "");
        }
        Err(e) => log::error!("could not remove demo flights: {e}"),
    }
}

#[tauri::command]
fn get_live_track(manager: State<ProviderManager>) -> Vec<TrackSample> {
    manager.live_track()
}

#[tauri::command]
fn get_settings(store: State<Store>) -> Result<Vec<(String, String)>, String> {
    store.all_settings().map_err(lang::ui_error)
}

#[tauri::command]
fn set_setting(key: String, value: String, app: AppHandle, store: State<Store>) -> Result<(), String> {
    store.set_setting(&key, &value).map_err(lang::ui_error)?;
    if key == lang::SETTING_LANGUAGE {
        // tray menu, notifications, Discord and the overlay default follow at once
        let before = lang::current();
        if lang::apply_setting(Some(&value)) != before {
            tray::relabel(&app);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_current_ofp(dispatch: State<DispatchState>) -> Option<Ofp> {
    dispatch.ofp.lock().unwrap().clone()
}

/// Load the latest OFP for the configured SimBrief user, keep it for the next
/// flight and attach it to a flight that is already running.
#[tauri::command]
async fn simbrief_fetch(
    user: Option<String>,
    app: AppHandle,
    store: State<'_, Store>,
    dispatch: State<'_, DispatchState>,
    manager: State<'_, ProviderManager>,
) -> Result<Ofp, String> {
    let user_input = match user {
        Some(u) if !u.trim().is_empty() => {
            store.set_setting(SETTING_SIMBRIEF_USER, u.trim()).map_err(lang::ui_error)?;
            u
        }
        _ => store.get_setting(SETTING_SIMBRIEF_USER).map_err(lang::ui_error)?.unwrap_or_default(),
    };
    let user = User::parse(&user_input).ok_or_else(|| SimbriefError::NoUser.to_string())?;
    let ofp = vectasim_simbrief::fetch_latest(&user).await.map_err(lang::ui_error)?;
    // no callsign at INFO (Streamer-Modus, Diagnosepaket); the DEBUG line is masked there
    log::info!("SimBrief OFP loaded: {} ({} fixes)", ofp.route_label(), ofp.navlog.len());
    log::debug!("SimBrief OFP callsign {}, registration {}", ofp.callsign, ofp.registration);

    let plan = plan_from_ofp(&ofp);
    *manager.planned.lock().unwrap_or_else(|e| e.into_inner()) = Some(plan.clone());
    *dispatch.ofp.lock().unwrap() = Some(ofp.clone());
    // only the flight of this session – a stale `active` row from a crash must not get the plan
    if let Some(id) = manager.current_flight_id() {
        store.attach_plan(&id, &plan).map_err(lang::ui_error)?;
        let _ = app.emit("logbook:changed", ());
    }
    let _ = app.emit("dispatch:ofp", &ofp);
    Ok(ofp)
}

#[tauri::command]
fn clear_ofp(app: AppHandle, dispatch: State<DispatchState>, manager: State<ProviderManager>) {
    *dispatch.ofp.lock().unwrap() = None;
    *manager.planned.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let _ = app.emit("dispatch:ofp", Option::<Ofp>::None);
}

#[tauri::command]
fn attach_ofp_to_flight(flight_id: String, app: AppHandle, store: State<Store>, dispatch: State<DispatchState>) -> Result<bool, String> {
    let Some(ofp) = dispatch.ofp.lock().unwrap().clone() else { return Err("kein OFP geladen".into()) };
    let ok = store.attach_plan(&flight_id, &plan_from_ofp(&ofp)).map_err(lang::ui_error)?;
    if ok {
        let _ = app.emit("logbook:changed", ());
    }
    Ok(ok)
}

/// Store work off the async runtime's worker threads: SQLite and the track codec block.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(lang::ui_error)?
}

#[tauri::command]
async fn list_flights(limit: Option<u32>, offset: Option<u32>, store: State<'_, Store>) -> Result<Vec<FlightRow>, String> {
    let store = store.inner().clone();
    blocking(move || store.list_flights(limit.unwrap_or(50), offset.unwrap_or(0)).map_err(lang::ui_error)).await
}

/// Logbook size and when it last changed (one aggregate query): the UI polls this and loads
/// the full list only when it differs, and can page with `list_flights(limit, offset)`.
#[tauri::command]
async fn flight_summary_counts(store: State<'_, Store>) -> Result<FlightCounts, String> {
    let store = store.inner().clone();
    blocking(move || store.flight_counts().map_err(lang::ui_error)).await
}

#[tauri::command]
fn get_flight(id: String, store: State<Store>) -> Result<Option<FlightDetail>, String> {
    store.get_flight(&id).map_err(lang::ui_error)
}

#[tauri::command]
async fn get_track(id: String, preview: Option<bool>, store: State<'_, Store>) -> Result<Option<Vec<TrackSample>>, String> {
    let store = store.inner().clone();
    blocking(move || {
        let r = if preview.unwrap_or(false) { store.get_track_preview(&id) } else { store.get_track(&id) };
        r.map_err(lang::ui_error)
    })
    .await
}

/// Moves the flight to the Papierkorb (restorable for 30 days, see `data`).
#[tauri::command]
fn delete_flight(id: String, app: AppHandle, store: State<Store>) -> Result<bool, String> {
    data::refuse_if_recording(&app, &id)?;
    let deleted = store.delete_flight(&id).map_err(lang::ui_error)?;
    if deleted {
        let _ = app.emit("logbook:changed", ());
    }
    Ok(deleted)
}

/// "Fortsetzen" on a `flight:resumable` toast: the running session continues that flight.
#[tauri::command]
async fn resume_flight(flight_id: String, app: AppHandle) -> Result<(), String> {
    blocking(move || app.state::<ProviderManager>().resume_flight(&flight_id)).await
}

/// Interrupted flights and the flight that seems to continue them (Logbuch hint). Never the
/// flight being recorded right now.
#[tauri::command]
async fn list_merge_candidates(store: State<'_, Store>, manager: State<'_, ProviderManager>) -> Result<Vec<MergeCandidate>, String> {
    let store = store.inner().clone();
    let running = manager.current_flight_id();
    blocking(move || {
        let all = store.list_merge_candidates().map_err(lang::ui_error)?;
        Ok(all.into_iter().filter(|c| running.as_deref() != Some(c.second.id.as_str()) && running.as_deref() != Some(c.first.id.as_str())).collect())
    })
    .await
}

/// Join `second_id` onto the interrupted `first_id`; the second flight goes to the Papierkorb.
#[tauri::command]
async fn merge_flights(first_id: String, second_id: String, app: AppHandle, store: State<'_, Store>) -> Result<MergeReport, String> {
    let running = app.state::<ProviderManager>().current_flight_id();
    if running.as_deref() == Some(first_id.as_str()) || running.as_deref() == Some(second_id.as_str()) {
        return Err(lang::tr(
            "Der laufende Flug lässt sich erst nach dem Ende der Aufzeichnung zusammenführen.",
            "The running flight can only be merged once the recording has ended.",
        )
        .into());
    }
    let store = store.inner().clone();
    let report = blocking(move || store.merge_flights(&first_id, &second_id).map_err(lang::ui_error)).await?;
    let _ = app.emit("logbook:changed", ());
    let _ = app.emit("airframes:changed", "");
    Ok(report)
}

#[tauri::command]
fn get_totals(store: State<Store>) -> Result<Totals, String> {
    store.totals().map_err(lang::ui_error)
}

fn parse_format(format: &str) -> Result<ExportFormat, String> {
    ExportFormat::parse(format).ok_or_else(|| format!("unbekanntes Exportformat: {format}"))
}

fn render_export(id: &str, format: ExportFormat, store: &Store) -> Result<String, String> {
    let detail = store.get_flight(id).map_err(lang::ui_error)?.ok_or(lang::tr("Flug nicht gefunden", "Flight not found"))?;
    let samples = store.get_track(id).map_err(lang::ui_error)?.unwrap_or_default();
    export::export_flight(format, &detail, &samples, lang::current()).map_err(lang::ui_error)
}

/// Excel only detects UTF-8 in a CSV that starts with a BOM.
fn write_export(path: &std::path::Path, format: ExportFormat, body: &str) -> Result<(), String> {
    let bom = if format == ExportFormat::Csv { "\u{feff}" } else { "" };
    std::fs::write(path, format!("{bom}{body}")).map_err(|e| format!("{}: {e}", path.display()))
}

/// One flight as CSV/GPX/KML/JSON text.
#[tauri::command]
async fn export_flight(id: String, format: String, store: State<'_, Store>) -> Result<String, String> {
    let format = parse_format(&format)?;
    let store = store.inner().clone();
    blocking(move || render_export(&id, format, &store)).await
}

/// Suggested file name for the save dialog, e.g. `2026-10-17_EDDF-EGLL.gpx`.
#[tauri::command]
fn export_file_name(id: String, format: String, store: State<Store>) -> Result<String, String> {
    let format = parse_format(&format)?;
    let detail = store.get_flight(&id).map_err(lang::ui_error)?.ok_or(lang::tr("Flug nicht gefunden", "Flight not found"))?;
    Ok(export::file_name(&detail.flight, format))
}

/// One flight written to the path from the save dialog; the extension must match the format.
#[tauri::command]
async fn save_export(id: String, format: String, path: String, store: State<'_, Store>) -> Result<(), String> {
    let format = parse_format(&format)?;
    let target = data::allowed_target(&path, &[format.extension()])?;
    let store = store.inner().clone();
    blocking(move || write_export(&target, format, &render_export(&id, format, &store)?)).await
}

/// Header of [`save_image`] with the target path (`encodeURIComponent` of the save-dialog path).
const SAVE_IMAGE_PATH_HEADER: &str = "x-vectasim-path";

/// Percent-decoding of an `encodeURIComponent` value (`%XX` → byte, then UTF-8). `None` for a
/// broken escape or bytes that are no UTF-8; `+` stays a `+` (encodeURIComponent writes `%2B`).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The target and the bytes of a [`save_image`] call: a raw body (`Uint8Array`, no JSON array of
/// numbers) and the path in [`SAVE_IMAGE_PATH_HEADER`], checked by `data::allowed_target`.
/// Largest picture `save_image` writes (a landing card at 2× is a few MB).
const SAVE_IMAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// The eight bytes every PNG starts with.
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn save_image_parts(body: &tauri::ipc::InvokeBody, headers: &tauri::http::HeaderMap) -> Result<(std::path::PathBuf, Vec<u8>), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("expected raw image bytes".into());
    };
    if bytes.len() > SAVE_IMAGE_MAX_BYTES {
        let mb = bytes.len() / (1024 * 1024);
        return Err(trf!("Bild zu groß ({mb} MB, höchstens 32 MB)", "Image too large ({mb} MB, at most 32 MB)"));
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(lang::tr("Kein PNG-Bild", "Not a PNG image").to_string());
    }
    let raw = headers
        .get(SAVE_IMAGE_PATH_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| lang::tr("kein Speicherort gewählt", "no location chosen").to_string())?;
    let path = percent_decode(raw).ok_or_else(|| lang::tr("Ungültiger Speicherort", "Invalid location").to_string())?;
    let target = data::allowed_target(&path, data::IMAGE_EXTENSIONS)?;
    Ok((target, bytes.clone()))
}

/// Binary file from the UI (Touchdown Card PNG), written to the path from the save dialog:
/// `invoke("save_image", bytes, { headers: { "x-vectasim-path": encodeURIComponent(path) } })`.
#[tauri::command]
async fn save_image(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let (target, bytes) = save_image_parts(request.body(), request.headers())?;
    blocking(move || std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))).await
}

/// Whole logbook, one row per flight. Returns the number of flights written.
#[tauri::command]
async fn export_logbook_csv(path: String, store: State<'_, Store>) -> Result<usize, String> {
    let target = data::allowed_target(&path, &[ExportFormat::Csv.extension()])?;
    let store = store.inner().clone();
    blocking(move || {
        let flights = store.list_flights(u32::MAX, 0).map_err(lang::ui_error)?;
        write_export(&target, ExportFormat::Csv, &export::export_logbook_csv_from_store(&store, &flights))?;
        Ok(flights.len())
    })
    .await
}

#[tauri::command]
fn airports_in_bbox(
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    limit: Option<usize>,
    airports: State<Arc<AirportIndex>>,
) -> Vec<Airport> {
    airports.in_bbox(min_lon, min_lat, max_lon, max_lat, limit.unwrap_or(500)).into_iter().cloned().collect()
}

#[tauri::command]
fn nearest_airport(lat: f64, lon: f64, max_nm: Option<f64>, airports: State<Arc<AirportIndex>>) -> Option<NearestAirport> {
    airports.nearest(lat, lon, max_nm.unwrap_or(10.0))
}

#[tauri::command]
fn get_airport(ident: String, airports: State<Arc<AirportIndex>>) -> Option<AirportDetail> {
    airports.get(&ident).map(|a| AirportDetail { airport: a.clone(), runways: airports.runways(&ident).to_vec() })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `vectasim.exe --install-simconnect [--check]` (NSIS installer): headless, before the
    // Tauri builder so the single-instance plugin never hands over to a running VectaSim
    if let Some(code) = simconnect_dl::run_cli(&std::env::args_os().collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    logging::install_panic_hook();

    tauri::Builder::default()
        // must be the first plugin: a second start hands over to this instance and exits
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("second start: focusing the running instance");
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(logging::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // size, position, monitor and maximised state survive a restart (two-monitor setups:
        // sim on one, VectaSim on the other); decorations stay as configured (custom title bar)
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::DECORATIONS)
                .build(),
        )
        .manage(ProviderManager::new())
        .manage(DispatchState::default())
        .manage(OnlineState::default())
        .manage(airframes::PhotoState::default())
        .manage(discord::DiscordState::default())
        .manage(server::ServerState::default())
        .manage(tray::TrayState::default())
        .on_window_event(tray::on_window_event)
        .setup(|app| {
            log::info!(
                "VectaSim {} starting; log folder: {}",
                app.package_info().version,
                app.path().app_log_dir().map(|d| d.display().to_string()).unwrap_or_default()
            );
            let db_path = data::db_path(app.handle())?;
            let default_backups = data::default_backup_dir(app.handle())?;
            log::info!("logbook database: {}", db_path.display());
            let store = match Store::open_with_backup_dir(&db_path, &default_backups) {
                Ok(store) => store,
                Err(e) => {
                    // a dialog with the paths, then a clean exit – never a window that just vanishes
                    data::report_store_error(app.handle(), &e, &db_path, &default_backups);
                    return Ok(());
                }
            };
            if let Some(kind) = vectasim_store::backup::sync_folder_kind(&db_path) {
                log::warn!("logbook database lies in a synced folder ({kind}); WAL files there can be damaged by the sync");
            }
            let level = store.get_setting(logging::SETTING_LOG_LEVEL).ok().flatten().and_then(|s| logging::parse_level(&s));
            logging::set_level(level.unwrap_or(log::LevelFilter::Info));
            if let Some(env) = logging::env_override() {
                log::info!("RUST_LOG={env} overrides the log level setting");
            }
            lang::init(&store);
            apply_dll_setting(&store);
            apply_debug_mode(app.handle(), &store, &app.state::<ProviderManager>());
            if debug_mode_on(&store) {
                log::info!("debug mode on (restored from settings)");
            }
            purge_demo(app.handle(), &store);
            data::purge_trash(&store);
            app.manage(store.clone());
            data::start_auto_backup(app.handle().clone(), store.clone());
            airframes::allow_image_dir(app.handle());
            // Integrationen: notification clicks focus the window, tray icon as set, Discord presence
            notify::on_click_focus(app.handle());
            tray::apply(app.handle());
            tray::start(app.handle().clone());
            discord::start(app.handle().clone());

            online::restore(app.handle(), &store);

            let started = std::time::Instant::now();
            let airports = Arc::new(AirportIndex::load());
            log::info!("airport index loaded in {:?}", started.elapsed());
            app.manage(airports.clone());
            // Overlay & Schnittstelle: the local server, if it was left on
            server::restore(app.handle(), &store);

            // `sim` = the simulator chosen in Settings → Simulator (default: automatic)
            let kind = std::env::var("VECTASIM_PROVIDER").unwrap_or_else(|_| "sim".into());
            let manager = app.state::<ProviderManager>();
            simselect::apply_settings(&store, &manager);
            if let Err(e) = manager.start(app.handle().clone(), store, Arc::new(IndexResolver(airports)), &kind) {
                log::error!("could not start provider {kind}: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data::reveal_path,
            discord::discord_status,
            server::server_status,
            server::server_set_enabled,
            server::server_set_options,
            notify::notify,
            notify::notify_test,
            store_notices,
            sim_text_test,
            tray::set_tray_enabled,
            tray::tray_active,
            countries::countries_geojson,
            countries::countries_list,
            countries::visited_countries,
            get_status,
            app_info,
            log_dir,
            get_log_level,
            set_log_level,
            set_simconnect_dll,
            simselect::get_sim_settings,
            simselect::set_sim_settings,
            dump_info,
            set_raw_dump,
            dump_now,
            get_debug_mode,
            set_debug_mode,
            diagpack::create_diag_package,
            diagnostics_snapshot,
            set_diag_stream,
            get_replay,
            set_replay,
            list_providers,
            select_provider,
            get_live_track,
            manager::get_live_track_since,
            manager::set_ui_visible,
            get_settings,
            set_setting,
            get_current_ofp,
            simbrief_fetch,
            clear_ofp,
            attach_ofp_to_flight,
            list_flights,
            flight_summary_counts,
            get_flight,
            get_track,
            delete_flight,
            resume_flight,
            list_merge_candidates,
            merge_flights,
            notes::update_flight_user,
            notes::list_tags,
            data::list_deleted_flights,
            data::restore_flight,
            data::delete_flight_permanently,
            data::empty_trash,
            data::delete_all_data,
            data::get_backup_info,
            data::set_backup_dir,
            data::create_backup,
            data::restore_backup,
            data::open_backup_dir,
            data::export_bundle,
            data::read_bundle_manifest,
            data::import_bundle,
            get_totals,
            export_flight,
            export_file_name,
            save_export,
            pirep::save_pirep_json,
            save_image,
            export_logbook_csv,
            airports_in_bbox,
            nearest_airport,
            get_airport,
            online::online_set_enabled,
            online::online_set_networks,
            online::online_set_shown,
            online::online_summary,
            online::online_snapshot_in_bbox,
            online::online_pilot,
            online::traffic_track,
            online::traffic_route_resolve,
            online::online_nearby,
            online::metar,
            online::metars,
            landing::landing_analysis,
            landing::landing_facts_recent,
            landing::list_user_runways,
            landing::save_user_runway,
            landing::delete_user_runway,
            approach::approach_analysis,
            approach::approach_facts_recent,
            approach::approach_profiles,
            approach::import_approach_profile,
            approach::delete_approach_profile,
            metrics::flight_metrics_recent,
            airframes::list_airframes,
            airframes::get_airframe,
            airframes::airframe_flights,
            airframes::active_airframe,
            airframes::upsert_airframe,
            airframes::set_flight_airframe,
            airframes::merge_airframes,
            airframes::delete_airframe,
            airframes::airframe_photo,
            airframes::traffic_photo,
            airframes::set_airframe_image,
            privacy::get_card_dir,
            privacy::set_card_dir,
            data::csv_sniff,
            data::csv_preview,
            data::csv_import,
            simconnect_dl::simconnect_download_info,
            simconnect_dl::download_simconnect
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // finish the zstd frame of an open raw dump
                app.state::<ProviderManager>().dump().flush_and_close();
            }
        });
}

#[cfg(test)]
mod dll_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn dll_in_a_drive_root_folder_or_on_path_is_flagged() {
        let root = Some(Path::new(r"C:\Windows"));
        for p in [r"C:\MSFS SDK\SimConnect SDK\lib\SimConnect.dll", r"D:\Tools\SimConnect.dll", "SimConnect.dll"] {
            assert!(dll_in_shared_folder(Path::new(p), root), "{p}");
        }
        for p in [
            r"C:\Users\max\AppData\Local\io.vectasim.app\simconnect\SimConnect.dll",
            r"C:\Program Files\VectaSim\SimConnect.dll",
            r"C:\Windows\System32\SimConnect.dll",
            r"E:\Win\System32\SimConnect.dll",
        ] {
            let root = if p.starts_with('E') { Some(Path::new(r"E:\Win")) } else { root };
            assert!(!dll_in_shared_folder(Path::new(p), root), "{p}");
        }
    }

    #[test]
    fn only_an_existing_simconnect_dll_is_accepted() {
        let dir = std::env::temp_dir().join(format!("vs-dll-{}-{}", std::process::id(), vectasim_core::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("SimConnect.dll");
        let evil = dir.join("evil.dll");
        std::fs::write(&good, b"MZ").unwrap();
        std::fs::write(&evil, b"MZ").unwrap();
        assert_eq!(check_dll_choice(&good.display().to_string()).unwrap(), good);
        assert!(check_dll_choice(&dir.join("simconnect.DLL").display().to_string()).is_ok(), "case does not matter");
        assert!(check_dll_choice(&evil.display().to_string()).is_err(), "any other DLL name");
        assert!(check_dll_choice(&dir.join("SimConnect.exe").display().to_string()).is_err());
        assert!(check_dll_choice("SimConnect.dll").is_err(), "relative");
        assert!(check_dll_choice(&dir.join("x").join("..").join("SimConnect.dll").display().to_string()).is_err(), "..");
        assert!(check_dll_choice(&dir.join("missing").join("SimConnect.dll").display().to_string()).is_err());
        // network paths, however written
        for p in [r"\\host\share\SimConnect.dll", r"//host/share/SimConnect.dll", r"\\?\UNC\host\share\SimConnect.dll"] {
            let e = check_dll_choice(p).unwrap_err();
            assert!(e.contains("Netzwerk") || e.contains("Network"), "{p}: {e}");
        }
        // the verbatim form of a local file is fine
        assert!(check_dll_choice(&format!(r"\\?\{}", good.display())).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod save_image_tests {
    use super::*;
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::InvokeBody;

    /// What `encodeURIComponent` makes of a path (unreserved characters stay, the rest `%XX`).
    fn encode_uri_component(s: &str) -> String {
        s.bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    }

    fn headers(path: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(SAVE_IMAGE_PATH_HEADER, HeaderValue::from_str(&encode_uri_component(path)).unwrap());
        h
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("C%3A%5CUsers%5CJ%C3%BCrgen%5CKarte%20%2B1.png").as_deref(), Some(r"C:\Users\Jürgen\Karte +1.png"));
        assert_eq!(percent_decode("a+b").as_deref(), Some("a+b"));
        for bad in ["%", "%4", "%zz", "%C3"] {
            assert_eq!(percent_decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn raw_body_and_header_pass_the_path_check() {
        let dir = std::env::temp_dir().join("vectasim-save-image-test");
        let target = dir.join("Landung EDDF – 25C.png");
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend([1, 2, 3]);
        let (path, bytes) = save_image_parts(&InvokeBody::Raw(png.clone()), &headers(&target.display().to_string())).unwrap();
        assert_eq!((path.as_path(), bytes.as_slice()), (target.as_path(), png.as_slice()));
        // the old JSON form, a missing header, a broken escape, a relative path or another extension: refused
        let json = InvokeBody::Json(serde_json::json!({ "path": target.display().to_string(), "bytes": [1, 2] }));
        assert_eq!(save_image_parts(&json, &headers(&target.display().to_string())).unwrap_err(), "expected raw image bytes");
        let raw = InvokeBody::Raw(png);
        assert!(save_image_parts(&raw, &HeaderMap::new()).is_err());
        let mut broken = HeaderMap::new();
        broken.insert(SAVE_IMAGE_PATH_HEADER, HeaderValue::from_static("C%3A%5Cx%ZZ.png"));
        assert!(save_image_parts(&raw, &broken).is_err());
        assert!(save_image_parts(&raw, &headers("karte.png")).is_err());
        assert!(save_image_parts(&raw, &headers(&dir.join("karte.exe").display().to_string())).is_err());
        assert!(save_image_parts(&raw, &headers(&dir.join("..").join("karte.png").display().to_string())).is_err());
        assert!(save_image_parts(&raw, &headers(r"\\nas\share\karte.png")).is_err(), "network path");
    }

    #[test]
    fn save_image_takes_only_pngs_of_a_sane_size() {
        let target = std::env::temp_dir().join("vectasim-save-image-test").join("karte.png");
        let h = headers(&target.display().to_string());
        // not a PNG (an executable, an empty body, a truncated signature)
        for body in [b"MZ\x90\x00".to_vec(), Vec::new(), PNG_SIGNATURE[..7].to_vec()] {
            let e = save_image_parts(&InvokeBody::Raw(body), &h).unwrap_err();
            assert!(e.contains("PNG"), "{e}");
        }
        // too large
        let mut big = PNG_SIGNATURE.to_vec();
        big.resize(SAVE_IMAGE_MAX_BYTES + 1, 0);
        assert!(save_image_parts(&InvokeBody::Raw(big), &h).unwrap_err().contains("32 MB"));
        // the largest allowed
        let mut max = PNG_SIGNATURE.to_vec();
        max.resize(SAVE_IMAGE_MAX_BYTES, 0);
        assert!(save_image_parts(&InvokeBody::Raw(max), &h).is_ok());
    }
}

#[cfg(test)]
mod capability_tests {
    /// The `opener:allow-open-url` scope of the main window: (allow, deny) glob patterns.
    fn open_url_scope() -> (Vec<glob::Pattern>, Vec<glob::Pattern>) {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let entry = caps["permissions"].as_array().unwrap().iter().find(|p| p["identifier"] == "opener:allow-open-url").expect("open-url permission");
        let list = |k: &str| entry[k].as_array().unwrap().iter().map(|e| glob::Pattern::new(e["url"].as_str().unwrap()).unwrap()).collect();
        (list("allow"), list("deny"))
    }

    fn allowed(url: &str) -> bool {
        let (allow, deny) = open_url_scope();
        !deny.iter().any(|p| p.matches(url)) && allow.iter().any(|p| p.matches(url))
    }

    /// `href="…"` values and `"https://…"` string constants of a source file.
    fn urls_in(src: &str) -> Vec<String> {
        src.split('"').filter(|s| s.starts_with("https://")).map(|s| if s[8..].contains('/') { s.to_string() } else { format!("{s}/") }).collect()
    }

    #[test]
    fn the_app_opens_only_the_hosts_it_links_to() {
        // what the webview opens: Planespotters credits, the notices on GitHub, the SDK licence,
        // the map attributions (MapLibre's own link, OpenFreeMap's style, satellite, weather) and the overlay pages
        let mut urls = vec![
            "https://www.planespotters.net/photo/1234567/d-aibl-lufthansa-airbus-a319-112".to_string(),
            crate::simconnect_dl::EULA_URL.to_string(),
            "https://maplibre.org/".into(),
            "https://openfreemap.org/".into(),
            "https://www.openmaptiles.org/".into(),
            "https://www.openstreetmap.org/copyright".into(),
            "http://127.0.0.1:8095/overlay/hud?scale=1.5".into(),
        ];
        let notices = urls_in(include_str!("../../src/Settings.tsx"));
        assert!(notices.iter().any(|u| u.starts_with("https://github.com/unwritten-dev/VectaSim/")), "{notices:?}");
        urls.extend(notices);
        let attributions: Vec<String> = urls_in(include_str!("../../src/map/satellite.ts")).into_iter().chain(urls_in(include_str!("../../src/map/weatherOverlay.ts"))).filter(|u| !u.contains('{')).collect();
        // the attribution links (tile URLs are fetched, not opened, but allowed hosts would not hurt)
        for u in attributions.iter().filter(|u| u.contains("cloudless.eox.at") || u.contains("rainviewer.com/api") || u.contains("view.eumetsat.int/")) {
            urls.push(u.clone());
        }
        assert!(urls.iter().any(|u| u.contains("cloudless.eox.at")) && urls.iter().any(|u| u.contains("rainviewer.com")) && urls.iter().any(|u| u.contains("eumetsat")));
        for u in &urls {
            assert!(allowed(u), "{u} must be allowed");
        }
        // anything else is not (no `https://*` scope)
        for u in [
            "https://evil.example/",
            "https://www.planespotters.net.evil.example/photo/1",
            "https://user@www.planespotters.net/photo/1",
            "http://www.planespotters.net/photo/1",
            "https://github.com/someone-else/x",
            "file:///C:/Windows/System32/calc.exe",
            "http://192.168.1.5:8095/",
        ] {
            assert!(!allowed(u), "{u} must be refused");
        }
    }
}

#[cfg(test)]
mod workspace_tests {
    /// No crate of the workspace can be published by accident (and cargo-deny's
    /// `[licenses.private] ignore` covers them all).
    #[test]
    fn every_crate_is_private() {
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates");
        let mut seen = 0;
        for dir in std::fs::read_dir(&crates).unwrap().flatten() {
            let manifest = dir.path().join("Cargo.toml");
            let Ok(text) = std::fs::read_to_string(&manifest) else { continue };
            assert!(text.lines().any(|l| l.trim() == "publish = false"), "{} lacks publish = false", manifest.display());
            seen += 1;
        }
        assert!(seen >= 10, "{seen} crates");
        let app = include_str!("../Cargo.toml");
        assert!(app.lines().any(|l| l.trim() == "publish = false"), "the app crate");
    }
}
