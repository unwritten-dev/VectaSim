//! File exports of a recorded flight (CSV, GPX, KML, JSON).
//!
//! Everything is rendered to a `String` so the app can either hand it to the
//! frontend or write it to the file the user picked. Writers are hand-rolled:
//! the formats are small and fixed, and a full XML/CSV dependency would cost
//! more than these few hundred lines.
//!
//! - CSV: one row per track sample, RFC 4180 quoting, `.` decimals.
//! - GPX 1.1: one `trkseg`, elevation in metres, ISO-8601 UTC times, speed (m/s)
//!   and course in the Garmin TrackPointExtension v2 that most tools read.
//! - KML 2.2: the path as `gx:Track` with `altitudeMode` absolute (so Google
//!   Earth replays it in 3-D with time), plus placemarks for departure,
//!   arrival and every touchdown.
//! - JSON: the full `FlightDetail` plus the decoded track.

use crate::store::{FlightDetail, FlightRow};
use crate::track::TrackSample;
use serde::Serialize;
use std::fmt::Write as _;
use vectasim_core::TouchdownReport;

const FT_TO_M: f64 = 0.3048;
const KT_TO_MS: f64 = 1852.0 / 3600.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Gpx,
    Kml,
    Json,
}

impl ExportFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "csv" => Some(Self::Csv),
            "gpx" => Some(Self::Gpx),
            "kml" => Some(Self::Kml),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Gpx => "gpx",
            Self::Kml => "kml",
            Self::Json => "json",
        }
    }
}

/// Render one flight in the given format.
pub fn export_flight(format: ExportFormat, detail: &FlightDetail, samples: &[TrackSample]) -> crate::Result<String> {
    Ok(match format {
        ExportFormat::Csv => export_csv(samples),
        ExportFormat::Gpx => export_gpx(&detail.flight, samples),
        ExportFormat::Kml => export_kml(&detail.flight, samples, &detail.touchdowns),
        ExportFormat::Json => export_json(detail, samples)?,
    })
}

// ---- CSV -------------------------------------------------------------------------------

const TRACK_CSV_HEADER: &str = "time_utc,t_ms,latitude,longitude,altitude_msl_ft,altitude_agl_ft,ground_speed_kt,ias_kt,\
vertical_speed_fpm,heading_true_deg,pitch_deg,bank_deg,g_force,on_ground,flaps_index,gear_pct,fuel_total_kg";

pub fn export_csv(samples: &[TrackSample]) -> String {
    let mut out = String::with_capacity(64 + samples.len() * 140);
    out.push_str(TRACK_CSV_HEADER);
    out.push_str("\r\n");
    for s in samples {
        let _ = write!(
            out,
            "{},{},{:.7},{:.7},{:.1},{:.1},{:.1},{:.1},{:.0},{:.2},{:.2},{:.2},{:.3},{},{},{:.0},{:.1}\r\n",
            iso_utc(s.t_ms),
            s.t_ms,
            s.latitude,
            s.longitude,
            s.altitude_msl_ft,
            s.altitude_agl_ft,
            s.ground_speed_kt,
            s.ias_kt,
            s.vertical_speed_fpm,
            s.heading_true_deg,
            s.pitch_deg,
            s.bank_deg,
            s.g_force,
            u8::from(s.on_ground),
            s.flaps_index,
            s.gear_pct,
            s.fuel_total_kg,
        );
    }
    out
}

const LOGBOOK_CSV_HEADER: &str = "id,state,date_utc,off_block_utc,on_block_utc,dep,arr,callsign,aircraft,aircraft_type,\
registration,block_time,flight_time,distance_nm,max_alt_ft,landing_vs_fpm,landings,fuel_start_kg,fuel_end_kg,\
fuel_used_kg,planned_dep,planned_arr,planned_block_time,planned_fuel_ramp_kg,planned_fuel_landing_kg,paused_s,\
pause_count,slew,time_acceleration,max_sim_rate,crashed,fuel_increased_airborne,provider,sim";

