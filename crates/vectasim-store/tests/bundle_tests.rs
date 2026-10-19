//! `.vectasim` bundles: export → empty logbook → import, merge with duplicates, replace.

use std::path::Path;
use vectasim_core::landing::RunwayEnd;
use vectasim_core::{FlightSession, Lang, MockFlight};
use vectasim_store::bundle::{self, BUNDLE_FORMAT};
use vectasim_store::{
    AirframeEdit, AirframePhoto, ExportOptions, FlightRecorder, ImportMode, ImportOptions, RecorderContext, RunwayRefinement, Store, UserRunwayEdit, UserRunwaySource,
};

const T0: u64 = 1_700_000_000_000;
const HOUR: u64 = 3_600_000;

/// One mock loop starting at `base_ms` (the recorder books it as a completed flight).
fn record_mock_flight(store: &Store, base_ms: u64) {
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), sim_name: Some("VectaSim Mock".into()), aircraft: Some(MockFlight::aircraft()) },
    );
    let hz = 5.0;
    for i in 1..=((MockFlight::loop_seconds() + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        let t = flight.sample(t_s, base_ms + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &events).unwrap();
    }
}

fn all_ids(store: &Store) -> Vec<String> {
    let mut ids: Vec<String> = store.list_flights(1000, 0).unwrap().into_iter().map(|f| f.id).collect();
    ids.extend(store.list_deleted_flights().unwrap().into_iter().map(|d| d.flight.id));
    ids.sort();
    ids
}

fn all_opts() -> ExportOptions {
    ExportOptions { include_deleted: true, include_demo: true, app_version: "0.1.0-test".into(), lang: Lang::De }
}

fn merge(images: &Path) -> ImportOptions {
    ImportOptions { mode: ImportMode::Merge, images_dir: Some(images.to_path_buf()), backup_dir: None, lang: Lang::De }
}

/// Three flights (one in the Papierkorb), an edited airframe with an own picture.
fn source_logbook(dir: &Path) -> Store {
    let store = Store::open(&dir.join("a.db")).unwrap();
    for k in 0..3 {
        record_mock_flight(&store, T0 + k * 5 * HOUR);
    }
    let ids = all_ids(&store);
    assert_eq!(ids.len(), 3);
    store.delete_flight_at(&ids[0], T0 + 20 * HOUR).unwrap();
    store
        .upsert_airframe(
            &AirframeEdit {
                registration: "D-AIBL".into(),
                custom_name: Some("Bella".into()),
                notes: Some("Notiz".into()),
                ..Default::default()
            },
            T0,
        )
        .unwrap();
    store.set_flight_airframe(&ids[1], Some("D-AIBL"), T0).unwrap();
    let pic = dir.join("pick.png");
    std::fs::write(&pic, b"\x89PNG fake picture").unwrap();
    let url = pic.display().to_string();
    let photo =
        AirframePhoto { url: url.clone(), thumb_url: url, credit: "Eigenes Bild".into(), link: String::new(), source: "user".into() };
    store.set_airframe_photo("D-AIBL", Some(&photo), T0).unwrap();
    store
}

