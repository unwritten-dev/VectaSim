//! Einstellungen → Daten: database location, backups (folder, automatic, restore),
//! Papierkorb and „Alle Daten löschen“, Gesamtexport/-import (`.vectasim`), CSV import from
//! other logbooks; plus the start-up error dialog of the store and the check of every path the
//! UI hands in for writing.

use crate::lang::Lang;
use crate::manager::ProviderManager;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use vectasim_store::backup::{self, BackupKind, SETTING_BACKUP_DIR};
use vectasim_data::AirportIndex;
use vectasim_store::bundle::{self, BundleManifest, BUNDLE_EXTENSION};
use vectasim_store::csvimport::{self, CSV_MAX_BYTES, PREVIEW_LIMIT};
use vectasim_store::{
    BackupEntry, ColumnMapping, CsvImportOptions, CsvImportReport, CsvPreview, CsvProfile, DeletedFlight, ExportOptions, ExportReport, ImportMode,
    ImportOptions, ImportReport, Store, StoreError, TRASH_RETENTION_DAYS,
};

pub const DB_FILE: &str = "vectasim.db";
/// First automatic check after start (the window and the provider come first).
const AUTO_BACKUP_FIRST_CHECK: std::time::Duration = std::time::Duration::from_secs(20);
const AUTO_BACKUP_RECHECK: std::time::Duration = std::time::Duration::from_secs(3600);

/// Error text for the UI in the backend language (store errors localized, see `lang::ui_error`).
fn err(e: impl std::fmt::Display + 'static) -> String {
    crate::lang::ui_error(e)
}

/// `%APPDATA%\io.vectasim.app\vectasim.db`
pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join(DB_FILE)).map_err(err)
}

/// `%LOCALAPPDATA%\io.vectasim.app\backups`
pub fn default_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("backups")).map_err(err)
}

/// The chosen backup folder (setting `backup_dir`), else the default.
pub fn backup_dir(app: &AppHandle, store: &Store) -> Result<PathBuf, String> {
    match store.get_setting(SETTING_BACKUP_DIR).ok().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => default_backup_dir(app),
    }
}

fn flight_running(app: &AppHandle) -> bool {
    app.state::<ProviderManager>().current_flight_id().is_some()
}

/// The flight being recorded cannot go to the Papierkorb or be deleted: its row would vanish
/// under the recorder (every later write fails, the log fills). `ids` are the flights to delete.
pub fn refuse_recording_flight<'a>(current: Option<&str>, mut ids: impl Iterator<Item = &'a str>) -> Result<(), String> {
    match current {
        Some(cur) if ids.any(|id| id == cur) => Err(crate::lang::tr(
            "Der Flug wird gerade aufgezeichnet und kann erst nach dem Flugende gelöscht werden.",
            "This flight is being recorded and can only be deleted after it has ended.",
        )
        .into()),
        _ => Ok(()),
    }
}

/// [`refuse_recording_flight`] for one id against the manager's running flight.
pub fn refuse_if_recording(app: &AppHandle, id: &str) -> Result<(), String> {
    refuse_recording_flight(app.state::<ProviderManager>().current_flight_id().as_deref(), std::iter::once(id))
}

fn file_bytes(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    db_path: String,
    /// Database plus its WAL file.
    db_bytes: u64,
    /// Sync service / network share the database lies on (WAL there is unsafe).
    db_sync: Option<&'static str>,
    dir: String,
    default_dir: String,
    is_default: bool,
    /// Sync service the backup folder lies on (good: off-site copy).
    dir_sync: Option<&'static str>,
    last_backup_ms: Option<u64>,
    /// Newest first.
    backups: Vec<BackupEntry>,
    trash_count: u64,
    trash_days: u32,
    /// A flight is being recorded: restore and „Alle Daten löschen“ wait.
    flight_active: bool,
}

