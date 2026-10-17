use vectasim_simbrief::parse_ofp_json;

const V2: &str = include_str!("fixtures/ofp_v2_min.json");

#[test]
fn parses_a_v2_document() {
    let ofp = parse_ofp_json(V2).expect("parse");
    assert_eq!(ofp.request_id, "987654321");
    assert_eq!(ofp.airac, "2510");
    assert_eq!(ofp.callsign, "DLH4YA");
    assert_eq!(ofp.route_label(), "EDDF → LIRF");
    assert_eq!(ofp.alternate_icao, "LIRN");
    assert_eq!(ofp.origin_runway, "25C");
    assert_eq!(ofp.aircraft_icao, "A20N");
    assert_eq!(ofp.registration, "D-AINA");
    assert_eq!(ofp.cruise_altitude_ft, 36000.0);
    assert_eq!(ofp.route_distance_nm, 1176.0);
    assert_eq!(ofp.passengers, 150);
    assert_eq!(ofp.times.block_s, 7200);
    assert_eq!(ofp.times.enroute_s, 5700);
    assert_eq!(ofp.times.sched_out_s, 1792207200);
    assert_eq!(ofp.fuel.plan_ramp_kg, 8265.0);
    assert_eq!(ofp.fuel.plan_landing_kg, 2765.0);
    assert_eq!(ofp.weights.est_tow_kg, 66465.0);
    assert_eq!(ofp.navlog.len(), 6);
    // mixed string/number fields in the first fix
    let first = &ofp.navlog[0];
    assert_eq!(first.ident, "ANEKI");
    assert!(first.is_sid_star);
    assert!((first.latitude - 49.9522).abs() < 1e-9);
    assert_eq!(first.altitude_ft, 4000.0);
    assert_eq!(first.fuel_remaining_kg, 8300.0);
    assert!(!ofp.navlog[1].is_sid_star);
    assert_eq!(ofp.navlog.last().unwrap().kind, "apt");
}

#[test]
fn converts_pounds_to_kg_and_tolerates_single_object_lists() {
    let json = V2
        .replace("\"units\": \"kgs\"", "\"units\": \"lbs\"")
        // navlog with a single fix given as an object instead of a list
        .replace(
            "\"fix\": [",
            "\"fix\": { \"ident\": \"ONLY\", \"pos_lat\": 1, \"pos_long\": 2, \"altitude_feet\": 100 }, \"unused\": [",
        );
    let ofp = parse_ofp_json(&json).expect("parse");
    assert!((ofp.fuel.plan_ramp_kg - 8265.0 * 0.453_592_37).abs() < 1e-6);
    assert!((ofp.weights.oew_kg - 44300.0 * 0.453_592_37).abs() < 1e-6);
    assert_eq!(ofp.source_units, "lbs");
    assert_eq!(ofp.navlog.len(), 1);
    assert_eq!(ofp.navlog[0].ident, "ONLY");
}

#[test]
fn missing_sections_do_not_fail() {
    let ofp = parse_ofp_json(r#"{"fetch":{"status":"Success"},"general":{"route":"DCT"}}"#).expect("parse");
    assert_eq!(ofp.route, "DCT");
    assert_eq!(ofp.callsign, "");
    assert!(ofp.navlog.is_empty());
    assert_eq!(ofp.fuel.plan_ramp_kg, 0.0);
}

#[test]
fn fetch_error_status_is_reported() {
    let err = parse_ofp_json(r#"{"fetch":{"status":"Error: Unknown UserID"}}"#).unwrap_err();
    assert!(err.to_string().contains("Unknown UserID"), "{err}");
    assert!(parse_ofp_json("not json").is_err());
}
