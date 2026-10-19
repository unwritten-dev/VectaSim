use std::time::Duration;
use vectasim_online::metar::{decode, observation_ms, parse_noaa_json, parse_vatsim_text};
use vectasim_online::feed::backoff_delay;
use vectasim_online::{Facility, FlightCategory, Metar, MetarClient, Network, OnlineFeed, parse_ivao_json, parse_vatsim_json};

const VATSIM_DATA: &str = include_str!("fixtures/vatsim-data.json");
const NOAA_METAR: &str = include_str!("fixtures/noaa-metar.json");
const VATSIM_METAR: &str = include_str!("fixtures/vatsim-metar.txt");

#[test]
fn parses_vatsim_pilots_controllers_prefiles() {
    let snap = parse_vatsim_json(VATSIM_DATA.as_bytes()).unwrap();
    assert_eq!(snap.update_timestamp, "2026-10-17T12:30:15.1234567Z");
    assert_eq!(snap.pilots.len(), 4);

    let dlh = snap.pilot(1234567).unwrap();
    assert_eq!(dlh.callsign, "DLH4AB");
    assert_eq!(dlh.aircraft_short, "A20N");
    assert_eq!((dlh.departure.as_str(), dlh.arrival.as_str()), ("EDDF", "LEPA"));
    assert_eq!(dlh.heading_deg, 251);
    assert!(dlh.route.starts_with("ANEKI1L"));
    // detail fields for the traffic card
    assert_eq!(dlh.name, "Pilot One EDDF");
    assert_eq!(dlh.logon_time, "2026-10-17T11:58:01.0000000Z");
    assert_eq!(dlh.planned_altitude, "36000");
    assert_eq!(dlh.remarks, "PBN/A1B1C1D1 /v/");
    // the bulk (map) form drops name and remarks, keeps the rest
    let lean = dlh.clone().lean();
    assert_eq!((lean.name.as_str(), lean.remarks.as_str()), ("", ""));
    assert_eq!((lean.callsign.as_str(), lean.planned_altitude.as_str()), ("DLH4AB", "36000"));
    let json = serde_json::to_value(&lean).unwrap();
    assert!(json.get("name").is_none() && json.get("remarks").is_none());

    // no flight plan → empty strings, not a parse error
    let vfr = snap.pilot(1400002).unwrap();
    assert_eq!(vfr.aircraft_short, "");
    assert_eq!(vfr.transponder, "7000");

    // observer and the controller on 199.998 are dropped; ATIS is folded in
    let calls: Vec<&str> = snap.controllers.iter().map(|c| c.callsign.as_str()).collect();
    assert_eq!(calls, ["EDDF_TWR", "EDDF_N_APP", "EDGG_CTR", "EDDF_ATIS"]);
    let atis = snap.controllers.iter().find(|c| c.facility == Facility::Atis).unwrap();
    assert_eq!(atis.atis_code.as_deref(), Some("K"));
    assert_eq!(atis.text_atis.len(), 4);
    let app = &snap.controllers[1];
    assert_eq!(app.station_prefix(), "EDDF");
    assert_eq!(app.facility, Facility::App);
    assert!(snap.controllers[2].facility.is_enroute());

    assert_eq!(snap.prefiles.len(), 1);
    assert_eq!(snap.prefiles[0].aircraft_short, "A320");
}

#[test]
fn bbox_and_nearest_queries() {
    let snap = parse_vatsim_json(VATSIM_DATA.as_bytes()).unwrap();
    let around_fra: Vec<&str> = snap.pilots_in_bbox(8.0, 49.5, 9.5, 50.5, 50).iter().map(|p| p.callsign.as_str()).collect();
    assert_eq!(around_fra, ["DLH4AB", "DEABC"]);

    // capped: the pilot nearest the box centre (50.1, 8.7) wins
    let capped = snap.pilots_in_bbox(8.0, 49.8, 9.4, 50.4, 1);
    assert_eq!(capped[0].callsign, "DEABC");

    // a box across the antimeridian finds the Pacific pilot
    let pacific = snap.pilots_in_bbox(170.0, -20.0, -170.0, 0.0, 50);
    assert_eq!(pacific.len(), 1);
    assert_eq!(pacific[0].callsign, "QFA1");

    let near = snap.nearest_pilots(50.03, 8.57, 2);
    assert_eq!(near[0].pilot.callsign, "DLH4AB");
    assert!(near[0].distance_nm < 1.0);
    assert_eq!(near[1].pilot.callsign, "DEABC");
    assert!(near[1].distance_nm > 5.0 && near[1].distance_nm < 10.0);
}

