use std::sync::Arc;
use vectasim_core::flight::{GeoPoint, haversine_nm};
use vectasim_core::{FlightSession, LandingRateSource, MockFlight};
use vectasim_store::{AirportResolver, FlightRecorder, MetarSlot, RecorderContext, Store, TrackSample, decode_track, encode_track};

/// Anything within range of the mock's start position is "EDDF"; everything else is unnamed.
struct FakeResolver;
impl AirportResolver for FakeResolver {
    fn nearest_ident(&self, lat: f64, lon: f64, max_nm: f64) -> Option<String> {
        let here = GeoPoint { latitude: lat, longitude: lon };
        let eddf = GeoPoint { latitude: 50.033, longitude: 8.570 };
        (haversine_nm(here, eddf) <= max_nm).then(|| "EDDF".to_string())
    }
}

fn sample(i: u64) -> TrackSample {
    TrackSample {
        t_ms: 1_700_000_000_000 + i * 1000,
        latitude: 50.0 + i as f64 * 0.001234567,
        longitude: 8.5 - i as f64 * 0.000987654,
        altitude_msl_ft: 364.0 + i as f64 * 12.3,
        altitude_agl_ft: i as f64 * 12.3,
        ground_speed_kt: 120.0 + (i % 7) as f64 * 0.5,
        ias_kt: 115.0 + (i % 5) as f64 * 0.3,
        vertical_speed_fpm: -700.0 + (i % 11) as f64 * 100.0,
        heading_true_deg: (i as f64 * 1.37) % 360.0,
        pitch_deg: 2.5 - (i % 3) as f64 * 0.25,
        bank_deg: (i % 9) as f64 - 4.0,
        g_force: 1.0 + (i % 4) as f64 * 0.013,
        on_ground: i < 10,
        flaps_index: (i % 5) as i32,
        gear_pct: if i < 20 { 100.0 } else { 0.0 },
        fuel_total_kg: 5000.0 - i as f64 * 0.4,
    }
}

#[test]
fn track_roundtrip_is_exact_within_quantisation() {
    let samples: Vec<_> = (0..3_600).map(sample).collect();
    let blob = encode_track(&samples);
    let per_sample = blob.len() as f64 / samples.len() as f64;
    assert!(per_sample < 40.0, "track too big: {per_sample:.1} bytes/sample");

    let decoded = decode_track(&blob).unwrap();
    assert_eq!(decoded.len(), samples.len());
    for (a, b) in samples.iter().zip(&decoded) {
        assert_eq!(a.t_ms, b.t_ms);
        assert!((a.latitude - b.latitude).abs() < 1e-6, "{a:?} vs {b:?}");
        assert!((a.longitude - b.longitude).abs() < 1e-6);
        assert!((a.altitude_msl_ft - b.altitude_msl_ft).abs() <= 0.05 + 1e-9);
        assert!((a.ground_speed_kt - b.ground_speed_kt).abs() <= 0.05 + 1e-9);
        assert!((a.vertical_speed_fpm - b.vertical_speed_fpm).abs() <= 0.5);
        assert!((a.heading_true_deg - b.heading_true_deg).abs() <= 0.005 + 1e-9);
        assert!((a.g_force - b.g_force).abs() <= 0.0005 + 1e-9);
        assert_eq!(a.on_ground, b.on_ground);
        assert_eq!(a.flaps_index, b.flaps_index);
        assert!((a.fuel_total_kg - b.fuel_total_kg).abs() <= 0.05 + 1e-9);
    }
}

/// Drive one mock loop (plus a bit, so the shutdown dwell elapses) through session + recorder.
fn record_mock_flight(store: &Store, hz: f64) -> FlightSession {
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), sim_name: Some("VectaSim Mock".into()), aircraft: Some(MockFlight::aircraft()) },
    )
    .with_resolver(Arc::new(FakeResolver));
    let steps = ((MockFlight::loop_seconds() + 10.0) * hz) as u64;
    for i in 1..=steps {
        let t_s = i as f64 / hz;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &events).unwrap();
    }
    session
}

