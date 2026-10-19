//! G-load over the whole flight in the logbook (schema v16): recorded live, derived from
//! the 1 Hz track for older flights, migrated, merged.

use vectasim_core::{FlightPhase, FlightSession, GLoadSource, Telemetry};
use vectasim_store::{FlightRecorder, RecorderContext, SCHEMA_VERSION, Store, TrackSample, g_load_from_track};

const G_COLUMNS: [&str; 11] = [
    "g_max",
    "g_max_ms",
    "g_max_phase",
    "g_max_alt_ft",
    "g_min",
    "g_min_ms",
    "g_min_phase",
    "g_min_alt_ft",
    "g_high_count",
    "g_low_count",
    "g_source",
];

/// A synthetic flight at 10 Hz from the gate to shutdown: a 1.6 g pull in the climb, a
/// 0.7 g push-over in the descent, 2.4 g at the touchdown (the landing's, not the flight's).
fn record_flight(store: &Store) -> String {
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "test".into(), ..Default::default() });
    let mut t_ms = 1_700_000_000_000u64;
    let mut agl = 0.0f64;
    let mut seg = |secs: f64, to_agl: f64, gs: f64, vs: f64, g: &dyn Fn(f64) -> f64, engines: u8| {
        let n = (secs * 10.0) as u64;
        let from = agl;
        for i in 1..=n {
            t_ms += 100;
            agl = from + (to_agl - from) * i as f64 / n as f64;
            let s = i as f64 / 10.0;
            let t = Telemetry {
                timestamp_ms: t_ms,
                sim_rate: 1.0,
                num_engines: 2,
                engines_running: engines,
                fuel_total_kg: 5_000.0 - t_ms.saturating_sub(1_700_000_000_000) as f64 / 10_000.0,
                on_ground: agl <= 0.0,
                altitude_agl_ft: agl,
                altitude_msl_ft: 400.0 + agl,
                ground_speed_kt: gs,
                vertical_speed_fpm: vs,
                latitude: 50.0 + t_ms.saturating_sub(1_700_000_000_000) as f64 * 1e-8,
                longitude: 8.5,
                g_force: g(s),
                ..Default::default()
            };
            let events = session.update(&t);
            rec.on_telemetry(&t, session.summary(), &events).unwrap();
        }
    };
    let one = |_| 1.0;
    seg(5.0, 0.0, 0.0, 0.0, &one, 2);
    seg(20.0, 0.0, 12.0, 0.0, &one, 2); // taxi out
    seg(5.0, 0.0, 90.0, 0.0, &one, 2); // roll
    seg(60.0, 3_000.0, 160.0, 1_500.0, &|s| if (20.0..21.5).contains(&s) { 1.6 } else { 1.0 }, 2);
    seg(90.0, 8_000.0, 250.0, 1_000.0, &one, 2);
    seg(90.0, 8_000.0, 250.0, 0.0, &one, 2); // cruise
    seg(60.0, 6_000.0, 240.0, -1_200.0, &|s| if (10.0..11.0).contains(&s) { 0.7 } else { 1.0 }, 2);
    seg(40.0, 3_000.0, 180.0, -800.0, &one, 2);
    seg(40.0, 30.0, 140.0, -700.0, &one, 2);
    seg(2.0, 0.0, 130.0, -300.0, &|_| 2.4, 2); // touchdown
    seg(20.0, 0.0, 20.0, 0.0, &one, 2); // rollout, taxi in
    seg(15.0, 0.0, 0.0, 0.0, &one, 0); // shutdown
    let f = &store.list_flights(1, 0).unwrap()[0];
    assert_eq!(f.state, "completed", "{f:?}");
    f.id.clone()
}

#[test]
fn live_g_load_is_stored_with_the_flight() {
    let store = Store::open_in_memory().unwrap();
    let id = record_flight(&store);
    let g = store.get_flight(&id).unwrap().unwrap().flight.g_load.expect("measured");
    assert_eq!(g.source, GLoadSource::Live);
    let (max, min) = (g.max.unwrap(), g.min.unwrap());
    assert!((max.g - 1.6).abs() < 1e-9, "{max:?}");
    assert!(max.phase.is_airborne_phase() || max.phase == FlightPhase::Takeoff, "{max:?}");
    assert!(max.altitude_msl_ft > 400.0, "{max:?}");
    assert!((min.g - 0.7).abs() < 1e-9, "{min:?}");
    assert_eq!((g.high_count, g.low_count), (1, 0));
}

