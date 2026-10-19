//! CSV import: sniffer, date formats, the Volanta import CSV (synthetic fixture),
//! own logbook CSV round trip, duplicates, landing rate handling.

use vectasim_core::{FlightSession, Lang, MockFlight, MockVariant};
use vectasim_store::csvimport::{
    self, ColumnMapping, CsvEncoding, CsvField, CsvImportOptions, CsvPreset, DateFormat, OffsetSpan, Stamp, WeightUnit, parse_stamp,
};
use vectasim_store::export::export_logbook_csv;
use vectasim_store::{FlightRecorder, FlightUserEdit, RecorderContext, Store};

const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;

/// 2023-05-01T00:00:00Z
const MAY1: i64 = 1_682_899_200_000;

/// Synthetic file in the 13-column format Volanta imports (header as in avs-code/volantaWidget,
/// values made up). Row 4 has no origin, row 5 repeats row 2 four minutes later.
const VOLANTA: &str = "Origin,Destination,DepartureTime,Duration,Airline,Callsign,FlightNumber,AircraftType,AircraftRegistration,Route,ArrivalTime,Distance,Fuel\r\n\
EDDF,EGLL,2023-05-01 08:00:00,01:35,DLH,DLH4AB,LH900,A20N,D-AINA,ANEKI Y6 BIG,2023-05-01 09:35:00,355,2400\r\n\
EGLL,EDDF,2023-05-01 12:00:00,95,DLH,DLH4AC,LH901,A20N,D-AINA,,,355,2350\r\n\
,LOWW,2023-05-02 07:00:00,01:20,AUA,AUA1,OS1,A320,OE-LBA,,,,\r\n\
EDDF,EGLL,2023-05-01 08:04:00,01:35,DLH,DLH4AB,LH900,A20N,D-AINA,,,355,2400\r\n";

fn mapping_of(bytes: &[u8]) -> ColumnMapping {
    csvimport::sniff(bytes).suggested
}

fn opts(tag: &str) -> CsvImportOptions {
    CsvImportOptions { dedupe: true, source_tag: tag.into(), lang: Lang::De }
}

