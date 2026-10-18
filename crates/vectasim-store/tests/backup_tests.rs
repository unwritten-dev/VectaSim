//! Backup folder: create, list, rotate, restore (temp directories only).

use std::path::Path;
use vectasim_core::{FlightSession, MockFlight};
use vectasim_store::backup::{self, BackupKind, KEEP_DAILY, KEEP_EVENT};
use vectasim_store::{FlightRecorder, RecorderContext, SCHEMA_VERSION, Store, StoreError};

const DAY: u64 = 86_400_000;
/// 2027-01-15 00:00 UTC
const T0: u64 = 1_800_000_000_000 - 1_800_000_000_000 % DAY;

fn record_mock_flight(store: &Store) {
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), ..Default::default() });
    let hz = 5.0;
    for i in 1..=((MockFlight::loop_seconds() + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &events).unwrap();
    }
}

fn count(store: &Store) -> usize {
    store.list_flights(100, 0).unwrap().len()
}

#[test]
fn backup_is_a_consistent_readable_copy() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("vectasim.db")).unwrap();
    record_mock_flight(&store);
    let backups = dir.path().join("my backups");
    assert!(backup::backup_due(&backups, T0), "no backup yet");

    let path = store.create_backup_at(&backups, BackupKind::Regular, T0 + 3_723_000).unwrap();
    assert_eq!(path.file_name().unwrap().to_string_lossy(), format!("vectasim-{}.db", backup::stamp(T0 + 3_723_000)));
    assert!(path.file_name().unwrap().to_string_lossy().ends_with("-010203.db"));
    let check = backup::inspect(&path).unwrap();
    assert_eq!((check.schema_version, check.flights), (SCHEMA_VERSION, 1));
    // the copy opens as a logbook of its own
    assert_eq!(count(&Store::open(&path).unwrap()), 1);

    let list = backup::list_backups(&backups).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].kind.as_str(), list[0].created_ms), ("regular", T0 + 3_723_000));
    assert!(list[0].bytes > 0);
    assert!(!backup::backup_due(&backups, T0 + DAY - 1));
    assert!(backup::backup_due(&backups, T0 + 3_723_000 + DAY));

    // a second copy in the same second does not overwrite the first
    let first = store.create_backup_at(&backups, BackupKind::PreUpdate, T0 + 3_723_000).unwrap();
    let again = store.create_backup_at(&backups, BackupKind::PreUpdate, T0 + 3_723_000).unwrap();
    assert_ne!(again, first);
    assert!(first.is_file() && again.is_file());
    // another regular copy of the same day replaces the earlier one (one per day)
    let later = store.create_backup_at(&backups, BackupKind::Regular, T0 + 7_200_000 + 3_723_000).unwrap();
    assert!(later.is_file() && !path.is_file());
    // in-memory stores can be backed up too
    let mem = Store::open_in_memory().unwrap();
    let p = mem.create_backup_at(&backups, BackupKind::PreWipe, T0).unwrap();
    assert_eq!(backup::inspect(&p).unwrap().flights, 0);
}

#[test]
fn rotation_keeps_one_per_day_recent_events_and_all_pre_migration_copies() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let b = dir.path();
    store.create_backup_at(b, BackupKind::PreMigration(8), T0 - 40 * DAY).unwrap();
    store.create_backup_at(b, BackupKind::PreMigration(9), T0 - 20 * DAY).unwrap();
    for day in 0..10 {
        // morning and evening copy every day
        store.create_backup_at(b, BackupKind::Regular, T0 + day * DAY + 8 * 3_600_000).unwrap();
        store.create_backup_at(b, BackupKind::Regular, T0 + day * DAY + 20 * 3_600_000).unwrap();
    }
    for i in 0..8 {
        store.create_backup_at(b, BackupKind::PreUpdate, T0 + i * DAY + 1000).unwrap();
    }
    store.create_backup_at(b, BackupKind::PreRestore, T0 + 12 * DAY).unwrap();
    // foreign files are never touched
    std::fs::write(b.join("notes.txt"), "keep").unwrap();
    std::fs::write(b.join("vectasim.db"), "not a backup name").unwrap();

    let list = backup::list_backups(b).unwrap();
    let of = |k: &str| list.iter().filter(|e| e.kind == k).collect::<Vec<_>>();
    let regular = of("regular");
    assert_eq!(regular.len(), KEEP_DAILY);
    // the newest 7 days, each with its evening copy
    let expect: Vec<u64> = (3..10).rev().map(|d| T0 + d * DAY + 20 * 3_600_000).collect();
    assert_eq!(regular.iter().map(|e| e.created_ms).collect::<Vec<_>>(), expect);
    assert_eq!(of("preMigration").len(), 2);
    let events = list.iter().filter(|e| e.kind == "preUpdate" || e.kind == "preRestore").count();
    assert_eq!(events, KEEP_EVENT);
    assert_eq!(of("preRestore").len(), 1, "the newest event copy stays");
    assert!(b.join("notes.txt").is_file() && b.join("vectasim.db").is_file());
    // newest first
    assert!(list.windows(2).all(|w| w[0].created_ms >= w[1].created_ms));
}

