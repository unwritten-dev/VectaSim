use vectasim_core::{AircraftInfo, FlightSession, MockFlight};
use vectasim_store::{
    AirframeEdit, AirframePhoto, FlightRecorder, PlannedFlight, PlannedSlot, RecorderContext, Store, icao_from_atc_model,
    normalize_registration, resolve_registration,
};

#[test]
fn registration_normalisation_and_validation() {
    assert_eq!(normalize_registration(" d-aina ").as_deref(), Some("D-AINA"));
    assert_eq!(normalize_registration("D AINA").as_deref(), Some("DAINA"));
    assert_eq!(normalize_registration("n12345x").as_deref(), Some("N12345X"));
    assert_eq!(normalize_registration("G-EUPT").as_deref(), Some("G-EUPT"));
    assert_eq!(normalize_registration("HB-JCA").as_deref(), Some("HB-JCA"));
    for bad in ["", "  ", "AB", "D-AINABCDE", "D_AINA", "12345", "-DAIN", "DAIN-", "D--AIN", "ASXGS", "asxgs", "ASOBO", "N12345", "D-ÄINA"] {
        assert_eq!(normalize_registration(bad), None, "{bad:?} must be rejected");
    }
}

#[test]
fn resolution_prefers_the_ofp_then_the_atc_id() {
    assert_eq!(resolve_registration(Some("D-AINA"), Some("D-AVCT")).as_deref(), Some("D-AINA"));
    // an empty/invalid OFP registration falls through to the sim
    assert_eq!(resolve_registration(Some(""), Some("d-avct")).as_deref(), Some("D-AVCT"));
    assert_eq!(resolve_registration(None, Some("D-AVCT")).as_deref(), Some("D-AVCT"));
    // sim placeholders are no registration
    assert_eq!(resolve_registration(None, Some("ASXGS")), None);
    assert_eq!(resolve_registration(Some(""), Some("")), None);
}

#[test]
fn atc_model_to_icao_type() {
    assert_eq!(icao_from_atc_model("TT:ATCCOM.AC_MODEL_A20N.0.text").as_deref(), Some("A20N"));
    assert_eq!(icao_from_atc_model("$$:b738").as_deref(), Some("B738"));
    assert_eq!(icao_from_atc_model("A20N").as_deref(), Some("A20N"));
    assert_eq!(icao_from_atc_model("Airbus A320neo"), None);
}

fn run(rec: &mut FlightRecorder, seconds: f64) {
    let mut flight = MockFlight::new();
    let mut session = FlightSession::new();
    let hz = 10.0;
    for i in 1..=((seconds * hz) as u64) {
        let t_s = i as f64 / hz;
        let t = flight.sample(t_s, 1_700_000_000_000 + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &events).unwrap();
    }
}

fn plan(reg: &str) -> PlannedFlight {
    PlannedFlight {
        callsign: "DLH4YA".into(),
        dep_icao: "EDDF".into(),
        arr_icao: "EDDF".into(),
        block_s: 600,
        ofp_json: "{}".into(),
        registration: reg.into(),
        aircraft_icao: "A20N".into(),
        aircraft_name: "A320-271N".into(),
        airline_icao: "dlh".into(),
        ..Default::default()
    }
}

#[test]
fn recorder_books_the_ofp_registration_over_the_sim_atc_id() {
    let store = Store::open_in_memory().unwrap();
    let planned = PlannedSlot::default();
    *planned.lock().unwrap() = Some(plan("d-aina"));
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    )
    .with_planned(planned);
    run(&mut rec, 60.0);
    let f = &store.list_flights(1, 0).unwrap()[0];
    assert_eq!(f.airframe_reg.as_deref(), Some("D-AINA"));
    let a = store.get_airframe("d-aina").unwrap().unwrap();
    assert_eq!((a.icao_type.as_deref(), a.title.as_deref(), a.airline.as_deref()), (Some("A20N"), Some("A320-271N"), Some("DLH")));
    assert!(store.get_airframe("D-AVCT").unwrap().is_none(), "the sim id is not used when the OFP has one");
}

