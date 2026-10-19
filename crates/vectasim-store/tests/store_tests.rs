use std::sync::Arc;
use vectasim_core::flight::{GeoPoint, haversine_nm};
use vectasim_core::{FlightSession, LandingRateSource, MockFlight, MockVariant};
use vectasim_store::{
    AirportResolver, FlightRecorder, MetarSlot, RecorderContext, SCHEMA_VERSION, Store, StoreError, TrackSample, decode_track, encode_track,
};

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
        ..Default::default()
    }
}

#[test]
fn v2_track_of_the_mock_flight_stays_small() {
    // a whole mock circuit at the recorder's 1 Hz, with every approach value of track v2
    let mut f = vectasim_core::MockFlight::with_variant(vectasim_core::MockVariant::Circuit);
    let samples: Vec<TrackSample> =
        (0..600).map(|i| TrackSample::from(&f.sample(i as f64, 1_700_000_000_000 + i * 1000))).collect();
    assert!(samples.iter().all(|s| s.tas_kt.is_some() && s.wind_kt.is_some() && s.nav_flags.is_some()));
    let blob = encode_track(&samples);
    let per_sample = blob.len() as f64 / samples.len() as f64;
    assert!(per_sample < 60.0, "v2 track too big: {per_sample:.1} bytes/sample");
    let back = decode_track(&blob).unwrap();
    assert_eq!(back.len(), samples.len());
    assert_eq!(back[300].nav_flags, samples[300].nav_flags);
    assert_eq!(back[300].flap_positions, Some(5));
    println!("v2 track of the mock: {per_sample:.1} bytes/sample");

    // what the debrief's measurement log shows for the landing
    let td = back.windows(2).find(|w| !w[0].on_ground && w[1].on_ground && w[0].altitude_agl_ft < 100.0).map(|w| w[1].t_ms).expect("landing");
    let r = vectasim_store::recorded_approach_data(&back, td).expect("v2 data");
    assert_eq!((r.wind_dir_true_deg, r.wind_kt), (Some(250.0), Some(8.0)));
    assert!(r.nav_flags_recorded && r.has_localizer && r.has_glide_slope && r.glide_slope_valid && r.autopilot_seen);
    assert_eq!((r.ils_gs_angle_deg, r.flap_positions, r.design_vs0_kt), (Some(3.0), Some(5), Some(104.0)));
    // a v1 track has none of it
    let v1: Vec<TrackSample> = (0..300).map(sample).collect();
    assert!(vectasim_store::recorded_approach_data(&v1, v1[299].t_ms).is_none());
    // the approach analysis gets the recorded values, the ILS deviations only with the station component
    let a = back[td_index(&back, td) - 5].to_approach_sample();
    assert!(a.tas_kt.is_some() && a.wind_kt == Some(8.0) && a.gs_error_deg.is_some() && a.loc_cdi.is_some());
    assert_ne!(a.nav_flags & vectasim_core::approach::nav_flags::HAS_GLIDE_SLOPE, 0);
    assert!(a.nav_recorded && a.gs_angle_deg == Some(3.0), "{a:?}");
    assert!(!v1[10].to_approach_sample().nav_recorded, "v1: no ILS state, not 'all off'");
}

fn td_index(track: &[TrackSample], t_ms: u64) -> usize {
    track.iter().position(|s| s.t_ms == t_ms).unwrap()
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
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), sim_name: Some("VectaSim Mock".into()), aircraft: Some(MockFlight::aircraft()) },
    )
    .with_resolver(Arc::new(FakeResolver));
    let steps = ((MockVariant::Circuit.loop_seconds() + 10.0) * hz) as u64;
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

    assert!(store.delete_flight_permanently(&f.id).unwrap());
    assert!(store.get_flight(&f.id).unwrap().is_none());
    assert!(store.get_track(&f.id).unwrap().is_none(), "cascade delete");
}

