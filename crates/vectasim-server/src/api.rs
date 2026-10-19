//! The JSON schema of `/api/v1/*` and the WebSocket messages (docs/overlay-api.md).
//!
//! These types are the stable interface: field names are camelCase, absent values are
//! `null` (never left out), units are in the field name (`…Ft`, `…Kt`, `…Fpm`, `…Ms` = Unix
//! milliseconds, `…Kg`, `…Nm`). New fields may be added in v1; nothing is renamed or removed.
//! The golden tests at the bottom pin the field lists.
//!
//! Streamer-Modus: [`Snapshot::masked`], [`Landing::mask`] and [`LogbookEntry::mask`] apply
//! the same display masking as the UI (format.ts → privacy / maskTitle): registrations keep
//! their nationality prefix ("D-••••"), callsigns become "•••••", airlines "•••", and the
//! aircraft title loses every occurrence of those values.

use serde::Serialize;
use vectasim_core::landing::Band;
use vectasim_core::{FlightPhase, FlightState, Lang, LandingRateSource};

pub const API_VERSION: u32 = 1;

/// `GET /api/v1/status`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub api_version: u32,
    pub app: String,
    /// App version (semver).
    pub version: String,
    /// simconnect | mock | replay | …
    pub provider: String,
    /// idle | connecting | connected | disconnected | error
    pub connection: String,
    /// Human-readable detail of the connection state (German, as the app shows it).
    pub detail: String,
    pub sim_name: Option<String>,
    pub sim_version: Option<String>,
    /// A flight is being recorded.
    pub recording: bool,
    /// Streamer-Modus on: registration, callsign and airline are masked in every answer.
    pub streamer_mode: bool,
    pub server_time_ms: u64,
    /// Backend language (de | en): language of `bandLabel` and the overlay pages' default.
    pub lang: Lang,
}

/// Aircraft as the UI names it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Aircraft {
    /// Sim title ("Airbus A320neo Lufthansa").
    pub title: Option<String>,
    /// ICAO type designator ("A20N").
    pub icao_type: Option<String>,
    pub registration: Option<String>,
    pub airline: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fuel {
    pub start_kg: Option<f64>,
    pub current_kg: Option<f64>,
    pub used_kg: Option<f64>,
    /// From the dispatch plan (SimBrief OFP), if one is attached.
    pub planned_ramp_kg: Option<f64>,
    pub planned_landing_kg: Option<f64>,
}

/// `GET /api/v1/flight`: the flight of the running session (what the live side panel shows).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flight {
    /// Logbook id (UUID) once the flight is recorded.
    pub id: Option<String>,
    /// idle | active | completed | interrupted
    pub state: FlightState,
    /// preflight | pushback | taxiOut | takeoff | climb | cruise | descent | approach | final | landing | taxiIn | shutdown
    pub phase: FlightPhase,
    pub off_block_ms: Option<u64>,
    pub takeoff_ms: Option<u64>,
    pub landing_ms: Option<u64>,
    pub on_block_ms: Option<u64>,
    /// Off-block → on-block; while the flight is active: off-block → now.
    pub block_time_ms: Option<u64>,
    /// Take-off → landing; while airborne: take-off → now.
    pub flight_time_ms: Option<u64>,
    /// ICAO of the departure airport.
    pub departure: Option<String>,
    /// ICAO of the airport the flight landed at (once landed).
    pub arrival: Option<String>,
    /// ICAO of the destination: the dispatch plan, else the arrival.
    pub destination: Option<String>,
    pub callsign: Option<String>,
    pub aircraft: Aircraft,
    pub distance_nm: f64,
    pub max_altitude_ft: f64,
    /// Great circle to the destination; `null` without a destination or after landing.
    pub remaining_nm: Option<f64>,
    /// From the current ground speed (≥ 50 kt), Unix ms.
    pub eta_ms: Option<u64>,
    pub fuel: Fuel,
    /// Headline rate of the last full-stop touchdown, fpm (negative = descending).
    pub landing_rate_fpm: Option<f64>,
    /// Touchdowns so far (touch-and-goes included).
    pub touchdowns: u32,
}

