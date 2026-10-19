//! Gesamtexport/-import: the whole logbook as one `.vectasim` file (a ZIP), to move to another
//! PC or to merge two PCs.
//!
//! Layout (format [`BUNDLE_FORMAT`]):
//! * `manifest.json` – format, app version, schema version, counts, creation time.
//! * `flights.jsonl` – one JSON object per line and flight: `flight` (every column of the
//!   `flights` row by name, `deleted_ms` included), `touchdowns` and `phaseEvents` (their rows
//!   without the local `id`/`flight_id`), `track` (file names, sample count, codec).
//! * `tracks/<flight_id>.bin` / `tracks/<flight_id>.preview.bin` – the raw blobs as stored in
//!   the database (zstd, codec named by `track.encoding`, today `vstk1`).
//! * `airframes.jsonl` – one airframe row per line (`airframe`), `imageFile` for own pictures.
//! * `images/<registration>.<ext>` – pictures the user picked (`image_source = 'user'`).
//! * `runways.jsonl` – one remembered runway per line (`runway`: the `user_runways` row,
//!   `landings`: its `user_runway_landings` rows without airport/ident). Merge: a runway the
//!   pilot set wins over a derived one (two set ones: the newer edit); two derived ones are
//!   averaged weighted by their landings (landings already counted here count once).
//!
//! Rows are written column by column under their SQL names, so a bundle of an older or newer
//! schema still imports: unknown columns are ignored, missing ones get their defaults. The
//! cached analysis (`landing_facts`, `approach_facts`) is not part of it; the app recomputes it.
//!
//! Import never extracts by entry name (only the names above are read, each with a size cap),
//! so a crafted archive cannot write outside the logbook.

use crate::backup::{BackupKind, stamp};
use crate::store::SCHEMA_VERSION;
use crate::track::decode_track;
use crate::error::path_text;
use crate::{Invalid, Result, Store, StoreError};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, Write};
use std::path::{Path, PathBuf};
use vectasim_core::Lang;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

/// Version of the bundle layout; a reader refuses a higher one.
pub const BUNDLE_FORMAT: u32 = 1;
/// File extension (without the dot).
pub const BUNDLE_EXTENSION: &str = "vectasim";
/// Track codec this build reads (`tracks.encoding`).
pub const TRACK_ENCODING: &str = "vstk1";
/// Two flights with the same route whose off-block times are closer than this are one flight.
pub const DUPLICATE_WINDOW_MS: i64 = 15 * 60 * 1000;
/// Flights per transaction when merging.
const MERGE_BATCH: usize = 100;

const MANIFEST: &str = "manifest.json";
const FLIGHTS: &str = "flights.jsonl";
const AIRFRAMES: &str = "airframes.jsonl";
const RUNWAYS: &str = "runways.jsonl";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_JSONL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TRACK_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
const SOURCE_USER: &str = "user";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub format: u32,
    pub app: String,
    pub app_version: String,
    pub schema_version: i64,
    pub created_ms: u64,
    /// `yyyyMMdd-HHmmss` (UTC) of `created_ms`, for people reading the file.
    pub created_utc: String,
    pub flights: u64,
    /// Of `flights`, how many were in the Papierkorb.
    pub flights_deleted: u64,
    pub tracks: u64,
    pub airframes: u64,
    pub images: u64,
    pub track_encoding: String,
    /// Remembered runways (`user_runways`); 0 in bundles written before they existed.
    #[serde(default)]
    pub runways: u64,
}

/// What [`Store::export_bundle`] puts in.
#[derive(Clone, Debug, Default)]
pub struct ExportOptions {
    /// Flights in the Papierkorb too (with their `deleted_ms`).
    pub include_deleted: bool,
    /// Demo and replay flights (providers `mock`/`replay`); the app leaves them out.
    pub include_demo: bool,
    /// Written into the manifest.
    pub app_version: String,
    /// Language of the warnings in the report.
    pub lang: Lang,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub bytes: u64,
    pub manifest: BundleManifest,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    /// Add what is new; flights already there (same id, or same route within 15 min of
    /// off-block) are skipped, airframes only get their empty fields filled. A flight with
    /// the same id gets the pilot's notes, tags, rating and corrections where it has none.
    Merge,
    /// Backup first, then every flight and airframe is replaced by the bundle's.
    Replace,
}

/// Where [`Store::import_bundle`] puts pictures and its safety copy.
#[derive(Clone, Debug)]
pub struct ImportOptions {
    pub mode: ImportMode,
    /// The app's folder for own airframe pictures; `None` skips them (with a warning).
    pub images_dir: Option<PathBuf>,
    /// Backup folder for the `pre-import` copy (required for [`ImportMode::Replace`]).
    pub backup_dir: Option<PathBuf>,
    /// Language of the warnings in the report.
    pub lang: Lang,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Flights in the bundle.
    pub flights_in_bundle: u64,
    pub flights_added: u64,
    /// Same id or same route within 15 min of off-block (Merge only).
    pub flights_skipped_duplicate: u64,
    /// Skipped flights (same id) that got notes, tags, rating or corrections from the bundle.
    #[serde(default)]
    pub flights_user_filled: u64,
    pub airframes_added: u64,
    /// Existing airframes that got empty fields (or a picture) from the bundle.
    pub airframes_updated: u64,
    pub images_added: u64,
    /// Remembered runways new in this logbook.
    #[serde(default)]
    pub runways_added: u64,
    /// Remembered runways here that the bundle replaced (set by the pilot) or refined (derived).
    #[serde(default)]
    pub runways_updated: u64,
    pub warnings: Vec<String>,
    /// The copy of the logbook made before a Replace.
    pub backup: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackRef {
    file: String,
    #[serde(default)]
    preview_file: Option<String>,
    sample_count: i64,
    encoding: String,
    updated_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlightLine {
    flight: Map<String, Value>,
    #[serde(default)]
    touchdowns: Vec<Map<String, Value>>,
    #[serde(default)]
    phase_events: Vec<Map<String, Value>>,
    #[serde(default)]
    track: Option<TrackRef>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AirframeLine {
    airframe: Map<String, Value>,
    #[serde(default)]
    image_file: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunwayLine {
    runway: Map<String, Value>,
    /// `user_runway_landings` rows of this runway: `flight_id`, `touchdown_index`, `added_ms`.
    #[serde(default)]
    landings: Vec<Map<String, Value>>,
}

fn invalid(i: Invalid) -> StoreError {
    StoreError::Invalid(i)
}

// ---- values -------------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn sql_to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$hex": hex(b) }),
    }
}

fn json_to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => n.as_f64().map_or(SqlValue::Null, SqlValue::Real),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) => match o.get("$hex").and_then(Value::as_str).and_then(unhex) {
            Some(b) => SqlValue::Blob(b),
            None => SqlValue::Text(v.to_string()),
        },
        Value::Array(_) => SqlValue::Text(v.to_string()),
    }
}