#[test]
fn feed_snapshot_updates_status() {
    let feed = OnlineFeed::vatsim();
    assert!(!feed.is_enabled());
    assert!(feed.pilots_in_bbox(-180.0, -90.0, 180.0, 90.0, 10).is_empty());
    feed.set_snapshot(parse_vatsim_json(VATSIM_DATA.as_bytes()).unwrap());
    let st = feed.status();
    assert_eq!((st.pilots, st.controllers, st.atis, st.prefiles), (4, 3, 1, 1));
    assert_eq!(feed.pilot(1300001).unwrap().callsign, "BAW117");
    assert_eq!(feed.nearest_pilots(51.0, -10.0, 1)[0].pilot.cid, 1300001);
    feed.stop();
    assert!(feed.snapshot().is_none());
    assert_eq!(feed.status().pilots, 0);
}

#[test]
fn backoff_never_below_15s_and_capped() {
    assert_eq!(backoff_delay(0), Duration::from_secs(15));
    assert_eq!(backoff_delay(1), Duration::from_secs(30));
    assert_eq!(backoff_delay(3), Duration::from_secs(120));
    assert_eq!(backoff_delay(10), Duration::from_secs(300));
}

#[test]
fn decodes_noaa_json() {
    let list = parse_noaa_json(NOAA_METAR).unwrap();
    assert_eq!(list.len(), 3);

    let eddf = &list[0];
    assert_eq!(eddf.station, "EDDF");
    assert_eq!(eddf.source, "aviationweather");
    assert_eq!(eddf.time.as_deref(), Some("171220Z"));
    let w = eddf.wind.as_ref().unwrap();
    assert_eq!((w.direction_deg, w.speed_kt, w.gust_kt), (Some(250), 12, Some(22)));
    assert_eq!(eddf.visibility_m, Some(10_000));
    assert_eq!(eddf.ceiling_ft, Some(4500));
    assert_eq!(eddf.qnh_hpa, Some(1013));
    assert_eq!((eddf.temperature_c, eddf.dewpoint_c), (Some(14), Some(6)));
    assert_eq!(eddf.category, FlightCategory::Vfr);

    // the TEMPO group must not lower the current ceiling
    let egll = &list[1];
    assert_eq!(egll.visibility_m, Some(4000));
    assert_eq!(egll.ceiling_ft, Some(800));
    assert_eq!(egll.category, FlightCategory::Ifr);

    let kjfk = &list[2];
    let w = kjfk.wind.as_ref().unwrap();
    assert_eq!((w.direction_deg, w.speed_kt), (None, 3));
    assert_eq!(kjfk.visibility_m, Some(805));
    assert_eq!(kjfk.ceiling_ft, Some(200));
    assert_eq!(kjfk.altimeter_inhg, Some(30.04));
    assert_eq!(kjfk.qnh_hpa, Some(1017));
    assert_eq!((kjfk.temperature_c, kjfk.dewpoint_c), (Some(8), Some(7)));
    assert_eq!(kjfk.category, FlightCategory::Lifr);

    assert!(parse_noaa_json("").unwrap().is_empty());
}

#[test]
fn decodes_vatsim_text() {
    let list = parse_vatsim_text(VATSIM_METAR);
    assert_eq!(list.len(), 2);
    let eddm = &list[0];
    assert!(eddm.cavok);
    assert_eq!(eddm.source, "vatsim");
    let w = eddm.wind.as_ref().unwrap();
    assert_eq!((w.variable_from_deg, w.variable_to_deg), (Some(30), Some(90)));
    assert_eq!(eddm.category, FlightCategory::Vfr);

    let kbos = &list[1];
    assert_eq!(kbos.visibility_m, Some(2414)); // 1 1/2 SM
    assert_eq!(kbos.ceiling_ft, Some(1500));
    assert_eq!((kbos.temperature_c, kbos.dewpoint_c), (Some(-2), Some(-5)));
    assert_eq!(kbos.category, FlightCategory::Ifr);
}

#[test]
fn observation_time_relative_to_the_landing() {
    // same day
    assert_eq!(observation_ms("181130Z", 1_792_324_800_000), Some(1_792_323_000_000)); // 2026-10-18 12:00 → 11:30
    // report from the last day of the previous month, landing just after midnight
    assert_eq!(observation_ms("302350Z", 1_793_492_400_000), Some(1_793_404_200_000)); // 2026-11-01 00:20 → 10-30 23:50
    // report of the next day, landing just before midnight
    assert_eq!(observation_ms("010010Z", 1_793_490_600_000), Some(1_793_491_800_000)); // 10-31 23:50 → 11-01 00:10
    // day 31 does not exist in November: October 31 is taken
    assert_eq!(observation_ms("311200Z", 1_794_744_000_000), Some(1_793_448_000_000)); // 11-15 → 10-31 12:00
    assert_eq!(observation_ms("1811Z", 1_792_324_800_000), None);
    assert_eq!(observation_ms("182460Z", 1_792_324_800_000), None);
}