/// The demo flight (standard variant) starts in the air on the downwind of EDDF 25C; each
/// loop after the first begins with `FlightLoaded`, like a sim loading a new flight.
#[test]
fn demo_flight_is_recorded_from_its_start_in_the_air() {
    use vectasim_core::ProviderEvent;
    let store = Store::open_in_memory().unwrap();
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), sim_name: Some("VectaSim Mock".into()), aircraft: Some(MockFlight::aircraft()) },
    )
    .with_resolver(Arc::new(FakeResolver));
    let hz = 10.0;
    for i in 1..=((2.0 * MockFlight::loop_seconds() - 1.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        let now = 1_700_000_000_000 + (t_s * 1000.0) as u64;
        for pe in flight.step(t_s, now) {
            match pe {
                ProviderEvent::Telemetry(t) => {
                    let events = session.update(&t);
                    rec.on_telemetry(&t, session.summary(), &events).unwrap();
                }
                ProviderEvent::Sim(e) => {
                    let events = session.on_sim_event(&e);
                    rec.on_events(session.summary(), &events, now).unwrap();
                }
                _ => {}
            }
        }
    }
    let flights = store.list_flights(10, 0).unwrap();
    assert_eq!(flights.len(), 2, "one flight per loop");
    for f in &flights {
        assert_eq!((f.state.as_str(), f.landing_count), ("completed", 1));
        assert!(!f.integrity.teleport_detected, "a new flight, not a jump in the old one");
        // recorded from the first sample: block time from there, no take-off seen
        assert!(f.off_block_ms.is_some() && f.landing_ms.is_some() && f.on_block_ms.is_some());
        assert_eq!(f.takeoff_ms, None);
        let block = f.on_block_ms.unwrap() - f.off_block_ms.unwrap();
        assert!((250_000..=300_000).contains(&block), "block {block} ms");
        // the downwind is > 3 nm from the airport: no departure airport, the arrival is EDDF
        assert_eq!(f.dep_icao, None);
        assert_eq!(f.arr_icao.as_deref(), Some("EDDF"));
        let rate = f.landing_vs_fpm.unwrap();
        assert!((-245.0..=-215.0).contains(&rate), "the demo landing: {rate}");
        let detail = store.get_flight(&f.id).unwrap().unwrap();
        assert_eq!(detail.phases.first().unwrap().to, vectasim_core::FlightPhase::Cruise, "{:?}", detail.phases);
        assert_eq!(detail.phases.last().unwrap().to, vectasim_core::FlightPhase::Shutdown);
        assert_eq!(detail.touchdowns.len(), 1);
    }
}

#[test]
fn interrupted_flight_is_marked_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    {
        let store = Store::open(&path).unwrap();
        let mut flight = MockFlight::with_variant(MockVariant::Circuit);
        let mut session = FlightSession::new();
        let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), ..Default::default() });
        // 150 s: airborne, well before landing; several 15 s flushes have happened
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

/// Hand-rolled v1 file: schema_version 1, flights table without the icao columns, one flight
/// with three touchdowns.
const V1_SQL: &str = "CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);
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
             INSERT INTO touchdowns VALUES (3, 'old1', 30, -520, -530, -520, 1.4, 0, 0, 120, 90, 50, 8, 0, 1);";

#[test]
fn v1_database_is_migrated_to_current_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    {
        // hand-rolled v1 file: schema_version 1, flights table without the icao columns
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(V1_SQL).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
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
    assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn settings_and_plan_attachment() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
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
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
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
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
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
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let f = &store.list_flights(1, 0).unwrap()[0];
    assert_eq!(f.state, "completed");
    assert!(f.arr_metar.is_none());
    assert!(store.set_flight_metar(&f.id, MetarSlot::Arrival, "EDDF 171250Z 24015KT CAVOK 13/06 Q1012", 1).unwrap());
}

#[test]
fn landing_facts_are_cached_per_touchdown_and_go_with_the_flight() {
    use vectasim_store::store::LandingFactCache;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let store = Store::open(&path).unwrap();
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);

    // mock flights are demo flights
    assert!(store.recent_landings(20, false).unwrap().is_empty());
    let all = store.recent_landings(20, true).unwrap();
    assert_eq!(all.len(), 2);
    assert!(all[0].touchdown.timestamp_ms >= all[1].touchdown.timestamp_ms, "newest first");
    assert!(all.iter().all(|l| l.touchdown_index == 0 && l.cached.is_none() && !l.touchdown.touch_and_go));
    assert_eq!(store.recent_landings(1, true).unwrap().len(), 1);

    let fact = LandingFactCache {
        version: 1,
        matched: true,
        airport_icao: Some("EDDF".into()),
        runway_ident: Some("25C".into()),
        touchdown_distance_m: Some(412.5),
        centerline_offset_m: Some(-2.25),
        in_touchdown_zone: true,
        runway_source: Some("derived".into()),
    };
    let id = all[0].flight.id.clone();
    assert!(store.put_landing_fact(&id, 0, &fact).unwrap());
    // replacing is fine; an unknown flight is refused
    assert!(store.put_landing_fact(&id, 0, &LandingFactCache { version: 2, ..fact.clone() }).unwrap());
    assert!(!store.put_landing_fact("nope", 0, &fact).unwrap());

    let again = store.recent_landings(20, true).unwrap();
    let cached = again.iter().find(|l| l.flight.id == id).unwrap().cached.clone().unwrap();
    assert_eq!(cached, LandingFactCache { version: 2, ..fact });
    assert!(again.iter().find(|l| l.flight.id != id).unwrap().cached.is_none());

    assert!(store.delete_flight_permanently(&id).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM landing_facts", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "cache rows go with the flight");
}

/// Approach facts of a recorded flight: computed from the stored track, phases and touchdowns.
fn approach_rows(store: &Store, id: &str) -> Vec<vectasim_store::ApproachFactRow> {
    use vectasim_core::approach::{self, AircraftRef, ApproachConfig, PhaseMark};
    let detail = store.get_flight(id).unwrap().unwrap();
    let track: Vec<_> = store.get_track(id).unwrap().unwrap().iter().map(TrackSample::to_approach_sample).collect();
    let phases: Vec<PhaseMark> = detail.phases.iter().map(|p| PhaseMark { from: p.from, to: p.to, t_ms: p.timestamp_ms }).collect();
    let rwy = MockFlight::runway();
    approach::analyze_flight(&track, &phases, &detail.touchdowns, std::slice::from_ref(&rwy), &AircraftRef::default(), &ApproachConfig::default())
        .iter()
        .map(vectasim_store::ApproachFactRow::from_analysis)
        .collect()
}