/// Every row of `sql` as `{column: value}`.
fn dump_rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt.query_map(args, |r| {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), sql_to_json(r.get_ref(i)?));
        }
        Ok(m)
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn columns_of(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Insert `row` into `table`: only columns the table has (minus `skip`), `extra` on top.
fn insert_row(
    tx: &Transaction<'_>,
    table: &str,
    cols: &HashSet<String>,
    row: &Map<String, Value>,
    skip: &[&str],
    extra: &[(&str, SqlValue)],
) -> Result<()> {
    let mut names: Vec<&str> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    for (k, v) in row {
        if cols.contains(k) && !skip.contains(&k.as_str()) && !extra.iter().any(|(e, _)| e == k) {
            names.push(k);
            values.push(json_to_sql(v));
        }
    }
    for (k, v) in extra {
        names.push(k);
        values.push(v.clone());
    }
    let placeholders = (1..=names.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let quoted = names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ");
    let mut stmt = tx.prepare_cached(&format!("INSERT INTO {table} ({quoted}) VALUES ({placeholders})"))?;
    stmt.execute(rusqlite::params_from_iter(values))?;
    Ok(())
}

fn str_of<'a>(m: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str)
}

fn i64_of(m: &Map<String, Value>, key: &str) -> Option<i64> {
    m.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn f64_of(m: &Map<String, Value>, key: &str) -> Option<f64> {
    m.get(key).and_then(Value::as_f64).filter(|v| v.is_finite())
}

// ---- export -------------------------------------------------------------------------------

fn zip_time(ms: u64) -> DateTime {
    let s = stamp(ms);
    let n = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<u16>().ok()).unwrap_or(0);
    DateTime::from_date_and_time(n(0, 4), n(4, 6) as u8, n(6, 8) as u8, n(9, 11) as u8, n(11, 13) as u8, n(13, 15) as u8)
        .unwrap_or_default()
}

/// The file name of an own picture inside the bundle (`images/D-AIBL.jpg`).
fn image_entry(reg: &str, ext: &str) -> Option<String> {
    let reg_ok = !reg.is_empty() && reg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    (reg_ok && IMAGE_EXTENSIONS.contains(&ext)).then(|| format!("images/{reg}.{ext}"))
}

fn extension_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default()
}