#[test]
fn mock_flight_is_recorded_completely() {
    let store = Store::open_in_memory().unwrap();
    let session = record_mock_flight(&store, 20.0);

    let flights = store.list_flights(10, 0).unwrap();
    assert_eq!(flights.len(), 1);
    let f = &flights[0];
    assert_eq!(f.state, "completed");
    assert_eq!(f.aircraft.atc_model, "A20N");
    assert_eq!(f.provider.as_deref(), Some("mock"));
    assert_eq!(f.landing_count, 1);
    assert!(f.landing_vs_fpm.unwrap() < 0.0);
    assert_eq!(f.dep_icao.as_deref(), Some("EDDF"));
    let arrival = session.summary().arrival.expect("arrival recorded");
    let expected_arr = FakeResolver.nearest_ident(arrival.latitude, arrival.longitude, 3.0);
    assert_eq!(f.arr_icao, expected_arr, "arrival ICAO follows the landing position");
    assert_eq!(f.arr_icao.as_deref(), Some("EDDF"), "the mock lands back on EDDF 25C");
    assert!(f.off_block_ms.is_some() && f.takeoff_ms.is_some() && f.landing_ms.is_some() && f.on_block_ms.is_some());
    assert!((f.distance_nm - session.summary().distance_nm).abs() < 1e-9);

    let detail = store.get_flight(&f.id).unwrap().unwrap();
    assert_eq!(detail.touchdowns.len(), 1);
    assert_eq!(detail.phases.len(), 10, "{:?}", detail.phases);
    assert_eq!(detail.phases.first().unwrap().to, vectasim_core::FlightPhase::TaxiOut);
    assert_eq!(detail.phases.last().unwrap().to, vectasim_core::FlightPhase::Shutdown);
    assert!(detail.has_track);

    let track = store.get_track(&f.id).unwrap().unwrap();
    // 1 Hz between off-block and on-block
    let expected = (f.on_block_ms.unwrap() - f.off_block_ms.unwrap()) / 1000;
    assert!((track.len() as i64 - expected as i64).abs() <= 2, "track {} vs expected {expected}", track.len());
    assert!(track.windows(2).all(|w| w[1].t_ms > w[0].t_ms));
    assert!(track.iter().any(|s| !s.on_ground));

    let preview = store.get_track_preview(&f.id).unwrap().unwrap();
    assert!(preview.len() < track.len() / 10 && preview.len() > 5);
    assert_eq!(preview.last().unwrap().t_ms, track.last().unwrap().t_ms);

    let totals = store.totals().unwrap();
    assert_eq!((totals.flights, totals.completed, totals.landings), (1, 1, 1));
    assert!(totals.block_time_ms > totals.flight_time_ms);
    assert!(totals.avg_landing_vs_fpm.unwrap() < 0.0);

    assert!(store.delete_flight(&f.id).unwrap());
    assert!(store.get_flight(&f.id).unwrap().is_none());
    assert!(store.get_track(&f.id).unwrap().is_none(), "cascade delete");
}

#[test]
fn interrupted_flight_is_marked_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    {
        let store = Store::open(&path).unwrap();
        let mut flight = MockFlight::new();
        let mut session = FlightSession::new();
        let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), ..Default::default() });
        // 150 s: airborne, well before landing; one 60 s flush has happened
        for i in 1..=(150 * 20) {
            let t_s = i as f64 / 20.0;
            let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
            let events = session.update(&t);
            rec.on_telemetry(&t, session.summary(), &events).unwrap();
        }
        assert!(rec.current_flight_id().is_some());
        assert_eq!(store.list_flights(10, 0).unwrap()[0].state, "active");
        let track = store.get_track(rec.current_flight_id().unwrap()).unwrap().unwrap();
        assert!(track.len() >= 60, "flushed track has {} samples", track.len());
    }
    let store = Store::open(&path).unwrap();
    let flights = store.list_flights(10, 0).unwrap();
    assert_eq!(flights.len(), 1);
    assert_eq!(flights[0].state, "interrupted");
    assert!(flights[0].takeoff_ms.is_some());
}

#[test]
fn second_flight_starts_new_record() {
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);
    let totals = store.totals().unwrap();
    assert_eq!(totals.flights, 2);
    assert_eq!(store.list_flights(1, 0).unwrap().len(), 1);
    assert_eq!(store.list_flights(10, 1).unwrap().len(), 1);
}