#[test]
fn decoder_edge_cases() {
    let mps = decode("UUEE 171230Z 27005MPS 6000 SCT020 OVC030 05/02 Q1009");
    assert_eq!(mps.wind.as_ref().unwrap().speed_kt, 10);
    assert_eq!(mps.category, FlightCategory::Mvfr);

    let calm = decode("METAR LOWW 171230Z 00000KT 0800 FG VV001 M01/M01 Q1022=");
    assert_eq!(calm.station, "LOWW");
    assert_eq!(calm.wind.as_ref().unwrap().speed_kt, 0);
    assert_eq!(calm.category, FlightCategory::Lifr);

    let garbage = decode("XXXX nothing useful here");
    assert_eq!(garbage.category, FlightCategory::Unknown);
    assert!(garbage.wind.is_none());

    assert_eq!(FlightCategory::from_conditions(Some(3000), Some(10.0)), FlightCategory::Mvfr);
    assert_eq!(FlightCategory::from_conditions(Some(3100), Some(6.0)), FlightCategory::Vfr);
    assert_eq!(FlightCategory::from_conditions(None, None), FlightCategory::Unknown);
}

#[test]
fn decoder_survives_non_ascii_tokens() {
    // multi-byte characters right at the byte positions the decoder looks at (4 for the
    // visibility, 3 after the cloud prefix, 3 in the wind group) – no slice panic
    let m = decode("EDDF 171220Z abcÄ 12Ä4 BKNÄ12 OVC0Ä OVC1€ abÄcdKT xyÄ1KT 25012KT 9999 BKN030 14/06 Q1013 äöü€ 𝄞𝄞");
    assert_eq!(m.station, "EDDF");
    assert_eq!(m.wind.as_ref().unwrap().speed_kt, 12);
    assert_eq!(m.visibility_m, Some(10_000));
    assert_eq!(m.ceiling_ft, Some(3000));
    assert_eq!(m.qnh_hpa, Some(1013));
    for raw in ["Ä", "ÄÄÄÄ", "EDDF ÄÄÄÄÄÄZ", "EDDF 1Ä", "EDDF VVÄ", "EDDF ÄÄKT", "EDDF 1ÄVÄ1", "EDDF Ä/Ä", "EDDF ÄSM"] {
        let _ = decode(raw);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn metar_cache_serves_without_network() {
    let client = MetarClient::new();
    let mut m: Metar = decode("EDDF 171220Z 25012KT 9999 FEW035 14/06 Q1013");
    m.source = "aviationweather".into();
    client.insert(m);
    let got = client.get_many(&["eddf".into(), "EDDF".into(), "bad id!".into()]).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].station, "EDDF");
    assert_eq!(client.get("EDDF").await.unwrap().unwrap().qnh_hpa, Some(1013));
}

/// Shortened Whazzup v2 file in the live structure (2026-10-18) with invented callsigns and ids.
const IVAO_DATA: &str = include_str!("fixtures/ivao-whazzup.json");