fn write_bundle<W: Write + Seek>(conn: &Connection, out: W, opts: &ExportOptions, now_ms: u64) -> Result<(BundleManifest, Vec<String>)> {
    let time = zip_time(now_ms);
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).last_modified_time(time).large_file(true);
    // tracks are zstd already, pictures are compressed formats
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).last_modified_time(time).large_file(true);
    let zerr = |e: zip::result::ZipError| StoreError::Io(std::io::Error::other(e));
    let mut zip = ZipWriter::new(out);
    let mut warnings = Vec::new();
    let lang = opts.lang;
    let mut m = BundleManifest {
        format: BUNDLE_FORMAT,
        app: "VectaSim".into(),
        app_version: opts.app_version.clone(),
        schema_version: crate::store::file_schema_version(conn)?,
        created_ms: now_ms,
        created_utc: stamp(now_ms),
        flights: 0,
        flights_deleted: 0,
        tracks: 0,
        airframes: 0,
        images: 0,
        track_encoding: TRACK_ENCODING.into(),
        runways: 0,
    };

    let mut cond = Vec::new();
    if !opts.include_deleted {
        cond.push("deleted_ms IS NULL");
    }
    if !opts.include_demo {
        cond.push("COALESCE(provider, '') NOT IN ('mock', 'replay')");
    }
    let filter = if cond.is_empty() { String::new() } else { format!("WHERE {}", cond.join(" AND ")) };
    let flights = dump_rows(conn, &format!("SELECT * FROM flights {filter} ORDER BY COALESCE(off_block_ms, created_ms), id"), [])?;

    zip.start_file(FLIGHTS, deflate).map_err(zerr)?;
    let mut tracks: Vec<(String, String, String)> = Vec::new();
    for flight in flights {
        let Some(id) = str_of(&flight, "id").map(str::to_owned) else { continue };
        if flight.get("deleted_ms").is_some_and(|v| !v.is_null()) {
            m.flights_deleted += 1;
        }
        let touchdowns = dump_rows(conn, "SELECT * FROM touchdowns WHERE flight_id = ?1 ORDER BY timestamp_ms, id", params![id])?
            .into_iter()
            .map(|mut r| {
                r.remove("id");
                r.remove("flight_id");
                r
            })
            .collect();
        let phase_events = dump_rows(conn, "SELECT * FROM phase_events WHERE flight_id = ?1 ORDER BY timestamp_ms, id", params![id])?
            .into_iter()
            .map(|mut r| {
                r.remove("id");
                r.remove("flight_id");
                r
            })
            .collect();
        let track = conn
            .query_row("SELECT sample_count, encoding, updated_ms FROM tracks WHERE flight_id = ?1", params![id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })
            .optional()?
            .map(|(sample_count, encoding, updated_ms)| {
                // ids are UUIDs; anything else gets a neutral entry name
                let safe = id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
                let stem = if safe { id.clone() } else { format!("flight-{}", tracks.len()) };
                let t = TrackRef {
                    file: format!("tracks/{stem}.bin"),
                    preview_file: Some(format!("tracks/{stem}.preview.bin")),
                    sample_count,
                    encoding,
                    updated_ms,
                };
                tracks.push((id.clone(), t.file.clone(), t.preview_file.clone().unwrap_or_default()));
                t
            });
        let line = FlightLine { flight, touchdowns, phase_events, track };
        serde_json::to_writer(&mut zip, &line)?;
        zip.write_all(b"\n")?;
        m.flights += 1;
    }

    for (id, file, preview) in &tracks {
        let (data, prev): (Vec<u8>, Vec<u8>) =
            conn.query_row("SELECT data, preview FROM tracks WHERE flight_id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        zip.start_file(file.as_str(), stored).map_err(zerr)?;
        zip.write_all(&data)?;
        zip.start_file(preview.as_str(), stored).map_err(zerr)?;
        zip.write_all(&prev)?;
        m.tracks += 1;
    }

    let airframes = dump_rows(conn, "SELECT * FROM airframes ORDER BY registration", [])?;
    let mut images: Vec<(String, PathBuf)> = Vec::new();
    zip.start_file(AIRFRAMES, deflate).map_err(zerr)?;
    for airframe in airframes {
        let reg = str_of(&airframe, "registration").unwrap_or_default().to_string();
        let mut image_file = None;
        if str_of(&airframe, "image_source") == Some(SOURCE_USER)
            && let Some(url) = str_of(&airframe, "image_url")
        {
            let p = PathBuf::from(url);
            match image_entry(&reg, &extension_of(&p)) {
                Some(entry) if p.is_file() => {
                    images.push((entry.clone(), p));
                    image_file = Some(entry);
                }
                _ => warnings.push(ltr!(lang, "Bild von {reg} nicht gefunden: {url}", "Picture of {reg} not found: {url}")),
            }
        }
        serde_json::to_writer(&mut zip, &AirframeLine { airframe, image_file })?;
        zip.write_all(b"\n")?;
        m.airframes += 1;
    }
    for (entry, path) in images {
        match std::fs::read(&path) {
            Ok(bytes) => {
                zip.start_file(entry.as_str(), stored).map_err(zerr)?;
                zip.write_all(&bytes)?;
                m.images += 1;
            }
            Err(e) => warnings.push(ltr!(lang, "Bild {} nicht lesbar: {e}", "Picture {} unreadable: {e}", path.display())),
        }
    }

    let runways = dump_rows(conn, "SELECT * FROM user_runways ORDER BY airport_icao, ident", [])?;
    zip.start_file(RUNWAYS, deflate).map_err(zerr)?;
    for runway in runways {
        let (icao, ident) = (str_of(&runway, "airport_icao").unwrap_or_default(), str_of(&runway, "ident").unwrap_or_default());
        let landings = dump_rows(
            conn,
            "SELECT flight_id, touchdown_index, added_ms FROM user_runway_landings WHERE airport_icao = ?1 AND ident = ?2
             ORDER BY flight_id, touchdown_index",
            params![icao, ident],
        )?;
        serde_json::to_writer(&mut zip, &RunwayLine { runway, landings })?;
        zip.write_all(b"\n")?;
        m.runways += 1;
    }

    zip.start_file(MANIFEST, deflate).map_err(zerr)?;
    zip.write_all(&serde_json::to_vec_pretty(&m)?)?;
    zip.finish().map_err(zerr)?;
    Ok((m, warnings))
}

// ---- import -------------------------------------------------------------------------------

fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str, limit: u64) -> Result<Option<Vec<u8>>> {
    let mut f = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(invalid(Invalid::BundleEntry { entry: name.to_string(), detail: e.to_string() })),
    };
    if f.size() > limit {
        return Err(invalid(Invalid::BundleEntryTooLarge { entry: name.to_string(), bytes: Some(f.size()) }));
    }
    let mut buf = Vec::with_capacity(f.size() as usize);
    // the header can lie; never read more than the limit
    (&mut f).take(limit + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > limit {
        return Err(invalid(Invalid::BundleEntryTooLarge { entry: name.to_string(), bytes: None }));
    }
    Ok(Some(buf))
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(bytes: &[u8], name: &str) -> Result<Vec<T>> {
    let mut out = Vec::new();
    for (i, line) in BufReader::new(bytes).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(&line).map_err(|e| invalid(Invalid::BundleLine { entry: name.to_string(), line: i + 1, detail: e.to_string() }))?);
    }
    Ok(out)
}

/// Everything of a bundle except the blobs, checked before anything is written.
struct Parsed {
    manifest: BundleManifest,
    flights: Vec<FlightLine>,
    airframes: Vec<AirframeLine>,
    runways: Vec<RunwayLine>,
}