#[test]
fn roundtrip_into_an_empty_logbook_keeps_everything() {
    let dir = tempfile::tempdir().unwrap();
    let a = source_logbook(dir.path());
    let file = dir.path().join("out").join("VectaSim-Export_test.vectasim");
    let report = a.export_bundle_at(&file, &all_opts(), T0 + 30 * HOUR).unwrap();
    assert!(report.bytes > 0 && file.is_file());
    assert!(!dir.path().join("out").join("VectaSim-Export_test.vectasim.partial").exists());
    let m = &report.manifest;
    assert_eq!(
        (m.format, m.flights, m.flights_deleted, m.tracks, m.airframes, m.images),
        (BUNDLE_FORMAT, 3, 1, 3, a.list_airframes(true).unwrap().len() as u64, 1)
    );
    assert_eq!(bundle::read_manifest(&file).unwrap(), *m);

    let b = Store::open(&dir.path().join("b.db")).unwrap();
    let images = dir.path().join("b-images");
    let r = b.import_bundle(&file, &merge(&images)).unwrap();
    assert_eq!((r.flights_in_bundle, r.flights_added, r.flights_skipped_duplicate), (3, 3, 0), "{r:?}");
    assert_eq!((r.airframes_added, r.images_added), (m.airframes, 1));
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);

    assert_eq!(all_ids(&a), all_ids(&b));
    assert_eq!(b.deleted_count().unwrap(), 1);
    assert_eq!(a.list_deleted_flights().unwrap(), b.list_deleted_flights().unwrap());
    assert_eq!(a.totals().unwrap(), b.totals().unwrap());
    for id in all_ids(&a) {
        let (fa, fb) = (a.get_flight(&id).unwrap().unwrap(), b.get_flight(&id).unwrap().unwrap());
        assert_eq!(fa, fb, "flight {id}");
        assert_eq!(a.get_track(&id).unwrap(), b.get_track(&id).unwrap());
        assert_eq!(a.get_track_preview(&id).unwrap(), b.get_track_preview(&id).unwrap());
    }
    let (aa, ab) = (a.get_airframe("D-AIBL").unwrap().unwrap(), b.get_airframe("D-AIBL").unwrap().unwrap());
    assert_eq!((ab.custom_name.as_deref(), ab.notes.as_deref(), ab.image_source.as_deref()), (Some("Bella"), Some("Notiz"), Some("user")));
    // the picture now lives in this PC's folder
    let pic = images.join("D_AIBL.png");
    assert_eq!(ab.image_url.as_deref(), Some(pic.display().to_string().as_str()));
    assert_eq!(std::fs::read(&pic).unwrap(), std::fs::read(aa.image_url.unwrap()).unwrap());
    assert_eq!(a.airframe_flights("D-AIBL", 10).unwrap().len(), b.airframe_flights("D-AIBL", 10).unwrap().len());

    // the same file again: everything is already there
    let again = b.import_bundle(&file, &merge(&images)).unwrap();
    assert_eq!((again.flights_added, again.flights_skipped_duplicate, again.airframes_added, again.images_added), (0, 3, 0, 0));
    assert_eq!(all_ids(&b).len(), 3);
}

#[test]
fn export_without_trash_and_demo_filters() {
    let dir = tempfile::tempdir().unwrap();
    let a = source_logbook(dir.path());
    let file = dir.path().join("x.vectasim");
    let r = a.export_bundle(&file, &ExportOptions { include_deleted: false, include_demo: true, app_version: "t".into(), lang: Lang::De }).unwrap();
    assert_eq!((r.manifest.flights, r.manifest.flights_deleted), (2, 0));
    let r = a.export_bundle(&file, &ExportOptions { include_deleted: true, include_demo: false, app_version: "t".into(), lang: Lang::De }).unwrap();
    assert_eq!(r.manifest.flights, 0, "mock flights are demo flights");
}

#[test]
fn merge_skips_the_same_flight_under_another_id_and_fills_empty_airframe_fields() {
    let dir = tempfile::tempdir().unwrap();
    let a = source_logbook(dir.path());
    let first = dir.path().join("first.vectasim");
    a.export_bundle(&first, &all_opts()).unwrap();

    // the other PC: the same flights recorded under new ids, one of them 20 min later
    let ids = all_ids(&a);
    drop(a);
    {
        let conn = rusqlite::Connection::open(dir.path().join("a.db")).unwrap();
        // children keep the old ids: this logbook only serves as the source of a second export
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute("UPDATE flights SET id = 'other-' || id", []).unwrap();
        conn.execute("UPDATE flights SET off_block_ms = off_block_ms + 20 * 60000 WHERE id = ?1", [format!("other-{}", ids[2])]).unwrap();
        conn.execute("UPDATE flights SET off_block_ms = off_block_ms + 10 * 60000 WHERE id = ?1", [format!("other-{}", ids[1])]).unwrap();
    }
    let a = Store::open(&dir.path().join("a.db")).unwrap();
    let second = dir.path().join("second.vectasim");
    a.export_bundle(&second, &all_opts()).unwrap();

    let b = Store::open_in_memory().unwrap();
    let images = dir.path().join("img");
    // b has the airframe already, with its own name but without notes or picture
    b.upsert_airframe(&AirframeEdit { registration: "D-AIBL".into(), custom_name: Some("Meine".into()), ..Default::default() }, T0)
        .unwrap();
    let r = b.import_bundle(&first, &merge(&images)).unwrap();
    // the mock aircraft brings its own airframe (from the ATC id); D-AIBL only gets filled
    assert_eq!((r.flights_added, r.airframes_added, r.airframes_updated, r.images_added), (3, 1, 1, 1), "{r:?}");
    let af = b.get_airframe("D-AIBL").unwrap().unwrap();
    assert_eq!((af.custom_name.as_deref(), af.notes.as_deref(), af.image_source.as_deref()), (Some("Meine"), Some("Notiz"), Some("user")));

    let r = b.import_bundle(&second, &merge(&images)).unwrap();
    // 0 and 1 (10 min off) are duplicates by route and off-block, 2 (20 min off) is new
    assert_eq!((r.flights_added, r.flights_skipped_duplicate), (1, 2), "{r:?}");
    assert_eq!(all_ids(&b).len(), 4);
    assert!(all_ids(&b).contains(&format!("other-{}", ids[2])));
}