fn backup_info_of(app: &AppHandle, store: &Store) -> Result<BackupInfo, String> {
    let db = db_path(app)?;
    let dir = backup_dir(app, store)?;
    let default_dir = default_backup_dir(app)?;
    let backups = backup::list_backups(&dir).unwrap_or_else(|e| {
        log::warn!("backup folder {} not readable: {e}", dir.display());
        Vec::new()
    });
    let wal = db.with_file_name(format!("{DB_FILE}-wal"));
    Ok(BackupInfo {
        db_path: db.display().to_string(),
        db_bytes: file_bytes(&db) + file_bytes(&wal),
        db_sync: backup::sync_folder_kind(&db),
        is_default: dir == default_dir,
        dir_sync: backup::sync_folder_kind(&dir),
        dir: dir.display().to_string(),
        default_dir: default_dir.display().to_string(),
        last_backup_ms: backups.first().map(|b| b.created_ms),
        backups,
        trash_count: store.deleted_count().map_err(err)?,
        trash_days: TRASH_RETENTION_DAYS,
        flight_active: flight_running(app),
    })
}

#[tauri::command]
pub async fn get_backup_info(app: AppHandle, store: State<'_, Store>) -> Result<BackupInfo, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup_info_of(&app, &store)).await.map_err(err)?
}

/// Choose (`Some`) or reset (`None`) the backup folder. The folder must be writable.
#[tauri::command]
pub async fn set_backup_dir(path: Option<String>, app: AppHandle, store: State<'_, Store>) -> Result<BackupInfo, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        if let Some(p) = &path {
            let dir = Path::new(p);
            if !dir.is_absolute() {
                return Err(trf!("Bitte einen vollständigen Pfad wählen: {p}", "Please choose a full path: {p}"));
            }
            std::fs::create_dir_all(dir).map_err(|e| format!("{p}: {e}"))?;
            let probe = dir.join(".vectasim-write-test");
            std::fs::write(&probe, b"ok").map_err(|e| trf!("Ordner nicht beschreibbar: {p} ({e})", "Folder not writable: {p} ({e})"))?;
            let _ = std::fs::remove_file(probe);
        }
        store.set_setting(SETTING_BACKUP_DIR, path.as_deref().unwrap_or("")).map_err(err)?;
        log::info!("backup folder: {}", path.as_deref().unwrap_or("<default>"));
        backup_info_of(&app, &store)
    })
    .await
    .map_err(err)?
}

/// A backup now: `kind` "update" before installing an update, anything else = regular.
#[tauri::command]
pub async fn create_backup(kind: Option<String>, app: AppHandle, store: State<'_, Store>) -> Result<BackupEntry, String> {
    let store = store.inner().clone();
    let kind = if kind.as_deref() == Some("update") { BackupKind::PreUpdate } else { BackupKind::Regular };
    let entry = tauri::async_runtime::spawn_blocking(move || make_backup(&app, &store, kind)).await.map_err(err)??;
    Ok(entry)
}

fn make_backup(app: &AppHandle, store: &Store, kind: BackupKind) -> Result<BackupEntry, String> {
    let dir = backup_dir(app, store)?;
    let started = std::time::Instant::now();
    let path = store.create_backup(&dir, kind).map_err(err)?;
    log::info!("backup ({}) written in {:?}: {}", kind.as_str(), started.elapsed(), path.display());
    let _ = app.emit("backup:changed", ());
    backup::list_backups(&dir)
        .map_err(err)?
        .into_iter()
        .find(|b| Path::new(&b.path) == path)
        .ok_or_else(|| {
            let p = path.display();
            trf!("Sicherung geschrieben, aber nicht gefunden: {p}", "Backup written but not found: {p}")
        })
}

/// Restore from a backup: check it, save the current logbook, stage it and restart.
/// Returns the copy of the current logbook (the restart follows a moment later).
#[tauri::command]
pub async fn restore_backup(path: String, app: AppHandle, store: State<'_, Store>) -> Result<String, String> {
    if flight_running(&app) {
        return Err(crate::lang::tr(
            "Während einer Aufzeichnung kann keine Sicherung wiederhergestellt werden. Bitte nach dem Flug.",
            "A backup cannot be restored during a recording. Please do it after the flight.",
        )
        .into());
    }
    let store = store.inner().clone();
    let app2 = app.clone();
    let store2 = store.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let dir = backup_dir(&app2, &store2)?;
        store2.restore_from(Path::new(&path), &dir).map_err(err)
    })
    .await
    .map_err(err)??;
    // give the UI a moment to show "startet neu", release the file, restart; the next open
    // puts the staged copy in place
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        if let Err(e) = store.close_for_restart() {
            log::warn!("logbook not closed before the restart: {e}");
        }
        app.request_restart();
    });
    Ok(saved.display().to_string())
}