#[test]
fn recorder_falls_back_to_the_atc_id_also_when_it_arrives_late() {
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), ..Default::default() });
    run(&mut rec, 60.0);
    let id = store.active_flight_id().unwrap().unwrap();
    assert_eq!(store.list_flights(1, 0).unwrap()[0].airframe_reg, None);
    // aircraft identity after the flight started
    rec.set_aircraft(MockFlight::aircraft()).unwrap();
    let f = store.get_flight(&id).unwrap().unwrap().flight;
    assert_eq!(f.airframe_reg.as_deref(), Some("D-AVCT"));
    let a = store.get_airframe("D-AVCT").unwrap().unwrap();
    assert_eq!(a.icao_type.as_deref(), Some("A20N"));
    assert_eq!(a.title.as_deref(), Some("Mock Airlines A320neo"));

    // a sim placeholder books nothing
    let store = Store::open_in_memory().unwrap();
    let ac = AircraftInfo { atc_id: "ASXGS".into(), ..MockFlight::aircraft() };
    let mut rec = FlightRecorder::new(store.clone(), RecorderContext { provider: "mock".into(), aircraft: Some(ac), ..Default::default() });
    run(&mut rec, 60.0);
    assert_eq!(store.list_flights(1, 0).unwrap()[0].airframe_reg, None);
    assert!(store.list_airframes(true).unwrap().is_empty());
}

#[test]
fn same_registration_books_onto_one_airframe_and_aggregates() {
    let store = Store::open_in_memory().unwrap();
    for _ in 0..2 {
        let mut rec = FlightRecorder::new(
            store.clone(),
            RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
        );
        run(&mut rec, MockFlight::loop_seconds() + 10.0);
    }
    let list = store.list_airframes(true).unwrap();
    assert_eq!(list.len(), 1);
    let a = &list[0];
    assert_eq!(a.airframe.registration, "D-AVCT");
    assert_eq!(a.flights, 2);
    assert_eq!(a.landings, 2);
    assert!(a.block_time_ms > 0 && a.flight_time_ms > 0 && a.distance_nm > 0.0);
    assert!(a.avg_landing_vs_fpm.unwrap() < 0.0);
    assert!(a.last_flown_ms.is_some());
    assert_eq!(a.total_flights, 2);
    // demo (mock) flights only count when asked for
    let a = &store.list_airframes(false).unwrap()[0];
    assert_eq!((a.flights, a.total_flights, a.landings, a.avg_landing_vs_fpm), (0, 2, 0, None));
    assert_eq!(store.airframe_flights("d-avct", 10).unwrap().len(), 2);
}

#[test]
fn manual_edit_rebooking_and_merge() {
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    );
    run(&mut rec, 60.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();

    // manual name/notes survive later automatic fills
    let edit = AirframeEdit { registration: "d-avct".into(), custom_name: Some("Vecta One".into()), notes: Some("Testflieger".into()), ..Default::default() };
    let a = store.upsert_airframe(&edit, 5).unwrap().unwrap();
    assert_eq!(a.custom_name.as_deref(), Some("Vecta One"));
    assert_eq!(a.icao_type.as_deref(), Some("A20N"), "fields not in the edit stay");
    rec.set_aircraft(AircraftInfo { title: "Other title".into(), ..MockFlight::aircraft() }).unwrap();
    let a = store.get_airframe("D-AVCT").unwrap().unwrap();
    assert_eq!((a.custom_name.as_deref(), a.notes.as_deref()), (Some("Vecta One"), Some("Testflieger")));
    assert!(store.upsert_airframe(&AirframeEdit { registration: "x".into(), ..Default::default() }, 5).unwrap().is_none());
    // clearing a field
    let a = store.upsert_airframe(&AirframeEdit { registration: "D-AVCT".into(), notes: Some(" ".into()), ..Default::default() }, 6).unwrap().unwrap();
    assert_eq!(a.notes, None);

    // re-book onto a new registration (created with the flight's type), then unbook
    assert!(store.set_flight_airframe(&id, Some("d-aina"), 7).unwrap());
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.airframe_reg.as_deref(), Some("D-AINA"));
    assert_eq!(store.get_airframe("D-AINA").unwrap().unwrap().icao_type.as_deref(), Some("A20N"));
    assert!(store.set_flight_airframe(&id, Some("??"), 7).is_err());
    assert!(!store.set_flight_airframe("nope", Some("D-AINA"), 7).unwrap());
    assert!(store.set_flight_airframe(&id, None, 8).unwrap());
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.airframe_reg, None);

    // merge D-AVCT into D-AINA: flights move, name fills the gap, source row is gone
    store.set_flight_airframe(&id, Some("D-AVCT"), 9).unwrap();
    let merged = store.merge_airframes("D-AVCT", "D-AINA", 10).unwrap().unwrap();
    assert_eq!(merged.registration, "D-AINA");
    assert_eq!(merged.custom_name.as_deref(), Some("Vecta One"));
    assert!(store.get_airframe("D-AVCT").unwrap().is_none());
    assert_eq!(store.get_flight(&id).unwrap().unwrap().flight.airframe_reg.as_deref(), Some("D-AINA"));
    // merging into a registration that does not exist yet renames
    let renamed = store.merge_airframes("D-AINA", "D-AINB", 11).unwrap().unwrap();
    assert_eq!(renamed.custom_name.as_deref(), Some("Vecta One"));
    assert_eq!(store.list_airframes(true).unwrap().len(), 1);
    assert!(store.merge_airframes("D-ZZZZ", "D-AINB", 12).unwrap().is_none());
}