/// One row per flight, for spreadsheets. Durations as `H:MM`, empty cells for unknowns.
pub fn export_logbook_csv(flights: &[FlightRow]) -> String {
    let mut out = String::with_capacity(512 + flights.len() * 256);
    out.push_str(LOGBOOK_CSV_HEADER);
    out.push_str("\r\n");
    for f in flights {
        let start = f.off_block_ms.unwrap_or(f.created_ms);
        let block_ms = f.on_block_ms.zip(f.off_block_ms).map(|(on, off)| on.saturating_sub(off));
        let flight_ms = f.landing_ms.zip(f.takeoff_ms).map(|(l, t)| l.saturating_sub(t));
        let fuel_used = f.fuel_start_kg.zip(f.fuel_end_kg).map(|(s, e)| s - e);
        let callsign = f.callsign.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| {
            let airline = format!("{} {}", f.aircraft.atc_airline, f.aircraft.atc_flight_number).trim().to_owned();
            if airline.is_empty() { f.aircraft.atc_id.clone() } else { airline }
        });
        let i = &f.integrity;
        let cells: [String; 34] = [
            f.id.clone(),
            f.state.clone(),
            iso_utc(start)[..10].to_owned(),
            f.off_block_ms.map(iso_utc).unwrap_or_default(),
            f.on_block_ms.map(iso_utc).unwrap_or_default(),
            f.dep_icao.clone().unwrap_or_default(),
            f.arr_icao.clone().unwrap_or_default(),
            callsign,
            f.aircraft.title.clone(),
            f.aircraft.atc_model.clone(),
            f.aircraft.atc_id.clone(),
            block_ms.map(hmm).unwrap_or_default(),
            flight_ms.map(hmm).unwrap_or_default(),
            format!("{:.1}", f.distance_nm),
            format!("{:.0}", f.max_alt_msl_ft),
            num(f.landing_vs_fpm, 0),
            f.landing_count.to_string(),
            num(f.fuel_start_kg, 0),
            num(f.fuel_end_kg, 0),
            num(fuel_used, 0),
            f.planned_dep.clone().unwrap_or_default(),
            f.planned_arr.clone().unwrap_or_default(),
            f.planned_block_s.map(|s| hmm(s * 1000)).unwrap_or_default(),
            num(f.planned_fuel_ramp_kg, 0),
            num(f.planned_fuel_landing_kg, 0),
            (i.paused_ms / 1000).to_string(),
            i.pause_count.to_string(),
            u8::from(i.slew_detected).to_string(),
            u8::from(i.time_acceleration_detected).to_string(),
            format!("{}", i.max_sim_rate),
            u8::from(i.crashed).to_string(),
            u8::from(i.fuel_increased_airborne).to_string(),
            f.provider.clone().unwrap_or_default(),
            f.sim_name.clone().unwrap_or_default(),
        ];
        for (n, c) in cells.iter().enumerate() {
            if n > 0 {
                out.push(',');
            }
            push_csv_cell(&mut out, c);
        }
        out.push_str("\r\n");
    }
    out
}