#[test]
fn approach_facts_are_cached_per_flight_versioned_and_cascade() {
    use vectasim_store::APPROACH_FACTS_VERSION;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    let store = Store::open(&path).unwrap();
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);

    assert!(store.recent_approach_facts(20, false).unwrap().is_empty(), "mock flights are demo flights");
    let recent = store.recent_approach_facts(20, true).unwrap();
    assert_eq!(recent.len(), 2);
    assert!(recent.iter().all(|r| r.has_track && r.cached_version.is_none() && r.facts.is_empty()));
    let (id, other) = (recent[0].flight.id.clone(), recent[1].flight.id.clone());

    // the mock's one approach, from the stored 1 Hz track
    let rows = approach_rows(&store, &id);
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!((r.outcome.as_str(), r.touchdown_index, r.runway_ident.as_deref()), ("landed", Some(0), Some("25C")));
    assert!(r.stable_from_ft.unwrap() >= 1000.0 && r.g1000_pass == Some(true) && r.g500_pass == Some(true), "{r:?}");
    assert_eq!(r.vapp_source.as_deref(), Some("flown"));
    // track v2: the mock records its ILS 25C, which is the reference now
    assert_eq!(r.gp_source.as_deref(), Some("ils"));
    let detail = r.detail().unwrap();
    assert_eq!(detail.band, Some(vectasim_core::approach::ApproachBand::Stable));
    assert!(detail.exceeded.is_empty());

    assert!(store.put_approach_facts(&id, APPROACH_FACTS_VERSION, &rows).unwrap());
    assert!(!store.put_approach_facts("nope", APPROACH_FACTS_VERSION, &rows).unwrap());
    let back = store.approach_facts_for_flight(&id).unwrap();
    assert_eq!(back.len(), 1);
    assert!(back[0].computed_ms > 0);
    assert_eq!(vectasim_store::ApproachFactRow { computed_ms: 0, ..back[0].clone() }, rows[0]);

    // no assessable approach: a marker row, not returned as a fact, but the flight counts as computed
    assert!(store.put_approach_facts(&other, APPROACH_FACTS_VERSION, &[]).unwrap());
    assert!(store.approach_facts_for_flight(&other).unwrap().is_empty());
    let recent = store.recent_approach_facts(20, true).unwrap();
    let o = recent.iter().find(|x| x.flight.id == other).unwrap();
    assert_eq!((o.cached_version, o.facts.len()), (Some(APPROACH_FACTS_VERSION), 0));
    let f = recent.iter().find(|x| x.flight.id == id).unwrap();
    assert_eq!((f.cached_version, f.facts.len()), (Some(APPROACH_FACTS_VERSION), 1));

    // an older version is visible as such; replacing removes the old rows
    let stale = vectasim_store::ApproachFactRow { version: APPROACH_FACTS_VERSION + 7, ..rows[0].clone() };
    assert!(store.put_approach_facts(&id, 0, &[stale.clone(), vectasim_store::ApproachFactRow { approach_index: 1, ..stale.clone() }]).unwrap());
    let f = store.recent_approach_facts(20, true).unwrap().into_iter().find(|x| x.flight.id == id).unwrap();
    assert_eq!((f.cached_version, f.facts.len()), (Some(APPROACH_FACTS_VERSION + 7), 2));
    assert!(store.put_approach_facts(&id, APPROACH_FACTS_VERSION, &rows).unwrap());
    assert_eq!(store.approach_facts_for_flight(&id).unwrap().len(), 1);
    assert_eq!(store.recent_approach_facts(1, true).unwrap().len(), 1);

    // rows go with their flight
    assert!(store.delete_flight_permanently(&id).unwrap());
    assert!(store.delete_flight_permanently(&other).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM approach_facts", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "approach facts go with the flight");
}

#[test]
fn approach_analysis_json_is_camel_case() {
    use vectasim_core::approach::{self, AircraftRef, ApproachBand, ApproachConfig, ApproachOutcome};
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    let detail = store.get_flight(&id).unwrap().unwrap();
    let track: Vec<_> = store.get_track(&id).unwrap().unwrap().iter().map(TrackSample::to_approach_sample).collect();
    let all = approach::analyze_flight(&track, &[], &detail.touchdowns, &[MockFlight::runway()], &AircraftRef::default(), &ApproachConfig::default());
    let v = serde_json::to_value(&all[0]).unwrap();
    assert_eq!(v["outcome"], serde_json::json!({"kind": "landed", "touchdownIndex": 0}));
    assert_eq!(v["band"], "stable");
    assert!(v["stability"]["stableFromFt"].is_number());
    assert_eq!(v["gates"][0]["kind"], "tenNm");
    assert_eq!(v["elevationSource"], "touchdown");
    assert_eq!(serde_json::to_value(ApproachBand::UnstableBelow500).unwrap(), "unstableBelow500");
    assert_eq!(serde_json::to_value(ApproachOutcome::GoAround).unwrap(), serde_json::json!({"kind": "goAround"}));
}

