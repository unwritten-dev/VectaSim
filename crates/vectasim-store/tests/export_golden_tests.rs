//! Golden files for the flight exports: every format is rendered from one fixed flight and
//! compared byte for byte (line endings aside) with `tests/golden/*`. An intended format
//! change regenerates them with `UPDATE_GOLDEN=1 cargo test -p vectasim-store --test export_golden_tests`;
//! review the diff of the golden files like code.

use std::path::PathBuf;
use vectasim_core::{AircraftInfo, FlightPhase, GLoadPoint, GLoadSource, GLoadStats, IntegrityFlags, Lang, LandingRateSource, TouchdownReport};
use vectasim_store::export::{LogbookPlan, export_csv, export_flight, export_logbook_csv, export_logbook_csv_with_plans};
use vectasim_store::{ExportFormat, FlightDetail, FlightRow, PhaseEventRow, TrackSample};

const T0: u64 = 1_792_137_600_000; // 2026-10-16T08:00:00Z

fn flight() -> FlightRow {
    FlightRow {
        id: "golden-1".into(),
        state: "completed".into(),
        created_ms: T0 - 60_000,
        off_block_ms: Some(T0),
        takeoff_ms: Some(T0 + 4_000),
        landing_ms: Some(T0 + 9_000),
        on_block_ms: Some(T0 + 3_723_000),
        dep_lat: Some(50.0333),
        dep_lon: Some(8.5706),
        arr_lat: Some(51.4706),
        arr_lon: Some(-0.4619),
        dep_icao: Some("EDDF".into()),
        arr_icao: Some("EGLL".into()),
        callsign: Some("DLH4AB".into()),
        distance_nm: 354.27,
        max_alt_msl_ft: 37_000.0,
        landing_vs_fpm: Some(-142.0),
        landing_count: 1,
        fuel_start_kg: Some(6_200.0),
        fuel_end_kg: Some(3_850.5),
        planned_dep: Some("EDDF".into()),
        planned_arr: Some("EGLL".into()),
        planned_block_s: Some(3_900),
        planned_fuel_ramp_kg: Some(6_300.0),
        planned_fuel_landing_kg: Some(3_900.0),
        provider: Some("mock".into()),
        sim_name: Some("Mock Sim".into()),
        aircraft: AircraftInfo {
            // XML escaping, CSV quoting, umlauts and a formula prefix in one title
            title: "A320neo <Lufthansa> & \"Grüße\", =Livery".into(),
            atc_model: "A20N".into(),
            atc_type: "AIRBUS".into(),
            atc_id: "D-AINA".into(),
            atc_airline: "Lufthansa".into(),
            atc_flight_number: "4AB".into(),
        },
        integrity: IntegrityFlags { paused_ms: 61_000, pause_count: 1, max_sim_rate: 1.0, ..Default::default() },
        // g-load over the flight (v16); golden-2 of the logbook CSV has none ("not measured")
        g_load: Some(GLoadStats {
            max: Some(GLoadPoint { g: 1.4234, timestamp_ms: T0 + 5_000, phase: FlightPhase::Climb, altitude_msl_ft: 3_212.4 }),
            min: Some(GLoadPoint { g: 0.7081, timestamp_ms: T0 + 8_000, phase: FlightPhase::Descent, altitude_msl_ft: 9_870.0 }),
            high_count: 0,
            low_count: 1,
            source: GLoadSource::Live,
        }),
        ..Default::default()
    }
}

fn samples() -> Vec<TrackSample> {
    (0..10)
        .map(|i| {
            let f = i as f64;
            TrackSample {
                t_ms: T0 + i * 1_000 + if i == 3 { 250 } else { 0 },
                latitude: 50.0333 + f * 0.001,
                longitude: 8.5706 - f * 0.0015,
                altitude_msl_ft: 364.0 + f * 120.5,
                altitude_agl_ft: f * 120.5,
                ground_speed_kt: 140.0 + f,
                ias_kt: 138.5 + f,
                vertical_speed_fpm: if i < 9 { 1_200.0 } else { -142.0 },
                // −10° normalises to 350° in GPX/KML
                heading_true_deg: if i == 0 { -10.0 } else { 249.75 },
                pitch_deg: 7.25,
                bank_deg: -1.5,
                g_force: 1.012,
                on_ground: i < 4 || i == 9,
                flaps_index: 2,
                gear_pct: if i < 6 { 100.0 } else { 0.0 },
                fuel_total_kg: 6_200.0 - f * 1.5,
                // track v2 from sample 2 on (a flight continued over an update); sample 5 without wind
                tas_kt: (i >= 2).then_some(141.25 + f),
                wind_dir_true_deg: (i >= 2 && i != 5).then_some(244.6),
                wind_kt: (i >= 2 && i != 5).then_some(12.25),
                ..Default::default()
            }
        })
        .collect()
}

fn touchdown() -> TouchdownReport {
    TouchdownReport {
        timestamp_ms: T0 + 9_000,
        vs_fpm_measured: -150.0,
        vs_fpm_sim: -142.0,
        vs_fpm_hardest: -150.0,
        peak_g: 1.21,
        pitch_deg: 4.0,
        bank_deg: 0.5,
        ground_speed_kt: 132.0,
        heading_true_deg: 270.0,
        latitude: 51.4706,
        longitude: -0.4619,
        bounces: 1,
        touch_and_go: false,
        landing_rate_fpm: -142.0,
        landing_rate_source: LandingRateSource::Sim,
    }
}