fn push_csv_cell(out: &mut String, cell: &str) {
    if cell.contains([',', '"', '\n', '\r']) {
        out.push('"');
        out.push_str(&cell.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(cell);
    }
}

fn num(v: Option<f64>, digits: usize) -> String {
    v.map(|v| format!("{v:.digits$}")).unwrap_or_default()
}

fn hmm(ms: u64) -> String {
    let min = (ms + 30_000) / 60_000;
    format!("{}:{:02}", min / 60, min % 60)
}

// ---- GPX -------------------------------------------------------------------------------

pub fn export_gpx(flight: &FlightRow, samples: &[TrackSample]) -> String {
    let name = xml_escape(&flight_title(flight));
    let mut out = String::with_capacity(512 + samples.len() * 260);
    out.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VectaSim" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
"#);
    let _ = writeln!(out, "  <metadata>\n    <name>{name}</name>");
    if let Some(t) = flight.off_block_ms.or(samples.first().map(|s| s.t_ms)) {
        let _ = writeln!(out, "    <time>{}</time>", iso_utc(t));
    }
    out.push_str("  </metadata>\n");
    let _ = writeln!(out, "  <trk>\n    <name>{name}</name>");
    if !flight.aircraft.title.is_empty() {
        let _ = writeln!(out, "    <desc>{}</desc>", xml_escape(&flight.aircraft.title));
    }
    out.push_str("    <type>flight</type>\n    <trkseg>\n");
    for s in samples {
        let _ = writeln!(
            out,
            "      <trkpt lat=\"{:.7}\" lon=\"{:.7}\"><ele>{:.1}</ele><time>{}</time>\
<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>{:.2}</gpxtpx:speed><gpxtpx:course>{:.1}</gpxtpx:course>\
</gpxtpx:TrackPointExtension></extensions></trkpt>\n",
            s.latitude,
            s.longitude,
            s.altitude_msl_ft * FT_TO_M,
            iso_utc(s.t_ms),
            s.ground_speed_kt * KT_TO_MS,
            s.heading_true_deg.rem_euclid(360.0),
        );
    }
    out.push_str("    </trkseg>\n  </trk>\n</gpx>\n");
    out
}

// ---- KML -------------------------------------------------------------------------------

pub fn export_kml(flight: &FlightRow, samples: &[TrackSample], touchdowns: &[TouchdownReport]) -> String {
    let mut out = String::with_capacity(1024 + samples.len() * 120);
    out.push_str(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
"#,
    );
    let _ = writeln!(out, "  <name>{}</name>", xml_escape(&flight_title(flight)));
    if !flight.aircraft.title.is_empty() {
        let _ = writeln!(out, "  <description>{}</description>", xml_escape(&flight.aircraft.title));
    }
    out.push_str(
        r#"  <Style id="track"><LineStyle><color>ffffc24c</color><width>3</width></LineStyle><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle></Style>
  <Style id="airport"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon></IconStyle></Style>
  <Style id="touchdown"><IconStyle><color>ff3c4ce7</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>
"#,
    );

    let dep = flight.dep_lat.zip(flight.dep_lon).or(samples.first().map(|s| (s.latitude, s.longitude)));
    if let Some((lat, lon)) = dep {
        let label = flight.dep_icao.as_deref().unwrap_or("");
        point_placemark(&mut out, &format!("Abflug {label}"), "airport", lat, lon, flight.off_block_ms, None);
    }

    out.push_str("  <Placemark>\n    <name>Flugweg</name>\n    <styleUrl>#track</styleUrl>\n    <gx:Track>\n      <altitudeMode>absolute</altitudeMode>\n");
    for s in samples {
        let _ = writeln!(out, "      <when>{}</when>", iso_utc(s.t_ms));
    }
    for s in samples {
        let _ = writeln!(out, "      <gx:coord>{:.7} {:.7} {:.1}</gx:coord>", s.longitude, s.latitude, s.altitude_msl_ft * FT_TO_M);
    }
    for s in samples {
        // KML tilt is positive nose-up, roll positive right-wing-down.
        let _ = writeln!(out, "      <gx:angles>{:.1} {:.1} {:.1}</gx:angles>", s.heading_true_deg.rem_euclid(360.0), s.pitch_deg, s.bank_deg);
    }
    out.push_str("    </gx:Track>\n  </Placemark>\n");

    for (n, t) in touchdowns.iter().enumerate() {
        let desc = format!(
            "{:.0} fpm · {:.2} g · {:.0} kt · {} Bounce{}",
            t.landing_rate_fpm,
            t.peak_g,
            t.ground_speed_kt,
            t.bounces,
            if t.touch_and_go { " · Touch-and-go" } else { "" }
        );
        point_placemark(&mut out, &format!("Aufsetzen {}", n + 1), "touchdown", t.latitude, t.longitude, Some(t.timestamp_ms), Some(&desc));
    }

    let arr = flight.arr_lat.zip(flight.arr_lon).or(samples.last().map(|s| (s.latitude, s.longitude)));
    if let Some((lat, lon)) = arr.filter(|_| flight.on_block_ms.is_some() || flight.arr_lat.is_some()) {
        let label = flight.arr_icao.as_deref().unwrap_or("");
        point_placemark(&mut out, &format!("Ankunft {label}"), "airport", lat, lon, flight.on_block_ms, None);
    }

    out.push_str("</Document>\n</kml>\n");
    out
}

fn point_placemark(out: &mut String, name: &str, style: &str, lat: f64, lon: f64, when: Option<u64>, desc: Option<&str>) {
    let _ = writeln!(out, "  <Placemark>\n    <name>{}</name>", xml_escape(name.trim()));
    if let Some(d) = desc {
        let _ = writeln!(out, "    <description>{}</description>", xml_escape(d));
    }
    if let Some(t) = when {
        let _ = writeln!(out, "    <TimeStamp><when>{}</when></TimeStamp>", iso_utc(t));
    }
    let _ = writeln!(
        out,
        "    <styleUrl>#{style}</styleUrl>\n    <Point><altitudeMode>clampToGround</altitudeMode><coordinates>{lon:.7},{lat:.7},0</coordinates></Point>\n  </Placemark>"
    );
}

// ---- JSON ------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonExport<'a> {
    format: &'static str,
    version: u32,
    #[serde(flatten)]
    detail: &'a FlightDetail,
    track: &'a [TrackSample],
}