// ---- Phase 3: safe migrations, downgrade lock, Papierkorb ---------------------------------

fn backups_in(dir: &std::path::Path) -> Vec<vectasim_store::BackupEntry> {
    vectasim_store::backup::list_backups(dir).unwrap()
}

#[test]
fn migration_copies_the_file_first_and_names_the_old_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    rusqlite::Connection::open(&path).unwrap().execute_batch(V1_SQL).unwrap();
    let backups = dir.path().join("backups");
    let store = Store::open_with_backup_dir(&path, &backups).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    let list = backups_in(&backups);
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].kind.as_str(), list[0].schema_from), ("preMigration", Some(1)));
    assert!(list[0].file_name.starts_with("vectasim-pre-v1-"), "{}", list[0].file_name);
    // the copy is the untouched v1 logbook
    let check = vectasim_store::backup::inspect(std::path::Path::new(&list[0].path)).unwrap();
    assert_eq!((check.schema_version, check.flights), (1, 1));
    // an up-to-date file is opened without another copy; a brand-new one never gets one
    drop(store);
    Store::open_with_backup_dir(&path, &backups).unwrap();
    Store::open_with_backup_dir(&dir.path().join("new.db"), &backups).unwrap();
    assert_eq!(backups_in(&backups).len(), 1);
}

#[test]
fn failing_migration_is_rolled_back_and_leaves_data_and_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    {
        // a v2 logbook on which step v3 fails half-way: `callsign` (its first ALTER) would
        // succeed, `planned_dep` already exists -> "duplicate column name"
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(V1_SQL).unwrap();
        conn.execute_batch(
            "ALTER TABLE flights ADD COLUMN dep_icao TEXT; ALTER TABLE flights ADD COLUMN arr_icao TEXT;
             ALTER TABLE flights ADD COLUMN planned_dep TEXT; UPDATE schema_version SET version = 2;",
        )
        .unwrap();
    }
    let backups = dir.path().join("backups");
    let err = Store::open_with_backup_dir(&path, &backups).err().expect("migration must fail");
    let StoreError::Migration { from, to, ref backup, .. } = err else { panic!("unexpected error {err:?}") };
    assert_eq!((from, to), (2, 3));
    let backup = backup.clone().expect("copy made before migrating");
    assert!(backup.is_file());
    assert_eq!(err.backup_path(), Some(backup.as_path()));

    // version and columns unchanged: nothing of step v3 survived, the flight is still there
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        let v: i64 = conn.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 2);
        let callsign: i64 =
            conn.query_row("SELECT COUNT(*) FROM pragma_table_info('flights') WHERE name = 'callsign'", [], |r| r.get(0)).unwrap();
        assert_eq!(callsign, 0, "rolled back");
        let settings: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'settings'", [], |r| r.get(0)).unwrap();
        assert_eq!(settings, 0, "CREATE TABLE of the failed step rolled back too");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM flights", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // repair the cause ...
        conn.execute_batch("ALTER TABLE flights DROP COLUMN planned_dep").unwrap();
    }
    assert_eq!(vectasim_store::backup::inspect(&backup).unwrap().schema_version, 2);
    // ... and the next start migrates all the way
    let store = Store::open_with_backup_dir(&path, &backups).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.list_flights(10, 0).unwrap()[0].id, "old1");
}

#[test]
fn newer_schema_is_refused_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    {
        let store = Store::open(&path).unwrap();
        store.set_setting("k", "v").unwrap();
    }
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE schema_version SET version = ?1", [SCHEMA_VERSION + 1]).unwrap();
    let backups = dir.path().join("backups");
    match Store::open_with_backup_dir(&path, &backups) {
        Err(StoreError::NewerSchema { found, supported }) => assert_eq!((found, supported), (SCHEMA_VERSION + 1, SCHEMA_VERSION)),
        other => panic!("expected NewerSchema, got {:?}", other.err()),
    }
    let conn = rusqlite::Connection::open(&path).unwrap();
    let v: i64 = conn.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, SCHEMA_VERSION + 1);
    assert!(backups_in(&backups).is_empty(), "no copy, no migration");
}

