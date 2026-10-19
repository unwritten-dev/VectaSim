//! Logbook backups: consistent copies of the SQLite file, rotation, restore.
//!
//! * A copy is made with `VACUUM INTO` – a transactionally consistent snapshot that also
//!   contains what is still in the WAL, written while the app keeps running. It goes to
//!   `<name>.db.partial` first and is renamed when complete, so a crash never leaves a
//!   half-written file that looks like a backup.
//! * File names carry kind and time (UTC): `vectasim-<yyyyMMdd-HHmmss>.db` (daily / manual),
//!   `vectasim-pre-v<old>-<stamp>.db` (before a schema migration), `vectasim-pre-update-…`,
//!   `vectasim-pre-restore-…`, `vectasim-pre-wipe-…`, `vectasim-pre-import-…` (before an update,
//!   a restore, „Alle Daten löschen“, an import that replaces the logbook). Everything is derived from the name, there is no index file.
//! * No extra compression: the tracks – by far the largest part of a logbook – are already
//!   zstd-compressed blobs (see `track`), so compressing the copy again would save little and
//!   would make the backup unreadable for any SQLite tool. A backup is a plain `.db` file.
//! * Rotation keeps the newest copy of each of the last [`KEEP_DAILY`] days that have one,
//!   the newest [`KEEP_EVENT`] update/restore/wipe copies and every pre-migration copy.
//! * Restore never swaps the open file: [`Store::restore_from`] checks the backup, saves the
//!   current logbook, and stages the copy next to the database; [`apply_pending_restore`]
//!   puts it in place on the next open (the app restarts right after staging).

use crate::store::{SCHEMA_VERSION, file_schema_version};
use crate::error::path_text;
use crate::{BackupStep, Invalid, Result, Store, StoreError};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Setting with the backup folder; empty/missing = the app's default folder.
pub const SETTING_BACKUP_DIR: &str = "backup_dir";
/// Daily copies kept by [`rotate`].
pub const KEEP_DAILY: usize = 7;
/// Update/restore/wipe copies kept by [`rotate`].
pub const KEEP_EVENT: usize = 5;
/// The automatic backup runs when the newest copy is older than this.
pub const AUTO_BACKUP_INTERVAL_MS: u64 = 24 * 3600 * 1000;

const PREFIX: &str = "vectasim-";
const EXT: &str = ".db";

/// Why a copy was made (encoded in its file name).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupKind {
    /// Daily automatic or „Jetzt sichern“.
    Regular,
    /// Before migrating from this schema version.
    PreMigration(i64),
    PreUpdate,
    PreRestore,
    PreWipe,
    /// Before a replacing `.vectasim` import (mode Replace).
    PreImport,
}

impl BackupKind {
    fn tag(self) -> String {
        match self {
            BackupKind::Regular => String::new(),
            BackupKind::PreMigration(v) => format!("pre-v{v}-"),
            BackupKind::PreUpdate => "pre-update-".into(),
            BackupKind::PreRestore => "pre-restore-".into(),
            BackupKind::PreWipe => "pre-wipe-".into(),
            BackupKind::PreImport => "pre-import-".into(),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BackupKind::Regular => "regular",
            BackupKind::PreMigration(_) => "preMigration",
            BackupKind::PreUpdate => "preUpdate",
            BackupKind::PreRestore => "preRestore",
            BackupKind::PreWipe => "preWipe",
            BackupKind::PreImport => "preImport",
        }
    }
}

/// One backup file in the folder.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: String,
    pub file_name: String,
    /// regular | preMigration | preUpdate | preRestore | preWipe | preImport
    pub kind: String,
    /// Schema version the logbook had before the migration (pre-migration copies only).
    pub schema_from: Option<i64>,
    /// From the file name (UTC), epoch ms.
    pub created_ms: u64,
    pub bytes: u64,
}