#[test]
fn replace_backs_up_first_and_swaps_the_logbook() {
    let dir = tempfile::tempdir().unwrap();
    let a = source_logbook(dir.path());
    let file = dir.path().join("all.vectasim");
    a.export_bundle(&file, &all_opts()).unwrap();

    let b = Store::open(&dir.path().join("b.db")).unwrap();
    record_mock_flight(&b, T0 + 100 * HOUR);
    b.upsert_airframe(&AirframeEdit { registration: "OE-LBX".into(), ..Default::default() }, T0).unwrap();
    let backups = dir.path().join("backups");
    let opts = ImportOptions { mode: ImportMode::Replace, images_dir: Some(dir.path().join("img")), backup_dir: Some(backups.clone()), lang: Lang::De };
    let r = b.import_bundle(&file, &opts).unwrap();
    assert_eq!((r.flights_added, r.flights_skipped_duplicate), (3, 0));
    let saved = r.backup.expect("pre-import backup");
    assert!(saved.contains("vectasim-pre-import-"), "{saved}");
    assert_eq!(vectasim_store::backup::inspect(Path::new(&saved)).unwrap().flights, 1);
    assert_eq!(vectasim_store::backup::list_backups(&backups).unwrap()[0].kind, "preImport");
    assert_eq!(all_ids(&a), all_ids(&b));
    assert!(b.get_airframe("OE-LBX").unwrap().is_none(), "airframes replaced");

    // without a backup folder nothing happens
    let no_backup = ImportOptions { backup_dir: None, ..opts };
    assert!(b.import_bundle(&file, &no_backup).is_err());
    assert_eq!(all_ids(&b).len(), 3);
}

#[test]
fn broken_or_foreign_files_are_refused_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let b = Store::open_in_memory().unwrap();
    record_mock_flight(&b, T0);
    let images = dir.path().join("img");

    let not_zip = dir.path().join("x.vectasim");
    std::fs::write(&not_zip, b"hello").unwrap();
    assert!(b.import_bundle(&not_zip, &merge(&images)).is_err());

    // a ZIP without manifest, and one from a future format
    let write_zip = |name: &str, entries: &[(&str, &str)]| {
        let p = dir.path().join(name);
        let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        for (n, body) in entries {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut z, body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
        p
    };
    let no_manifest = write_zip("a.vectasim", &[("flights.jsonl", "")]);
    assert!(b.import_bundle(&no_manifest, &merge(&images)).unwrap_err().to_string().contains("manifest"));
    let manifest = |format: u32| {
        format!(
            r#"{{"format":{format},"app":"VectaSim","appVersion":"9","schemaVersion":10,"createdMs":0,"createdUtc":"","flights":1,"flightsDeleted":0,"tracks":0,"airframes":0,"images":0,"trackEncoding":"vstk1"}}"#
        )
    };
    let future = write_zip("f.vectasim", &[("manifest.json", &manifest(99))]);
    assert!(b.import_bundle(&future, &merge(&images)).unwrap_err().to_string().contains("neueren"));
    // a broken line aborts before anything is written
    let broken = write_zip(
        "b.vectasim",
        &[("manifest.json", &manifest(1)), ("flights.jsonl", "{\"flight\":{\"id\":\"n1\",\"state\":\"completed\"}}\n{nope\n")],
    );
    assert!(b.import_bundle(&broken, &merge(&images)).unwrap_err().to_string().contains("Zeile 2"));
    assert_eq!(all_ids(&b).len(), 1);
    // a minimal flight from another tool imports with defaults; a missing track is a warning
    let minimal = write_zip(
        "m.vectasim",
        &[
            ("manifest.json", &manifest(1)),
            (
                "flights.jsonl",
                r#"{"flight":{"id":"n1","state":"active","phase":"cruise","created_ms":5,"updated_ms":5,"future_column":1},"track":{"file":"tracks/n1.bin","sampleCount":3,"encoding":"vstk1","updatedMs":5}}"#,
            ),
        ],
    );
    let r = b.import_bundle(&minimal, &merge(&images)).unwrap();
    assert_eq!(r.flights_added, 1);
    assert_eq!(r.warnings, ["Flug n1: tracks/n1.bin fehlt, Flug ohne Track übernommen"]);
    // the warnings follow the language in the options
    let c = Store::open(&dir.path().join("c.db")).unwrap();
    let r = c.import_bundle(&minimal, &ImportOptions { lang: Lang::En, ..merge(&images) }).unwrap();
    assert_eq!(r.warnings, ["Flight n1: tracks/n1.bin missing, flight imported without track"]);
    let f = b.get_flight("n1").unwrap().unwrap();
    assert_eq!(f.flight.state, "interrupted", "an exported running flight is not running here");
    assert!(!f.has_track);
}