#[test]
fn photo_hit_and_miss_are_stored() {
    let store = Store::open_in_memory().unwrap();
    let p = AirframePhoto {
        url: "https://t.plnspttrs.net/1_280.jpg".into(),
        thumb_url: "https://t.plnspttrs.net/1_t.jpg".into(),
        credit: "Max".into(),
        link: "https://www.planespotters.net/photo/1".into(),
        source: "planespotters".into(),
    };
    let a = store.set_airframe_photo("d-aina", Some(&p), 100).unwrap().unwrap();
    assert_eq!(a.image_url.as_deref(), Some(p.url.as_str()));
    assert_eq!((a.image_source.as_deref(), a.image_fetched_ms), (Some("planespotters"), Some(100)));
    let a = store.set_airframe_photo("D-AINA", None, 200).unwrap().unwrap();
    assert_eq!((a.image_url, a.image_source.as_deref(), a.image_fetched_ms), (None, Some("none"), Some(200)));
}

#[test]
fn existing_flights_are_booked_by_the_v6_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vectasim.db");
    {
        let store = Store::open(&path).unwrap();
        for _ in 0..3 {
            let mut rec = FlightRecorder::new(
                store.clone(),
                RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
            );
            run(&mut rec, 30.0);
        }
    }
    let ids: Vec<String> = Store::open(&path).unwrap().list_flights(10, 0).unwrap().into_iter().map(|f| f.id).collect();
    // back to a v5 logbook: one flight with an OFP registration, one with only the sim id, one with a placeholder
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("DROP INDEX flights_airframe; ALTER TABLE flights DROP COLUMN airframe_reg; DROP TABLE airframes;").unwrap();
        conn.execute(
            "UPDATE flights SET ofp_json = ?2 WHERE id = ?1",
            rusqlite::params![ids[0], r#"{"registration":"D-AINA","aircraftIcao":"A20N","aircraftName":"A320-271N","airlineIcao":"DLH"}"#],
        )
        .unwrap();
        conn.execute("UPDATE flights SET atc_id = 'ASXGS' WHERE id = ?1", rusqlite::params![ids[2]]).unwrap();
        conn.execute("UPDATE schema_version SET version = 5", []).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), vectasim_store::SCHEMA_VERSION);
    let reg = |id: &str| store.get_flight(id).unwrap().unwrap().flight.airframe_reg;
    assert_eq!(reg(&ids[0]).as_deref(), Some("D-AINA"));
    assert_eq!(reg(&ids[1]).as_deref(), Some("D-AVCT"));
    assert_eq!(reg(&ids[2]), None);
    let a = store.get_airframe("D-AINA").unwrap().unwrap();
    assert_eq!((a.icao_type.as_deref(), a.airline.as_deref()), (Some("A20N"), Some("DLH")));
    assert_eq!(store.list_airframes(true).unwrap().len(), 2);
    drop(store);
    assert_eq!(Store::open(&path).unwrap().schema_version().unwrap(), vectasim_store::SCHEMA_VERSION);
}

#[test]
fn demo_flights_and_their_airframes_are_purged_but_edited_airframes_stay() {
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    );
    run(&mut rec, 60.0);
    assert_eq!(store.list_flights(10, 0).unwrap().len(), 1);
    assert!(store.get_airframe("D-AVCT").unwrap().is_some());

    assert_eq!(store.delete_demo_flights().unwrap(), 1);
    assert!(store.list_flights(10, 0).unwrap().is_empty());
    assert!(store.get_airframe("D-AVCT").unwrap().is_none(), "an airframe only the demo created goes with it");

    // an airframe the user touched survives the purge
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    );
    run(&mut rec, 60.0);
    store
        .upsert_airframe(&AirframeEdit { registration: "D-AVCT".into(), custom_name: Some("Meine Neo".into()), ..Default::default() }, 1)
        .unwrap();
    assert_eq!(store.delete_demo_flights().unwrap(), 1);
    assert!(store.get_airframe("D-AVCT").unwrap().is_some());
}