#[test]
fn v1_database_is_migrated_to_current_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    {
        // hand-rolled v1 file: schema_version 1, flights table without the icao columns
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);
             CREATE TABLE flights (id TEXT PRIMARY KEY, state TEXT NOT NULL, phase TEXT NOT NULL, created_ms INTEGER NOT NULL,
               updated_ms INTEGER NOT NULL, off_block_ms INTEGER, takeoff_ms INTEGER, landing_ms INTEGER, on_block_ms INTEGER,
               dep_lat REAL, dep_lon REAL, arr_lat REAL, arr_lon REAL, max_alt_msl_ft REAL NOT NULL DEFAULT 0,
               distance_nm REAL NOT NULL DEFAULT 0, fuel_start_kg REAL, fuel_end_kg REAL, aircraft_title TEXT, atc_model TEXT,
               atc_type TEXT, atc_id TEXT, atc_airline TEXT, atc_flight_number TEXT, provider TEXT, sim_name TEXT,
               paused_ms INTEGER NOT NULL DEFAULT 0, pause_count INTEGER NOT NULL DEFAULT 0, slew_detected INTEGER NOT NULL DEFAULT 0,
               time_accel_detected INTEGER NOT NULL DEFAULT 0, max_sim_rate REAL NOT NULL DEFAULT 1, crashed INTEGER NOT NULL DEFAULT 0,
               fuel_increased_airborne INTEGER NOT NULL DEFAULT 0);
             INSERT INTO flights (id, state, phase, created_ms, updated_ms) VALUES ('old1', 'completed', 'shutdown', 1, 2);
             CREATE TABLE touchdowns (id INTEGER PRIMARY KEY, flight_id TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
               vs_fpm_measured REAL NOT NULL, vs_fpm_sim REAL NOT NULL, vs_fpm_hardest REAL NOT NULL, peak_g REAL NOT NULL,
               pitch_deg REAL NOT NULL, bank_deg REAL NOT NULL, ground_speed_kt REAL NOT NULL, heading_true_deg REAL NOT NULL,
               latitude REAL NOT NULL, longitude REAL NOT NULL, bounces INTEGER NOT NULL, touch_and_go INTEGER NOT NULL);
             -- full stop without a sim value, full stop with one, then a touch-and-go
             INSERT INTO touchdowns VALUES (1, 'old1', 10, -180.4, 0, -180.4, 1.1, 0, 0, 120, 90, 50, 8, 0, 0);
             INSERT INTO touchdowns VALUES (2, 'old1', 20, -150, -211.6, -150, 1.1, 0, 0, 120, 90, 50, 8, 0, 0);
             INSERT INTO touchdowns VALUES (3, 'old1', 30, -520, -530, -520, 1.4, 0, 0, 120, 90, 50, 8, 0, 1);",
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 6);
    let flights = store.list_flights(10, 0).unwrap();
    assert_eq!(flights.len(), 1);
    assert_eq!(flights[0].id, "old1");
    assert_eq!(flights[0].dep_icao, None);
    // pre-v4 touchdowns get their headline rate derived on read: sim value if any, else measured
    let detail = store.get_flight("old1").unwrap().unwrap();
    let rates: Vec<(f64, LandingRateSource)> = detail.touchdowns.iter().map(|t| (t.landing_rate_fpm, t.landing_rate_source)).collect();
    assert_eq!(rates, vec![(-180.0, LandingRateSource::Measured), (-212.0, LandingRateSource::Sim), (-530.0, LandingRateSource::Sim)]);
    // the flight's landing rate is the last full stop, not the touch-and-go and not the hardest
    assert_eq!(flights[0].landing_vs_fpm, Some(-212.0));
    let totals = store.totals().unwrap();
    assert_eq!(totals.landings, 2);
    assert!((totals.avg_landing_vs_fpm.unwrap() + 196.0).abs() < 1e-9);
    // reopening must not try to re-apply the migration
    drop(store);
    assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), 6);
}