#[tauri::command]
pub fn open_backup_dir(app: AppHandle, store: State<Store>) -> Result<(), String> {
    let dir = backup_dir(&app, &store)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(err)
}

// ---- Papierkorb ---------------------------------------------------------------------

#[tauri::command]
pub fn list_deleted_flights(store: State<Store>) -> Result<Vec<DeletedFlight>, String> {
    store.list_deleted_flights().map_err(err)
}

#[tauri::command]
pub fn restore_flight(id: String, app: AppHandle, store: State<Store>) -> Result<bool, String> {
    let ok = store.restore_flight(&id).map_err(err)?;
    if ok {
        let _ = app.emit("logbook:changed", ());
        let _ = app.emit("airframes:changed", "");
    }
    Ok(ok)
}

#[tauri::command]
pub fn delete_flight_permanently(id: String, app: AppHandle, store: State<Store>) -> Result<bool, String> {
    refuse_if_recording(&app, &id)?;
    let ok = store.delete_flight_permanently(&id).map_err(err)?;
    if ok {
        let _ = app.emit("logbook:changed", ());
    }
    Ok(ok)
}

/// „Papierkorb leeren“. Returns how many flights went.
#[tauri::command]
pub fn empty_trash(app: AppHandle, store: State<Store>) -> Result<usize, String> {
    if let Some(cur) = app.state::<ProviderManager>().current_flight_id() {
        let trashed = store.list_deleted_flights().map_err(err)?;
        refuse_recording_flight(Some(&cur), trashed.iter().map(|d| d.flight.id.as_str()))?;
    }
    let n = store.purge_deleted(0, vectasim_core::now_ms()).map_err(err)?;
    log::info!("trash emptied: {n} flight(s)");
    let _ = app.emit("logbook:changed", ());
    Ok(n)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WipeResult {
    flights: usize,
    backup: String,
}

/// „Alle Daten löschen“: backup first (no backup, no wipe), then every flight and airframe.
#[tauri::command]
pub async fn delete_all_data(app: AppHandle, store: State<'_, Store>) -> Result<WipeResult, String> {
    if flight_running(&app) {
        return Err(crate::lang::tr("Während einer Aufzeichnung kann das Logbuch nicht gelöscht werden.", "The logbook cannot be deleted during a recording.").into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let saved = make_backup(&app, &store, BackupKind::PreWipe)?;
        let flights = store.delete_all_data().map_err(err)?;
        log::warn!("all logbook data deleted ({flights} flights); copy: {}", saved.path);
        let _ = app.emit("logbook:changed", ());
        let _ = app.emit("airframes:changed", "");
        Ok(WipeResult { flights, backup: saved.path })
    })
    .await
    .map_err(err)?
}

// ---- paths from the UI ------------------------------------------------------------------

/// Extensions per writing command (flight exports take the one of their format).
pub const IMAGE_EXTENSIONS: &[&str] = &["png"];
pub const BUNDLE_EXTENSIONS: &[&str] = &[BUNDLE_EXTENSION];
pub const DIAG_EXTENSIONS: &[&str] = &["zip"];
/// Files the CSV import reads.
pub const CSV_EXTENSIONS: &[&str] = &["csv", "txt"];

/// Lower case, `/` → `\`, without the `\\?\` prefix and trailing separators – for prefix checks.
fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\").to_lowercase();
    let s = s.strip_prefix(r"\\?\unc\").map(|r| format!(r"\\{r}")).unwrap_or(s);
    let s = s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s);
    s.trim_end_matches('\\').to_string()
}

fn is_under(p: &Path, root: &Path) -> bool {
    let (p, root) = (path_key(p), path_key(root));
    !root.is_empty() && (p == root || p.starts_with(&format!("{root}\\")))
}