#[test]
fn migration_v16_derives_old_flights_from_the_track() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    const { assert!(SCHEMA_VERSION >= 16) };
    let id = record_flight(&Store::open(&path).unwrap());
    // a v15 file: none of the columns
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        for c in G_COLUMNS {
            conn.execute_batch(&format!("ALTER TABLE flights DROP COLUMN {c}")).unwrap();
        }
        conn.execute("UPDATE schema_version SET version = 15", []).unwrap();
    }
    let backups = dir.path().join("backups");
    let store = Store::open_with_backup_dir(&path, &backups).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let list = vectasim_store::backup::list_backups(&backups).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].file_name.starts_with("vectasim-pre-v15-"), "{}", list[0].file_name);
    // the list does not derive anything; opening the flight does, once
    assert_eq!(store.list_flights(1, 0).unwrap()[0].g_load, None);
    let g = store.get_flight(&id).unwrap().unwrap().flight.g_load.expect("from the track");
    assert_eq!(g.source, GLoadSource::Track);
    // 1 Hz: the pull is in the track (1.5 s at 1.6 g), the touchdown is not
    let max = g.max.unwrap();
    assert!((max.g - 1.6).abs() < 1e-3, "{max:?}");
    assert!(max.phase.is_airborne_phase() || max.phase == FlightPhase::Takeoff, "{max:?}");
    assert!((g.min.unwrap().g - 0.7).abs() < 1e-3, "{g:?}");
    assert_eq!(store.list_flights(1, 0).unwrap()[0].g_load, Some(g));

    // columns there, version number rolled back: migrates again, keeps the values
    drop(store);
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE schema_version SET version = 15", []).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.g_load, Some(g));
}

#[test]
fn flight_without_track_is_not_measured() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let id = record_flight(&Store::open(&path).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute("UPDATE flights SET g_source = NULL", []).unwrap();
        conn.execute("DELETE FROM tracks", []).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.g_load, None);
    let src: Option<String> =
        rusqlite::Connection::open(&path).unwrap().query_row("SELECT g_source FROM flights", [], |r| r.get(0)).unwrap();
    assert_eq!(src.as_deref(), Some("none"), "derived once, not on every open");
}

#[test]
fn track_derivation_leaves_out_frozen_samples_and_ground() {
    let s = |i: u64, g: f64, on_ground: bool, alt: f64| TrackSample {
        t_ms: i * 1_000,
        latitude: 50.0 + i as f64 * 0.001,
        altitude_msl_ft: alt,
        g_force: g,
        on_ground,
        ..Default::default()
    };
    let mut track = vec![s(0, 1.0, true, 400.0)];
    track.extend((1..20).map(|i| s(i, 1.1, false, 400.0 + i as f64 * 100.0)));
    // paused: position and altitude frozen, a bogus 3 g
    let frozen = TrackSample { t_ms: 20_000, g_force: 3.0, ..track[19].clone() };
    track.push(frozen);
    track.extend((21..40).map(|i| s(i, 0.95, false, 3_000.0)));
    let g = g_load_from_track(&track, &[(FlightPhase::Climb, 1_000), (FlightPhase::Cruise, 21_000)]).unwrap();
    assert_eq!(g.max.unwrap().g, 1.1);
    assert_eq!(g.max.unwrap().phase, FlightPhase::Climb);
    assert_eq!(g.min.unwrap().g, 0.95);
    assert_eq!(g.min.unwrap().phase, FlightPhase::Cruise);
    assert_eq!(g_load_from_track(&track[..1], &[]), None, "nothing airborne");
}

#[test]
fn g_load_travels_with_the_bundle_and_fills_an_old_copy() {
    use vectasim_core::Lang;
    use vectasim_store::{ExportOptions, ImportMode, ImportOptions};
    let dir = tempfile::tempdir().unwrap();
    let a = Store::open(&dir.path().join("a.db")).unwrap();
    let id = record_flight(&a);
    let measured = a.get_flight(&id).unwrap().unwrap().flight.g_load.expect("measured");
    let file = dir.path().join("all.vectasim");
    let opts = ExportOptions { include_deleted: true, include_demo: true, app_version: "0.1.0-test".into(), lang: Lang::De };
    a.export_bundle(&file, &opts).unwrap();
    let merge = ImportOptions { mode: ImportMode::Merge, images_dir: None, backup_dir: None, lang: Lang::De };

    // into an empty logbook: the columns come along
    let b = Store::open_in_memory().unwrap();
    b.import_bundle(&file, &merge).unwrap();
    assert_eq!(b.get_flight(&id).unwrap().unwrap().flight.g_load, Some(measured));

    // a logbook with the same flight from before v16 (no g-load yet, not opened) takes the bundle's
    let path_c = dir.path().join("c.db");
    let c = Store::open(&path_c).unwrap();
    c.import_bundle(&file, &merge).unwrap();
    {
        let conn = rusqlite::Connection::open(&path_c).unwrap();
        conn.execute("UPDATE flights SET g_source = NULL, g_max = NULL", []).unwrap();
    }
    let r = c.import_bundle(&file, &merge).unwrap();
    assert_eq!((r.flights_added, r.flights_skipped_duplicate), (0, 1), "{r:?}");
    assert_eq!(c.get_flight(&id).unwrap().unwrap().flight.g_load, Some(measured));
}