fn parse_bundle<R: Read + Seek>(zip: &mut ZipArchive<R>, warnings: &mut Vec<String>, lang: Lang) -> Result<Parsed> {
    let manifest =
        read_entry(zip, MANIFEST, MAX_MANIFEST_BYTES)?.ok_or_else(|| invalid(Invalid::ManifestMissing))?;
    let manifest: BundleManifest = serde_json::from_slice(&manifest).map_err(|e| invalid(Invalid::ManifestUnreadable { detail: e.to_string() }))?;
    if manifest.format > BUNDLE_FORMAT {
        return Err(invalid(Invalid::BundleTooNew { format: manifest.format, supported: BUNDLE_FORMAT }));
    }
    if manifest.schema_version > SCHEMA_VERSION {
        warnings.push(ltr!(
            lang,
            "Export aus einer neueren VectaSim-Version (Datenformat v{}); Felder, die diese Version nicht kennt, werden übergangen.",
            "Export from a newer VectaSim version (data format v{}); fields this version does not know are skipped.",
            manifest.schema_version
        ));
    }
    let flights: Vec<FlightLine> = match read_entry(zip, FLIGHTS, MAX_JSONL_BYTES)? {
        Some(b) => read_jsonl(&b, FLIGHTS)?,
        None => Vec::new(),
    };
    let airframes: Vec<AirframeLine> = match read_entry(zip, AIRFRAMES, MAX_JSONL_BYTES)? {
        Some(b) => read_jsonl(&b, AIRFRAMES)?,
        None => Vec::new(),
    };
    let runways: Vec<RunwayLine> = match read_entry(zip, RUNWAYS, MAX_JSONL_BYTES)? {
        Some(b) => read_jsonl(&b, RUNWAYS)?,
        None => Vec::new(),
    };
    for (i, f) in flights.iter().enumerate() {
        if str_of(&f.flight, "id").is_none_or(str::is_empty) {
            return Err(invalid(Invalid::FlightWithoutId { entry: FLIGHTS.to_string(), line: i + 1 }));
        }
    }
    if flights.len() as u64 != manifest.flights {
        warnings.push(ltr!(
            lang,
            "manifest.json nennt {} Flüge, die Datei enthält {}",
            "manifest.json lists {} flights, the file contains {}",
            manifest.flights,
            flights.len()
        ));
    }
    Ok(Parsed { manifest, flights, airframes, runways })
}

/// A flight ready to insert: its line plus the checked track blobs.
struct Prepared {
    line: FlightLine,
    track: Option<(Vec<u8>, Vec<u8>)>,
}

fn prepare_track<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    line: &FlightLine,
    warnings: &mut Vec<String>,
    lang: Lang,
) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
    let Some(t) = &line.track else { return Ok(None) };
    let id = str_of(&line.flight, "id").unwrap_or_default();
    if t.encoding != TRACK_ENCODING {
        warnings.push(ltr!(lang, "Flug {id}: Track-Format {} unbekannt, Track übergangen", "Flight {id}: track format {} unknown, track skipped", t.encoding));
        return Ok(None);
    }
    let Some(data) = read_entry(zip, &t.file, MAX_TRACK_BYTES)? else {
        warnings.push(ltr!(lang, "Flug {id}: {} fehlt, Flug ohne Track übernommen", "Flight {id}: {} missing, flight imported without track", t.file));
        return Ok(None);
    };
    if let Err(e) = decode_track(&data) {
        warnings.push(ltr!(lang, "Flug {id}: Track beschädigt ({e}), Flug ohne Track übernommen", "Flight {id}: track damaged ({e}), flight imported without track"));
        return Ok(None);
    }
    let preview = match &t.preview_file {
        Some(p) => read_entry(zip, p, MAX_TRACK_BYTES)?.filter(|b| decode_track(b).is_ok()),
        None => None,
    };
    // no usable preview: the full track serves as one (just larger)
    let preview = preview.unwrap_or_else(|| data.clone());
    Ok(Some((data, preview)))
}

/// Same id, or the same route within [`DUPLICATE_WINDOW_MS`] of off-block (trash included).
fn is_duplicate(tx: &Transaction<'_>, f: &Map<String, Value>) -> Result<bool> {
    let id = str_of(f, "id").unwrap_or_default();
    let same_id: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM flights WHERE id = ?1)", params![id], |r| r.get(0))?;
    if same_id {
        return Ok(true);
    }
    let Some(off) = i64_of(f, "off_block_ms") else { return Ok(false) };
    route_near(tx, str_of(f, "dep_icao"), str_of(f, "arr_icao"), off)
}

/// A flight here (trash included) with this route and its off-block within
/// [`DUPLICATE_WINDOW_MS`] of `off_block_ms` (also used by the CSV import).
pub(crate) fn route_near(conn: &Connection, dep: Option<&str>, arr: Option<&str>, off_block_ms: i64) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM flights WHERE off_block_ms > ?1 AND off_block_ms < ?2 AND dep_icao IS ?3 AND arr_icao IS ?4)",
        params![off_block_ms - DUPLICATE_WINDOW_MS, off_block_ms + DUPLICATE_WINDOW_MS, dep, arr],
        |r| r.get(0),
    )?)
}

/// What the pilot adds to a flight (schema v14); a merge fills these on a flight kept here.
const USER_FLIGHT_COLS: &[&str] =
    &["notes", "tags", "user_callsign", "user_dep_icao", "user_arr_icao", "user_aircraft_title", "user_registration", "rating"];

/// The flight with the bundle row's id is here already: take the bundle's notes, tags, rating
/// and corrections where this one has none (its own values win). True if anything changed.
fn fill_user_fields(tx: &Transaction<'_>, cols: &Cols, f: &Map<String, Value>) -> Result<bool> {
    let id = str_of(f, "id").unwrap_or_default();
    let mut changed = false;
    for col in USER_FLIGHT_COLS.iter().filter(|c| cols.flights.contains(**c)) {
        let v = match f.get(*col) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) if s.trim().is_empty() => continue,
            Some(v) => json_to_sql(v),
        };
        changed |= tx.execute(
            &format!("UPDATE flights SET \"{col}\" = ?2 WHERE id = ?1 AND (\"{col}\" IS NULL OR \"{col}\" = '')"),
            params![id, v],
        )? > 0;
    }
    Ok(changed)
}