/// What [`inspect`] found in a backup file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCheck {
    pub schema_version: i64,
    pub flights: u64,
}

// ---- names and times --------------------------------------------------------------------

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian (H. Hinnant).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `yyyyMMdd-HHmmss` (UTC) of an epoch-ms time.
pub fn stamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!("{y:04}{mo:02}{d:02}-{:02}{:02}{:02}", s / 3600, s % 3600 / 60, s % 60)
}

fn parse_stamp(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 15 || b[8] != b'-' || !s[..8].bytes().chain(s[9..].bytes()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(4..6)?, n(6..8)?, n(9..11)?, n(11..13)?, n(13..15)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let days = days_from_civil(i64::from(y), mo, d);
    let secs = days * 86_400 + i64::from(h * 3600 + mi * 60 + se);
    u64::try_from(secs).ok().map(|s| s * 1000)
}

/// File name of a backup of `kind` made at `ms`.
pub fn file_name(kind: BackupKind, ms: u64) -> String {
    format!("{PREFIX}{}{}{EXT}", kind.tag(), stamp(ms))
}

/// Kind and time of a backup file name; `None` for any other file.
pub fn parse_file_name(name: &str) -> Option<(BackupKind, u64)> {
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(EXT)?;
    let (kind, stamp) = if let Some(r) = rest.strip_prefix("pre-update-") {
        (BackupKind::PreUpdate, r)
    } else if let Some(r) = rest.strip_prefix("pre-restore-") {
        (BackupKind::PreRestore, r)
    } else if let Some(r) = rest.strip_prefix("pre-wipe-") {
        (BackupKind::PreWipe, r)
    } else if let Some(r) = rest.strip_prefix("pre-import-") {
        (BackupKind::PreImport, r)
    } else if let Some(r) = rest.strip_prefix("pre-v") {
        let (v, stamp) = r.split_once('-')?;
        (BackupKind::PreMigration(v.parse().ok()?), stamp)
    } else {
        (BackupKind::Regular, rest)
    };
    Some((kind, parse_stamp(stamp)?))
}

// ---- folder -----------------------------------------------------------------------------

/// Backups in `dir`, newest first. A missing folder has none.
pub fn list_backups(dir: &Path) -> Result<Vec<BackupEntry>> {
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((kind, created_ms)) = parse_file_name(&name) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        out.push(BackupEntry {
            path: entry.path().display().to_string(),
            file_name: name,
            kind: kind.as_str().into(),
            schema_from: match kind {
                BackupKind::PreMigration(v) => Some(v),
                _ => None,
            },
            created_ms,
            bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then_with(|| b.file_name.cmp(&a.file_name)));
    Ok(out)
}

/// The automatic backup is due: no copy in `dir`, or the newest is older than a day.
pub fn backup_due(dir: &Path, now_ms: u64) -> bool {
    match list_backups(dir) {
        Ok(list) => list.first().is_none_or(|b| now_ms.saturating_sub(b.created_ms) >= AUTO_BACKUP_INTERVAL_MS),
        Err(_) => true,
    }
}

/// Delete old copies: of the regular ones the newest per UTC day for the newest
/// `keep_daily` days, of update/restore/wipe copies the newest `keep_event`; pre-migration
/// copies always stay. Returns the removed files.
pub fn rotate(dir: &Path, keep_daily: usize, keep_event: usize) -> Result<Vec<PathBuf>> {
    let mut days_kept: Vec<u64> = Vec::new();
    let mut events = 0;
    let mut removed = Vec::new();
    for b in list_backups(dir)? {
        let keep = match b.kind.as_str() {
            "preMigration" => true,
            "regular" => {
                let day = b.created_ms / 86_400_000;
                if days_kept.contains(&day) || days_kept.len() >= keep_daily {
                    false
                } else {
                    days_kept.push(day);
                    true
                }
            }
            _ => {
                events += 1;
                events <= keep_event
            }
        };
        if !keep {
            match std::fs::remove_file(&b.path) {
                Ok(()) => removed.push(PathBuf::from(&b.path)),
                Err(e) => log::warn!("could not remove old backup {}: {e}", b.path),
            }
        }
    }
    Ok(removed)
}

/// Consistent copy of the database behind `conn` into `dir` (see the module docs).
pub(crate) fn create_backup_from(conn: &Connection, dir: &Path, kind: BackupKind, now_ms: u64) -> Result<PathBuf> {
    let fail = |step: BackupStep, e: &dyn std::fmt::Display| StoreError::Backup { step, dir: dir.to_path_buf(), detail: e.to_string() };
    std::fs::create_dir_all(dir).map_err(|e| fail(BackupStep::CreateDir, &e))?;
    // two copies within one second get the next free second
    let mut ms = now_ms;
    let mut target = dir.join(file_name(kind, ms));
    while target.exists() {
        ms += 1000;
        target = dir.join(file_name(kind, ms));
    }
    let partial = dir.join(format!("{}.partial", target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let _ = std::fs::remove_file(&partial);
    let path = partial.to_str().ok_or_else(|| fail(BackupStep::PathNotUtf8, &"non-UTF-8"))?;
    if let Err(e) = conn.execute("VACUUM INTO ?1", params![path]) {
        let _ = std::fs::remove_file(&partial);
        return Err(fail(BackupStep::Copy, &e));
    }
    std::fs::rename(&partial, &target).map_err(|e| fail(BackupStep::Rename, &e))?;
    Ok(target)
}

// ---- checks and restore -----------------------------------------------------------------

/// Open a backup read-only and check it: `PRAGMA integrity_check`, a VectaSim schema not
/// newer than this build ([`StoreError::NewerSchema`] otherwise), number of flights.
pub fn inspect(path: &Path) -> Result<RestoreCheck> {
    if !path.is_file() {
        return Err(Invalid::FileNotFound { path: path_text(path) }.into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| StoreError::from(Invalid::NotADatabase { detail: e.to_string() }))?;
    let problems: Vec<String> = (|| -> rusqlite::Result<Vec<String>> {
        let mut stmt = conn.prepare("PRAGMA integrity_check")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect()
    })()
    .map_err(|e| StoreError::from(Invalid::NotADatabase { detail: e.to_string() }))?;
    if problems.len() != 1 || problems[0] != "ok" {
        return Err(Invalid::BackupCorrupt { detail: problems.join("; ") }.into());
    }
    let schema_version = file_schema_version(&conn).map_err(|e| StoreError::from(Invalid::NotVectasimDatabase { detail: e.to_string() }))?;
    if schema_version == 0 {
        return Err(Invalid::SchemaMissing.into());
    }
    if schema_version > SCHEMA_VERSION {
        return Err(StoreError::NewerSchema { found: schema_version, supported: SCHEMA_VERSION });
    }
    let flights: i64 = conn
        .query_row("SELECT COUNT(*) FROM flights", [], |r| r.get(0))
        .map_err(|e| StoreError::from(Invalid::NotVectasimDatabase { detail: e.to_string() }))?;
    Ok(RestoreCheck { schema_version, flights: flights.max(0) as u64 })
}

fn sibling(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    db.with_file_name(name)
}

/// Windows refuses to rename a file another process still has open; that process is the
/// previous instance on its way out after a restart.
fn with_retries(mut op: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 25 && e.kind() != std::io::ErrorKind::NotFound => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Where a staged restore waits for the next open.
pub fn pending_restore_path(db: &Path) -> PathBuf {
    sibling(db, ".restore-pending")
}

fn stage_restore(db: &Path, src: &Path) -> Result<()> {
    let pending = pending_restore_path(db);
    let partial = sibling(db, ".restore-pending.partial");
    std::fs::copy(src, &partial)?;
    std::fs::rename(&partial, &pending)?;
    Ok(())
}

/// Put a staged restore in place (called by `Store::open*` before connecting). The current
/// file is checkpointed and replaced; its `-wal`/`-shm` go with it. A staged file that
/// fails [`inspect`] – or that cannot be put in place (checkpoint or rename failing, e.g. a
/// virus scanner or a second instance holding a file) while the current logbook is still
/// there – is set aside as `.restore-failed` and the current logbook opens, instead of every
/// start failing the same way. True when a restore was applied.
pub fn apply_pending_restore(db: &Path) -> Result<bool> {
    let pending = pending_restore_path(db);
    if !pending.is_file() {
        return Ok(false);
    }
    if let Err(e) = inspect(&pending) {
        log::error!("staged restore {} is unusable, keeping the current logbook: {e}", pending.display());
        let _ = std::fs::rename(&pending, sibling(db, ".restore-failed"));
        return Ok(false);
    }
    match put_restore_in_place(db, &pending) {
        Ok(()) => Ok(true),
        // the current logbook is still there: open it, the restore can be repeated from the backup
        Err(e) if db.is_file() => {
            log::error!("staged restore {} could not be applied, keeping the current logbook: {e}", pending.display());
            if let Err(e) = std::fs::rename(&pending, sibling(db, ".restore-failed")) {
                log::error!("staged restore {} could not be set aside either: {e}", pending.display());
            }
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

fn put_restore_in_place(db: &Path, pending: &Path) -> Result<()> {
    let replaced = sibling(db, ".replaced");
    if db.is_file() {
        {
            // fold the WAL into the main file so nothing is left behind in -wal
            let conn = Connection::open(db)?;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        }
        let _ = std::fs::remove_file(&replaced);
        // the previous process may still be closing its handles (restart): retry a few seconds
        with_retries(|| std::fs::rename(db, &replaced))?;
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(sibling(db, suffix));
    }
    if let Err(e) = with_retries(|| std::fs::rename(pending, db)) {
        if replaced.is_file() {
            let _ = std::fs::rename(&replaced, db);
        }
        return Err(e.into());
    }
    // the pre-restore backup in the backup folder is the way back
    let _ = std::fs::remove_file(&replaced);
    Ok(())
}

/// Name of the sync service or network share `path` lies on, by path heuristics:
/// OneDrive (also its environment variables), Dropbox, Google Drive, iCloud, Nextcloud/ownCloud,
/// UNC paths (`\\server\share`). Fine for backups, risky for the live database (WAL).
pub fn sync_folder_kind(path: &Path) -> Option<&'static str> {
    let lower = path.to_string_lossy().replace('/', "\\").to_lowercase();
    if lower.starts_with("\\\\") && !lower.starts_with("\\\\?\\") && !lower.starts_with("\\\\.\\") {
        return Some("Netzlaufwerk");
    }
    if lower.starts_with("\\\\?\\unc\\") {
        return Some("Netzlaufwerk");
    }
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(root) = std::env::var_os(var) {
            let root = root.to_string_lossy().replace('/', "\\").to_lowercase();
            let root = root.trim_end_matches('\\');
            if !root.is_empty() && (lower == root || lower.starts_with(&format!("{root}\\"))) {
                return Some("OneDrive");
            }
        }
    }
    for part in lower.split('\\') {
        if part.starts_with("onedrive") {
            return Some("OneDrive");
        }
        if part.starts_with("dropbox") {
            return Some("Dropbox");
        }
        if matches!(part, "google drive" | "googledrive" | "my drive" | "meine ablage") || part.starts_with("google drive") {
            return Some("Google Drive");
        }
        if part.starts_with("icloud") {
            return Some("iCloud Drive");
        }
        if part.starts_with("nextcloud") || part.starts_with("owncloud") {
            return Some("Nextcloud");
        }
    }
    None
}

impl Store {
    /// Consistent copy of the logbook into `dir`, then [`rotate`]. Uses its own read-only
    /// connection when the store has a file, so the recorder is not blocked meanwhile.
    pub fn create_backup(&self, dir: &Path, kind: BackupKind) -> Result<PathBuf> {
        self.create_backup_at(dir, kind, vectasim_core::now_ms())
    }

    /// [`Store::create_backup`] with an explicit time (tests).
    pub fn create_backup_at(&self, dir: &Path, kind: BackupKind, now_ms: u64) -> Result<PathBuf> {
        let separate = self.path().and_then(|p| Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok());
        let target = match separate {
            Some(conn) => create_backup_from(&conn, dir, kind, now_ms)?,
            None => create_backup_from(&self.conn(), dir, kind, now_ms)?,
        };
        let removed = rotate(dir, KEEP_DAILY, KEEP_EVENT)?;
        if !removed.is_empty() {
            log::info!("backup rotation removed {} old copies", removed.len());
        }
        Ok(target)
    }

    /// Restore the logbook from `src`: checks it ([`inspect`]), saves the current logbook to
    /// `backup_dir` (`vectasim-pre-restore-…`) and stages the copy; it replaces the database
    /// the next time it is opened – restart the app right after this. Returns the copy of the
    /// current logbook.
    pub fn restore_from(&self, src: &Path, backup_dir: &Path) -> Result<PathBuf> {
        let db = self.path().ok_or_else(|| StoreError::from(Invalid::InMemory))?.to_path_buf();
        let same = |a: &Path, b: &Path| matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y);
        if same(src, &db) {
            return Err(Invalid::ActiveDatabase.into());
        }
        inspect(src)?;
        let saved = self.create_backup(backup_dir, BackupKind::PreRestore)?;
        stage_restore(&db, src)?;
        log::warn!("restore staged from {} (current logbook saved as {})", src.display(), saved.display());
        Ok(saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_roundtrip() {
        // 2026-10-18 07:05:09 UTC
        let ms = 1_792_307_109_000;
        assert_eq!(stamp(ms), "20261018-070509");
        assert_eq!(parse_stamp("20261018-070509"), Some(ms));
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(parse_stamp("20261318-070509"), None);
        assert_eq!(parse_stamp("2026101-0705090"), None);
    }

    #[test]
    fn names_roundtrip() {
        let ms = 1_792_307_109_000;
        for kind in [BackupKind::Regular, BackupKind::PreMigration(9), BackupKind::PreUpdate, BackupKind::PreRestore, BackupKind::PreWipe, BackupKind::PreImport] {
            assert_eq!(parse_file_name(&file_name(kind, ms)), Some((kind, ms)), "{kind:?}");
        }
        assert_eq!(file_name(BackupKind::PreMigration(9), ms), "vectasim-pre-v9-20261018-070509.db");
        assert_eq!(parse_file_name("vectasim.db"), None);
        assert_eq!(parse_file_name("vectasim-20261018-070509.db.partial"), None);
        assert_eq!(parse_file_name("other-20261018-070509.db"), None);
    }

    #[test]
    fn sync_folders_are_recognised() {
        let k = |p: &str| sync_folder_kind(Path::new(p));
        assert_eq!(k(r"C:\Users\pilot\OneDrive\VectaSim"), Some("OneDrive"));
        assert_eq!(k(r"C:\Users\pilot\OneDrive - Firma GmbH\Backups"), Some("OneDrive"));
        assert_eq!(k(r"D:\Dropbox\vs"), Some("Dropbox"));
        assert_eq!(k(r"G:\My Drive\vs"), Some("Google Drive"));
        assert_eq!(k(r"G:\Meine Ablage\vs"), Some("Google Drive"));
        assert_eq!(k(r"\\nas\backup\vs"), Some("Netzlaufwerk"));
        assert_eq!(k(r"C:\Users\pilot\AppData\Local\io.vectasim.app\backups"), None);
    }
}