#[test]
fn parses_ivao_pilots_and_atc() {
    let snap = parse_ivao_json(IVAO_DATA.as_bytes()).unwrap();
    assert_eq!(snap.network, Network::Ivao);
    assert_eq!(snap.update_timestamp, "2026-10-18T14:45:28.259225639Z");
    // the pilot without lastTrack has no position yet and is skipped
    let calls: Vec<&str> = snap.pilots.iter().map(|p| p.callsign.as_str()).collect();
    assert_eq!(calls, ["TST101", "DTEST", "TST3"]);
    assert!(snap.pilots.iter().all(|p| p.network == Network::Ivao));

    let a = snap.pilot(900101).unwrap();
    assert_eq!((a.departure.as_str(), a.arrival.as_str(), a.aircraft_short.as_str()), ("EDDF", "LEPA", "A20N"));
    assert_eq!((a.altitude_ft, a.ground_speed_kt, a.heading_deg), (34012, 452, 211));
    assert_eq!(a.transponder, "2301");
    assert_eq!(a.flight_rules, "I");
    assert_eq!(a.on_ground, Some(false));
    assert_eq!((a.planned_altitude.as_str(), a.remarks.as_str(), a.aircraft_model.as_str()), ("F340", "TEST", "A320neo"));
    assert_eq!(a.logon_time, "2026-10-18T10:00:00.000Z");
    // IVAO publishes no names
    assert_eq!(a.name, "");

    // no flight plan → empty strings; onGround passes through
    let vfr = snap.pilot(900102).unwrap();
    assert_eq!(vfr.aircraft_short, "");
    assert_eq!(vfr.transponder, "7000");
    assert_eq!(vfr.on_ground, Some(true));

    // nulls everywhere: type from flightPlan.aircraft.icaoCode, no transponder
    let pac = snap.pilot(900103).unwrap();
    assert_eq!(pac.aircraft_short, "B789");
    assert_eq!(pac.transponder, "");
    assert_eq!(pac.route, "");

    // frequency 0 dropped, position from the callsign suffix when null, DEP counts as APP
    let atc: Vec<(&str, &str, Facility)> = snap.controllers.iter().map(|c| (c.callsign.as_str(), c.frequency.as_str(), c.facility)).collect();
    assert_eq!(
        atc,
        [
            ("EDDF_TWR", "119.900", Facility::Twr),
            ("EDDF_N_APP", "120.805", Facility::App),
            ("EDGG_CTR", "127.500", Facility::Ctr),
            ("EDDM_GND", "121.775", Facility::Gnd),
            ("EDDM_DEP", "129.000", Facility::App),
        ]
    );
    let twr = &snap.controllers[0];
    assert_eq!(twr.network, Network::Ivao);
    assert_eq!(twr.atis_code.as_deref(), Some("K"));
    // the voice-room line is not ATIS text
    assert_eq!(twr.text_atis, ["Frankfurt Information KILO recorded at 1420z", "RWY 25C IN USE"]);
    assert!(snap.controllers[1].text_atis.is_empty());
    // centre stations get no ATIS letter
    assert_eq!(snap.controllers[2].atis_code, None);
    assert_eq!(snap.controllers[2].station_prefix(), "EDGG");
    assert!(snap.prefiles.is_empty());
}

#[test]
fn rejects_garbage_but_tolerates_empty_ivao_file() {
    assert!(parse_ivao_json(b"<html>maintenance</html>").is_err());
    let empty = parse_ivao_json(br#"{"updatedAt":null,"clients":null}"#).unwrap();
    assert!(empty.pilots.is_empty() && empty.controllers.is_empty());
}

#[test]
fn ivao_feed_and_merged_queries() {
    let ivao = OnlineFeed::ivao();
    assert_eq!(ivao.status().network, Network::Ivao);
    ivao.set_snapshot(parse_ivao_json(IVAO_DATA.as_bytes()).unwrap());
    let st = ivao.status();
    assert_eq!((st.pilots, st.controllers, st.atis, st.prefiles), (3, 5, 0, 0));
    ivao.stop();
    assert_eq!(ivao.status().network, Network::Ivao);
    assert!(ivao.snapshot().is_none());

    // both networks in one query: VATSIM's DLH4AB and IVAO's TST101 sit at Frankfurt
    let v = parse_vatsim_json(VATSIM_DATA.as_bytes()).unwrap();
    let i = parse_ivao_json(IVAO_DATA.as_bytes()).unwrap();
    let both = vectasim_online::pilots_in_bbox(v.pilots.iter().chain(i.pilots.iter()), 8.0, 49.5, 9.5, 50.5, 50);
    let tagged: Vec<(Network, &str)> = both.iter().map(|p| (p.network, p.callsign.as_str())).collect();
    assert!(tagged.contains(&(Network::Vatsim, "DLH4AB")));
    assert!(tagged.contains(&(Network::Ivao, "TST101")));
    let near = vectasim_online::nearest_pilots(v.pilots.iter().chain(i.pilots.iter()), 50.0455, 8.5421, 1);
    assert_eq!((near[0].pilot.network, near[0].pilot.callsign.as_str()), (Network::Ivao, "DTEST"));

    // the network goes to the webview as "vatsim" / "ivao"
    assert_eq!(serde_json::to_value(&i.pilots[0]).unwrap()["network"], "ivao");
    assert_eq!(serde_json::to_value(&v.controllers[0]).unwrap()["network"], "vatsim");
    assert_eq!(serde_json::to_value(ivao.status()).unwrap()["network"], "ivao");
    assert_eq!(Network::from_id("IVAO"), Some(Network::Ivao));
}

/// Manual check against a real download: `VECTASIM_IVAO_FILE=whazzup.json cargo test -p vectasim-online -- --ignored`.
#[test]
#[ignore]
fn parses_live_ivao_file() {
    let Ok(path) = std::env::var("VECTASIM_IVAO_FILE") else { return };
    let snap = parse_ivao_json(&std::fs::read(path).unwrap()).unwrap();
    let positioned = snap.pilots.iter().filter(|p| p.latitude != 0.0 || p.longitude != 0.0).count();
    println!("{} pilots ({positioned} with position), {} controllers, updated {}", snap.pilots.len(), snap.controllers.len(), snap.update_timestamp);
    assert!(!snap.pilots.is_empty());
}