#[test]
fn v10_migration_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    drop(Store::open(&path).unwrap());
    // column already there, version number rolled back
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE schema_version SET version = 9", []).unwrap();
    assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn v11_migration_adds_the_airframe_vapp_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    drop(Store::open(&path).unwrap());
    let has_vapp = |p: &std::path::Path| -> i64 {
        rusqlite::Connection::open(p)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pragma_table_info('airframes') WHERE name = 'vapp_kt'", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(has_vapp(&path), 1);
    // a v10 logbook (no column) is brought to v11
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("ALTER TABLE airframes DROP COLUMN vapp_kt; UPDATE schema_version SET version = 10;")
        .unwrap();
    assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(has_vapp(&path), 1);
    // column already there, version number rolled back
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE schema_version SET version = 10", []).unwrap();
    assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn trash_hides_flights_everywhere_and_restores_or_purges_them() {
    const DAY: u64 = 86_400_000;
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);
    let ids: Vec<String> = store.list_flights(10, 0).unwrap().into_iter().map(|f| f.id).collect();
    let (gone, kept) = (ids[0].clone(), ids[1].clone());
    let reg = store.get_flight(&gone).unwrap().unwrap().flight.airframe_reg.expect("mock books an airframe");
    let airframe_counts = |s: &Store| {
        let a = s.list_airframes(true).unwrap().into_iter().find(|a| a.airframe.registration == reg).unwrap();
        (a.flights, a.total_flights, a.landings)
    };
    assert_eq!(airframe_counts(&store), (2, 2, 2));

    let t0 = 1_800_000_000_000;
    assert!(store.delete_flight_at(&gone, t0).unwrap());
    assert!(!store.delete_flight_at(&gone, t0 + 5).unwrap(), "already in the trash");
    let listed: Vec<String> = store.list_flights(10, 0).unwrap().into_iter().map(|f| f.id).collect();
    assert_eq!(listed, vec![kept.clone()]);
    let totals = store.totals().unwrap();
    assert_eq!((totals.flights, totals.landings), (1, 1));
    assert!(store.recent_landings(20, true).unwrap().iter().all(|l| l.flight.id != gone));
    assert!(store.recent_approach_facts(20, true).unwrap().iter().all(|r| r.flight.id != gone));
    assert_eq!(airframe_counts(&store), (1, 1, 1));
    assert!(store.airframe_flights(&reg, 10).unwrap().iter().all(|f| f.id != gone));
    // still complete, just hidden
    assert!(store.get_flight(&gone).unwrap().unwrap().has_track);
    let trash = store.list_deleted_flights().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!((trash[0].flight.id.as_str(), trash[0].deleted_ms), (gone.as_str(), t0));
    assert_eq!(store.deleted_count().unwrap(), 1);
    let c = store.flight_counts().unwrap();
    assert_eq!((c.flights, c.deleted, c.last_deleted_ms), (1, 1, Some(t0)));
    assert!(c.last_updated_ms.is_some());

    assert!(store.restore_flight(&gone).unwrap());
    assert_eq!(store.flight_counts().unwrap().deleted, 0);
    assert!(!store.restore_flight(&gone).unwrap());
    assert_eq!(store.list_flights(10, 0).unwrap().len(), 2);
    assert_eq!(store.totals().unwrap().flights, 2);
    assert_eq!(airframe_counts(&store), (2, 2, 2));

    // purge after 30 days, not before
    assert!(store.delete_flight_at(&gone, t0).unwrap());
    assert_eq!(store.purge_deleted(30, t0 + 30 * DAY - 1).unwrap(), 0);
    assert_eq!(store.purge_deleted(30, t0 + 30 * DAY).unwrap(), 1);
    assert!(store.get_flight(&gone).unwrap().is_none());
    assert!(store.get_track(&gone).unwrap().is_none(), "rows go with the purge");
    assert_eq!(store.deleted_count().unwrap(), 0);

    // "Papierkorb leeren" = purge with 0 days; permanent delete of a single flight
    assert!(store.delete_flight_at(&kept, t0).unwrap());
    assert_eq!(store.purge_deleted(0, t0).unwrap(), 1);
    assert!(store.list_flights(10, 0).unwrap().is_empty());
    record_mock_flight(&store, 10.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    assert!(store.delete_flight_permanently(&id).unwrap());
    assert!(store.get_flight(&id).unwrap().is_none());
}

#[test]
fn delete_all_data_removes_flights_and_airframes_but_keeps_settings() {
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);
    let first = store.list_flights(1, 0).unwrap()[0].id.clone();
    store.delete_flight(&first).unwrap();
    store.set_setting("simbrief_user", "1").unwrap();
    assert_eq!(store.delete_all_data().unwrap(), 2, "trash included");
    assert!(store.list_flights(10, 0).unwrap().is_empty());
    assert!(store.list_deleted_flights().unwrap().is_empty());
    assert!(store.list_airframes(true).unwrap().is_empty());
    assert_eq!(store.get_setting("simbrief_user").unwrap().as_deref(), Some("1"));
}

// ---- remembered runways (v12) ---------------------------------------------------------

/// Runway 09 at 50°N 8°E: threshold `thr_m` metres east of 8°E, `len_m` long, `north_m` north.
fn runway09_end(thr_m: f64, len_m: f64, north_m: f64) -> vectasim_core::landing::RunwayEnd {
    use vectasim_core::landing::{RunwayEnd, offset_point};
    let (lat, lon) = offset_point(50.0, 8.0, 0.0, north_m);
    let (thr_lat, thr_lon) = offset_point(lat, lon, 90.0, thr_m);
    let (end_lat, end_lon) = offset_point(thr_lat, thr_lon, 90.0, len_m);
    RunwayEnd {
        airport: "dx-0001".into(),
        ident: "09".into(),
        opposite_ident: "27".into(),
        threshold_lat: thr_lat,
        threshold_lon: thr_lon,
        end_lat,
        end_lon,
        elevation_ft: Some(400.0),
        ..Default::default()
    }
}