/// `GET /api/v1/telemetry`: the latest sample (the WebSocket sends it at 2 Hz).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    pub timestamp_ms: u64,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_msl_ft: f64,
    pub altitude_agl_ft: f64,
    pub ias_kt: f64,
    pub tas_kt: f64,
    pub ground_speed_kt: f64,
    pub vertical_speed_fpm: f64,
    pub heading_mag_deg: f64,
    pub heading_true_deg: f64,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub g_force: f64,
    pub on_ground: bool,
    pub gear_pct: f64,
    pub flaps_index: i32,
    pub fuel_total_kg: f64,
    pub paused: bool,
    pub sim_rate: f64,
    pub wind_dir_true_deg: Option<f64>,
    pub wind_kt: Option<f64>,
}

impl From<&vectasim_core::Telemetry> for Telemetry {
    fn from(t: &vectasim_core::Telemetry) -> Self {
        Self {
            timestamp_ms: t.timestamp_ms,
            latitude: t.latitude,
            longitude: t.longitude,
            altitude_msl_ft: t.altitude_msl_ft,
            altitude_agl_ft: t.altitude_agl_ft,
            ias_kt: t.ias_kt,
            tas_kt: t.tas_kt,
            ground_speed_kt: t.ground_speed_kt,
            vertical_speed_fpm: t.vertical_speed_fpm,
            heading_mag_deg: t.heading_mag_deg,
            heading_true_deg: t.heading_true_deg,
            pitch_deg: t.pitch_deg,
            bank_deg: t.bank_deg,
            g_force: t.g_force,
            on_ground: t.on_ground,
            gear_pct: t.gear_pct,
            flaps_index: t.flaps_index,
            fuel_total_kg: t.fuel_total_kg,
            paused: t.paused,
            sim_rate: t.sim_rate,
            wind_dir_true_deg: t.wind_dir_true_deg,
            wind_kt: t.wind_kt,
        }
    }
}

/// `GET /api/v1/landing`: the last landing – of the running flight, else the newest in the logbook.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Landing {
    pub flight_id: Option<String>,
    /// Index within the flight's touchdowns.
    pub touchdown_index: u32,
    /// First contact, Unix ms.
    pub timestamp_ms: u64,
    /// Headline landing rate, fpm (negative = descending).
    pub landing_rate_fpm: f64,
    /// sim (the simulator's touchdown velocity) | measured (last V/S sample before contact)
    pub landing_rate_source: LandingRateSource,
    /// smooth (< 150 fpm) | normal (< 300) | firm (< 600) | hard
    pub band: Band,
    /// Label of `band` in the backend language (`Status.lang`): sanft | normal | fest | hart,
    /// smooth | normal | firm | hard. Overlays should translate `band` themselves.
    pub band_label: String,
    pub peak_g: f64,
    /// Band of `peakG`: smooth < 1.25 · normal < 1.5 · firm < 2.0 · hard
    pub g_band: Band,
    pub bounces: u32,
    pub touch_and_go: bool,
    pub pitch_deg: f64,
    pub bank_deg: f64,
    pub ground_speed_kt: f64,
    pub airport: Option<String>,
    pub runway: Option<String>,
    /// Along the runway from the threshold, metres (negative = before it).
    pub touchdown_distance_m: Option<f64>,
    /// Metres from the centreline in landing direction (negative = left).
    pub centerline_offset_m: Option<f64>,
    pub in_touchdown_zone: Option<bool>,
    /// From the approach assessment: height above the threshold from which the approach was stable, ft.
    pub stable_from_ft: Option<f64>,
    /// stable | deviations | unstable | unstableBelow500 (approach assessment)
    pub approach_band: Option<String>,
    pub aircraft: Aircraft,
    /// From the running session (true) or the logbook (false).
    pub live: bool,
    /// The flight's callsign, only for [`Landing::mask`] (it can be part of the aircraft
    /// title); not part of the JSON.
    #[serde(skip)]
    pub callsign: Option<String>,
}