/// Folders nothing is ever written to: Windows, the program folders, where VectaSim is installed.
pub fn forbidden_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .collect();
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        roots.push(dir);
    }
    roots
}

/// A path the UI wants written (from a save dialog): (a) absolute, (b) without `..`, (c) with
/// one of `extensions` (case-insensitive), (d) not inside one of `forbidden`. Anything else is
/// refused with „Pfad nicht erlaubt“, so a compromised webview cannot write anywhere it likes.
pub fn check_path(raw: &str, extensions: &[&str], forbidden: &[PathBuf]) -> Result<PathBuf, String> {
    let deny = |why: &str| {
        let p = raw.trim();
        Err(trf!("Pfad nicht erlaubt: {p} ({why})", "Path not allowed: {p} ({why})"))
    };
    let tr = crate::lang::tr;
    let raw = raw.trim();
    if raw.is_empty() {
        return deny(tr("leer", "empty"));
    }
    let p = PathBuf::from(raw);
    if !p.is_absolute() {
        return deny(tr("kein vollständiger Pfad", "not a full path"));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) || raw.split(['\\', '/']).any(|part| part == "..") {
        return deny(tr("enthält ..", "contains .."));
    }
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !extensions.contains(&ext.as_str()) {
        let list = extensions.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(", ");
        return deny(&trf!("erwartet {list}", "expected {list}"));
    }
    if p.file_stem().is_none_or(|s| s.to_string_lossy().trim().is_empty()) {
        return deny(tr("kein Dateiname", "no file name"));
    }
    if forbidden.iter().any(|root| is_under(&p, root)) {
        return deny(tr("System- oder Programmordner", "system or program folder"));
    }
    Ok(p)
}

/// [`check_path`] against the folders of this machine.
pub fn allowed_target(raw: &str, extensions: &[&str]) -> Result<PathBuf, String> {
    check_path(raw, extensions, &forbidden_roots())
}

// ---- Gesamtexport/-import (.vectasim) -------------------------------------------------

/// Own airframe pictures (`%APPDATA%\io.vectasim.app\airframes`, see `airframes`).
fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("airframes")).map_err(err)
}

/// „Alles exportieren …“: the whole logbook (Papierkorb on request) with tracks, fleet and own
/// pictures as one `.vectasim` file. Demo and replay flights stay out.
#[tauri::command]
pub async fn export_bundle(path: String, include_deleted: Option<bool>, app: AppHandle, store: State<'_, Store>) -> Result<ExportReport, String> {
    let target = allowed_target(&path, BUNDLE_EXTENSIONS)?;
    let store = store.inner().clone();
    let opts = ExportOptions { include_deleted: include_deleted.unwrap_or(false), include_demo: false, app_version: app.package_info().version.to_string(), lang: crate::lang::current() };
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let r = store.export_bundle(&target, &opts).map_err(err)?;
        log::info!(
            "bundle exported in {:?}: {} ({} bytes, {} flights, {} airframes, {} images)",
            started.elapsed(),
            r.path,
            r.bytes,
            r.manifest.flights,
            r.manifest.airframes,
            r.manifest.images
        );
        for w in &r.warnings {
            log::warn!("bundle export: {w}");
        }
        Ok(r)
    })
    .await
    .map_err(err)?
}

/// What a `.vectasim` file holds (shown before the import asks Zusammenführen/Ersetzen).
#[tauri::command]
pub async fn read_bundle_manifest(path: String) -> Result<BundleManifest, String> {
    let src = check_path(&path, BUNDLE_EXTENSIONS, &[])?;
    tauri::async_runtime::spawn_blocking(move || bundle::read_manifest(&src).map_err(err)).await.map_err(err)?
}