pub fn export_json(detail: &FlightDetail, samples: &[TrackSample]) -> crate::Result<String> {
    Ok(serde_json::to_string_pretty(&JsonExport { format: "vectasim-flight", version: 1, detail, track: samples })?)
}

// ---- helpers ---------------------------------------------------------------------------

/// "EDDF → EGLL · DLH4AB" style title used as document/track name.
pub fn flight_title(f: &FlightRow) -> String {
    let route = format!("{} → {}", f.dep_icao.as_deref().unwrap_or("????"), f.arr_icao.as_deref().unwrap_or("????"));
    match f.callsign.as_deref().filter(|c| !c.is_empty()) {
        Some(cs) => format!("{route} · {cs}"),
        None => route,
    }
}

/// Suggested file name, e.g. `2026-10-17_EDDF-EGLL.gpx`.
pub fn file_name(f: &FlightRow, format: ExportFormat) -> String {
    let date = &iso_utc(f.off_block_ms.unwrap_or(f.created_ms))[..10];
    let clean = |s: Option<&str>| s.unwrap_or("XXXX").chars().filter(char::is_ascii_alphanumeric).collect::<String>();
    format!("{date}_{}-{}.{}", clean(f.dep_icao.as_deref()), clean(f.arr_icao.as_deref()), format.extension())
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids most control characters even escaped.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

/// Unix milliseconds → `YYYY-MM-DDTHH:MM:SS[.mmm]Z`.
pub fn iso_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    if millis == 0 {
        format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
    } else {
        format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
    }
}