fn detail() -> FlightDetail {
    FlightDetail {
        flight: flight(),
        touchdowns: vec![touchdown()],
        phases: vec![
            PhaseEventRow { from: FlightPhase::Preflight, to: FlightPhase::TaxiOut, timestamp_ms: T0 },
            PhaseEventRow { from: FlightPhase::TaxiOut, to: FlightPhase::Takeoff, timestamp_ms: T0 + 2_000 },
            PhaseEventRow { from: FlightPhase::Final, to: FlightPhase::Landing, timestamp_ms: T0 + 9_000 },
        ],
        has_track: true,
        ofp_json: None,
    }
}

fn check(name: &str, actual: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden").join(name);
    // the repository stores text with LF (.gitattributes); CRLF of the CSV is checked separately
    let actual = actual.replace("\r\n", "\n");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (UPDATE_GOLDEN=1 creates it)", path.display()))
        .replace("\r\n", "\n");
    if expected != actual {
        let line =
            expected.lines().zip(actual.lines()).position(|(a, b)| a != b).unwrap_or(expected.lines().count().min(actual.lines().count()));
        panic!(
            "{name} differs from the golden file at line {}:\n  expected: {:?}\n  actual:   {:?}\n(UPDATE_GOLDEN=1 regenerates after an intended change)",
            line + 1,
            expected.lines().nth(line),
            actual.lines().nth(line)
        );
    }
}

#[test]
fn track_csv_matches_golden() {
    let csv = export_csv(&samples());
    assert!(csv.ends_with("\r\n") && !csv.replace("\r\n", "").contains('\n'), "RFC 4180 CRLF rows");
    check("track.csv", &csv);
}

#[test]
fn logbook_csv_matches_golden() {
    let mut second = flight();
    second.id = "golden-2".into();
    second.state = "interrupted".into();
    second.on_block_ms = None;
    second.landing_ms = None;
    second.landing_vs_fpm = None;
    second.fuel_end_kg = None;
    second.callsign = None;
    second.arr_icao = None;
    second.aircraft.title = "Cessna 172 \"Skyhawk\"\nG1000".into();
    // the pilot's additions (v14): a correction overlays the recorded arrival, notes keep
    // their line break and are quoted, a formula prefix is neutralised
    second.user_arr_icao = Some("EGKK".into());
    second.notes = Some("=Umleitung nach Gatwick,\nWetter".into());
    second.tags = vec!["Diversion".into(), "vatsim".into()];
    second.rating = Some(3);
    second.g_load = None;
    second.integrity = IntegrityFlags {
        slew_detected: true,
        time_acceleration_detected: true,
        max_sim_rate: 4.0,
        teleport_detected: true,
        ..Default::default()
    };
    // golden-1 carries an OFP plan (4 min late out, 2 min early in); golden-2 has none
    let plan = LogbookPlan { sched_out_ms: Some(T0 - 240_000), sched_in_ms: Some(T0 + 3_843_000), trip_kg: Some(5_300.0) };
    let csv = export_logbook_csv_with_plans(&[flight(), second.clone()], |f| (f.id == "golden-1").then_some(plan));
    check("logbook.csv", &csv);
    // the plain export is the same without the OFP columns
    let plain = export_logbook_csv(&[flight(), second]);
    assert_eq!(plain.lines().next(), csv.lines().next());
    assert!(plain.lines().nth(1).unwrap().ends_with(",Mock Sim,,,,,3900,,,,,1.42,climb,3212,0.71,descent,9870,0,1,live"), "{plain}");
}

#[test]
fn gpx_matches_golden() {
    check("flight.gpx", &export_flight(ExportFormat::Gpx, &detail(), &samples(), Lang::De).unwrap());
}

#[test]
fn kml_matches_golden() {
    check("flight.kml", &export_flight(ExportFormat::Kml, &detail(), &samples(), Lang::De).unwrap());
}

#[test]
fn kml_says_unrated_instead_of_zero_fpm() {
    // an unrated touchdown (slewed / fast-forwarded down) was described as "0 fpm"
    let mut d = detail();
    d.touchdowns[0].landing_rate_fpm = 0.0;
    d.touchdowns[0].landing_rate_source = LandingRateSource::Unrated;
    let kml = export_flight(ExportFormat::Kml, &d, &samples(), Lang::De).unwrap();
    assert!(kml.contains("<description>Landerate nicht bewertbar · 1.21 g"), "{kml}");
    assert!(!kml.contains("0 fpm"));
}

#[test]
fn kml_texts_follow_the_app_language() {
    // the placemark texts were German whatever the app language
    let de = export_flight(ExportFormat::Kml, &detail(), &samples(), Lang::De).unwrap();
    let mut d = detail();
    d.touchdowns[0].landing_rate_source = LandingRateSource::Unrated;
    let en = export_flight(ExportFormat::Kml, &d, &samples(), Lang::En).unwrap();
    for word in ["Abflug", "Ankunft", "Flugweg", "Aufsetzen", "Landerate", "wahr"] {
        assert!(!en.contains(word), "{word} in the English KML");
    }
    for word in ["<name>Flight path</name>", "<name>Touchdown 1</name>", "Landing rate not assessable · 1.21 g", "Departure", "Arrival"] {
        assert!(en.contains(word), "{word} missing: {en}");
    }
    // the data is the same in both
    let coords = |k: &str| k.lines().filter(|l| l.contains("<gx:coord>") || l.contains("<when>")).collect::<Vec<_>>().join("\n");
    assert_eq!(coords(&de), coords(&en));
}

#[test]
fn json_matches_golden() {
    let json = export_flight(ExportFormat::Json, &detail(), &samples(), Lang::De).unwrap();
    check("flight.json", &json);
}

#[test]
fn flight_csv_is_the_track_csv() {
    assert_eq!(export_flight(ExportFormat::Csv, &detail(), &samples(), Lang::De).unwrap(), export_csv(&samples()));
}