#[test]
fn sniffer_finds_delimiter_header_and_encoding() {
    // semicolon with decimal commas
    let p = csvimport::sniff("Datum;Von;Nach;Distanz\n18.10.2026;EDDF;EDDM;162,5\n19.10.2026;EDDM;EDDF;162,5\n".as_bytes());
    assert_eq!((p.delimiter.as_str(), p.has_header, p.encoding), (";", true, CsvEncoding::Utf8));
    assert_eq!(p.columns, vec!["Datum", "Von", "Nach", "Distanz"]);
    assert_eq!(p.row_count, 2);
    assert_eq!(p.suggested.columns.get(&CsvField::Date), Some(&0));
    assert_eq!(p.suggested.columns.get(&CsvField::DepIcao), Some(&1));
    assert_eq!(p.suggested.columns.get(&CsvField::ArrIcao), Some(&2));
    assert_eq!(p.suggested.columns.get(&CsvField::DistanceNm), Some(&3));

    // comma, with semicolons inside quotes
    let p = csvimport::sniff(b"dep,arr,notes\nEDDF,EDDM,\"a;b;c;d\"\nEDDM,EDDF,\"x;y\"\n");
    assert_eq!(p.delimiter, ",");
    assert_eq!(p.sample_rows[0], vec!["EDDF", "EDDM", "a;b;c;d"]);

    // UTF-8 BOM: not part of the first column name
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend_from_slice("dep;arr;date\nEDDF;EDDM;2026-10-18\n".as_bytes());
    let p = csvimport::sniff(&bom);
    assert_eq!(p.encoding, CsvEncoding::Utf8Bom);
    assert_eq!(p.columns[0], "dep");

    // Latin-1 (Excel on a German Windows): ä = 0xE4, € = 0x80 (Windows-1252)
    let latin: Vec<u8> = b"Abflughafen;Zielflughafen;Datum;Bemerkung\nEDDF;EDDM;18.10.2026;Sch\xF6ner Flug \x80\n".to_vec();
    let p = csvimport::sniff(&latin);
    assert_eq!(p.encoding, CsvEncoding::Latin1);
    assert_eq!(p.sample_rows[0][3], "Schöner Flug €");
    assert_eq!(p.suggested.columns.get(&CsvField::Notes), Some(&3));
    assert_eq!(p.suggested.columns.get(&CsvField::DepIcao), Some(&0));

    // UTF-16 LE with BOM, tab separated (Excel "Unicode-Text")
    let mut u16le = vec![0xFF, 0xFE];
    for u in "dep\tarr\tdate\r\nEDDF\tEDDM\t2026-10-18\r\n".encode_utf16() {
        u16le.extend_from_slice(&u.to_le_bytes());
    }
    let p = csvimport::sniff(&u16le);
    assert_eq!((p.encoding, p.delimiter.as_str()), (CsvEncoding::Utf16le, "\t"));
    assert_eq!(p.sample_rows[0], vec!["EDDF", "EDDM", "2026-10-18"]);

    // Excel's sep= line
    let p = csvimport::sniff(b"sep=|\ndep|arr|date\nEDDF|EDDM|2026-10-18\n");
    assert_eq!((p.delimiter.as_str(), p.columns.len(), p.row_count), ("|", 3, 1));

    // no header: generic names, no suggestion
    let p = csvimport::sniff(b"EDDF,EDDM,2026-10-18 08:00\nEDDM,EDDF,2026-10-18 12:00\n");
    assert!(!p.has_header);
    assert_eq!(p.columns, vec!["Spalte 1", "Spalte 2", "Spalte 3"]);
    assert_eq!(p.row_count, 2);
    assert!(p.suggested.columns.is_empty());
}

fn utc(stamp: Option<Stamp>) -> i64 {
    match stamp {
        Some(Stamp::DateTime { naive_ms, offset_min }) => naive_ms - offset_min.unwrap_or(0) as i64 * MIN,
        other => panic!("no date-time: {other:?}"),
    }
}