impl Landing {
    /// A landing from a touchdown report; runway and approach fields stay empty.
    pub fn from_report(td: &vectasim_core::TouchdownReport, index: u32) -> Self {
        let band = vectasim_core::landing::vs_band(td.landing_rate_fpm);
        Self {
            flight_id: None,
            touchdown_index: index,
            timestamp_ms: td.timestamp_ms,
            landing_rate_fpm: td.landing_rate_fpm,
            landing_rate_source: td.landing_rate_source,
            band,
            band_label: band_label(band).to_string(),
            peak_g: td.peak_g,
            g_band: vectasim_core::landing::g_band(td.peak_g),
            bounces: td.bounces,
            touch_and_go: td.touch_and_go,
            pitch_deg: td.pitch_deg,
            bank_deg: td.bank_deg,
            ground_speed_kt: td.ground_speed_kt,
            airport: None,
            runway: None,
            touchdown_distance_m: None,
            centerline_offset_m: None,
            in_touchdown_zone: None,
            stable_from_ft: None,
            approach_band: None,
            aircraft: Aircraft::default(),
            live: false,
            callsign: None,
        }
    }

    /// Registration and airline, and those plus the callsign inside the title.
    pub fn mask(&mut self) {
        let cs = self.callsign.take();
        self.aircraft.mask(cs.as_deref());
    }
}

/// Band label in `lang` (facts.ts → BAND_LABEL; English: i18n `band.*`).
pub fn band_label_in(b: Band, lang: Lang) -> &'static str {
    match (lang, b) {
        (Lang::De, _) => band_label(b),
        (Lang::En, Band::Smooth) => "smooth",
        (Lang::En, Band::Normal) => "normal",
        (Lang::En, Band::Firm) => "firm",
        (Lang::En, Band::Hard) => "hard",
    }
}

/// German band label (facts.ts → BAND_LABEL).
pub fn band_label(b: Band) -> &'static str {
    match b {
        Band::Smooth => "sanft",
        Band::Normal => "normal",
        Band::Firm => "fest",
        Band::Hard => "hart",
    }
}

/// One row of `GET /api/v1/logbook`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogbookEntry {
    pub id: String,
    /// active | completed | interrupted
    pub state: String,
    pub departure: Option<String>,
    pub arrival: Option<String>,
    pub off_block_ms: Option<u64>,
    pub on_block_ms: Option<u64>,
    pub block_time_ms: Option<u64>,
    pub distance_nm: f64,
    pub callsign: Option<String>,
    pub aircraft: Aircraft,
    pub landing_rate_fpm: Option<f64>,
    pub landings: u32,
}