fn insert_flight(tx: &Transaction<'_>, cols: &Cols, p: &Prepared) -> Result<()> {
    let f = &p.line.flight;
    let id = str_of(f, "id").unwrap_or_default().to_string();
    // a flight recorded while exporting is not running here
    let state = match str_of(f, "state") {
        Some("active") | None => "interrupted",
        Some(s) => s,
    };
    insert_row(tx, "flights", &cols.flights, f, &[], &[("state", SqlValue::Text(state.into()))])?;
    let fid = [("flight_id", SqlValue::Text(id.clone()))];
    for t in &p.line.touchdowns {
        insert_row(tx, "touchdowns", &cols.touchdowns, t, &["id"], &fid)?;
    }
    for e in &p.line.phase_events {
        insert_row(tx, "phase_events", &cols.phase_events, e, &["id"], &fid)?;
    }
    if let (Some((data, preview)), Some(t)) = (&p.track, &p.line.track) {
        tx.execute(
            "INSERT INTO tracks (flight_id, sample_count, encoding, data, preview, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, t.sample_count, t.encoding, data, preview, t.updated_ms],
        )?;
    }
    Ok(())
}

struct Cols {
    flights: HashSet<String>,
    touchdowns: HashSet<String>,
    phase_events: HashSet<String>,
    airframes: HashSet<String>,
    user_runways: HashSet<String>,
}

/// An own picture from the bundle written to `images_dir` (`<REG with _>.<ext>`, other
/// extensions of the same airframe removed). Returns the new path.
fn write_image(images_dir: &Path, reg: &str, entry: &str, bytes: &[u8]) -> Result<PathBuf> {
    let ext = extension_of(Path::new(entry));
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(invalid(Invalid::NotAnImage { entry: entry.to_string() }));
    }
    std::fs::create_dir_all(images_dir)?;
    let stem = reg.replace('-', "_");
    for old in IMAGE_EXTENSIONS {
        let _ = std::fs::remove_file(images_dir.join(format!("{stem}.{old}")));
    }
    let dest = images_dir.join(format!("{stem}.{ext}"));
    std::fs::write(&dest, bytes)?;
    Ok(dest)
}

fn has_image(a: &Map<String, Value>) -> bool {
    str_of(a, "image_url").is_some_and(|u| !u.is_empty()) && str_of(a, "image_source") != Some("none")
}