fn east_of_8e_m(lat: f64, lon: f64) -> f64 {
    (lon - 8.0).to_radians() * 6_371_008.8 * lat.to_radians().cos()
}

#[test]
fn derived_runway_is_stored_once_per_landing_and_refined_by_the_next() {
    use vectasim_store::{RunwayRefinement, UserRunwaySource};
    let store = Store::open_in_memory().unwrap();

    // first landing: stored as derived, key normalised
    let first = store.refine_derived_runway(&runway09_end(0.0, 1200.0, 0.0), true, "f1", 0).unwrap();
    let RunwayRefinement::Inserted(r) = &first else { panic!("{first:?}") };
    assert_eq!((r.airport_icao.as_str(), r.ident.as_str(), r.source, r.uses, r.length_estimated), ("DX-0001", "09", UserRunwaySource::Derived, 1, true));
    assert_eq!(r.width_m, None, "width unknown");
    // the same landing analysed again does not count twice
    let again = store.refine_derived_runway(&runway09_end(0.0, 1200.0, 0.0), true, "f1", 0).unwrap();
    assert!(matches!(again, RunwayRefinement::AlreadyCounted(ref r) if r.uses == 1), "{again:?}");

    // second landing 40 m further on and 4 m north, rollout longer: mean of both, longer length
    let second = store.refine_derived_runway(&runway09_end(40.0, 1400.0, 4.0), true, "f2", 0).unwrap();
    let RunwayRefinement::Refined(r) = &second else { panic!("{second:?}") };
    assert_eq!(r.uses, 2);
    assert!((east_of_8e_m(r.lat_thr, r.lon_thr) - 20.0).abs() < 0.5, "{}", east_of_8e_m(r.lat_thr, r.lon_thr));
    assert!(((r.lat_thr - 50.0).to_radians() * 6_371_008.8 - 2.0).abs() < 0.2);
    let e = r.runway_end();
    let f = vectasim_core::landing::RunwayFrame::new(&e);
    assert!((f.heading_deg - 90.0).abs() < 0.1 && (f.length_m - 1400.0).abs() < 2.0, "{} {}", f.heading_deg, f.length_m);
    assert_eq!(e.opposite_ident, "27");
    assert!(r.reverse_end().is_none(), "a derived far end is no threshold");
    // a third estimate weighs 1/3
    let RunwayRefinement::Refined(r) = store.refine_derived_runway(&runway09_end(80.0, 1400.0, 2.0), true, "f3", 1).unwrap() else { panic!() };
    assert_eq!(r.uses, 3);
    assert!((east_of_8e_m(r.lat_thr, r.lon_thr) - 40.0).abs() < 0.5);

    // an estimate that does not fit (other strip 200 m north) leaves it alone
    let off = store.refine_derived_runway(&runway09_end(0.0, 1200.0, 200.0), true, "f4", 0).unwrap();
    assert!(matches!(off, RunwayRefinement::Kept(ref r) if r.uses == 3));

    assert_eq!(store.list_user_runways("dx-0001").unwrap().len(), 1);
    assert_eq!(store.user_runways_near(50.0, 8.0, 0.05, 0.05).unwrap().len(), 1);
    assert!(store.user_runways_near(51.0, 8.0, 0.05, 0.05).unwrap().is_empty());

    // delete: forgets the landings too, so the next one starts afresh
    assert!(store.delete_user_runway("DX-0001", "09").unwrap());
    assert!(!store.delete_user_runway("DX-0001", "09").unwrap());
    let fresh = store.refine_derived_runway(&runway09_end(0.0, 1200.0, 0.0), true, "f1", 0).unwrap();
    assert!(matches!(fresh, RunwayRefinement::Inserted(ref r) if r.uses == 1));
}