#[test]
fn restore_replaces_the_logbook_on_the_next_open_and_saves_the_current_one() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("vectasim.db");
    let backups = dir.path().join("backups");
    let store = Store::open(&db).unwrap();
    record_mock_flight(&store);
    store.set_setting("marker", "old").unwrap();
    let snapshot = store.create_backup_at(&backups, BackupKind::Regular, T0).unwrap();
    record_mock_flight(&store);
    store.set_setting("marker", "new").unwrap();
    assert_eq!(count(&store), 2);

    let saved = store.restore_from(&snapshot, &backups).unwrap();
    assert!(saved.file_name().unwrap().to_string_lossy().starts_with("vectasim-pre-restore-"));
    assert_eq!(backup::inspect(&saved).unwrap().flights, 2, "the current logbook is saved first");
    assert!(backup::pending_restore_path(&db).is_file());
    // the running store is untouched until the restart
    assert_eq!(count(&store), 2);
    // the app releases the file before restarting; the old handle may linger (clones)
    store.close_for_restart().unwrap();
    let old = store;

    let store = Store::open(&db).unwrap();
    assert_eq!(count(&store), 1);
    assert_eq!(store.get_setting("marker").unwrap().as_deref(), Some("old"));
    assert!(!backup::pending_restore_path(&db).exists());
    assert!(snapshot.is_file(), "the backup itself stays");
    assert!(old.list_flights(10, 0).is_err(), "the closed store has no logbook any more");
    drop((store, old));
    // and it stays restored
    assert_eq!(count(&Store::open(&db).unwrap()), 1);
}

#[test]
fn restore_refuses_damaged_foreign_and_newer_files() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("vectasim.db");
    let backups = dir.path().join("backups");
    let store = Store::open(&db).unwrap();

    let garbage = dir.path().join("garbage.db");
    std::fs::write(&garbage, vec![0x42u8; 8192]).unwrap();
    assert!(matches!(store.restore_from(&garbage, &backups), Err(StoreError::Invalid(_))));

    let foreign = dir.path().join("foreign.db");
    rusqlite::Connection::open(&foreign).unwrap().execute_batch("CREATE TABLE t (x INTEGER);").unwrap();
    assert!(matches!(store.restore_from(&foreign, &backups), Err(StoreError::Invalid(_))));

    let newer = store.create_backup_at(&backups, BackupKind::Regular, T0).unwrap();
    rusqlite::Connection::open(&newer).unwrap().execute("UPDATE schema_version SET version = ?1", [SCHEMA_VERSION + 1]).unwrap();
    assert!(matches!(store.restore_from(&newer, &backups), Err(StoreError::NewerSchema { .. })));

    assert!(matches!(store.restore_from(&db, &backups), Err(StoreError::Invalid(_))), "the live file is no backup");
    assert!(matches!(store.restore_from(Path::new("does-not-exist.db"), &backups), Err(StoreError::Invalid(_))));
    assert!(!backup::pending_restore_path(&db).exists(), "nothing staged");
}

#[test]
fn unusable_staged_restore_is_set_aside_and_the_logbook_stays() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("vectasim.db");
    {
        let store = Store::open(&db).unwrap();
        record_mock_flight(&store);
    }
    std::fs::write(backup::pending_restore_path(&db), b"broken").unwrap();
    let store = Store::open(&db).unwrap();
    assert_eq!(count(&store), 1);
    assert!(!backup::pending_restore_path(&db).exists());
    assert!(dir.path().join("vectasim.db.restore-failed").is_file());
}