/// Picture columns to set, and whether a picture file was written for them.
type ImageValues = (Vec<(&'static str, SqlValue)>, bool);

const IMAGE_COLS: &[&str] = &["image_url", "image_thumb_url", "image_credit", "image_link", "image_source", "image_fetched_ms"];
const FILLABLE_COLS: &[&str] = &["icao_type", "title", "airline", "custom_name", "notes"];

/// The bundle's picture fields for this PC: an own picture is copied into `images_dir`
/// (`None` if that is not possible – the row then gets no picture and the app looks one up).
fn image_values<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    line: &AirframeLine,
    images_dir: Option<&Path>,
    warnings: &mut Vec<String>,
    lang: Lang,
) -> Result<Option<ImageValues>> {
    let a = &line.airframe;
    let reg = str_of(a, "registration").unwrap_or_default();
    if !has_image(a) {
        return Ok(None);
    }
    let field = |k: &'static str| (k, a.get(k).map(json_to_sql).unwrap_or(SqlValue::Null));
    if str_of(a, "image_source") != Some(SOURCE_USER) {
        return Ok(Some((IMAGE_COLS.iter().copied().map(field).collect(), false)));
    }
    let Some(entry) = &line.image_file else {
        warnings.push(ltr!(lang, "Eigenes Bild von {reg} ist nicht in der Datei", "Own picture of {reg} is not in the file"));
        return Ok(None);
    };
    let Some(dir) = images_dir else {
        warnings.push(ltr!(lang, "Eigenes Bild von {reg} übergangen (kein Bildordner)", "Own picture of {reg} skipped (no picture folder)"));
        return Ok(None);
    };
    let Some(bytes) = read_entry(zip, entry, MAX_IMAGE_BYTES)? else {
        warnings.push(ltr!(lang, "Eigenes Bild von {reg} fehlt in der Datei ({entry})", "Own picture of {reg} missing from the file ({entry})"));
        return Ok(None);
    };
    let path = write_image(dir, reg, entry, &bytes)?.display().to_string();
    let mut v: Vec<(&'static str, SqlValue)> = IMAGE_COLS.iter().copied().map(field).collect();
    for (k, val) in v.iter_mut() {
        if *k == "image_url" || *k == "image_thumb_url" {
            *val = SqlValue::Text(path.clone());
        }
    }
    Ok(Some((v, true)))
}

fn import_airframes<R: Read + Seek>(
    tx: &Transaction<'_>,
    zip: &mut ZipArchive<R>,
    cols: &Cols,
    lines: &[AirframeLine],
    opts: &ImportOptions,
    report: &mut ImportReport,
) -> Result<()> {
    for line in lines {
        let a = &line.airframe;
        let Some(reg) = str_of(a, "registration").filter(|r| !r.is_empty()) else {
            report.warnings.push(opts.lang.tr("Flugzeug ohne Registrierung übergangen", "Aircraft without registration skipped").into());
            continue;
        };
        let existing = dump_rows(tx, "SELECT * FROM airframes WHERE registration = ?1", params![reg])?.into_iter().next();
        match existing {
            None => {
                let image = image_values(zip, line, opts.images_dir.as_deref(), &mut report.warnings, opts.lang)?;
                let extra: Vec<(&str, SqlValue)> = match &image {
                    Some((v, _)) => v.clone(),
                    // no picture here: cleared, so the app looks it up again
                    None => IMAGE_COLS.iter().map(|k| (*k, SqlValue::Null)).collect(),
                };
                insert_row(tx, "airframes", &cols.airframes, a, &[], &extra)?;
                report.airframes_added += 1;
                if image.is_some_and(|(_, file)| file) {
                    report.images_added += 1;
                }
            }
            Some(current) => {
                // fill what is empty here; never overwrite
                let mut changed = false;
                for k in FILLABLE_COLS {
                    let empty_here = str_of(&current, k).is_none_or(|s| s.trim().is_empty());
                    let theirs = str_of(a, k).filter(|s| !s.trim().is_empty());
                    if let (true, Some(v), true) = (empty_here, theirs, cols.airframes.contains(*k)) {
                        tx.execute(&format!("UPDATE airframes SET {k} = ?2 WHERE registration = ?1"), params![reg, v])?;
                        changed = true;
                    }
                }
                if !has_image(&current)
                    && let Some((values, file)) = image_values(zip, line, opts.images_dir.as_deref(), &mut report.warnings, opts.lang)?
                {
                    for (k, v) in values {
                        tx.execute(&format!("UPDATE airframes SET {k} = ?2 WHERE registration = ?1"), params![reg, v])?;
                    }
                    changed = true;
                    if file {
                        report.images_added += 1;
                    }
                }
                if changed {
                    report.airframes_updated += 1;
                }
            }
        }
    }
    Ok(())
}

// ---- remembered runways -------------------------------------------------------------------

/// Upper-case, trimmed key part, as the store keys `user_runways`.
fn runway_key(s: &str) -> String {
    s.trim().to_ascii_uppercase()
}

/// The fields of a `user_runways` row the merge looks at.
#[derive(Clone, Debug)]
struct RunwayGeo {
    lat_thr: f64,
    lon_thr: f64,
    lat_end: f64,
    lon_end: f64,
    user: bool,
    length_estimated: bool,
    uses: i64,
    updated_ms: i64,
}

impl RunwayGeo {
    fn of(m: &Map<String, Value>) -> Option<Self> {
        Some(Self {
            lat_thr: f64_of(m, "lat_thr").filter(|v| v.abs() <= 90.0)?,
            lon_thr: f64_of(m, "lon_thr").filter(|v| v.abs() <= 180.0)?,
            lat_end: f64_of(m, "lat_end").filter(|v| v.abs() <= 90.0)?,
            lon_end: f64_of(m, "lon_end").filter(|v| v.abs() <= 180.0)?,
            user: str_of(m, "source") == Some("user"),
            length_estimated: m.get("length_estimated").is_some_and(|v| v.as_bool().unwrap_or_else(|| v.as_i64().unwrap_or(0) != 0)),
            uses: i64_of(m, "uses").unwrap_or(0).max(0),
            updated_ms: i64_of(m, "updated_ms").unwrap_or(0),
        })
    }
}

/// After the runways of an airport changed: its cached landing facts (and the ones that matched
/// nothing) go, its approach facts are marked stale – as `Store::invalidate_runway_facts`.
fn invalidate_airport(tx: &Transaction<'_>, icao: &str) -> Result<()> {
    tx.execute("DELETE FROM landing_facts WHERE matched = 0 OR airport_icao = ?1", params![icao])?;
    tx.execute(
        "UPDATE approach_facts SET version = 0 WHERE flight_id IN (
            SELECT flight_id FROM approach_facts WHERE airport_icao IS NULL OR airport_icao = ?1)",
        params![icao],
    )?;
    Ok(())
}

/// Add the landings of a bundle runway that are not counted here; returns how many were new.
fn add_runway_landings(tx: &Transaction<'_>, icao: &str, ident: &str, landings: &[Map<String, Value>]) -> Result<i64> {
    let mut added = 0;
    for l in landings {
        let (Some(flight), Some(index)) = (str_of(l, "flight_id"), i64_of(l, "touchdown_index")) else { continue };
        added += tx.execute(
            "INSERT OR IGNORE INTO user_runway_landings (airport_icao, ident, flight_id, touchdown_index, added_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![icao, ident, flight, index, i64_of(l, "added_ms").unwrap_or(0)],
        )? as i64;
    }
    Ok(added)
}

/// Remembered runways of the bundle. New ones are taken as they are. Against one already here:
/// a runway the pilot set beats a derived one (two set ones: the newer edit wins); two derived
/// ones become their mean weighted by landings, where the bundle only weighs with the landings
/// not yet counted here (none new: unchanged). An end that is only a lower bound gives way to
/// a known one.
fn import_runways(tx: &Transaction<'_>, cols: &Cols, lines: &[RunwayLine], report: &mut ImportReport, lang: Lang) -> Result<()> {
    let mut touched: HashSet<String> = HashSet::new();
    for line in lines {
        let r = &line.runway;
        let icao = runway_key(str_of(r, "airport_icao").unwrap_or_default());
        let ident = runway_key(str_of(r, "ident").unwrap_or_default());
        let Some(theirs) = RunwayGeo::of(r).filter(|_| !icao.is_empty() && !ident.is_empty()) else {
            report.warnings.push(ltr!(lang, "Piste {icao} {ident} ohne gültige Koordinaten übergangen", "Runway {icao} {ident} without valid coordinates skipped"));
            continue;
        };
        let mine = dump_rows(tx, "SELECT * FROM user_runways WHERE airport_icao = ?1 AND ident = ?2", params![icao, ident])?.into_iter().next();
        let Some(mine) = mine.as_ref().and_then(RunwayGeo::of) else {
            if mine.is_some() {
                tx.execute("DELETE FROM user_runways WHERE airport_icao = ?1 AND ident = ?2", params![icao, ident])?;
            }
            let keys = [("airport_icao", SqlValue::Text(icao.clone())), ("ident", SqlValue::Text(ident.clone()))];
            insert_row(tx, "user_runways", &cols.user_runways, r, &[], &keys)?;
            add_runway_landings(tx, &icao, &ident, &line.landings)?;
            report.runways_added += 1;
            touched.insert(icao);
            continue;
        };
        let set_geometry = |g: &RunwayGeo, source: &str, uses: i64, width: Option<&Value>, elevation: Option<&Value>| -> Result<()> {
            tx.execute(
                "UPDATE user_runways SET lat_thr = ?3, lon_thr = ?4, lat_end = ?5, lon_end = ?6, source = ?7, length_estimated = ?8,
                    uses = ?9, updated_ms = MAX(updated_ms, ?10),
                    width_m = COALESCE(?11, width_m), elevation_ft = COALESCE(?12, elevation_ft)
                 WHERE airport_icao = ?1 AND ident = ?2",
                params![
                    icao,
                    ident,
                    g.lat_thr,
                    g.lon_thr,
                    g.lat_end,
                    g.lon_end,
                    source,
                    g.length_estimated,
                    uses,
                    g.updated_ms,
                    width.map(json_to_sql).unwrap_or(SqlValue::Null),
                    elevation.map(json_to_sql).unwrap_or(SqlValue::Null)
                ],
            )?;
            Ok(())
        };
        let changed = match (mine.user, theirs.user) {
            // the pilot's runway here stays unless the bundle has a newer one of the pilot's
            (true, false) => false,
            (true, true) => {
                let newer = theirs.updated_ms > mine.updated_ms;
                if newer {
                    set_geometry(&theirs, "user", mine.uses.max(theirs.uses), r.get("width_m"), r.get("elevation_ft"))?;
                }
                newer
            }
            (false, true) => {
                set_geometry(&theirs, "user", mine.uses, r.get("width_m"), r.get("elevation_ft"))?;
                true
            }
            (false, false) => {
                let new_landings = add_runway_landings(tx, &icao, &ident, &line.landings)?;
                let listed = line.landings.len() as i64;
                // landings the bundle counted but did not list (older rows) count as new too
                let weight = if listed == 0 { theirs.uses } else { new_landings + (theirs.uses - listed).max(0) };
                if weight > 0 {
                    let (wm, wt) = (mine.uses.max(1) as f64, weight as f64);
                    let mix = |a: f64, b: f64| (a * wm + b * wt) / (wm + wt);
                    let mut g = RunwayGeo {
                        lat_thr: mix(mine.lat_thr, theirs.lat_thr),
                        lon_thr: mix(mine.lon_thr, theirs.lon_thr),
                        lat_end: mix(mine.lat_end, theirs.lat_end),
                        lon_end: mix(mine.lon_end, theirs.lon_end),
                        length_estimated: mine.length_estimated && theirs.length_estimated,
                        ..theirs.clone()
                    };
                    // a known far end beats one that is only a lower bound
                    let known = match (mine.length_estimated, theirs.length_estimated) {
                        (false, true) => Some(&mine),
                        (true, false) => Some(&theirs),
                        _ => None,
                    };
                    if let Some(k) = known {
                        (g.lat_end, g.lon_end) = (k.lat_end, k.lon_end);
                    }
                    set_geometry(&g, "derived", mine.uses.max(1) + weight, None, None)?;
                }
                weight > 0
            }
        };
        if changed {
            report.runways_updated += 1;
            touched.insert(icao);
        }
    }
    for icao in touched {
        invalidate_airport(tx, &icao)?;
    }
    Ok(())
}

fn run_import(store: &Store, path: &Path, opts: &ImportOptions) -> Result<ImportReport> {
    let file = File::open(path).map_err(|e| invalid(Invalid::FileOpen { path: path_text(path), detail: e.to_string() }))?;
    let mut zip = ZipArchive::new(file).map_err(|e| invalid(Invalid::NotABundle { detail: e.to_string() }))?;
    let mut report = ImportReport::default();
    let parsed = parse_bundle(&mut zip, &mut report.warnings, opts.lang)?;
    report.flights_in_bundle = parsed.flights.len() as u64;
    log::info!(
        "import {} ({:?}): {} flights, {} airframes, exported by VectaSim {} (schema v{})",
        path.display(),
        opts.mode,
        parsed.flights.len(),
        parsed.airframes.len(),
        parsed.manifest.app_version,
        parsed.manifest.schema_version
    );

    if opts.mode == ImportMode::Replace {
        let dir = opts.backup_dir.as_deref().ok_or_else(|| invalid(Invalid::NoBackupDir))?;
        let saved = store.create_backup(dir, BackupKind::PreImport)?;
        report.backup = Some(saved.display().to_string());
    }

    // Replace: one transaction for everything – the old logbook goes only if the new one is
    // complete. Merge: batches, so the recorder is not held up for the whole file.
    let size = if opts.mode == ImportMode::Replace { usize::MAX } else { MERGE_BATCH };
    let mut flights = parsed.flights.into_iter().peekable();
    let mut first = true;
    while first || flights.peek().is_some() {
        let mut conn = store.conn();
        let tx = conn.transaction()?;
        let cols = Cols {
            flights: columns_of(&tx, "flights")?,
            touchdowns: columns_of(&tx, "touchdowns")?,
            phase_events: columns_of(&tx, "phase_events")?,
            airframes: columns_of(&tx, "airframes")?,
            user_runways: columns_of(&tx, "user_runways")?,
        };
        if first {
            if opts.mode == ImportMode::Replace {
                tx.execute("DELETE FROM flights", [])?;
                tx.execute("DELETE FROM airframes", [])?;
                tx.execute("DELETE FROM user_runways", [])?;
                tx.execute("DELETE FROM user_runway_landings", [])?;
            }
            import_airframes(&tx, &mut zip, &cols, &parsed.airframes, opts, &mut report)?;
            import_runways(&tx, &cols, &parsed.runways, &mut report, opts.lang)?;
            first = false;
        }
        for line in flights.by_ref().take(size) {
            if opts.mode == ImportMode::Merge && is_duplicate(&tx, &line.flight)? {
                report.flights_skipped_duplicate += 1;
                if fill_user_fields(&tx, &cols, &line.flight)? {
                    report.flights_user_filled += 1;
                }
                continue;
            }
            let track = prepare_track(&mut zip, &line, &mut report.warnings, opts.lang)?;
            let p = Prepared { line, track };
            insert_flight(&tx, &cols, &p)
                .map_err(|e| invalid(Invalid::FlightImport { flight_id: str_of(&p.line.flight, "id").unwrap_or_default().to_string(), source: Box::new(e) }))?;
            report.flights_added += 1;
        }
        tx.commit()?;
    }
    Ok(report)
}

impl Store {
    /// Write the whole logbook to `path` (a `.vectasim` ZIP, see the module docs). Written to
    /// `<path>.partial` and renamed when complete. Reads through its own read-only connection
    /// in one read transaction, so the copy is consistent and the recorder keeps writing.
    pub fn export_bundle(&self, path: &Path, opts: &ExportOptions) -> Result<ExportReport> {
        self.export_bundle_at(path, opts, vectasim_core::now_ms())
    }

    /// [`Store::export_bundle`] with an explicit time (tests).
    pub fn export_bundle_at(&self, path: &Path, opts: &ExportOptions, now_ms: u64) -> Result<ExportReport> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(".partial");
        let partial = path.with_file_name(name);
        let separate = self
            .path()
            .and_then(|p| Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok());
        let written = (|| -> Result<(BundleManifest, Vec<String>)> {
            let out = File::create(&partial)?;
            match &separate {
                Some(conn) => {
                    conn.busy_timeout(std::time::Duration::from_secs(5))?;
                    conn.execute_batch("BEGIN")?;
                    let r = write_bundle(conn, out, opts, now_ms);
                    let _ = conn.execute_batch("COMMIT");
                    r
                }
                None => write_bundle(&self.conn(), out, opts, now_ms),
            }
        })();
        let (manifest, warnings) = match written {
            Ok(w) => w,
            Err(e) => {
                let _ = std::fs::remove_file(&partial);
                return Err(e);
            }
        };
        std::fs::rename(&partial, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&partial);
        })?;
        let bytes = std::fs::metadata(path)?.len();
        Ok(ExportReport { path: path.display().to_string(), bytes, manifest, warnings })
    }

    /// Read a `.vectasim` file into the logbook (see [`ImportMode`]). The whole file is checked
    /// before anything is written. Replace runs in one transaction after a `pre-import` backup;
    /// Merge commits in batches of 100 flights – an error rolls back the running batch, and
    /// importing the same file again skips what already came in.
    pub fn import_bundle(&self, path: &Path, opts: &ImportOptions) -> Result<ImportReport> {
        run_import(self, path, opts)
    }
}