#[test]
fn date_formats() {
    let t = MAY1 + 14 * HOUR + 5 * MIN;
    assert_eq!(utc(parse_stamp("2023-05-01 14:05", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("2023-05-01T14:05:00Z", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("2023-05-01T14:05:00.250Z", DateFormat::Iso)), t + 250);
    assert_eq!(utc(parse_stamp("2023-05-01T16:05:00+02:00", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("2023-05-01 14:05 UTC", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("01.05.2023 14:05", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("01.05.23 14:05:00", DateFormat::Dmy)), t);
    assert_eq!(utc(parse_stamp("05/01/2023 2:05 PM", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("05/01/2023 14:05", DateFormat::Mdy)), t);
    assert_eq!(utc(parse_stamp("13/05/2023 14:05", DateFormat::Auto)), t + 12 * 24 * HOUR, "first number > 12: day first");
    assert_eq!(utc(parse_stamp("1682949900", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("1682949900000", DateFormat::Auto)), t);
    assert_eq!(utc(parse_stamp("1682949900", DateFormat::EpochS)), t);
    assert_eq!(utc(parse_stamp("1682949900000", DateFormat::EpochMs)), t);
    assert_eq!(parse_stamp("01.05.2023", DateFormat::Auto), Some(Stamp::Date { days: MAY1 / (24 * HOUR) }));
    assert_eq!(parse_stamp("14:05", DateFormat::Auto), Some(Stamp::Time { ms_of_day: 14 * HOUR + 5 * MIN, offset_min: None }));
    for bad in ["31.02.2023", "2023-13-01", "25:00", "gestern", "05/01/2023 13:05 PM"] {
        assert_eq!(parse_stamp(bad, DateFormat::Auto), None, "{bad}");
    }
}

#[test]
fn separate_date_and_time_columns_local_time_and_pounds() {
    // local time CEST (+2 h); landing after midnight; fuel in lb
    let csv = "Datum;Von;Nach;Off-Block;On-Block;Kraftstoff Start;Kraftstoff Ende\n01.05.2023;EDDF;KJFK;22:30;07:45;10000;2000\n";
    let mut m = mapping_of(csv.as_bytes());
    assert_eq!(m.columns.get(&CsvField::OffBlock), Some(&3));
    assert_eq!(m.columns.get(&CsvField::OnBlock), Some(&4));
    m.weight_unit = WeightUnit::Lb;
    m.local_offsets = vec![OffsetSpan { from_ms: 0, offset_min: 60 }, OffsetSpan { from_ms: MAY1 - 40 * 24 * HOUR, offset_min: 120 }];
    let rows = csvimport::preview(csv.as_bytes(), &m, 20, Lang::De).unwrap();
    let r = &rows[0];
    assert_eq!(r.error, None, "{r:?}");
    assert_eq!(r.off_block_ms, Some(MAY1 + 20 * HOUR + 30 * MIN));
    assert_eq!(r.on_block_ms, Some(MAY1 + 24 * HOUR + 5 * HOUR + 45 * MIN), "next day");
    assert!((r.fuel_start_kg.unwrap() - 4535.9237).abs() < 1e-6);
    // fixed offset instead
    m.local_offsets.clear();
    m.utc_offset_min = -300;
    let r = &csvimport::preview(csv.as_bytes(), &m, 20, Lang::De).unwrap()[0];
    assert_eq!(r.off_block_ms, Some(MAY1 + 27 * HOUR + 30 * MIN));
}

#[test]
fn volanta_import_csv_is_recognised_and_imported() {
    let bytes = VOLANTA.as_bytes();
    let p = csvimport::sniff(bytes);
    assert_eq!(p.detected_preset, CsvPreset::VolantaImport);
    assert_eq!(p.row_count, 4);
    let c = &p.suggested.columns;
    for (f, i) in [
        (CsvField::DepIcao, 0),
        (CsvField::ArrIcao, 1),
        (CsvField::OffBlock, 2),
        (CsvField::BlockMin, 3),
        (CsvField::Airline, 4),
        (CsvField::Callsign, 5),
        (CsvField::FlightNumber, 6),
        (CsvField::AircraftIcao, 7),
        (CsvField::Registration, 8),
        (CsvField::OnBlock, 10),
        (CsvField::DistanceNm, 11),
        (CsvField::FuelUsed, 12),
    ] {
        assert_eq!(c.get(&f), Some(&i), "{f:?}");
    }
    assert_eq!(c.len(), 12, "Route stays unmapped: {c:?}");

    let preview = csvimport::preview(bytes, &p.suggested, 20, Lang::De).unwrap();
    assert_eq!(preview.len(), 4);
    assert_eq!(preview[0].on_block_ms, Some(MAY1 + 9 * HOUR + 35 * MIN));
    assert_eq!(preview[1].on_block_ms, Some(MAY1 + 13 * HOUR + 35 * MIN), "from Duration 95 min");
    assert_eq!(preview[2].error.as_deref(), Some("Abflughafen fehlt"));

    let store = Store::open_in_memory().unwrap();
    let pv = store.preview_csv(bytes, &p.suggested, &opts("volanta"), 20, &|_| None).unwrap();
    assert_eq!((pv.total_rows, pv.valid, pv.invalid, pv.duplicates), (4, 3, 1, 1), "row 5 repeats row 2 within 15 min");
    assert!(pv.rows[3].duplicate);

    let r = store.import_csv(bytes, &p.suggested, &opts("volanta")).unwrap();
    assert_eq!((r.rows, r.added, r.skipped_duplicate, r.skipped_invalid, r.airframes_added), (4, 2, 1, 1, 1), "{r:?}");
    assert!(r.warnings.iter().any(|w| w.starts_with("Zeile 4: übersprungen – Abflughafen fehlt")), "{:?}", r.warnings);

    let flights = store.list_flights(100, 0).unwrap();
    assert_eq!(flights.len(), 2);
    let f = flights.iter().find(|f| f.dep_icao.as_deref() == Some("EDDF")).unwrap();
    assert_eq!(f.provider.as_deref(), Some("import:volanta_import"));
    assert_eq!((f.state.as_str(), f.sim_name.as_deref()), ("completed", Some("Import")));
    assert_eq!(f.tags, vec!["import", "volanta"]);
    assert_eq!(f.callsign.as_deref(), Some("DLH4AB"));
    assert_eq!(
        (f.aircraft.atc_model.as_str(), f.aircraft.atc_id.as_str(), f.aircraft.atc_flight_number.as_str()),
        ("A20N", "D-AINA", "LH900")
    );
    assert_eq!(f.airframe_reg.as_deref(), Some("D-AINA"));
    assert_eq!(f.distance_nm, 355.0);
    assert_eq!(f.notes.as_deref(), Some("Kraftstoffverbrauch laut Importdatei: 2400 kg"));
    assert_eq!((f.takeoff_ms, f.landing_ms), (None, None), "no air time in the file");
    let af = store.list_airframes(false).unwrap();
    assert_eq!(af.len(), 1);
    assert_eq!((af[0].airframe.icao_type.as_deref(), af[0].flights, af[0].block_time_ms), (Some("A20N"), 2, 2 * 95 * MIN as u64));
    let tags = store.list_tags().unwrap();
    assert!(tags.iter().any(|t| t.tag == "import" && t.count == 2));
}

#[test]
fn duplicates_against_logbook_and_trash() {
    let bytes = VOLANTA.as_bytes();
    let m = mapping_of(bytes);
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.import_csv(bytes, &m, &opts("volanta")).unwrap().added, 2);
    let again = store.import_csv(bytes, &m, &opts("volanta")).unwrap();
    assert_eq!((again.added, again.skipped_duplicate), (0, 3));
    // in the trash still counts as there
    let id = store.list_flights(10, 0).unwrap()[0].id.clone();
    assert!(store.delete_flight_at(&id, 1).unwrap());
    assert_eq!(store.import_csv(bytes, &m, &opts("volanta")).unwrap().added, 0);
    // without the check everything valid comes in
    let all = store.import_csv(bytes, &m, &CsvImportOptions { dedupe: false, ..CsvImportOptions::default() }).unwrap();
    assert_eq!((all.added, all.skipped_duplicate), (3, 0));
}

#[test]
fn landing_rate_goes_to_the_notes_not_to_touchdowns() {
    let csv = "dep,arr,off_block_utc,on_block_utc,air_time,landing_rate,notes,tags,rating\n\
EDDF,EDDM,2023-05-01T08:00:00Z,2023-05-01T09:00:00Z,0:40,-142,Seitenwind,\"Training; VATSIM\",4\n";
    let m = mapping_of(csv.as_bytes());
    let store = Store::open_in_memory().unwrap();
    let r = store
        .import_csv_with(
            csv.as_bytes(),
            &m,
            &opts("Logbuch-2023"),
            &|icao| match icao {
                "EDDF" => Some((50.0333, 8.5706)),
                "EDDM" => Some((48.3538, 11.7861)),
                _ => None,
            },
            0,
        )
        .unwrap();
    assert_eq!(r.added, 1);
    let f = &store.list_flights(10, 0).unwrap()[0];
    assert_eq!(f.landing_vs_fpm, None);
    assert_eq!(f.landing_count, 0);
    assert_eq!(f.notes.as_deref(), Some("Seitenwind\nLanderate laut Importdatei: -142 fpm (nicht von VectaSim gemessen)"));
    assert_eq!(f.tags, vec!["import", "Logbuch-2023", "Training", "VATSIM"]);
    assert_eq!(f.rating, Some(4));
    // air time centred in the block time
    assert_eq!(f.takeoff_ms, Some((MAY1 + 8 * HOUR + 10 * MIN) as u64));
    assert_eq!(f.landing_ms, Some((MAY1 + 8 * HOUR + 50 * MIN) as u64));
    // great circle from the index, airports on the map
    assert!((f.distance_nm - 162.0).abs() < 3.0, "{}", f.distance_nm);
    assert!(f.dep_lat.is_some() && f.arr_lon.is_some());
    assert!(r.warnings[0].contains("Großkreis"), "{:?}", r.warnings);
    let detail = store.get_flight(&f.id).unwrap().unwrap();
    assert!(detail.touchdowns.is_empty() && detail.phases.is_empty() && !detail.has_track);
    let totals = store.totals().unwrap();
    assert_eq!((totals.flights, totals.completed, totals.landings, totals.avg_landing_vs_fpm), (1, 1, 0, None));
    assert_eq!((totals.block_time_ms, totals.flight_time_ms), (HOUR as u64, 40 * MIN as u64));
    assert!(store.recent_landings(20, true).unwrap().is_empty());
    let approaches = store.recent_approach_facts(20, true).unwrap();
    assert!(approaches.iter().all(|a| !a.has_track));
}

#[test]
fn import_texts_follow_the_language() {
    let bytes = VOLANTA.as_bytes();
    let p = csvimport::sniff(bytes);
    let preview = csvimport::preview(bytes, &p.suggested, 20, Lang::En).unwrap();
    assert_eq!(preview[2].error.as_deref(), Some("Departure airport missing"));
    let store = Store::open_in_memory().unwrap();
    let r = store.import_csv(bytes, &p.suggested, &CsvImportOptions { lang: Lang::En, ..opts("volanta") }).unwrap();
    assert!(r.warnings.iter().any(|w| w == "Line 4: skipped – Departure airport missing"), "{:?}", r.warnings);
    let flights = store.list_flights(100, 0).unwrap();
    let f = flights.iter().find(|f| f.dep_icao.as_deref() == Some("EDDF")).unwrap();
    assert_eq!(f.notes.as_deref(), Some("Fuel used per import file: 2400 kg"));
    // a value that cannot be read, with English quotes
    let csv = "EDDF;EGLL;2023-05-01 08:00;abc\n";
    let mut m = csvimport::sniff_named(csv.as_bytes(), None, Lang::En).suggested;
    m.columns = [(CsvField::DepIcao, 0), (CsvField::ArrIcao, 1), (CsvField::OffBlock, 2), (CsvField::DistanceNm, 3)].into_iter().collect();
    let r = &csvimport::preview(csv.as_bytes(), &m, 20, Lang::En).unwrap()[0];
    assert_eq!(r.warnings, ["Distance “abc” unreadable"]);
    let r = &csvimport::preview(csv.as_bytes(), &m, 20, Lang::De).unwrap()[0];
    assert_eq!(r.warnings, ["Distanz „abc“ nicht lesbar"]);
    assert_eq!(csvimport::sniff_named(csv.as_bytes(), None, Lang::En).columns[0], "Column 1");
}

#[test]
fn mapping_without_airports_is_refused() {
    let mut m = mapping_of(VOLANTA.as_bytes());
    m.columns.remove(&CsvField::DepIcao);
    let e = csvimport::preview(VOLANTA.as_bytes(), &m, 20, Lang::De).unwrap_err().to_string();
    assert!(e.contains("Abflughafen"), "{e}");
}

/// One mock loop starting at `base_ms`, corrected to the given route (the mock has no airports).
fn record_mock_flight(store: &Store, base_ms: u64, dep: &str, arr: &str) {
    let mut flight = MockFlight::with_variant(MockVariant::Circuit);
    let mut session = FlightSession::new();
    let mut rec = FlightRecorder::new(
        store.clone(),
        RecorderContext { provider: "mock".into(), sim_name: Some("VectaSim Mock".into()), aircraft: Some(MockFlight::aircraft()) },
    );
    let hz = 5.0;
    for i in 1..=((MockVariant::Circuit.loop_seconds() + 10.0) * hz) as u64 {
        let t_s = i as f64 / hz;
        let t = flight.sample(t_s, base_ms + (t_s * 1000.0) as u64);
        let events = session.update(&t);
        rec.on_telemetry(&t, session.summary(), &events).unwrap();
    }
    let id = store.list_flights(1, 0).unwrap()[0].id.clone();
    let edit = FlightUserEdit {
        dep_icao: Some(dep.into()),
        arr_icao: Some(arr.into()),
        notes: Some("Notiz, mit \"Komma\"".into()),
        ..Default::default()
    };
    store.update_flight_user(&id, &edit, base_ms).unwrap();
}

#[test]
fn own_logbook_csv_round_trip_keeps_the_totals() {
    let src = Store::open_in_memory().unwrap();
    let t0 = MAY1 as u64;
    for (k, (d, a)) in [("EDDF", "EDDM"), ("EDDM", "EDDH"), ("EDDH", "EDDF")].into_iter().enumerate() {
        record_mock_flight(&src, t0 + k as u64 * 5 * HOUR as u64, d, a);
    }
    let flights = src.list_flights(100, 0).unwrap();
    assert_eq!(flights.len(), 3);
    let csv = export_logbook_csv(&flights);
    let p = csvimport::sniff(csv.as_bytes());
    assert_eq!(p.detected_preset, CsvPreset::Vectasim);
    assert_eq!(p.row_count, 3);

    let dst = Store::open_in_memory().unwrap();
    let r = dst.import_csv(csv.as_bytes(), &p.suggested, &opts("vectasim")).unwrap();
    assert_eq!((r.added, r.skipped_invalid, r.skipped_duplicate), (3, 0, 0), "{r:?}");
    let (a, b) = (src.totals().unwrap(), dst.totals().unwrap());
    assert_eq!((a.flights, a.completed), (b.flights, b.completed));
    assert_eq!(a.block_time_ms, b.block_time_ms, "off/on block exact to the second");
    // air time travels as H:MM: at most half a minute per flight
    assert!((a.flight_time_ms as i64 - b.flight_time_ms as i64).abs() <= 3 * 30_000, "{} vs {}", a.flight_time_ms, b.flight_time_ms);
    assert!((a.distance_nm - b.distance_nm).abs() <= 3.0 * 0.05 + 1e-9);
    assert_eq!(b.landings, 0, "no touchdowns for imports");
    let imported = dst.list_flights(100, 0).unwrap();
    for f in &imported {
        assert_eq!(f.provider.as_deref(), Some("import:vectasim"));
        let orig = flights.iter().find(|o| o.off_block_ms == f.off_block_ms).expect("same off-block");
        assert_eq!(f.dep_icao, orig.user_dep_icao);
        assert_eq!(f.arr_icao, orig.user_arr_icao);
        assert_eq!(f.aircraft.title, orig.aircraft.title);
        assert_eq!(f.airframe_reg.as_deref(), Some("D-AVCT"));
        assert!(f.notes.as_deref().unwrap_or_default().starts_with("Notiz, mit \"Komma\""), "{:?}", f.notes);
        assert!(f.notes.as_deref().unwrap_or_default().contains("Landerate laut Importdatei"));
    }
    // importing the same file again: all duplicates
    let again = dst.import_csv(csv.as_bytes(), &p.suggested, &opts("vectasim")).unwrap();
    assert_eq!((again.added, again.skipped_duplicate), (0, 3));
}