#[test]
fn runway_set_by_the_pilot_wins_and_is_never_refined() {
    use vectasim_store::{RunwayRefinement, UserRunwayEdit, UserRunwaySource};
    let store = Store::open_in_memory().unwrap();
    store.refine_derived_runway(&runway09_end(0.0, 1200.0, 0.0), true, "f1", 0).unwrap();
    store.refine_derived_runway(&runway09_end(20.0, 1200.0, 0.0), true, "f2", 0).unwrap();

    // the pilot corrects the threshold and the length of the derived "09"
    let e = runway09_end(-150.0, 900.0, 0.0);
    let edit = UserRunwayEdit {
        airport_icao: "DX-0001".into(),
        ident: "09".into(),
        lat_thr: e.threshold_lat,
        lon_thr: e.threshold_lon,
        lat_end: e.end_lat,
        lon_end: e.end_lon,
        width_m: Some(20.0),
        elevation_ft: Some(395.0),
        ..Default::default()
    };
    let saved = store.upsert_user_runway(&edit, UserRunwaySource::User).unwrap();
    assert_eq!((saved.source, saved.uses, saved.width_m, saved.length_estimated), (UserRunwaySource::User, 2, Some(20.0), false));
    let rev = saved.reverse_end().expect("both ends of a user runway are thresholds");
    assert_eq!((rev.ident.as_str(), rev.opposite_ident.as_str()), ("27", "09"));

    // later landings leave it as the pilot set it
    let later = store.refine_derived_runway(&runway09_end(60.0, 1500.0, 1.0), true, "f3", 0).unwrap();
    assert!(matches!(later, RunwayRefinement::Kept(ref r) if *r == saved), "{later:?}");

    // renaming the designator (it is a 10, not a 09) moves the row
    let renamed = store.upsert_user_runway(&UserRunwayEdit { ident: "10".into(), previous_ident: Some("09".into()), ..edit.clone() }, UserRunwaySource::User).unwrap();
    assert_eq!((renamed.ident.as_str(), renamed.uses, renamed.created_ms), ("10", 2, saved.created_ms));
    let all = store.list_user_runways("DX-0001").unwrap();
    assert_eq!(all.iter().map(|r| r.ident.as_str()).collect::<Vec<_>>(), vec!["10"]);

    // implausible input is refused
    for bad in [
        UserRunwayEdit { airport_icao: "".into(), ..edit.clone() },
        UserRunwayEdit { ident: "09 L".into(), ..edit.clone() },
        UserRunwayEdit { lat_end: edit.lat_thr, lon_end: edit.lon_thr, ..edit.clone() },
        UserRunwayEdit { lat_thr: f64::NAN, ..edit.clone() },
        UserRunwayEdit { width_m: Some(0.0), ..edit.clone() },
    ] {
        assert!(matches!(store.upsert_user_runway(&bad, UserRunwaySource::User), Err(StoreError::Invalid(_))), "{bad:?}");
    }
    // "delete all data" forgets them
    store.delete_all_data().unwrap();
    assert!(store.list_user_runways("DX-0001").unwrap().is_empty());
}

#[test]
fn migration_v12_adds_user_runways_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    const { assert!(SCHEMA_VERSION >= 12) };
    {
        let store = Store::open(&path).unwrap();
        record_mock_flight(&store, 10.0);
        store.refine_derived_runway(&runway09_end(0.0, 1200.0, 0.0), true, "f1", 0).unwrap();
    }
    // a v11 file: no runway tables, no runway_source column
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE user_runways; DROP TABLE user_runway_landings; ALTER TABLE landing_facts DROP COLUMN runway_source;
             UPDATE schema_version SET version = 11;",
        )
        .unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.list_user_runways("DX-0001").unwrap().is_empty());
        store.refine_derived_runway(&runway09_end(0.0, 1200.0, 0.0), true, "f1", 0).unwrap();
    }
    // a file that has v12's tables but says v11 (rolled back version number): migrates again, keeps the rows
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE schema_version SET version = 11", []).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.list_user_runways("DX-0001").unwrap()[0].uses, 1);
    assert_eq!(store.list_flights(10, 0).unwrap().len(), 1);
}

// ---- Notizen & Tags (schema v14) ------------------------------------------------------

use vectasim_store::{FlightUserEdit, TagCount, normalize_tags};

#[test]
fn tags_are_normalised() {
    let raw = ["  VATSIM ", "vatsim", "Night  Flight", "a,b", "", "   ", &"x".repeat(40)];
    assert_eq!(normalize_tags(&raw), vec!["VATSIM".to_string(), "Night Flight".into(), "a b".into(), "x".repeat(30)]);
    let many: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
    assert_eq!(normalize_tags(&many).len(), 20);
}