/// A runway end at (lat, lon) towards the east, `len_deg` of longitude long.
fn east_end(icao: &str, ident: &str, lat: f64, lon: f64, len_deg: f64) -> RunwayEnd {
    RunwayEnd {
        airport: icao.into(),
        ident: ident.into(),
        opposite_ident: "27".into(),
        threshold_lat: lat,
        threshold_lon: lon,
        end_lat: lat,
        end_lon: lon + len_deg,
        ..Default::default()
    }
}

fn pilot_runway(icao: &str, ident: &str, lon: f64) -> UserRunwayEdit {
    UserRunwayEdit {
        airport_icao: icao.into(),
        ident: ident.into(),
        lat_thr: 50.0,
        lon_thr: lon,
        lat_end: 50.0,
        lon_end: lon + 0.02,
        width_m: Some(23.0),
        ..Default::default()
    }
}

#[test]
fn remembered_runways_travel_with_the_bundle_and_merge() {
    let dir = tempfile::tempdir().unwrap();
    let a = Store::open(&dir.path().join("a.db")).unwrap();
    record_mock_flight(&a, T0);
    // derived from two landings, and one the pilot set
    a.refine_derived_runway(&east_end("EDXA", "09", 50.0, 8.0, 0.02), true, "f1", 0).unwrap();
    a.refine_derived_runway(&east_end("EDXA", "09", 50.0, 8.0002, 0.02), true, "f2", 0).unwrap();
    a.upsert_user_runway(&pilot_runway("EDXB", "07", 9.0), UserRunwaySource::User).unwrap();
    let file = dir.path().join("rwy.vectasim");
    let report = a.export_bundle(&file, &all_opts()).unwrap();
    assert_eq!(report.manifest.runways, 2);

    // into an empty logbook: rows as they were, the counted landings came along
    let b = Store::open_in_memory().unwrap();
    let r = b.import_bundle(&file, &merge(&dir.path().join("img"))).unwrap();
    assert_eq!((r.runways_added, r.runways_updated), (2, 0), "{r:?}");
    for icao in ["EDXA", "EDXB"] {
        assert_eq!(a.list_user_runways(icao).unwrap(), b.list_user_runways(icao).unwrap(), "{icao}");
    }
    let again = b.refine_derived_runway(&east_end("EDXA", "09", 50.0, 8.0, 0.02), true, "f2", 0).unwrap();
    assert!(matches!(again, RunwayRefinement::AlreadyCounted(_)), "{again:?}");
    // the same file again changes nothing
    let r = b.import_bundle(&file, &merge(&dir.path().join("img"))).unwrap();
    assert_eq!((r.runways_added, r.runways_updated), (0, 0), "{r:?}");
    assert_eq!(a.list_user_runways("EDXA").unwrap(), b.list_user_runways("EDXA").unwrap());

    // another PC: its own derived 09 (one other landing) and a derived 07 where a has the pilot's
    let c = Store::open_in_memory().unwrap();
    c.refine_derived_runway(&east_end("EDXA", "09", 50.0, 8.0006, 0.02), true, "g1", 0).unwrap();
    c.refine_derived_runway(&east_end("EDXB", "07", 50.0, 9.001, 0.02), true, "g2", 0).unwrap();
    let r = c.import_bundle(&file, &merge(&dir.path().join("img"))).unwrap();
    assert_eq!((r.runways_added, r.runways_updated), (0, 2), "{r:?}");
    let mine = c.list_user_runways("EDXA").unwrap().remove(0);
    let theirs = a.list_user_runways("EDXA").unwrap().remove(0);
    assert_eq!((mine.uses, mine.source), (3, UserRunwaySource::Derived), "1 here + 2 from the bundle");
    // weighted 1 : 2 between 8.0006 and the bundle's mean (8.0001)
    let expect = (8.0006 + 2.0 * theirs.lon_thr) / 3.0;
    assert!((mine.lon_thr - expect).abs() < 1e-9, "{} vs {expect}", mine.lon_thr);
    // the pilot's runway beats the derived one
    let set = c.list_user_runways("EDXB").unwrap().remove(0);
    assert_eq!((set.source, set.lon_thr, set.width_m), (UserRunwaySource::User, 9.0, Some(23.0)));

    // a pilot's runway here is kept against a derived one in the bundle
    let d = Store::open(&dir.path().join("d.db")).unwrap();
    d.refine_derived_runway(&east_end("EDXC", "09", 50.0, 10.0, 0.02), true, "h1", 0).unwrap();
    let derived_file = dir.path().join("derived.vectasim");
    d.export_bundle(&derived_file, &all_opts()).unwrap();
    let e = Store::open_in_memory().unwrap();
    e.upsert_user_runway(&pilot_runway("EDXC", "09", 10.001), UserRunwaySource::User).unwrap();
    let r = e.import_bundle(&derived_file, &merge(&dir.path().join("img"))).unwrap();
    assert_eq!((r.runways_added, r.runways_updated), (0, 0), "{r:?}");
    assert_eq!(e.list_user_runways("EDXC").unwrap()[0].lon_thr, 10.001);

    // Replace swaps the runways too
    let opts = ImportOptions { mode: ImportMode::Replace, images_dir: Some(dir.path().join("img")), backup_dir: Some(dir.path().join("bk")), lang: Lang::De };
    let f = Store::open(&dir.path().join("f.db")).unwrap();
    f.upsert_user_runway(&pilot_runway("EDXD", "09", 11.0), UserRunwaySource::User).unwrap();
    let r = f.import_bundle(&file, &opts).unwrap();
    assert_eq!(r.runways_added, 2);
    assert!(f.list_user_runways("EDXD").unwrap().is_empty());
    assert_eq!(f.list_user_runways("EDXB").unwrap().len(), 1);
}