#[test]
fn settings_and_plan_attachment() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 6);
    assert_eq!(store.get_setting("simbrief_user").unwrap(), None);
    store.set_setting("simbrief_user", "123456").unwrap();
    store.set_setting("simbrief_user", "654321").unwrap();
    assert_eq!(store.get_setting("simbrief_user").unwrap().as_deref(), Some("654321"));
    assert_eq!(store.all_settings().unwrap().len(), 1);

    // plan loaded before the flight starts is attached automatically
    let plan = vectasim_store::PlannedFlight {
        callsign: "DLH4YA".into(),
        dep_icao: "EDDF".into(),
        arr_icao: "LIRF".into(),
        block_s: 7200,
        fuel_ramp_kg: 8265.0,
        fuel_landing_kg: 2765.0,
        ofp_json: "{\"general\":{}}".into(),
        ..Default::default()
    };
    let planned = vectasim_store::PlannedSlot::default();
    *planned.lock().unwrap() = Some(plan.clone());
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), ..Default::default() })
        .with_planned(planned);
    for i in 1..=(60 * 10) {
        let t_s = i as f64 / 10.0;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &events).unwrap();
    }
    let id = store.active_flight_id().unwrap().expect("flight is active");
    let row = &store.list_flights(1, 0).unwrap()[0];
    assert_eq!(row.id, id);
    assert_eq!(row.callsign.as_deref(), Some("DLH4YA"));
    assert_eq!(row.planned_block_s, Some(7200));
    assert!(row.has_ofp);
    let detail = store.get_flight(&id).unwrap().unwrap();
    assert_eq!(detail.ofp_json.as_deref(), Some(plan.ofp_json.as_str()));

    // re-attaching replaces
    let mut plan2 = plan.clone();
    plan2.callsign = "DLH123".into();
    assert!(store.attach_plan(&id, &plan2).unwrap());
    assert_eq!(store.list_flights(1, 0).unwrap()[0].callsign.as_deref(), Some("DLH123"));
    assert!(!store.attach_plan("nope", &plan2).unwrap());
}

#[test]
fn metar_at_off_block_and_landing_is_stored() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 6);
    record_mock_flight(&store, 10.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    let f = &store.list_flights(1, 0).unwrap()[0];
    assert_eq!((f.dep_metar.as_deref(), f.arr_metar.as_deref()), (None, None));

    let dep = "EDDF 171220Z 25012KT 9999 FEW035 14/06 Q1013";
    let arr = "EDDF 171250Z 24015G25KT 9999 BKN030 13/06 Q1012";
    assert!(store.set_flight_metar(&id, MetarSlot::Departure, dep, 1_000).unwrap());
    assert!(store.set_flight_metar(&id, MetarSlot::Arrival, "EDDF 171220Z 00000KT CAVOK 14/06 Q1013", 2_000).unwrap());
    assert!(store.set_flight_metar(&id, MetarSlot::Arrival, arr, 3_000).unwrap(), "a later landing replaces it");
    assert!(!store.set_flight_metar("nope", MetarSlot::Arrival, arr, 3_000).unwrap());

    let d = store.get_flight(&id).unwrap().unwrap().flight;
    assert_eq!((d.dep_metar.as_deref(), d.dep_metar_ms), (Some(dep), Some(1_000)));
    assert_eq!((d.arr_metar.as_deref(), d.arr_metar_ms), (Some(arr), Some(3_000)));
}

#[test]
fn v4_logbook_is_migrated_to_current() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    {
        let store = Store::open(&path).unwrap();
        record_mock_flight(&store, 10.0);
    }
    // turn the file back into a v4 logbook
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        for c in ["dep_metar", "dep_metar_ms", "arr_metar", "arr_metar_ms"] {
            conn.execute(&format!("ALTER TABLE flights DROP COLUMN {c}"), []).unwrap();
        }
        conn.execute_batch("DROP INDEX flights_airframe; ALTER TABLE flights DROP COLUMN airframe_reg; DROP TABLE airframes;").unwrap();
        conn.execute("UPDATE schema_version SET version = 4", []).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 6);
    let f = &store.list_flights(1, 0).unwrap()[0];
    assert_eq!(f.state, "completed");
    assert!(f.arr_metar.is_none());
    assert!(store.set_flight_metar(&f.id, MetarSlot::Arrival, "EDDF 171250Z 24015KT CAVOK 13/06 Q1012", 1).unwrap());
}