#[test]
fn user_edit_sets_clears_and_validates() {
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    let before = store.get_flight(&id).unwrap().unwrap().flight;
    assert_eq!((before.notes.as_deref(), before.tags.len(), before.rating), (None, 0, None));

    let edit = FlightUserEdit {
        notes: Some("Erste Zeile\r\nZweite Zeile\n".into()),
        tags: Some(vec!["VATSIM".into(), "vatsim ".into(), "Event".into()]),
        callsign: Some(" DLH9X ".into()),
        dep_icao: Some("eddm".into()),
        aircraft_title: Some("A321neo".into()),
        rating: Some(4),
        ..Default::default()
    };
    let f = store.update_flight_user(&id, &edit, 5_000_000_000_000).unwrap().unwrap();
    assert_eq!(f.notes.as_deref(), Some("Erste Zeile\nZweite Zeile"));
    assert_eq!(f.tags, vec!["VATSIM".to_string(), "Event".into()]);
    assert_eq!(f.user_callsign.as_deref(), Some("DLH9X"));
    assert_eq!(f.user_dep_icao.as_deref(), Some("EDDM"));
    assert_eq!(f.user_aircraft_title.as_deref(), Some("A321neo"));
    assert_eq!(f.rating, Some(4));
    assert_eq!(f.updated_ms, 5_000_000_000_000, "open views reload the flight");
    // the recorded values stay
    assert_eq!((f.dep_icao.clone(), f.callsign.clone(), f.aircraft.title.clone()), (before.dep_icao.clone(), before.callsign.clone(), before.aircraft.title.clone()));

    // None = unchanged; only the rating changes
    let f = store.update_flight_user(&id, &FlightUserEdit { rating: Some(5), ..Default::default() }, 0).unwrap().unwrap();
    assert_eq!((f.rating, f.tags.len(), f.notes.is_some()), (Some(5), 2, true));

    // invalid values fail the whole edit and change nothing
    for bad in [
        FlightUserEdit { arr_icao: Some("EGL".into()), notes: Some(String::new()), ..Default::default() },
        FlightUserEdit { dep_icao: Some("ED-F".into()), ..Default::default() },
        FlightUserEdit { rating: Some(6), ..Default::default() },
        FlightUserEdit { notes: Some("x".repeat(2001)), ..Default::default() },
        FlightUserEdit { registration: Some("D".into()), ..Default::default() },
    ] {
        assert!(matches!(store.update_flight_user(&id, &bad, 0), Err(StoreError::Invalid(_))), "{bad:?}");
    }
    assert!(store.get_flight(&id).unwrap().unwrap().flight.notes.is_some());
    assert!(store.update_flight_user(&id, &FlightUserEdit { notes: Some("x".repeat(2000)), ..Default::default() }, 0).is_ok());

    // Some("") / [] / 0 clear
    let clear = FlightUserEdit {
        notes: Some(String::new()),
        tags: Some(vec![]),
        callsign: Some(" ".into()),
        dep_icao: Some(String::new()),
        aircraft_title: Some(String::new()),
        rating: Some(0),
        ..Default::default()
    };
    let f = store.update_flight_user(&id, &clear, 0).unwrap().unwrap();
    assert_eq!((f.notes, f.tags.len(), f.user_callsign, f.user_dep_icao, f.user_aircraft_title, f.rating), (None, 0, None, None, None, None));
    assert_eq!(store.update_flight_user("nope", &FlightUserEdit::default(), 0).unwrap(), None);
}

#[test]
fn corrected_registration_rebooks_the_flight_and_clearing_books_it_back() {
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    let recorded = store.get_flight(&id).unwrap().unwrap().flight.airframe_reg;
    let f = store.update_flight_user(&id, &FlightUserEdit { registration: Some("d-aiea".into()), ..Default::default() }, 1).unwrap().unwrap();
    assert_eq!((f.user_registration.as_deref(), f.airframe_reg.as_deref()), (Some("D-AIEA"), Some("D-AIEA")));
    assert!(store.get_airframe("D-AIEA").unwrap().is_some(), "a new airframe is created for it");
    let f = store.update_flight_user(&id, &FlightUserEdit { registration: Some(String::new()), ..Default::default() }, 2).unwrap().unwrap();
    assert_eq!((f.user_registration, f.airframe_reg), (None, recorded));
}

#[test]
fn list_tags_counts_flights_without_the_trash() {
    let store = Store::open_in_memory().unwrap();
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);
    record_mock_flight(&store, 10.0);
    let ids: Vec<String> = store.list_flights(10, 0).unwrap().into_iter().map(|f| f.id).collect();
    assert_eq!(ids.len(), 3);
    let tag = |id: &str, t: &[&str]| {
        store.update_flight_user(id, &FlightUserEdit { tags: Some(t.iter().map(|s| s.to_string()).collect()), ..Default::default() }, 0).unwrap();
    };
    tag(&ids[0], &["vatsim", "Event"]);
    tag(&ids[1], &["VATSIM"]);
    tag(&ids[2], &["vatsim", "trash"]);
    store.delete_flight(&ids[2]).unwrap();
    assert_eq!(
        store.list_tags().unwrap(),
        vec![TagCount { tag: "VATSIM".into(), count: 2 }, TagCount { tag: "Event".into(), count: 1 }],
        "case-insensitive, the Papierkorb does not count"
    );
}

#[test]
fn migration_v14_adds_the_user_columns_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    const { assert!(SCHEMA_VERSION >= 14) };
    let id = {
        let store = Store::open(&path).unwrap();
        record_mock_flight(&store, 10.0);
        store.list_flights(1, 0).unwrap()[0].id.clone()
    };
    // a v13 file: none of the columns
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        for c in ["notes", "tags", "user_callsign", "user_dep_icao", "user_arr_icao", "user_aircraft_title", "user_registration", "rating"] {
            conn.execute_batch(&format!("ALTER TABLE flights DROP COLUMN {c}")).unwrap();
        }
        conn.execute("UPDATE schema_version SET version = 13", []).unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        store.update_flight_user(&id, &FlightUserEdit { notes: Some("bleibt".into()), ..Default::default() }, 0).unwrap();
    }
    // columns there, version number rolled back: migrates again, keeps the values
    rusqlite::Connection::open(&path).unwrap().execute("UPDATE schema_version SET version = 13", []).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.notes.as_deref(), Some("bleibt"));
}