/// „Aus Datei importieren …“: `mode` "merge" (default) adds what is new, "replace" saves the
/// logbook (`pre-import` backup) and replaces flights and fleet. Not while recording for "replace".
#[tauri::command]
pub async fn import_bundle(path: String, mode: Option<String>, app: AppHandle, store: State<'_, Store>) -> Result<ImportReport, String> {
    let src = check_path(&path, BUNDLE_EXTENSIONS, &[])?;
    let mode = match mode.as_deref().unwrap_or("merge") {
        "merge" => ImportMode::Merge,
        "replace" => ImportMode::Replace,
        other => return Err(trf!("unbekannter Importmodus: {other}", "unknown import mode: {other}")),
    };
    if mode == ImportMode::Replace && flight_running(&app) {
        return Err(crate::lang::tr(
            "Während einer Aufzeichnung kann das Logbuch nicht ersetzt werden. Bitte nach dem Flug – oder „Zusammenführen“ wählen.",
            "The logbook cannot be replaced during a recording. Please do it after the flight – or choose “Merge”.",
        )
        .into());
    }
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let opts = ImportOptions { mode, images_dir: Some(images_dir(&app)?), backup_dir: Some(backup_dir(&app, &store)?), lang: crate::lang::current() };
        let started = std::time::Instant::now();
        let r = store.import_bundle(&src, &opts).map_err(err)?;
        log::info!(
            "bundle imported ({mode:?}) in {:?} from {}: {} flights added, {} duplicates skipped, {} airframes added, {} updated, {} images",
            started.elapsed(),
            src.display(),
            r.flights_added,
            r.flights_skipped_duplicate,
            r.airframes_added,
            r.airframes_updated,
            r.images_added
        );
        for w in &r.warnings {
            log::warn!("bundle import: {w}");
        }
        let _ = app.emit("logbook:changed", ());
        let _ = app.emit("airframes:changed", "");
        if r.backup.is_some() {
            let _ = app.emit("backup:changed", ());
        }
        Ok(r)
    })
    .await
    .map_err(err)?
}

// ---- CSV import (other logbooks) ------------------------------------------------------

/// A CSV the UI wants read: absolute, `.csv`/`.txt`, at most 50 MB. Bytes and file stem.
fn read_csv_file(raw: &str) -> Result<(Vec<u8>, String), String> {
    let src = check_path(raw, CSV_EXTENSIONS, &[])?;
    let shown = src.display().to_string();
    let file = std::fs::File::open(&src).map_err(|e| format!("{shown}: {e}"))?;
    let max_mb = CSV_MAX_BYTES / (1024 * 1024);
    let too_big = || trf!("Datei zu groß: höchstens {max_mb} MB ({shown})", "File too large: at most {max_mb} MB ({shown})");
    if file.metadata().map_err(|e| format!("{shown}: {e}"))?.len() > CSV_MAX_BYTES {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    file.take(CSV_MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("{shown}: {e}"))?;
    if bytes.len() as u64 > CSV_MAX_BYTES {
        return Err(too_big());
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((bytes, stem))
}

fn coords_of(index: &AirportIndex) -> impl Fn(&str) -> Option<(f64, f64)> + '_ {
    move |icao| index.get(icao).map(|a| (a.latitude, a.longitude))
}

/// „CSV importieren …“ step 1: encoding, delimiter, header, preset and a suggested mapping.
#[tauri::command]
pub async fn csv_sniff(path: String) -> Result<CsvProfile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, stem) = read_csv_file(&path)?;
        Ok(csvimport::sniff_named(&bytes, Some(&stem), crate::lang::current()))
    })
    .await
    .map_err(err)?
}