/// The manifest of a bundle, without importing it (for a preview in the UI).
pub fn read_manifest(path: &Path) -> Result<BundleManifest> {
    let file = File::open(path).map_err(|e| invalid(Invalid::FileOpen { path: path_text(path), detail: e.to_string() }))?;
    let mut zip = ZipArchive::new(file).map_err(|e| invalid(Invalid::NotABundle { detail: e.to_string() }))?;
    let bytes =
        read_entry(&mut zip, MANIFEST, MAX_MANIFEST_BYTES)?.ok_or_else(|| invalid(Invalid::ManifestMissing))?;
    serde_json::from_slice(&bytes).map_err(|e| invalid(Invalid::ManifestUnreadable { detail: e.to_string() }))
}

/// `VectaSim-Export_2026-10-18.vectasim` (local date from the UI is better; this is UTC).
pub fn default_file_name(now_ms: u64) -> String {
    let s = stamp(now_ms);
    format!("VectaSim-Export_{}-{}-{}.{BUNDLE_EXTENSION}", &s[0..4], &s[4..6], &s[6..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_roundtrip() {
        for v in [json!(null), json!(42), json!(-1.25), json!(0.0), json!("ÄÖÜ"), json!({ "$hex": "00ff10" })] {
            let back = match json_to_sql(&v) {
                SqlValue::Null => sql_to_json(ValueRef::Null),
                SqlValue::Integer(i) => sql_to_json(ValueRef::Integer(i)),
                SqlValue::Real(f) => sql_to_json(ValueRef::Real(f)),
                SqlValue::Text(t) => sql_to_json(ValueRef::Text(t.as_bytes())),
                SqlValue::Blob(b) => sql_to_json(ValueRef::Blob(&b)),
            };
            assert_eq!(back, v);
        }
        assert_eq!(unhex("0g"), None);
        assert_eq!(unhex("abc"), None);
    }

    #[test]
    fn image_entries_are_plain_names() {
        assert_eq!(image_entry("D-AIBL", "jpg").as_deref(), Some("images/D-AIBL.jpg"));
        assert_eq!(image_entry("../x", "jpg"), None);
        assert_eq!(image_entry("D-AIBL", "exe"), None);
    }

    #[test]
    fn default_name_has_the_date() {
        assert_eq!(default_file_name(1_792_307_109_000), "VectaSim-Export_2026-10-18.vectasim");
    }
}