impl LogbookEntry {
    pub fn mask(&mut self) {
        let cs = self.callsign.clone();
        self.aircraft.mask(cs.as_deref());
        self.callsign = self.callsign.as_deref().map(mask_callsign);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Logbook {
    /// Newest first.
    pub flights: Vec<LogbookEntry>,
}

/// Everything the 2 Hz stream and the status/flight/telemetry endpoints read in one go.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub status: Status,
    pub flight: Option<Flight>,
    pub telemetry: Option<Telemetry>,
}

impl Snapshot {
    /// The snapshot as clients see it: masked while the Streamer-Modus is on.
    pub fn masked(mut self, privacy: bool) -> Self {
        self.status.streamer_mode = privacy;
        if privacy && let Some(f) = self.flight.as_mut() {
            f.mask();
        }
        self
    }
}

impl Flight {
    pub fn mask(&mut self) {
        let cs = self.callsign.clone();
        self.aircraft.mask(cs.as_deref());
        self.callsign = self.callsign.as_deref().map(mask_callsign);
    }
}

impl Aircraft {
    /// Masks registration and airline, and those values plus `callsign` inside the title.
    pub fn mask(&mut self, callsign: Option<&str>) {
        self.title = self.title.as_deref().map(|t| mask_title(t, self.registration.as_deref(), self.airline.as_deref(), callsign));
        self.registration = self.registration.as_deref().map(mask_registration);
        self.airline = self.airline.as_deref().map(mask_airline);
    }
}

// ---- masking (format.ts → maskRegistration / maskCallsign / maskAirline / maskTitle) -------

pub const MASK: char = '•';

fn bullets(n: usize) -> String {
    std::iter::repeat_n(MASK, n).collect()
}

/// "D-AINA" → "D-••••", "N123AB" → "N••••", "" → "". The nationality prefix stays readable.
pub fn mask_registration(reg: &str) -> String {
    let r = reg.trim();
    if r.is_empty() {
        return String::new();
    }
    let head: String = match r.find('-') {
        Some(d) if d > 0 && d <= 3 => r[..=d].to_string(),
        _ => r.chars().take(1).collect(),
    };
    format!("{head}{}", bullets(4))
}

/// Callsign / flight number → "•••••".
pub fn mask_callsign(cs: &str) -> String {
    if cs.trim().is_empty() { String::new() } else { bullets(5) }
}

/// Airline name or code → "•••".
pub fn mask_airline(a: &str) -> String {
    if a.trim().is_empty() { String::new() } else { bullets(3) }
}

/// Case-insensitive search of `needle` in `hay` from byte `from`; byte range of the match.
fn find_ci(hay: &str, needle: &str, from: usize) -> Option<(usize, usize)> {
    let n: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    for (start, _) in hay[from..].char_indices().map(|(i, c)| (i + from, c)) {
        let mut it = hay[start..].char_indices();
        let mut k = 0;
        let mut end = start;
        while k < n.len() {
            let Some((i, c)) = it.next() else { break };
            let lower: Vec<char> = c.to_lowercase().collect();
            if n.get(k..k + lower.len()) != Some(lower.as_slice()) {
                break;
            }
            k += lower.len();
            end = start + i + c.len_utf8();
        }
        if k == n.len() {
            return Some((start, end));
        }
    }
    None
}

fn replace_ci(text: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while let Some((s, e)) = find_ci(text, needle, pos) {
        out.push_str(&text[pos..s]);
        out.push_str(with);
        pos = e;
    }
    out.push_str(&text[pos..]);
    out
}

type Masker = fn(&str) -> String;

/// A free text (the sim's aircraft title) with the known registration, callsign and airline
/// masked wherever they appear (case-insensitive, at least two characters).
pub fn mask_title(text: &str, registration: Option<&str>, airline: Option<&str>, callsign: Option<&str>) -> String {
    let mut out = text.to_string();
    let parts: [(Option<&str>, Masker); 3] = [(registration, mask_registration), (callsign, mask_callsign), (airline, mask_airline)];
    for (v, mask) in parts {
        let s = v.unwrap_or("").trim();
        if s.chars().count() < 2 {
            continue;
        }
        out = replace_ci(&out, s, &mask(s));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// Field names of an object, sorted (serde_json may or may not keep the order).
    fn keys(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
        k.sort();
        k
    }

    fn sorted<const N: usize>(names: [&str; N]) -> Vec<String> {
        let mut k: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        k.sort();
        k
    }

    /// A touchdown report with everything zero but rate and g (the type has no Default).
    fn report(fpm: f64, g: f64) -> vectasim_core::TouchdownReport {
        vectasim_core::TouchdownReport {
            timestamp_ms: 1_700_000_000_000,
            vs_fpm_measured: fpm,
            vs_fpm_sim: fpm,
            vs_fpm_hardest: fpm,
            peak_g: g,
            pitch_deg: 2.5,
            bank_deg: 0.4,
            ground_speed_kt: 132.0,
            heading_true_deg: 250.0,
            latitude: 50.03,
            longitude: 8.55,
            bounces: 0,
            touch_and_go: false,
            landing_rate_fpm: fpm,
            landing_rate_source: LandingRateSource::Sim,
        }
    }

    pub(crate) fn sample_flight() -> Flight {
        Flight {
            id: Some("f-1".into()),
            state: FlightState::Active,
            phase: FlightPhase::Cruise,
            off_block_ms: Some(1_700_000_000_000),
            takeoff_ms: Some(1_700_000_600_000),
            block_time_ms: Some(3_600_000),
            flight_time_ms: Some(3_000_000),
            departure: Some("EDDF".into()),
            destination: Some("EGLL".into()),
            callsign: Some("DLH4YA".into()),
            aircraft: Aircraft {
                title: Some("Airbus A320neo Lufthansa D-AINA".into()),
                icao_type: Some("A20N".into()),
                registration: Some("D-AINA".into()),
                airline: Some("Lufthansa".into()),
            },
            distance_nm: 312.4,
            max_altitude_ft: 36_010.0,
            remaining_nm: Some(120.0),
            eta_ms: Some(1_700_004_000_000),
            fuel: Fuel { start_kg: Some(9000.0), current_kg: Some(6500.0), used_kg: Some(2500.0), ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn masks_like_the_ui() {
        assert_eq!(mask_registration("D-AINA"), "D-••••");
        assert_eq!(mask_registration("N123AB"), "N••••");
        assert_eq!(mask_registration("  "), "");
        assert_eq!(mask_callsign("DLH4YA"), "•••••");
        assert_eq!(mask_airline("Lufthansa"), "•••");
        assert_eq!(mask_title("A320neo LUFTHANSA d-aina", Some("D-AINA"), Some("Lufthansa"), None), "A320neo ••• D-••••");
        // one-character values are left alone (they would eat random letters)
        assert_eq!(mask_title("Cessna 172", None, Some("C"), None), "Cessna 172");
        // non-ASCII text survives
        assert_eq!(mask_title("Flugzeug Ölflug ÖLF", None, Some("ölf"), None), "Flugzeug •••lug •••");
    }

    #[test]
    fn streamer_mode_masks_flight_and_keeps_the_rest() {
        let s = Snapshot { flight: Some(sample_flight()), ..Default::default() }.masked(true);
        assert!(s.status.streamer_mode);
        let f = s.flight.unwrap();
        assert_eq!(f.callsign.as_deref(), Some("•••••"));
        assert_eq!(f.aircraft.registration.as_deref(), Some("D-••••"));
        assert_eq!(f.aircraft.airline.as_deref(), Some("•••"));
        assert_eq!(f.aircraft.title.as_deref(), Some("Airbus A320neo ••• D-••••"));
        assert_eq!(f.aircraft.icao_type.as_deref(), Some("A20N"));
        assert_eq!(f.departure.as_deref(), Some("EDDF"));
        let json = serde_json::to_string(&f).unwrap();
        for secret in ["D-AINA", "DLH4YA", "Lufthansa"] {
            assert!(!json.contains(secret), "{secret} leaked: {json}");
        }
        // off: untouched
        let plain = Snapshot { flight: Some(sample_flight()), ..Default::default() }.masked(false);
        assert_eq!(plain.flight.unwrap(), sample_flight());
    }

    #[test]
    fn logbook_and_landing_mask() {
        let mut e = LogbookEntry { callsign: Some("BAW12".into()), aircraft: sample_flight().aircraft, ..Default::default() };
        e.mask();
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("D-AINA") && !json.contains("BAW12") && !json.contains("Lufthansa"), "{json}");
        let mut l = Landing::from_report(&report(-120.0, 1.1), 0);
        l.aircraft = sample_flight().aircraft;
        l.aircraft.title = Some("A320neo BAW12 special".into());
        l.callsign = Some("BAW12".into());
        l.mask();
        assert_eq!(l.aircraft.registration.as_deref(), Some("D-••••"));
        let title = l.aircraft.title.as_deref().unwrap();
        assert!(!title.contains("BAW12"), "{title}");
        let json = serde_json::to_string(&l).unwrap();
        assert!(!json.contains("BAW12") && !json.contains("callsign"), "{json}");
    }

    #[test]
    fn landing_bands() {
        let td = |fpm: f64, g: f64| Landing::from_report(&report(fpm, g), 0);
        assert_eq!((td(-120.0, 1.1).band, td(-120.0, 1.1).band_label.as_str()), (Band::Smooth, "sanft"));
        assert_eq!(td(-299.0, 1.3).band_label, "normal");
        assert_eq!(td(-450.0, 1.6).band_label, "fest");
        assert_eq!(td(-700.0, 2.1).g_band, Band::Hard);
    }

    // ---- golden schemas: field lists and value shapes are the API contract ------------

    #[test]
    fn golden_status() {
        let v = serde_json::to_value(Status { api_version: API_VERSION, app: "VectaSim".into(), ..Default::default() }).unwrap();
        assert_eq!(
            keys(&v),
            sorted(["apiVersion", "app", "version", "provider", "connection", "detail", "simName", "simVersion", "recording", "streamerMode", "serverTimeMs", "lang"])
        );
        assert_eq!(v["apiVersion"], json!(1));
        assert_eq!(v["lang"], json!("de"));
        assert_eq!(band_label_in(Band::Firm, Lang::En), "firm");
        assert_eq!(band_label_in(Band::Firm, Lang::De), "fest");
        assert_eq!(v["simName"], Value::Null);
    }

    #[test]
    fn golden_flight() {
        let v = serde_json::to_value(sample_flight()).unwrap();
        assert_eq!(
            keys(&v),
            sorted([
                "id", "state", "phase", "offBlockMs", "takeoffMs", "landingMs", "onBlockMs", "blockTimeMs", "flightTimeMs", "departure", "arrival",
                "destination", "callsign", "aircraft", "distanceNm", "maxAltitudeFt", "remainingNm", "etaMs", "fuel", "landingRateFpm", "touchdowns"
            ])
        );
        assert_eq!(v["state"], json!("active"));
        assert_eq!(v["phase"], json!("cruise"));
        assert_eq!(
            keys(&v["aircraft"]),
            sorted(["title", "icaoType", "registration", "airline"]));
        assert_eq!(
            keys(&v["fuel"]),
            sorted(["startKg", "currentKg", "usedKg", "plannedRampKg", "plannedLandingKg"]));
        let taxi = serde_json::to_value(Flight { phase: FlightPhase::TaxiOut, ..Default::default() }).unwrap();
        assert_eq!(taxi["phase"], json!("taxiOut"));
        assert_eq!(taxi["landingMs"], Value::Null);
    }

    #[test]
    fn golden_telemetry() {
        let v = serde_json::to_value(Telemetry::from(&vectasim_core::Telemetry { altitude_msl_ft: 5000.0, ..Default::default() })).unwrap();
        assert_eq!(
            keys(&v),
            sorted([
                "timestampMs", "latitude", "longitude", "altitudeMslFt", "altitudeAglFt", "iasKt", "tasKt", "groundSpeedKt", "verticalSpeedFpm",
                "headingMagDeg", "headingTrueDeg", "pitchDeg", "bankDeg", "gForce", "onGround", "gearPct", "flapsIndex", "fuelTotalKg", "paused",
                "simRate", "windDirTrueDeg", "windKt"
            ])
        );
        assert_eq!(v["altitudeMslFt"], json!(5000.0));
        assert_eq!(v["windKt"], Value::Null);
    }

    #[test]
    fn golden_landing_and_logbook() {
        let td = vectasim_core::TouchdownReport { bounces: 1, ..report(-142.0, 1.18) };
        let v = serde_json::to_value(Landing::from_report(&td, 0)).unwrap();
        assert_eq!(
            keys(&v),
            sorted([
                "flightId", "touchdownIndex", "timestampMs", "landingRateFpm", "landingRateSource", "band", "bandLabel", "peakG", "gBand", "bounces",
                "touchAndGo", "pitchDeg", "bankDeg", "groundSpeedKt", "airport", "runway", "touchdownDistanceM", "centerlineOffsetM",
                "inTouchdownZone", "stableFromFt", "approachBand", "aircraft", "live"
            ])
        );
        assert_eq!(v["landingRateSource"], json!("sim"));
        assert_eq!(v["band"], json!("smooth"));
        assert_eq!(v["gBand"], json!("smooth"));
        let lb = serde_json::to_value(Logbook { flights: vec![LogbookEntry { id: "x".into(), state: "completed".into(), ..Default::default() }] }).unwrap();
        assert_eq!(
            keys(&lb["flights"][0]),
            sorted([
                "id", "state", "departure", "arrival", "offBlockMs", "onBlockMs", "blockTimeMs", "distanceNm", "callsign", "aircraft", "landingRateFpm",
                "landings"
            ])
        );
    }
}