#[test]
fn vapp_per_airframe_is_set_cleared_validated_and_found_from_the_flight() {
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    );
    run(&mut rec, 60.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    assert_eq!(store.flight_vapp_kt(&id).unwrap(), None, "nothing entered yet");

    let edit = |v: Option<f64>| AirframeEdit { registration: "D-AVCT".into(), vapp_kt: v, ..Default::default() };
    let a = store.upsert_airframe(&edit(Some(138.0)), 5).unwrap().unwrap();
    assert_eq!(a.vapp_kt, Some(138.0));
    assert_eq!(store.flight_vapp_kt(&id).unwrap(), Some(138.0));
    assert_eq!(store.list_airframes(true).unwrap()[0].airframe.vapp_kt, Some(138.0), "the fleet list carries it");
    // other edits leave it alone
    let a = store.upsert_airframe(&AirframeEdit { registration: "D-AVCT".into(), notes: Some("n".into()), ..Default::default() }, 6).unwrap().unwrap();
    assert_eq!(a.vapp_kt, Some(138.0));
    // implausible values are refused, nothing changes
    assert!(store.upsert_airframe(&edit(Some(12.0)), 7).is_err());
    assert!(store.upsert_airframe(&edit(Some(400.0)), 7).is_err());
    assert_eq!(store.get_airframe("D-AVCT").unwrap().unwrap().vapp_kt, Some(138.0));
    // 0 clears
    assert_eq!(store.upsert_airframe(&edit(Some(0.0)), 8).unwrap().unwrap().vapp_kt, None);
    assert_eq!(store.flight_vapp_kt(&id).unwrap(), None);
    assert_eq!(store.flight_vapp_kt("no-such-flight").unwrap(), None);

    // merging keeps the target's Vapp, fills it from the source when empty
    store.upsert_airframe(&edit(Some(140.0)), 9).unwrap();
    store.merge_airframes("D-AVCT", "D-AINA", 10).unwrap();
    assert_eq!(store.get_airframe("D-AINA").unwrap().unwrap().vapp_kt, Some(140.0));
    assert_eq!(store.flight_vapp_kt(&id).unwrap(), Some(140.0));
}

#[test]
fn landing_flaps_per_airframe_are_set_cleared_validated_and_found_from_the_flight() {
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    );
    run(&mut rec, 60.0);
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    assert_eq!(store.flight_airframe_refs(&id).unwrap(), (None, None));

    let edit = |v: Option<i32>| AirframeEdit { registration: "D-AVCT".into(), landing_flaps: v, ..Default::default() };
    let a = store.upsert_airframe(&edit(Some(3)), 5).unwrap().unwrap();
    assert_eq!(a.landing_flaps, Some(3));
    assert_eq!(store.flight_airframe_refs(&id).unwrap(), (None, Some(3)));
    assert_eq!(store.list_airframes(true).unwrap()[0].airframe.landing_flaps, Some(3), "the fleet list carries it");
    // 0 is a valid stage (no flaps, e.g. a flapless type); other edits leave it alone
    let a = store.upsert_airframe(&AirframeEdit { registration: "D-AVCT".into(), vapp_kt: Some(134.0), ..Default::default() }, 6).unwrap().unwrap();
    assert_eq!((a.vapp_kt, a.landing_flaps), (Some(134.0), Some(3)));
    assert_eq!(store.flight_airframe_refs(&id).unwrap(), (Some(134.0), Some(3)));
    assert!(store.upsert_airframe(&edit(Some(11)), 7).is_err(), "beyond the handle positions any sim has");
    assert_eq!(store.get_airframe("D-AVCT").unwrap().unwrap().landing_flaps, Some(3));
    assert_eq!(store.upsert_airframe(&edit(Some(0)), 8).unwrap().unwrap().landing_flaps, Some(0));
    // negative clears
    assert_eq!(store.upsert_airframe(&edit(Some(-1)), 9).unwrap().unwrap().landing_flaps, None);
    // merging fills the target from the source
    store.upsert_airframe(&edit(Some(4)), 10).unwrap();
    store.merge_airframes("D-AVCT", "D-AINA", 11).unwrap();
    assert_eq!(store.get_airframe("D-AINA").unwrap().unwrap().landing_flaps, Some(4));
}

#[test]
fn an_airframe_with_a_vapp_survives_the_demo_purge() {
    let store = Store::open_in_memory().unwrap();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), aircraft: Some(MockFlight::aircraft()), ..Default::default() },
    );
    run(&mut rec, 60.0);
    store.upsert_airframe(&AirframeEdit { registration: "D-AVCT".into(), vapp_kt: Some(132.0), ..Default::default() }, 1).unwrap();
    assert_eq!(store.delete_demo_flights().unwrap(), 1);
    assert_eq!(store.get_airframe("D-AVCT").unwrap().unwrap().vapp_kt, Some(132.0));
}