#[test]
fn notes_tags_rating_and_corrections_travel_with_the_bundle() {
    use vectasim_store::FlightUserEdit;
    let dir = tempfile::tempdir().unwrap();
    let a = source_logbook(dir.path());
    let ids: Vec<String> = a.list_flights(10, 0).unwrap().into_iter().map(|f| f.id).collect();
    let plain = dir.path().join("plain.vectasim");
    a.export_bundle(&plain, &all_opts()).unwrap();

    let edit = FlightUserEdit {
        notes: Some("Böiger Wind,\nzweiter Anflug".into()),
        tags: Some(vec!["vatsim".into(), "Event".into()]),
        callsign: Some("DLH9X".into()),
        arr_icao: Some("EDDM".into()),
        rating: Some(4),
        ..Default::default()
    };
    let edited = a.update_flight_user(&ids[0], &edit, T0 + 40 * HOUR).unwrap().unwrap();
    let file = dir.path().join("edited.vectasim");
    a.export_bundle(&file, &all_opts()).unwrap();

    // into an empty logbook: the columns come along without any special handling
    let b = Store::open_in_memory().unwrap();
    b.import_bundle(&file, &merge(&dir.path().join("img-b"))).unwrap();
    assert_eq!(b.get_flight(&ids[0]).unwrap().unwrap().flight, edited);
    assert_eq!(b.list_tags().unwrap(), a.list_tags().unwrap());

    // a logbook that has the flight without the additions gets them on merge ...
    let c = Store::open_in_memory().unwrap();
    let images = dir.path().join("img-c");
    c.import_bundle(&plain, &merge(&images)).unwrap();
    assert_eq!(c.get_flight(&ids[0]).unwrap().unwrap().flight.notes, None);
    let r = c.import_bundle(&file, &merge(&images)).unwrap();
    assert_eq!((r.flights_added, r.flights_user_filled), (0, 1), "{r:?}");
    let f = c.get_flight(&ids[0]).unwrap().unwrap().flight;
    assert_eq!((f.notes, f.tags, f.user_callsign, f.user_arr_icao, f.rating), (edited.notes.clone(), edited.tags.clone(), edited.user_callsign.clone(), edited.user_arr_icao.clone(), Some(4)));

    // ... but its own ones win
    c.update_flight_user(&ids[0], &FlightUserEdit { notes: Some("meine".into()), ..Default::default() }, 0).unwrap();
    let r = c.import_bundle(&file, &merge(&images)).unwrap();
    assert_eq!(r.flights_user_filled, 0);
    assert_eq!(c.get_flight(&ids[0]).unwrap().unwrap().flight.notes.as_deref(), Some("meine"));
}