/// Days since 1970-01-01 → (year, month, day); Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::PhaseEventRow;
    use quick_xml::Reader;
    use quick_xml::events::Event;
    use vectasim_core::{AircraftInfo, FlightPhase};

    const T0: u64 = 1_792_137_600_000; // 2026-10-16T08:00:00Z

    fn flight() -> FlightRow {
        FlightRow {
            id: "f1".into(),
            state: "completed".into(),
            created_ms: T0,
            off_block_ms: Some(T0),
            takeoff_ms: Some(T0 + 10_000),
            landing_ms: Some(T0 + 50_000),
            on_block_ms: Some(T0 + 59_000),
            dep_lat: Some(50.03),
            dep_lon: Some(8.56),
            arr_lat: Some(51.47),
            arr_lon: Some(-0.45),
            dep_icao: Some("EDDF".into()),
            arr_icao: Some("EGLL".into()),
            callsign: Some("DLH4AB".into()),
            distance_nm: 12.34,
            fuel_start_kg: Some(5000.0),
            fuel_end_kg: Some(4200.0),
            // characters that must be escaped in XML and quoted in CSV
            aircraft: AircraftInfo { title: "A320 <Neo> & \"Friends\", Livery".into(), ..Default::default() },
            ..Default::default()
        }
    }

    fn samples(n: usize) -> Vec<TrackSample> {
        (0..n)
            .map(|i| TrackSample {
                t_ms: T0 + i as u64 * 1000 + 250,
                latitude: 50.0 + i as f64 * 0.01,
                longitude: 8.5 - i as f64 * 0.02,
                altitude_msl_ft: 364.0 + i as f64 * 100.0,
                ground_speed_kt: 150.0,
                heading_true_deg: if i == 0 { -10.0 } else { 270.0 },
                ..Default::default()
            })
            .collect()
    }

    fn touchdown(ts: u64) -> TouchdownReport {
        TouchdownReport {
            timestamp_ms: ts,
            vs_fpm_measured: -142.0,
            vs_fpm_sim: -138.0,
            vs_fpm_hardest: -142.0,
            peak_g: 1.21,
            pitch_deg: 4.0,
            bank_deg: 0.5,
            ground_speed_kt: 132.0,
            heading_true_deg: 270.0,
            latitude: 51.47,
            longitude: -0.46,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: -138.0,
            landing_rate_source: vectasim_core::LandingRateSource::Sim,
        }
    }

    type Attrs = Vec<(String, Vec<(String, String)>)>;

    /// Minimal event walk: element names (with prefix) in document order, the
    /// text of each leaf as `(element, text)`, and the attributes of each start tag.
    fn walk(xml: &str) -> (Vec<String>, Vec<(String, String)>, Attrs) {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(true);
        let mut names = Vec::new();
        let mut texts = Vec::new();
        let mut attrs = Vec::new();
        let mut stack: Vec<String> = Vec::new();
        loop {
            match reader.read_event().expect("well-formed XML") {
                Event::Start(e) => {
                    let name = e.name().as_ref().to_owned();
                    let a = e
                        .attributes()
                        .map(|a| {
                            let a = a.unwrap();
                            (a.key.as_ref().to_owned(), a.value.into_owned())
                        })
                        .collect();
                    attrs.push((name.clone(), a));
                    names.push(name.clone());
                    stack.push(name);
                }
                Event::Empty(e) => names.push(e.name().as_ref().to_owned()),
                Event::End(_) => {
                    stack.pop();
                }
                Event::Text(t) => {
                    if let Some(top) = stack.last() {
                        texts.push((top.clone(), t.to_string()));
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
        assert!(stack.is_empty(), "unclosed elements: {stack:?}");
        (names, texts, attrs)
    }

    #[test]
    fn iso_time_formatting() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(T0), "2026-10-16T08:00:00Z");
        assert_eq!(iso_utc(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(hmm(59 * 60_000 + 40_000), "1:00");
        assert_eq!(hmm(0), "0:00");
    }

    #[test]
    fn csv_has_one_row_per_sample() {
        let csv = export_csv(&samples(5));
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 6);
        assert_eq!(lines[0].split(',').count(), lines[1].split(',').count());
        assert!(lines[1].starts_with("2026-10-16T08:00:00.250Z,"));
    }

    #[test]
    fn logbook_csv_quotes_and_columns() {
        let mut f2 = flight();
        f2.id = "f2".into();
        f2.on_block_ms = None;
        f2.fuel_end_kg = None;
        let csv = export_logbook_csv(&[flight(), f2]);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 3);
        let header_cols = lines[0].split(',').count();
        assert_eq!(header_cols, 34);
        assert!(lines[1].contains("\"A320 <Neo> & \"\"Friends\"\", Livery\""));
        assert!(lines[1].starts_with("f1,completed,2026-10-16,2026-10-16T08:00:00Z,"));
        // block 59 s → rounds to 0:01, fuel used 800
        assert!(lines[1].contains(",0:01,0:01,12.3,"));
        assert!(lines[1].contains(",5000,4200,800,"));
        assert!(lines[2].contains(",5000,,,"));
    }

    #[test]
    fn gpx_parses_with_ordered_points() {
        let s = samples(20);
        let gpx = export_gpx(&flight(), &s);
        let (names, texts, attrs) = walk(&gpx);
        assert_eq!(names.iter().filter(|n| *n == "trkpt").count(), 20);
        assert_eq!(names.iter().filter(|n| *n == "trkseg").count(), 1);
        assert_eq!(names.iter().filter(|n| *n == "gpxtpx:speed").count(), 20);

        let times: Vec<&str> =
            texts.iter().filter(|(n, _)| n == "time").map(|(_, t)| t.as_str()).skip(1).collect(); // skip metadata time
        assert_eq!(times.len(), 20);
        assert!(times.windows(2).all(|w| w[0] < w[1]), "times ascending");
        assert_eq!(times[0], "2026-10-16T08:00:00.250Z");

        let ele: Vec<f64> = texts.iter().filter(|(n, _)| n == "ele").map(|(_, t)| t.parse().unwrap()).collect();
        assert!((ele[0] - 364.0 * FT_TO_M).abs() < 0.1);
        let speed: f64 = texts.iter().find(|(n, _)| n == "gpxtpx:speed").unwrap().1.parse().unwrap();
        assert!((speed - 77.17).abs() < 0.01);
        let course: f64 = texts.iter().find(|(n, _)| n == "gpxtpx:course").unwrap().1.parse().unwrap();
        assert_eq!(course, 350.0);

        let lats: Vec<f64> = attrs
            .iter()
            .filter(|(n, _)| n == "trkpt")
            .map(|(_, a)| a.iter().find(|(k, _)| k == "lat").unwrap().1.parse().unwrap())
            .collect();
        assert!(lats.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn kml_parses_with_matching_track_arrays() {
        let s = samples(15);
        let tds = [touchdown(T0 + 48_000), touchdown(T0 + 50_000)];
        let kml = export_kml(&flight(), &s, &tds);
        let (names, texts, _) = walk(&kml);

        // departure + track + 2 touchdowns + arrival
        assert_eq!(names.iter().filter(|n| *n == "Placemark").count(), 5);
        assert_eq!(names.iter().filter(|n| *n == "gx:Track").count(), 1);
        let pm_names: Vec<&str> = texts.iter().filter(|(n, _)| n == "name").map(|(_, t)| t.as_str()).skip(1).collect();
        assert_eq!(pm_names, ["Abflug EDDF", "Flugweg", "Aufsetzen 1", "Aufsetzen 2", "Ankunft EGLL"]);

        // gx:Track: all <when> first, then all <gx:coord>, then <gx:angles>; counts equal
        let start = names.iter().position(|n| n == "gx:Track").unwrap();
        let track: Vec<&String> = names[start + 1..].iter().take_while(|n| *n != "Placemark").collect();
        assert_eq!(track[0], "altitudeMode");
        let whens = track.iter().filter(|n| **n == "when").count();
        let coords = track.iter().filter(|n| **n == "gx:coord").count();
        let angles = track.iter().filter(|n| **n == "gx:angles").count();
        assert_eq!((whens, coords, angles), (15, 15, 15));
        let last_when = track.iter().rposition(|n| *n == "when").unwrap();
        let first_coord = track.iter().position(|n| *n == "gx:coord").unwrap();
        assert!(last_when < first_coord);

        assert!(texts.iter().any(|(n, t)| n == "altitudeMode" && t == "absolute"));
        let first: Vec<f64> = texts.iter().find(|(n, _)| n == "gx:coord").unwrap().1.split(' ').map(|v| v.parse().unwrap()).collect();
        assert_eq!(first.len(), 3);
        assert!((first[0] - 8.5).abs() < 1e-9 && (first[1] - 50.0).abs() < 1e-9, "lon lat order");
        assert!((first[2] - 364.0 * FT_TO_M).abs() < 0.1);

        let track_whens: Vec<&str> = texts
            .iter()
            .filter(|(n, t)| n == "when" && t.ends_with(".250Z"))
            .map(|(_, t)| t.as_str())
            .collect();
        assert_eq!(track_whens.len(), 15);
        assert!(track_whens.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn kml_without_samples_is_still_valid() {
        let kml = export_kml(&FlightRow::default(), &[], &[]);
        let (names, _, _) = walk(&kml);
        assert_eq!(names.iter().filter(|n| *n == "Placemark").count(), 1);
    }

    #[test]
    fn json_roundtrips_detail_and_track() {
        let detail = FlightDetail {
            flight: flight(),
            touchdowns: vec![touchdown(T0 + 50_000)],
            phases: vec![PhaseEventRow { from: FlightPhase::Preflight, to: FlightPhase::TaxiOut, timestamp_ms: T0 + 1000 }],
            has_track: true,
            ofp_json: None,
        };
        let json = export_json(&detail, &samples(3)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["format"], "vectasim-flight");
        assert_eq!(v["flight"]["depIcao"], "EDDF");
        assert_eq!(v["track"].as_array().unwrap().len(), 3);
        assert_eq!(v["track"][0]["altitudeMslFt"], 364.0);
        assert_eq!(v["phases"][0]["to"], "taxiOut");
    }

    #[test]
    fn file_names_and_formats() {
        assert_eq!(file_name(&flight(), ExportFormat::Kml), "2026-10-16_EDDF-EGLL.kml");
        assert_eq!(ExportFormat::parse("GPX"), Some(ExportFormat::Gpx));
        assert_eq!(ExportFormat::parse("xls"), None);
    }
}