/// Step 3: the first 20 rows with the mapping, counts and duplicates over the whole file.
#[tauri::command]
pub async fn csv_preview(
    path: String,
    mapping: ColumnMapping,
    mut options: CsvImportOptions,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<CsvPreview, String> {
    options.lang = crate::lang::current();
    let (store, airports) = (store.inner().clone(), airports.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, _) = read_csv_file(&path)?;
        store.preview_csv(&bytes, &mapping, &options, PREVIEW_LIMIT, &coords_of(&airports)).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Step 4: import the valid rows as completed flights without track (see `csvimport`).
#[tauri::command]
pub async fn csv_import(
    path: String,
    mapping: ColumnMapping,
    mut options: CsvImportOptions,
    app: AppHandle,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<CsvImportReport, String> {
    options.lang = crate::lang::current();
    let (store, airports) = (store.inner().clone(), airports.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, _) = read_csv_file(&path)?;
        let started = std::time::Instant::now();
        let r = store
            .import_csv_with(&bytes, &mapping, &options, &coords_of(&airports), vectasim_core::now_ms() as i64)
            .map_err(err)?;
        log::info!(
            "CSV imported ({}) in {:?}: {} rows, {} added, {} duplicates, {} invalid, {} airframes new",
            mapping.preset.as_str(),
            started.elapsed(),
            r.rows,
            r.added,
            r.skipped_duplicate,
            r.skipped_invalid,
            r.airframes_added
        );
        for w in &r.warnings {
            log::warn!("CSV import: {w}");
        }
        if r.added > 0 {
            let _ = app.emit("logbook:changed", ());
            let _ = app.emit("airframes:changed", "");
        }
        Ok(r)
    })
    .await
    .map_err(err)?
}

// ---- start-up -------------------------------------------------------------------------

/// Papierkorb older than 30 days goes at every start.
pub fn purge_trash(store: &Store) {
    match store.purge_deleted(TRASH_RETENTION_DAYS, vectasim_core::now_ms()) {
        Ok(0) => {}
        Ok(n) => log::info!("trash: {n} flight(s) older than {TRASH_RETENTION_DAYS} days removed"),
        Err(e) => log::error!("could not purge the trash: {e}"),
    }
}

/// Daily automatic backup: shortly after start and then hourly, whenever the newest copy is
/// older than 24 h and no flight is being recorded.
pub fn start_auto_backup(app: AppHandle, store: Store) {
    let spawned = std::thread::Builder::new().name("auto-backup".into()).spawn(move || {
        std::thread::sleep(AUTO_BACKUP_FIRST_CHECK);
        loop {
            match backup_dir(&app, &store) {
                Ok(dir) if !flight_running(&app) && backup::backup_due(&dir, vectasim_core::now_ms()) => {
                    if let Err(e) = make_backup(&app, &store, BackupKind::Regular) {
                        log::error!("automatic backup failed: {e}");
                    }
                }
                Ok(_) => {}
                Err(e) => log::error!("no backup folder: {e}"),
            }
            std::thread::sleep(AUTO_BACKUP_RECHECK);
        }
    });
    if let Err(e) = spawned {
        log::error!("could not start the automatic backup: {e}");
    }
}

/// What the start-up dialog says when the logbook cannot be opened.
pub fn store_error_text(e: &StoreError, db: &Path, backups: &Path, lang: Lang) -> String {
    let db = db.display();
    if lang == Lang::En {
        return store_error_text_en(e, &db.to_string(), backups);
    }
    match e {
        StoreError::NewerSchema { found, supported } => format!(
            "Dein Logbuch stammt von einer neueren VectaSim-Version (Datenformat v{found}, diese Version kennt bis v{supported}).\n\n\
             Installiere die aktuelle VectaSim-Version. Das Logbuch wurde nicht verändert.\n\nDatenbank: {db}"
        ),
        StoreError::Migration { from, to, message, backup } => format!(
            "Das Logbuch konnte nicht auf das neue Datenformat umgestellt werden (Schritt v{from} → v{to}). \
             Die Umstellung wurde zurückgenommen – deine Daten sind unverändert.\n\n\
             Datenbank: {db}\nSicherung vor der Umstellung: {}\n\nFehler: {message}\n\n\
             Bitte melde den Fehler mit der Protokolldatei an den Entwickler.",
            backup.as_ref().map(|b| b.display().to_string()).unwrap_or_else(|| "keine".into())
        ),
        StoreError::Backup { .. } => format!(
            "Vor der Umstellung des Logbuchs ließ sich keine Sicherung anlegen. VectaSim verändert die Datenbank deshalb nicht.\n\n\
             Prüfe den freien Speicherplatz und den Sicherungsordner.\n\nDatenbank: {db}\nSicherungsordner: {}\n\nFehler: {}",
            backups.display(),
            e.message(lang)
        ),
        other => format!("VectaSim kann das Logbuch nicht öffnen.\n\nDatenbank: {db}\n\nFehler: {}", other.message(lang)),
    }
}

fn store_error_text_en(e: &StoreError, db: &str, backups: &Path) -> String {
    match e {
        StoreError::NewerSchema { found, supported } => format!(
            "Your logbook comes from a newer VectaSim version (data format v{found}, this version knows up to v{supported}).\n\n\
             Install the current VectaSim version. The logbook was not changed.\n\nDatabase: {db}"
        ),
        StoreError::Migration { from, to, message, backup } => format!(
            "The logbook could not be converted to the new data format (step v{from} → v{to}). \
             The conversion was rolled back – your data is unchanged.\n\n\
             Database: {db}\nBackup before the conversion: {}\n\nError: {message}\n\n\
             Please report the error to the developer together with the log file.",
            backup.as_ref().map(|b| b.display().to_string()).unwrap_or_else(|| "none".into())
        ),
        StoreError::Backup { .. } => format!(
            "No backup could be written before converting the logbook, so VectaSim leaves the database unchanged.\n\n\
             Check the free disk space and the backup folder.\n\nDatabase: {db}\nBackup folder: {}\n\nError: {}",
            backups.display(),
            e.message(Lang::En)
        ),
        other => format!("VectaSim cannot open the logbook.\n\nDatabase: {db}\n\nError: {}", other.message(Lang::En)),
    }
}

/// The logbook did not open: hide the (empty) window, explain it in a native dialog and
/// quit cleanly. „Ordner öffnen“ shows the database (or the backup) in the Explorer.
pub fn report_store_error(app: &AppHandle, e: &StoreError, db: &Path, backups: &Path) {
    log::error!("logbook could not be opened ({}): {e}", db.display());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    let lang = crate::lang::current();
    let text = store_error_text(e, db, backups, lang);
    let reveal = e.backup_path().map(Path::to_path_buf).unwrap_or_else(|| db.to_path_buf());
    let app = app.clone();
    // not on the main thread: the dialog needs the event loop, which runs once setup returns
    std::thread::spawn(move || {
        let open_folder = app
            .dialog()
            .message(text)
            .title(lang.tr("VectaSim – Logbuch nicht geöffnet", "VectaSim – logbook not opened"))
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(lang.tr("Ordner öffnen", "Open folder").into(), lang.tr("Beenden", "Quit").into()))
            .blocking_show();
        if open_folder {
            let _ = app.opener().reveal_item_in_dir(&reveal);
        }
        app.exit(1);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_recording_flight_cannot_be_deleted() {
        let ids = ["a", "b"];
        assert!(refuse_recording_flight(Some("b"), ids.iter().copied()).is_err());
        assert!(refuse_recording_flight(Some("c"), ids.iter().copied()).is_ok());
        assert!(refuse_recording_flight(None, ids.iter().copied()).is_ok());
        assert!(refuse_recording_flight(Some("a"), std::iter::empty()).is_ok());
    }

    #[test]
    fn write_paths_are_checked() {
        const EXPORT_EXTENSIONS: &[&str] = &["csv", "gpx", "kml", "json"];
        let forbidden = [PathBuf::from(r"C:\Windows"), PathBuf::from(r"C:\Program Files"), PathBuf::from(r"C:\Users\p\AppData\Local\VectaSim")];
        let ok = |p: &str, ext: &[&str]| check_path(p, ext, &forbidden);
        assert_eq!(ok(r"C:\Users\p\Desktop\Flug.GPX", EXPORT_EXTENSIONS).unwrap(), PathBuf::from(r"C:\Users\p\Desktop\Flug.GPX"));
        assert!(ok(r"D:\Backups\VectaSim-Export_2026-10-18.vectasim", BUNDLE_EXTENSIONS).is_ok());
        assert!(ok(r"\\nas\share\karte.png", IMAGE_EXTENSIONS).is_ok());
        assert!(ok(r"C:\Program Files Extra\x.zip", DIAG_EXTENSIONS).is_ok(), "only the folder itself, not a name prefix");
        for (p, ext) in [
            ("", EXPORT_EXTENSIONS),
            (r"Flug.gpx", EXPORT_EXTENSIONS),
            (r"..\Flug.gpx", EXPORT_EXTENSIONS),
            (r"C:\Users\p\..\..\Windows\Flug.gpx", EXPORT_EXTENSIONS),
            (r"C:\Users\p\Desktop\Flug.exe", EXPORT_EXTENSIONS),
            (r"C:\Users\p\Desktop\Flug", EXPORT_EXTENSIONS),
            (r"C:\Users\p\Desktop\karte.jpg", IMAGE_EXTENSIONS),
            (r"C:\Users\p\Desktop\diag.vectasim", DIAG_EXTENSIONS),
            (r"C:\Users\p\Desktop\.vectasim", BUNDLE_EXTENSIONS),
            (r"C:\WINDOWS\System32\x.csv", EXPORT_EXTENSIONS),
            (r"c:/windows/x.csv", EXPORT_EXTENSIONS),
            (r"\\?\C:\Windows\x.csv", EXPORT_EXTENSIONS),
            (r"C:\Program Files\VectaSim\x.json", EXPORT_EXTENSIONS),
            (r"C:\Users\p\AppData\Local\VectaSim\vectasim.png", IMAGE_EXTENSIONS),
        ] {
            let e = ok(p, ext).expect_err(p);
            assert!(e.starts_with("Pfad nicht erlaubt"), "{p}: {e}");
        }
        // the real roots of this machine contain Windows
        if let Some(win) = std::env::var_os("WINDIR") {
            let p = PathBuf::from(win).join("vectasim.csv");
            assert!(allowed_target(&p.display().to_string(), EXPORT_EXTENSIONS).is_err());
        }
    }

    #[test]
    fn csv_paths_are_checked() {
        assert!(check_path(r"C:\Users\p\Downloads\volanta.CSV", CSV_EXTENSIONS, &[]).is_ok());
        assert!(check_path(r"D:\stkp-logbook.txt", CSV_EXTENSIONS, &[]).is_ok());
        for p in [r"volanta.csv", r"C:\Users\p\..\x.csv", r"C:\Users\p\logbook.xlsx", r"C:\Users\p\logbook"] {
            assert!(read_csv_file(p).unwrap_err().starts_with("Pfad nicht erlaubt"), "{p}");
        }
        let dir = std::env::temp_dir().join(format!("vs-csv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("ok.csv");
        std::fs::write(&f, b"dep,arr\nEDDF,EDDM\n").unwrap();
        let (bytes, stem) = read_csv_file(&f.display().to_string()).unwrap();
        assert_eq!((bytes.len(), stem.as_str()), (18, "ok"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_texts_name_database_and_backup() {
        let db = Path::new(r"C:\Users\p\AppData\Roaming\io.vectasim.app\vectasim.db");
        let dir = Path::new(r"C:\b");
        let t = store_error_text(&StoreError::NewerSchema { found: 11, supported: 10 }, db, dir, Lang::De);
        assert!(t.contains("v11") && t.contains("v10") && t.contains("vectasim.db") && t.contains("nicht verändert"), "{t}");
        let e = StoreError::Migration { from: 9, to: 10, message: "duplicate column".into(), backup: Some(PathBuf::from(r"C:\b\vectasim-pre-v9-x.db")) };
        let t = store_error_text(&e, db, dir, Lang::De);
        assert!(t.contains("v9 → v10") && t.contains("vectasim-pre-v9-x.db") && t.contains("duplicate column"), "{t}");
        let e = StoreError::Backup { step: vectasim_store::BackupStep::Copy, dir: PathBuf::from(r"C:\b"), detail: "disk full".into() };
        let t = store_error_text(&e, db, dir, Lang::De);
        assert!(t.contains(r"C:\b") && t.contains("disk full") && t.contains("Kopie fehlgeschlagen"), "{t}");
        let t = store_error_text(&e, db, dir, Lang::En);
        assert!(t.starts_with("No backup could be written") && t.contains("copy failed") && t.contains("disk full"), "{t}");
        let t = store_error_text(&StoreError::NewerSchema { found: 11, supported: 10 }, db, dir, Lang::En);
        assert!(t.contains("newer VectaSim version") && t.contains("v11") && t.contains("vectasim.db"), "{t}");
    }
}
