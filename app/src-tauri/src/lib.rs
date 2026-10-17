mod airframes;
mod landing;
mod manager;
mod online;

use manager::{ProviderManager, StatusSnapshot};
use online::OnlineState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use std::sync::Mutex;
use vectasim_data::{Airport, AirportIndex, NearestAirport, Runway};
use vectasim_simbrief::{Ofp, SimbriefError, User};
use vectasim_store::{AirportResolver, ExportFormat, FlightDetail, FlightRow, PlannedFlight, Store, Totals, TrackSample, export};

const SETTING_SIMBRIEF_USER: &str = "simbrief_user";

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
}

/// Same order as the SimConnect provider's loader; the bare name is resolved like the
/// Windows DLL search (System32, then PATH). Only checks that the file exists.
fn find_simconnect_dll() -> Option<std::path::PathBuf> {
    for p in vectasim_simconnect::ffi::candidate_paths() {
        if p.is_absolute() {
            if p.is_file() {
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
        if let Some(found) = dirs.into_iter().map(|d| d.join(&p)).find(|f| f.is_file()) {
            return Some(found);
        }
    }
    None
}

/// Version, data paths and integration checks for Settings → Diagnose.
#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let data_dir = app.path().app_data_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let db_path = app.path().app_data_dir().map(|d| d.join("vectasim.db").display().to_string()).unwrap_or_default();
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir,
        db_path,
        simconnect_dll: find_simconnect_dll().map(|p| p.display().to_string()),
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
    manager.start(app, store.inner().clone(), Arc::new(IndexResolver(airports.inner().clone())), &kind)
}

#[tauri::command]
fn get_live_track(manager: State<ProviderManager>) -> Vec<TrackSample> {
    manager.live_track()
}

#[tauri::command]
fn get_settings(store: State<Store>) -> Result<Vec<(String, String)>, String> {
    store.all_settings().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_setting(key: String, value: String, store: State<Store>) -> Result<(), String> {
    store.set_setting(&key, &value).map_err(|e| e.to_string())
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
            store.set_setting(SETTING_SIMBRIEF_USER, u.trim()).map_err(|e| e.to_string())?;
            u
        }
        _ => store.get_setting(SETTING_SIMBRIEF_USER).map_err(|e| e.to_string())?.unwrap_or_default(),
    };
    let user = User::parse(&user_input).ok_or_else(|| SimbriefError::NoUser.to_string())?;
    let ofp = vectasim_simbrief::fetch_latest(&user).await.map_err(|e| e.to_string())?;
    log::info!("SimBrief OFP loaded: {} {} ({} fixes)", ofp.callsign, ofp.route_label(), ofp.navlog.len());

    let plan = plan_from_ofp(&ofp);
    *manager.planned.lock().unwrap_or_else(|e| e.into_inner()) = Some(plan.clone());
    *dispatch.ofp.lock().unwrap() = Some(ofp.clone());
    if let Some(id) = store.active_flight_id().map_err(|e| e.to_string())? {
        store.attach_plan(&id, &plan).map_err(|e| e.to_string())?;
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
    let ok = store.attach_plan(&flight_id, &plan_from_ofp(&ofp)).map_err(|e| e.to_string())?;
    if ok {
        let _ = app.emit("logbook:changed", ());
    }
    Ok(ok)
}

#[tauri::command]
fn list_flights(limit: Option<u32>, offset: Option<u32>, store: State<Store>) -> Result<Vec<FlightRow>, String> {
    store.list_flights(limit.unwrap_or(50), offset.unwrap_or(0)).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_flight(id: String, store: State<Store>) -> Result<Option<FlightDetail>, String> {
    store.get_flight(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_track(id: String, preview: Option<bool>, store: State<Store>) -> Result<Option<Vec<TrackSample>>, String> {
    let r = if preview.unwrap_or(false) { store.get_track_preview(&id) } else { store.get_track(&id) };
    r.map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_flight(id: String, app: AppHandle, store: State<Store>) -> Result<bool, String> {
    let deleted = store.delete_flight(&id).map_err(|e| e.to_string())?;
    if deleted {
        let _ = app.emit("logbook:changed", ());
    }
    Ok(deleted)
}

#[tauri::command]
fn get_totals(store: State<Store>) -> Result<Totals, String> {
    store.totals().map_err(|e| e.to_string())
}

fn parse_format(format: &str) -> Result<ExportFormat, String> {
    ExportFormat::parse(format).ok_or_else(|| format!("unbekanntes Exportformat: {format}"))
}

fn render_export(id: &str, format: ExportFormat, store: &Store) -> Result<String, String> {
    let detail = store.get_flight(id).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
    let samples = store.get_track(id).map_err(|e| e.to_string())?.unwrap_or_default();
    export::export_flight(format, &detail, &samples).map_err(|e| e.to_string())
}

/// Excel only detects UTF-8 in a CSV that starts with a BOM.
fn write_export(path: &str, format: ExportFormat, body: &str) -> Result<(), String> {
    let bom = if format == ExportFormat::Csv { "\u{feff}" } else { "" };
    std::fs::write(path, format!("{bom}{body}")).map_err(|e| format!("{path}: {e}"))
}

/// One flight as CSV/GPX/KML/JSON text.
#[tauri::command]
fn export_flight(id: String, format: String, store: State<Store>) -> Result<String, String> {
    render_export(&id, parse_format(&format)?, &store)
}

/// Suggested file name for the save dialog, e.g. `2026-10-17_EDDF-EGLL.gpx`.
#[tauri::command]
fn export_file_name(id: String, format: String, store: State<Store>) -> Result<String, String> {
    let format = parse_format(&format)?;
    let detail = store.get_flight(&id).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
    Ok(export::file_name(&detail.flight, format))
}

#[tauri::command]
fn save_export(id: String, format: String, path: String, store: State<Store>) -> Result<(), String> {
    let format = parse_format(&format)?;
    write_export(&path, format, &render_export(&id, format, &store)?)
}

/// Whole logbook, one row per flight. Returns the number of flights written.
#[tauri::command]
fn export_logbook_csv(path: String, store: State<Store>) -> Result<usize, String> {
    let flights = store.list_flights(u32::MAX, 0).map_err(|e| e.to_string())?;
    write_export(&path, ExportFormat::Csv, &export::export_logbook_csv(&flights))?;
    Ok(flights.len())
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
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ProviderManager::new())
        .manage(DispatchState::default())
        .manage(OnlineState::default())
        .manage(airframes::PhotoState::default())
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join("vectasim.db");
            log::info!("logbook database: {}", db_path.display());
            let store = Store::open(&db_path)?;
            app.manage(store.clone());
            airframes::allow_image_dir(app.handle());

            if store.get_setting(online::SETTING_VATSIM).ok().flatten().as_deref() == Some("1") {
                online::start_vatsim(app.handle(), &app.state::<OnlineState>().vatsim);
            }

            let started = std::time::Instant::now();
            let airports = Arc::new(AirportIndex::load());
            log::info!("airport index loaded in {:?}", started.elapsed());
            app.manage(airports.clone());

            let kind = std::env::var("VECTASIM_PROVIDER").unwrap_or_else(|_| "simconnect".into());
            let manager = app.state::<ProviderManager>();
            if let Err(e) = manager.start(app.handle().clone(), store, Arc::new(IndexResolver(airports)), &kind) {
                log::error!("could not start provider {kind}: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            app_info,
            list_providers,
            select_provider,
            get_live_track,
            get_settings,
            set_setting,
            get_current_ofp,
            simbrief_fetch,
            clear_ofp,
            attach_ofp_to_flight,
            list_flights,
            get_flight,
            get_track,
            delete_flight,
            get_totals,
            export_flight,
            export_file_name,
            save_export,
            export_logbook_csv,
            airports_in_bbox,
            nearest_airport,
            get_airport,
            online::online_set_enabled,
            online::online_summary,
            online::online_snapshot_in_bbox,
            online::online_pilot,
            online::online_nearby,
            online::metar,
            online::metars,
            landing::landing_analysis,
            airframes::list_airframes,
            airframes::get_airframe,
            airframes::airframe_flights,
            airframes::active_airframe,
            airframes::upsert_airframe,
            airframes::set_flight_airframe,
            airframes::merge_airframes,
            airframes::delete_airframe,
            airframes::airframe_photo,
            airframes::set_airframe_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
