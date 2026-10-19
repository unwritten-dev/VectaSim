//! „Diagnosepaket erstellen“ (Einstellungen → Diagnose): one ZIP the user sends to the developer.
//!
//! Always: `logs/` (every `vectasim*.log*`), `settings.json` (SimBrief ID masked), `system.json`,
//! `db.json` (schema, counts, size, the last phase events), `README.txt` (in the backend language;
//! notes about skipped files in `HINWEISE.txt` / `NOTES.txt`). With the Debug-Modus also
//! `dumps/` (newest first, at most [`DUMP_BUDGET`] bytes; the running file is flushed and the RAM
//! ring written as a fresh `ring-*.vsdump` first) and `simconnect.json` (DLL search, connection,
//! raw diagnostics). Nothing is uploaded – the file goes where the save dialog says.
//! With the Streamer-Modus on, the JSON files, the logs and the notes have the Windows user
//! name removed from their paths (`privacy::mask_user_paths`); the dumps stay as recorded.

use crate::lang::Lang;
use crate::manager::ProviderManager;
use serde::Serialize;
use serde_json::{Value, json};
use std::fs::File;
use std::io::{self, Seek, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use vectasim_store::Store;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

/// Upper bound for `dumps/` (uncompressed file sizes; `.vsdump` is already zstd).
const DUMP_BUDGET: u64 = 200 * 1024 * 1024;
/// Phase events in `db.json` and the flights they are taken from.
const EVENT_LIMIT: u32 = 50;
const EVENT_FLIGHTS: u32 = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagPackageInfo {
    pub path: String,
    pub bytes: u64,
    /// Entry names in the ZIP, in order.
    pub files: Vec<String>,
}

/// Everything that goes into one package, collected before writing.
struct Sources {
    log_dir: Option<PathBuf>,
    /// `Some` only with the Debug-Modus.
    dumps_dir: Option<PathBuf>,
    settings: Value,
    system: Value,
    db: Value,
    simconnect: Option<Value>,
    /// Streamer-Modus: user names removed from paths in JSON, logs and notes.
    mask_paths: bool,
    /// Language of README and notes (file contents from logs/JSON stay as they are).
    lang: Lang,
}

/// Build the package at `target_path` (from the save dialog).
#[tauri::command]
pub async fn create_diag_package(target_path: String, app: AppHandle) -> Result<DiagPackageInfo, String> {
    if target_path.trim().is_empty() {
        return Err(crate::lang::tr("kein Speicherort gewählt", "no location chosen").into());
    }
    let target = crate::data::allowed_target(&target_path, crate::data::DIAG_EXTENSIONS)?;
    tauri::async_runtime::spawn_blocking(move || {
        let sources = collect(&app);
        let info = write_package(&target, &sources).map_err(|e| format!("{}: {e}", target.display()))?;
        log::info!("diagnostic package written: {} ({} bytes, {} files)", info.path, info.bytes, info.files.len());
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn collect(app: &AppHandle) -> Sources {
    let store = app.state::<Store>();
    let manager = app.state::<ProviderManager>();
    let debug = crate::debug_mode_on(&store);
    let mask_paths = crate::privacy::privacy_mode_on(&store);
    log::logger().flush();

    let dumps_dir = if debug {
        crate::dumps_dir(app).ok().inspect(|dir| {
            // the session file is flushed (its zstd frame stays open); the ring is a complete file
            manager.dump().flush();
            let ring = dir.join(format!("ring-{}.{}", vectasim_dump::file_stamp(vectasim_core::now_ms()), vectasim_dump::EXTENSION));
            match manager.dump().dump_ring(&ring) {
                Ok(lines) => log::info!("diagnostic package: raw ring saved to {} ({lines} lines)", ring.display()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => log::warn!("diagnostic package: raw ring not saved: {e}"),
            }
        })
    } else {
        None
    };

    let settings = settings_json(store.all_settings().unwrap_or_default());
    let status = manager.snapshot();
    let system = json!({
        "createdUtc": vectasim_dump::file_stamp(vectasim_core::now_ms()),
        "app": { "name": app.package_info().name, "version": app.package_info().version.to_string(), "tauri": tauri::VERSION },
        "debugMode": debug,
        "privacyMode": mask_paths,
        "logLevel": store.get_setting(crate::logging::SETTING_LOG_LEVEL).ok().flatten(),
        "rustLog": crate::logging::env_override(),
        "os": os_info(),
        "webview2": webview2_version(),
        "cpu": {
            "identifier": std::env::var("PROCESSOR_IDENTIFIER").ok(),
            "arch": std::env::consts::ARCH,
            "threads": std::thread::available_parallelism().map(|n| n.get()).ok(),
        },
        "simulator": { "provider": status.provider, "state": status.state, "name": status.sim_name, "version": status.sim_version },
        // VATSIM/IVAO feeds: on/off, source URL, age of the last download, last error
        "online": app.state::<crate::online::OnlineState>().summary().networks,
    });
    let db_path = app.path().app_data_dir().map(|d| d.join("vectasim.db")).ok();
    let db = db_json(&store, db_path.as_deref());
    let simconnect = debug.then(|| simconnect_json(&store, &manager));

    Sources { log_dir: app.path().app_log_dir().ok(), dumps_dir, settings, system, db, simconnect, mask_paths, lang: crate::lang::current() }
}

/// `simbrief_user` → first two characters + `***`; anything that looks like a secret → `***`.
fn mask_setting(key: &str, value: &str) -> String {
    let k = key.to_ascii_lowercase();
    if k == "simbrief_user" {
        if value.is_empty() {
            return String::new();
        }
        return format!("{}***", value.chars().take(2).collect::<String>());
    }
    if ["password", "secret", "token", "api_key", "apikey"].iter().any(|s| k.contains(s)) {
        return "***".into();
    }
    value.to_string()
}

fn settings_json(rows: Vec<(String, String)>) -> Value {
    Value::Object(rows.into_iter().map(|(k, v)| (k.clone(), Value::String(mask_setting(&k, &v)))).collect())
}

fn simconnect_json(store: &Store, manager: &ProviderManager) -> Value {
    let candidates: Vec<Value> = vectasim_simconnect::ffi::candidate_paths()
        .into_iter()
        .map(|p| json!({ "path": p.display().to_string(), "exists": p.is_absolute().then(|| p.is_file()) }))
        .collect();
    let status = manager.snapshot();
    json!({
        "settingDll": store.get_setting(crate::SETTING_SIMCONNECT_DLL).ok().flatten(),
        "envDll": std::env::var(crate::ENV_SIMCONNECT_DLL).ok(),
        "foundDll": crate::find_simconnect_dll().map(|p| p.display().to_string()),
        "searchedPaths": candidates,
        "status": { "provider": status.provider, "state": status.state, "detail": status.detail, "simName": status.sim_name,
                    "simVersion": status.sim_version, "frames": status.frames, "aircraft": status.aircraft },
        "diagnostics": manager.diagnostics(),
    })
}

/// Schema version, row counts, file size and the last phase events, over a read-only
/// connection (the app's own connection keeps recording meanwhile).
fn db_json(store: &Store, db_path: Option<&Path>) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("schemaVersion".into(), json!(store.schema_version().ok()));
    if let Some(p) = db_path {
        let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).ok();
        out.insert("path".into(), json!(p.display().to_string()));
        out.insert("bytes".into(), json!(size(p)));
        out.insert("walBytes".into(), json!(size(&p.with_extension("db-wal"))));
        match db_stats(p) {
            Ok(v) => {
                if let Value::Object(m) = v {
                    out.extend(m);
                }
            }
            Err(e) => {
                out.insert("error".into(), json!(e.to_string()));
            }
        }
    }
    Value::Object(out)
}

fn db_stats(path: &Path) -> rusqlite::Result<Value> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    let count = |sql: &str| -> Value { conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map_or_else(|e| json!(e.to_string()), |n| json!(n)) };
    let counts = json!({
        // the logbook without the Papierkorb; the trash is counted on its own
        "flights": count("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NULL"),
        "flightsDeleted": count("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NOT NULL"),
        "flightsCompleted": count("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NULL AND state = 'completed'"),
        "flightsInterrupted": count("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NULL AND state = 'interrupted'"),
        "flightsActive": count("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NULL AND state = 'active'"),
        "flightsDemo": count("SELECT COUNT(*) FROM flights WHERE deleted_ms IS NULL AND provider IN ('mock', 'replay')"),
        "touchdowns": count("SELECT COUNT(*) FROM touchdowns"),
        "phaseEvents": count("SELECT COUNT(*) FROM phase_events"),
        "tracks": count("SELECT COUNT(*) FROM tracks"),
        "airframes": count("SELECT COUNT(*) FROM airframes"),
        "approachFacts": count("SELECT COUNT(*) FROM approach_facts"),
        "landingFacts": count("SELECT COUNT(*) FROM landing_facts"),
    });

    let mut stmt = conn.prepare(
        "SELECT id, state, phase, provider, sim_name, dep_icao, arr_icao, aircraft_title, created_ms, off_block_ms, on_block_ms
         FROM flights ORDER BY created_ms DESC LIMIT ?1",
    )?;
    let flights: Vec<Value> = stmt
        .query_map([EVENT_FLIGHTS], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "state": r.get::<_, String>(1)?, "phase": r.get::<_, String>(2)?,
                "provider": r.get::<_, Option<String>>(3)?, "sim": r.get::<_, Option<String>>(4)?,
                "dep": r.get::<_, Option<String>>(5)?, "arr": r.get::<_, Option<String>>(6)?,
                "aircraft": r.get::<_, Option<String>>(7)?, "createdMs": r.get::<_, i64>(8)?,
                "offBlockMs": r.get::<_, Option<i64>>(9)?, "onBlockMs": r.get::<_, Option<i64>>(10)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(
        "SELECT flight_id, from_phase, to_phase, timestamp_ms FROM phase_events
         WHERE flight_id IN (SELECT id FROM flights ORDER BY created_ms DESC LIMIT ?1)
         ORDER BY timestamp_ms DESC, id DESC LIMIT ?2",
    )?;
    let events: Vec<Value> = stmt
        .query_map([EVENT_FLIGHTS, EVENT_LIMIT], |r| {
            let ms = r.get::<_, i64>(3)?;
            Ok(json!({
                "flightId": r.get::<_, String>(0)?, "from": r.get::<_, String>(1)?, "to": r.get::<_, String>(2)?,
                "timestampMs": ms, "utc": vectasim_dump::file_stamp(ms.max(0) as u64),
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({ "counts": counts, "recentFlights": flights, "recentPhaseEvents": events }))
}

/// Value of one `reg query` line (`    Name    REG_SZ    value`).
fn reg_value(output: &str, name: &str) -> Option<String> {
    output.lines().find_map(|l| {
        let mut parts = l.split_whitespace();
        if parts.next()? != name {
            return None;
        }
        let kind = parts.next()?;
        let rest = parts.collect::<Vec<_>>().join(" ");
        if kind == "REG_DWORD" {
            return u32::from_str_radix(rest.trim_start_matches("0x"), 16).ok().map(|v| v.to_string());
        }
        Some(rest)
    })
}

#[cfg(windows)]
fn reg_query(key: &str, value: Option<&str>) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", key]);
    if let Some(v) = value {
        cmd.args(["/v", v]);
    }
    let out = cmd.creation_flags(CREATE_NO_WINDOW).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(windows))]
fn reg_query(_key: &str, _value: Option<&str>) -> Option<String> {
    None
}

fn os_info() -> Value {
    let reg = reg_query(r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion", None).unwrap_or_default();
    let get = |n: &str| reg_value(&reg, n);
    let build = get("CurrentBuild");
    // ProductName still says "Windows 10" on Windows 11
    let family = build.as_deref().and_then(|b| b.parse::<u32>().ok()).map(|b| if b >= 22_000 { "Windows 11" } else { "Windows 10 oder älter" });
    json!({
        "family": family.unwrap_or(std::env::consts::OS),
        "productName": get("ProductName"),
        "edition": get("EditionID"),
        "displayVersion": get("DisplayVersion"),
        "build": build,
        "ubr": get("UBR"),
    })
}

/// Evergreen WebView2 runtime version (per machine or per user), if installed that way.
fn webview2_version() -> Option<String> {
    const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [format!(r"HKLM\SOFTWARE\WOW6432Node\{CLIENT}"), format!(r"HKLM\SOFTWARE\{CLIENT}"), format!(r"HKCU\SOFTWARE\{CLIENT}")]
        .iter()
        .find_map(|k| reg_query(k, Some("pv")).and_then(|o| reg_value(&o, "pv")).filter(|v| !v.is_empty() && v != "0.0.0.0"))
}

/// `vectasim.log` and its rotated siblings (`vectasim_<date>.log`, `.bak`).
fn log_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .filter(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                    name.starts_with(crate::logging::LOG_FILE_STEM) && name.contains(".log")
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// `.vsdump` files newest first, as long as their sizes add up to at most `budget`.
fn pick_dumps(dir: &Path, budget: u64) -> (Vec<PathBuf>, Vec<String>) {
    let mut all: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case(vectasim_dump::EXTENSION)))
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    m.is_file().then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    all.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.2.cmp(&a.2)));
    let (mut used, mut picked, mut skipped) = (0u64, Vec::new(), Vec::new());
    for (_, len, p) in all {
        if used + len <= budget {
            used += len;
            picked.push(p);
        } else {
            skipped.push(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        }
    }
    (picked, skipped)
}

/// ZIP timestamp for "now" (UTC; ZIP has no time zone).
fn zip_now() -> DateTime {
    let s = vectasim_dump::file_stamp(vectasim_core::now_ms()); // 20261017-140322Z
    let n = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<u16>().ok()).unwrap_or(0);
    DateTime::from_date_and_time(n(0, 4), n(4, 6) as u8, n(6, 8) as u8, n(9, 11) as u8, n(11, 13) as u8, n(13, 15) as u8).unwrap_or_default()
}

const README_DE: &str = "VectaSim – Diagnosepaket
========================

Dieses Paket hilft dem Entwickler, einen Fehler nachzuvollziehen. Bitte als Ganzes schicken
(z. B. an ein GitHub-Issue anhängen oder per Mail). VectaSim lädt nichts automatisch hoch.

Inhalt
------
logs/            Protokolldateien von VectaSim (vectasim.log und ältere Teile)
settings.json    Deine Einstellungen. Die SimBrief-Pilot-ID ist bis auf die ersten zwei Zeichen
                 unkenntlich gemacht.
system.json      App-Version, Windows-Version, WebView2-Version, Prozessor, Simulator-Version
db.json          Statistik des Logbuchs: Schema-Version, Anzahl Flüge/Aufsetzer/Flugzeuge,
                 Dateigröße und die letzten Phasenwechsel der letzten drei Flüge.
                 Das Logbuch selbst ist NICHT enthalten.

Nur bei eingeschaltetem Debug-Modus:
dumps/           Roh-Aufzeichnungen der Simulator-Daten (.vsdump), neueste zuerst, höchstens
                 200 MB. Damit lässt sich ein Flug ohne Simulator nachspielen.
simconnect.json  Welche SimConnect.dll geladen wurde, welche Pfade durchsucht wurden und der
                 letzte Verbindungsstand.

Datenschutz
-----------
Es sind keine Passwörter, Schlüssel oder Zugangsdaten enthalten – VectaSim speichert keine.
Dateipfade (z. B. C:\\Users\\<Name>\\...) können deinen Windows-Benutzernamen zeigen – außer im
Streamer-Modus (Einstellungen → Anzeige): dann ersetzt VectaSim ihn in den JSON-Dateien, den
Protokollen und HINWEISE.txt durch %USERPROFILE%, %LOCALAPPDATA% oder %APPDATA%. Die
Roh-Aufzeichnungen (dumps/) bleiben unverändert.
Die Roh-Aufzeichnungen enthalten Flugdaten (Position, Flugzeug, Kennung) wie im Logbuch.
";

const README_EN: &str = "VectaSim – diagnostic package
=============================

This package helps the developer to trace an error. Please send it as a whole
(e.g. attach it to a GitHub issue or send it by mail). VectaSim uploads nothing by itself.

Contents
--------
logs/            VectaSim's log files (vectasim.log and older parts)
settings.json    Your settings. The SimBrief pilot ID is made unrecognisable except for the
                 first two characters.
system.json      App version, Windows version, WebView2 version, processor, simulator version
db.json          Logbook statistics: schema version, number of flights/touchdowns/aircraft,
                 file size and the latest phase changes of the last three flights.
                 The logbook itself is NOT included.

Only with the debug mode on:
dumps/           Raw recordings of the simulator data (.vsdump), newest first, at most
                 200 MB. They let a flight be replayed without a simulator.
simconnect.json  Which SimConnect.dll was loaded, which paths were searched and the
                 latest connection state.

Privacy
-------
No passwords, keys or credentials are included – VectaSim stores none.
File paths (e.g. C:\\Users\\<name>\\...) can show your Windows user name – except in the
streamer mode (Settings → Display): then VectaSim replaces it in the JSON files, the logs and
NOTES.txt with %USERPROFILE%, %LOCALAPPDATA% or %APPDATA%. The raw recordings (dumps/) stay
unchanged.
The raw recordings contain flight data (position, aircraft, registration) as in the logbook.
";

/// Name of the notes file in the package.
fn notes_name(lang: Lang) -> &'static str {
    lang.tr("HINWEISE.txt", "NOTES.txt")
}

fn write_package(target: &Path, src: &Sources) -> io::Result<DiagPackageInfo> {
    if let Some(dir) = target.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let result = write_zip(File::create(target)?, src);
    match result {
        Ok(files) => {
            let bytes = std::fs::metadata(target)?.len();
            Ok(DiagPackageInfo { path: target.display().to_string(), bytes, files })
        }
        Err(e) => {
            let _ = std::fs::remove_file(target);
            Err(e)
        }
    }
}

fn write_zip<W: Write + Seek>(out: W, src: &Sources) -> io::Result<Vec<String>> {
    let now = zip_now();
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).last_modified_time(now).large_file(true);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).last_modified_time(now).large_file(true);
    let mut zip = ZipWriter::new(out);
    let mut files = Vec::new();

    let mut add_bytes = |zip: &mut ZipWriter<W>, name: &str, bytes: &[u8]| -> io::Result<()> {
        zip.start_file(name, deflate).map_err(io::Error::other)?;
        zip.write_all(bytes)?;
        files.push(name.to_string());
        Ok(())
    };
    let l = src.lang;
    let base = l.tr(README_DE, README_EN);
    let readme = if src.mask_paths {
        let masked = l.tr("In diesem Paket: Benutzername in Pfaden ausgeblendet (Streamer-Modus an).", "In this package: user name hidden in paths (streamer mode on).");
        format!("{base}\n{masked}\n")
    } else {
        base.to_string()
    };
    add_bytes(&mut zip, "README.txt", readme.replace('\n', "\r\n").as_bytes())?;
    let pretty = |v: &Value| {
        let mut v = v.clone();
        if src.mask_paths {
            crate::privacy::mask_json(&mut v);
        }
        serde_json::to_vec_pretty(&v).unwrap_or_default()
    };
    add_bytes(&mut zip, "settings.json", &pretty(&src.settings))?;
    add_bytes(&mut zip, "system.json", &pretty(&src.system))?;
    add_bytes(&mut zip, "db.json", &pretty(&src.db))?;
    if let Some(sc) = &src.simconnect {
        add_bytes(&mut zip, "simconnect.json", &pretty(sc))?;
    }

    let mut notes: Vec<String> = Vec::new();
    let mut add_file = |zip: &mut ZipWriter<W>, name: String, path: &Path, opts: SimpleFileOptions, mask_text: bool| -> io::Result<()> {
        // a log/dump can vanish (rotation) or be locked; the package goes on without it
        match File::open(path) {
            // a log with the Streamer-Modus: read, mask, write; everything else is streamed
            Ok(f) if mask_text => match io::read_to_string(f) {
                Ok(text) => {
                    zip.start_file(name.as_str(), opts).map_err(io::Error::other)?;
                    zip.write_all(crate::privacy::mask_user_paths(&text).as_bytes())?;
                    files.push(name);
                }
                Err(e) => notes.push(format!("{}: {e}", path.display())),
            },
            Ok(mut f) => {
                zip.start_file(name.as_str(), opts).map_err(io::Error::other)?;
                io::copy(&mut f, zip)?;
                files.push(name);
            }
            Err(e) => notes.push(format!("{}: {e}", path.display())),
        }
        Ok(())
    };
    if let Some(dir) = &src.log_dir {
        for p in log_files(dir) {
            let name = format!("logs/{}", p.file_name().unwrap_or_default().to_string_lossy());
            add_file(&mut zip, name, &p, deflate, src.mask_paths)?;
        }
    }
    if let Some(dir) = &src.dumps_dir {
        let (picked, skipped) = pick_dumps(dir, DUMP_BUDGET);
        for p in picked {
            let name = format!("dumps/{}", p.file_name().unwrap_or_default().to_string_lossy());
            add_file(&mut zip, name, &p, stored, false)?;
        }
        if !skipped.is_empty() {
            notes.push(format!("{}: {}", l.tr("nicht aufgenommen (über 200 MB)", "not included (over 200 MB)"), skipped.join(", ")));
        }
    }
    if !notes.is_empty() {
        zip.start_file(notes_name(l), deflate).map_err(io::Error::other)?;
        let text = notes.join("\r\n");
        let text = if src.mask_paths { crate::privacy::mask_user_paths(&text) } else { text };
        zip.write_all(text.as_bytes())?;
        files.push(notes_name(l).into());
    }
    zip.finish().map_err(io::Error::other)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vs-diagpack-{tag}-{}-{}", std::process::id(), vectasim_core::now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn masks_simbrief_id_and_secrets_only() {
        assert_eq!(mask_setting("simbrief_user", "123456"), "12***");
        assert_eq!(mask_setting("simbrief_user", "Ä"), "Ä***");
        assert_eq!(mask_setting("simbrief_user", ""), "");
        assert_eq!(mask_setting("simconnect_dll_path", r"C:\MSFS SDK\SimConnect.dll"), r"C:\MSFS SDK\SimConnect.dll");
        assert_eq!(mask_setting("some_api_key", "abc"), "***");
        // overlay server token (server.rs → SETTING_SERVER_TOKEN)
        assert_eq!(mask_setting(crate::server::SETTING_SERVER_TOKEN, "abc"), "***");
        assert_eq!(mask_setting("log_level", "debug"), "debug");
    }

    #[test]
    fn parses_reg_query_output() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    ProductName    REG_SZ    Windows 10 Pro\r\n    CurrentBuild    REG_SZ    26100\r\n    UBR    REG_DWORD    0x1a2b\r\n";
        assert_eq!(reg_value(out, "ProductName").as_deref(), Some("Windows 10 Pro"));
        assert_eq!(reg_value(out, "CurrentBuild").as_deref(), Some("26100"));
        assert_eq!(reg_value(out, "UBR").as_deref(), Some("6699"));
        assert_eq!(reg_value(out, "EditionID"), None);
    }

    #[test]
    fn dumps_newest_first_within_budget() {
        let dir = temp_dir("dumps");
        for (name, len) in [("a.vsdump", 40usize), ("b.vsdump", 50), ("c.vsdump", 30), ("x.txt", 10)] {
            std::fs::write(dir.join(name), vec![0u8; len]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (picked, skipped) = pick_dumps(&dir, 85);
        let names: Vec<_> = picked.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["c.vsdump", "b.vsdump"]);
        assert_eq!(skipped, ["a.vsdump"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_a_readable_zip() {
        let dir = temp_dir("zip");
        let logs = dir.join("logs");
        let dumps = dir.join("dumps");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::create_dir_all(&dumps).unwrap();
        std::fs::write(logs.join("vectasim.log"), "line 1\n").unwrap();
        std::fs::write(logs.join("vectasim_2026-10-17_12-00-00.log"), "old\n").unwrap();
        std::fs::write(logs.join("other.txt"), "no").unwrap();
        std::fs::write(dumps.join("20261017-140322Z.vsdump"), [1u8, 2, 3]).unwrap();
        let src = Sources {
            log_dir: Some(logs),
            dumps_dir: Some(dumps),
            settings: settings_json(vec![("simbrief_user".into(), "987654".into())]),
            system: json!({ "app": "test" }),
            db: json!({ "schemaVersion": 9 }),
            simconnect: Some(json!({ "foundDll": null })),
            mask_paths: false,
            lang: Lang::De,
        };
        let target = dir.join("out").join("VectaSim-Diagnose_test.zip");
        let info = write_package(&target, &src).unwrap();
        assert!(info.bytes > 0);
        assert_eq!(
            info.files,
            [
                "README.txt",
                "settings.json",
                "system.json",
                "db.json",
                "simconnect.json",
                "logs/vectasim.log",
                "logs/vectasim_2026-10-17_12-00-00.log",
                "dumps/20261017-140322Z.vsdump"
            ]
        );
        let mut zip = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let mut s = String::new();
        zip.by_name("settings.json").unwrap().read_to_string(&mut s).unwrap();
        assert!(s.contains("98***") && !s.contains("987654"), "{s}");
        let mut d = Vec::new();
        zip.by_name("dumps/20261017-140322Z.vsdump").unwrap().read_to_end(&mut d).unwrap();
        assert_eq!(d, [1, 2, 3]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn streamer_mode_masks_user_paths_in_json_and_logs() {
        let dir = temp_dir("mask");
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("vectasim.log"), r"db at C:\Users\Max\AppData\Roaming\io.vectasim.app\vectasim.db").unwrap();
        let src = Sources {
            log_dir: Some(logs),
            dumps_dir: None,
            settings: settings_json(vec![("backup_dir".into(), r"C:\Users\Max\Documents\Backups".into())]),
            system: json!({ "app": "test" }),
            db: json!({ "path": r"C:\Users\Max\AppData\Roaming\io.vectasim.app\vectasim.db" }),
            simconnect: None,
            mask_paths: true,
            lang: Lang::De,
        };
        let target = dir.join("pkg.zip");
        write_package(&target, &src).unwrap();
        let mut zip = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let mut read = |n: &str| {
            let mut s = String::new();
            zip.by_name(n).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        let [settings, db, log, readme] = ["settings.json", "db.json", "logs/vectasim.log", "README.txt"].map(&mut read);
        for s in [&settings, &db, &log] {
            assert!(!s.contains("Max"), "{s}");
        }
        // JSON escapes the backslashes
        assert!(settings.contains(r"%USERPROFILE%\\Documents\\Backups"), "{settings}");
        assert!(db.contains(r"%APPDATA%\\io.vectasim.app"), "{db}");
        assert_eq!(log, r"db at %APPDATA%\io.vectasim.app\vectasim.db");
        assert!(readme.contains("Streamer-Modus an"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn english_package_has_english_readme_and_notes() {
        let dir = temp_dir("en");
        let dumps = dir.join("dumps");
        std::fs::create_dir_all(&dumps).unwrap();
        std::fs::write(dumps.join("big.vsdump"), vec![0u8; 16]).unwrap();
        let src = Sources {
            log_dir: None,
            dumps_dir: Some(dumps),
            settings: json!({}),
            system: json!({}),
            db: json!({}),
            simconnect: None,
            mask_paths: true,
            lang: Lang::En,
        };
        let target = dir.join("pkg.zip");
        let info = write_package(&target, &src).unwrap();
        assert!(info.files.iter().any(|f| f == "README.txt"), "{:?}", info.files);
        let mut zip = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let mut readme = String::new();
        zip.by_name("README.txt").unwrap().read_to_string(&mut readme).unwrap();
        assert!(readme.starts_with("VectaSim – diagnostic package") && readme.contains("streamer mode on"), "{readme}");
        assert_eq!(notes_name(Lang::En), "NOTES.txt");
        assert_eq!(notes_name(Lang::De), "HINWEISE.txt");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn db_stats_on_a_fresh_logbook() {
        let dir = temp_dir("db");
        let path = dir.join("vectasim.db");
        let store = Store::open(&path).unwrap();
        let v = db_json(&store, Some(&path));
        assert_eq!(v["counts"]["flights"], json!(0));
        assert_eq!(v["counts"]["flightsDeleted"], json!(0));
        assert_eq!(v["counts"]["airframes"], json!(0));
        assert!(v["schemaVersion"].as_i64().unwrap() >= 9);
        assert_eq!(v["recentPhaseEvents"], json!([]));
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
