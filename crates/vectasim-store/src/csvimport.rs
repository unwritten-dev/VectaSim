//! CSV import: flights from other logbooks (Volanta's import CSV, SimToolkitPro, phpVMS/VA
//! exports, VectaSim's own logbook CSV, any table with a free column mapping).
//!
//! * [`sniff`] reads the first lines: encoding (UTF-8, UTF-8 with BOM, UTF-16, else
//!   Latin-1/Windows-1252), delimiter (`,` `;` tab `|`, Excel's `sep=` line), header, the
//!   preset the columns look like and a suggested [`ColumnMapping`] (column-name synonyms DE/EN).
//! * [`preview`] parses rows with a mapping (no store): what would be imported, with warnings.
//! * [`Store::import_csv`] writes them, 100 rows per transaction.
//!
//! Imported flights are a class of their own: `provider = "import:<preset>"`, `state =
//! 'completed'`, `sim_name = 'Import'`, tags `import` + the source tag. They have no track, no
//! touchdowns and no phase events, so they count for totals, fleet, airports and countries
//! but never for the landing statistics, the dispersion, the approach facts or the debrief.
//!
//! **Landing rate:** a rate from the file is *not* written as a touchdown row. `touchdowns`
//! needs a position, G, pitch, bounces … that the file does not have, and a row would put
//! the foreign figure (another tracker's method) into averages, best values and the
//! dispersion. It goes into the flight's notes as one line instead ("Landerate laut
//! Importdatei: −142 fpm (nicht von VectaSim gemessen)"); the same for a fuel figure that
//! has no start/end value. `landing_vs_fpm` of an imported flight therefore stays empty.
//!
//! Duplicates: like the bundle merge – same departure and arrival and off-block within
//! ±15 min of a flight already in the logbook (Papierkorb included) or earlier in the file.

use crate::airframe::{AirframeHint, icao_from_atc_model, normalize_registration, upsert_from_hint};
use crate::bundle::route_near;
use crate::store::{NOTES_MAX_CHARS, normalize_tags, phase_str};
use crate::{Invalid, Result, Store, StoreError};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use vectasim_core::{FlightPhase, Lang};

/// Largest file the import reads.
pub const CSV_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Rows [`preview`] returns by default.
pub const PREVIEW_LIMIT: usize = 20;
/// Tag every imported flight gets.
pub const IMPORT_TAG: &str = "import";
/// `sim_name` of imported flights.
pub const IMPORT_SIM_NAME: &str = "Import";
/// Rows per transaction.
const BATCH: usize = 100;
/// Data rows in [`CsvProfile::sample_rows`].
const SAMPLE_ROWS: usize = 5;
/// Records the sniffer looks at.
const SNIFF_RECORDS: usize = 50;
/// Row warnings kept in a report (the rest is counted).
const WARNINGS_MAX: usize = 50;
const DAY_MS: i64 = 86_400_000;
const LB_TO_KG: f64 = 0.453_592_37;

// ---- types ----------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CsvEncoding {
    Utf8,
    Utf8Bom,
    /// UTF-16 little endian with BOM (Excel's "Unicode-Text").
    Utf16le,
    Utf16be,
    /// ISO-8859-1 read as Windows-1252 (Excel's "CSV (Trennzeichen-getrennt)" on a German Windows).
    Latin1,
}

/// What the columns look like; decides `provider = "import:<preset>"` and the default tag.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CsvPreset {
    /// VectaSim's own logbook CSV (`export_logbook_csv`).
    Vectasim,
    /// The 13-column CSV Volanta imports (`Origin,Destination,DepartureTime,Duration,…`).
    VolantaImport,
    /// SimToolkitPro logbook CSV – best effort, its columns are not documented.
    Simtoolkitpro,
    #[default]
    Generic,
}

impl CsvPreset {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vectasim => "vectasim",
            Self::VolantaImport => "volanta_import",
            Self::Simtoolkitpro => "simtoolkitpro",
            Self::Generic => "generic",
        }
    }

    /// Suggested source tag.
    pub fn default_tag(self) -> &'static str {
        match self {
            Self::Vectasim => "vectasim",
            Self::VolantaImport => "volanta",
            Self::Simtoolkitpro => "stkp",
            Self::Generic => "csv",
        }
    }
}

/// Fields of a flight a column can be mapped onto.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CsvField {
    /// Date of the flight; completes time-only values of the other time columns.
    Date,
    OffBlock,
    Takeoff,
    Landing,
    OnBlock,
    DepIcao,
    ArrIcao,
    Callsign,
    FlightNumber,
    Airline,
    AircraftTitle,
    AircraftIcao,
    Registration,
    DistanceNm,
    MaxAltFt,
    FuelStart,
    FuelEnd,
    /// Burned fuel; only kept (in the notes) when start/end are missing.
    FuelUsed,
    BlockMin,
    AirMin,
    LandingRateFpm,
    Notes,
    Tags,
    Rating,
}

impl CsvField {
    pub const ALL: [CsvField; 24] = [
        Self::Date,
        Self::OffBlock,
        Self::Takeoff,
        Self::Landing,
        Self::OnBlock,
        Self::DepIcao,
        Self::ArrIcao,
        Self::Callsign,
        Self::FlightNumber,
        Self::Airline,
        Self::AircraftTitle,
        Self::AircraftIcao,
        Self::Registration,
        Self::DistanceNm,
        Self::MaxAltFt,
        Self::FuelStart,
        Self::FuelEnd,
        Self::FuelUsed,
        Self::BlockMin,
        Self::AirMin,
        Self::LandingRateFpm,
        Self::Notes,
        Self::Tags,
        Self::Rating,
    ];

    /// Normalised column names ([`norm_name`]) that mean this field, most specific first.
    #[rustfmt::skip]
    fn synonyms(self) -> &'static [&'static str] {
        match self {
            Self::Date => &["dateutc", "date", "datum", "flightdate", "flugdatum", "day", "tag"],
            Self::OffBlock => &[
                "offblockutc", "offblock", "offblocks", "offblocktime", "offblockstime", "blockofftime", "blockoff", "departuretime",
                "deptime", "departuretimeutc", "offblockzeit", "abflugzeit", "out", "outtime", "starttime",
            ],
            Self::Takeoff => &["takeoffutc", "takeoff", "takeofftime", "wheelsoff", "airborne", "airbornetime", "offtime", "abhebezeit", "startzeit"],
            Self::Landing => &["landingutc", "landingtime", "landing", "wheelson", "touchdown", "touchdowntime", "ontime", "landezeit"],
            Self::OnBlock => &[
                "onblockutc", "onblock", "onblocks", "onblocktime", "onblockstime", "blockontime", "blockon", "arrivaltime", "arrtime",
                "arrivaltimeutc", "onblockzeit", "ankunftszeit", "in", "intime", "endtime",
            ],
            Self::DepIcao => &[
                "dep", "depicao", "departureicao", "departure", "departureairport", "depairport", "origin", "originicao", "from", "dptairportid",
                "dptairport", "abflughafen", "abflugort", "abflug", "von", "startflughafen",
            ],
            Self::ArrIcao => &[
                "arr", "arricao", "arrivalicao", "arrival", "arrivalairport", "arrairport", "destination", "destinationicao", "dest", "to",
                "arrairportid", "zielflughafen", "ziel", "ankunft", "nach",
            ],
            Self::Callsign => &["callsign", "atccallsign", "rufzeichen"],
            Self::FlightNumber => &["flightnumber", "flightno", "flightnum", "flugnummer", "flight", "flug"],
            Self::Airline => &["airline", "airlineicao", "operator", "fluggesellschaft", "airlineid"],
            Self::AircraftTitle => &["aircrafttitle", "aircraft", "aircraftname", "title", "flugzeug", "luftfahrzeug", "aircraftmodel"],
            Self::AircraftIcao => &["aircrafttype", "aircrafticao", "icaotype", "actype", "type", "typ", "flugzeugtyp", "atcmodel", "model", "equipment"],
            Self::Registration => &["registration", "aircraftregistration", "reg", "tailnumber", "tail", "kennzeichen", "atcid", "immatrikulation"],
            Self::DistanceNm => &["distancenm", "distance", "dist", "nm", "distanz", "entfernung", "strecke"],
            Self::MaxAltFt => &["maxaltft", "maxalt", "maxaltitude", "cruisealtitude", "flightlevel", "reiseflughoehe"],
            Self::FuelStart => &["fuelstartkg", "fuelstart", "blockfuel", "rampfuel", "fuelramp", "fuelatstart", "kraftstoffstart"],
            Self::FuelEnd => &["fuelendkg", "fuelend", "fuelremaining", "remainingfuel", "fuelatend", "kraftstoffende"],
            Self::FuelUsed => &["fuelusedkg", "fuelused", "fuelburn", "fuel", "burn", "tripfuel", "verbrauch", "kraftstoffverbrauch", "kraftstoff"],
            Self::BlockMin => &["blocktime", "block", "duration", "blockzeit", "dauer", "totaltime", "blocktimemin", "blockminutes"],
            Self::AirMin => &["airtime", "flighttime", "flugzeit", "airbornetimemin", "flighttimemin", "airminutes"],
            Self::LandingRateFpm => &[
                "landingvsfpm", "landingrate", "landingratefpm", "landingvs", "landingfpm", "touchdownrate", "touchdownfpm", "landerate", "fpm", "vs",
            ],
            Self::Notes => &["notes", "note", "remarks", "remark", "comment", "comments", "notizen", "notiz", "bemerkung", "bemerkungen"],
            Self::Tags => &["tags", "tag", "labels", "schlagworte"],
            Self::Rating => &["rating", "bewertung", "stars", "sterne"],
        }
    }

    fn is_time(self) -> bool {
        matches!(self, Self::OffBlock | Self::Takeoff | Self::Landing | Self::OnBlock)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateFormat {
    /// Per value: ISO (`2026-10-18 14:05`), `18.10.2026 14:05`, `10/18/2026` (`18/10/2026`
    /// when the first number is > 12), Unix seconds / milliseconds.
    #[default]
    Auto,
    Iso,
    /// `dd.MM.yyyy [HH:mm[:ss]]` (also `/` or `-`, two-digit years = 20xx).
    Dmy,
    /// `MM/dd/yyyy [hh:mm[:ss] [AM|PM]]`.
    Mdy,
    EpochS,
    EpochMs,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeightUnit {
    #[default]
    Kg,
    Lb,
}

/// Unit of a plain number in a duration column (`1:35` is always hours:minutes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurationUnit {
    #[default]
    Minutes,
    Hours,
}

/// From `from_ms` (UTC) on, local time is UTC + `offset_min` (the UI sends the PC's offsets
/// with their daylight-saving changes, so "Ortszeit" is right on both sides of a change).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetSpan {
    pub from_ms: i64,
    pub offset_min: i32,
}

/// How the file is read and which column fills which field.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ColumnMapping {
    pub preset: CsvPreset,
    /// One character; `None` = as sniffed.
    pub delimiter: Option<String>,
    pub has_header: Option<bool>,
    pub encoding: Option<CsvEncoding>,
    /// Field → column index (0-based).
    pub columns: BTreeMap<CsvField, usize>,
    pub date_format: DateFormat,
    /// Times without zone are UTC + this (0 = UTC), unless `local_offsets` is set.
    pub utc_offset_min: i32,
    /// Times without zone are local time of these spans (sorted by `from_ms`).
    pub local_offsets: Vec<OffsetSpan>,
    pub weight_unit: WeightUnit,
    pub duration_unit: DurationUnit,
}

/// What [`sniff`] found.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProfile {
    pub delimiter: String,
    pub has_header: bool,
    pub encoding: CsvEncoding,
    /// Header names, or `Spalte 1` … without a header.
    pub columns: Vec<String>,
    /// The first data rows as read.
    pub sample_rows: Vec<Vec<String>>,
    pub detected_preset: CsvPreset,
    /// Data rows in the file (without header and blank lines).
    pub row_count: usize,
    /// Mapping from the preset and the column names.
    pub suggested: ColumnMapping,
}

/// One row as it would be imported.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFlight {
    /// Line in the file (1-based) where the row starts.
    pub line: usize,
    pub dep_icao: Option<String>,
    pub arr_icao: Option<String>,
    pub off_block_ms: Option<i64>,
    pub takeoff_ms: Option<i64>,
    pub landing_ms: Option<i64>,
    pub on_block_ms: Option<i64>,
    pub callsign: Option<String>,
    pub flight_number: Option<String>,
    pub airline: Option<String>,
    pub aircraft_title: Option<String>,
    pub aircraft_icao: Option<String>,
    pub registration: Option<String>,
    pub distance_nm: Option<f64>,
    /// The distance is the great circle between the airports (the file had none).
    pub distance_estimated: bool,
    pub max_alt_ft: Option<f64>,
    pub fuel_start_kg: Option<f64>,
    pub fuel_end_kg: Option<f64>,
    pub fuel_used_kg: Option<f64>,
    pub block_min: Option<f64>,
    pub air_min: Option<f64>,
    pub landing_rate_fpm: Option<f64>,
    pub notes: Option<String>,
    pub tags: Vec<String>,
    pub rating: Option<u8>,
    pub warnings: Vec<String>,
    /// Why the row is not imported (`None` = valid).
    pub error: Option<String>,
    /// Already in the logbook (or earlier in the file); only set by [`Store::preview_csv`].
    pub duplicate: bool,
}

/// What the importer does besides the mapping.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvImportOptions {
    /// Skip rows that are already in the logbook (same route, off-block within 15 min).
    pub dedupe: bool,
    /// Tag besides `import` (e.g. `volanta`, `stkp`, the file name); empty = none.
    pub source_tag: String,
    /// Language of the warnings, row errors and generated note lines; set by the app (backend
    /// language), not sent by the frontend.
    #[serde(skip)]
    pub lang: Lang,
}

impl Default for CsvImportOptions {
    fn default() -> Self {
        Self { dedupe: true, source_tag: String::new(), lang: Lang::default() }
    }
}

/// [`Store::preview_csv`]: the first rows plus counts over the whole file.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub rows: Vec<ParsedFlight>,
    pub total_rows: usize,
    pub valid: usize,
    pub invalid: usize,
    /// Valid rows that would be skipped as duplicates (0 without `dedupe`).
    pub duplicates: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportReport {
    /// Data rows in the file.
    pub rows: usize,
    pub added: usize,
    pub skipped_duplicate: usize,
    pub skipped_invalid: usize,
    /// Airframes (registrations) new in the fleet.
    pub airframes_added: usize,
    /// `Zeile N: …` (at most 50, then a count).
    pub warnings: Vec<String>,
}

fn invalid(i: Invalid) -> StoreError {
    StoreError::Invalid(i)
}

// ---- decoding -------------------------------------------------------------------------------

/// Windows-1252 0x80..=0x9F (the rest of Latin-1 maps 1:1).
const CP1252_HIGH: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F, 0x0090,
    0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

fn detect_encoding(bytes: &[u8]) -> CsvEncoding {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        CsvEncoding::Utf8Bom
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        CsvEncoding::Utf16le
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        CsvEncoding::Utf16be
    } else if std::str::from_utf8(bytes).is_ok() {
        CsvEncoding::Utf8
    } else {
        CsvEncoding::Latin1
    }
}

fn decode_utf16(bytes: &[u8], le: bool) -> String {
    let body = if bytes.len() >= 2 && (bytes[..2] == [0xFF, 0xFE] || bytes[..2] == [0xFE, 0xFF]) { &bytes[2..] } else { bytes };
    let (pairs, _) = body.as_chunks::<2>();
    let units = pairs.iter().map(|&c| if le { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) });
    char::decode_utf16(units).map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER)).collect()
}

/// The text of the file in `enc` (detected when `None`).
pub fn decode(bytes: &[u8], enc: Option<CsvEncoding>) -> (String, CsvEncoding) {
    let enc = enc.unwrap_or_else(|| detect_encoding(bytes));
    let text = match enc {
        CsvEncoding::Utf8 | CsvEncoding::Utf8Bom => {
            let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
            String::from_utf8_lossy(b).into_owned()
        }
        CsvEncoding::Utf16le => decode_utf16(bytes, true),
        CsvEncoding::Utf16be => decode_utf16(bytes, false),
        CsvEncoding::Latin1 => bytes
            .iter()
            .map(|&b| match b {
                0x80..=0x9F => char::from_u32(CP1252_HIGH[(b - 0x80) as usize] as u32).unwrap_or('\u{FFFD}'),
                _ => b as char,
            })
            .collect(),
    };
    (text, enc)
}

// ---- CSV records ----------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Record {
    /// 1-based line where the record starts.
    line: usize,
    cells: Vec<String>,
}

/// Excel's first line `sep=;` names the delimiter.
fn sep_line(text: &str) -> Option<(char, &str)> {
    let first = text.lines().next()?;
    let t = first.trim();
    let rest = t.strip_prefix("sep=").or_else(|| t.strip_prefix("SEP="))?;
    let mut chars = rest.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    let after = text.get(first.len()..).unwrap_or("");
    Some((c, after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')).unwrap_or(after)))
}

/// A cell as stored: trimmed, the formula guard `'` of a spreadsheet-safe export removed.
fn clean_cell(raw: &str) -> String {
    let t = raw.trim();
    match t.strip_prefix('\'') {
        Some(rest) if rest.starts_with(['=', '+', '-', '@']) => rest.to_string(),
        _ => t.to_string(),
    }
}

/// RFC 4180 records (quotes, doubled quotes, line breaks in quotes; CRLF or LF). Blank lines
/// are skipped. `max` stops after that many records.
fn parse_records(text: &str, delim: char, max: Option<usize>) -> Vec<Record> {
    let mut out = Vec::new();
    let mut cells: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut in_quotes = false;
    let mut line = 1usize;
    let mut start_line = 1usize;
    let mut chars = text.chars().peekable();
    let finish = |cells: &mut Vec<String>, cell: &mut String, out: &mut Vec<Record>, start: usize| {
        cells.push(clean_cell(cell));
        cell.clear();
        let row = std::mem::take(cells);
        if row.iter().any(|c| !c.is_empty()) {
            out.push(Record { line: start, cells: row });
        }
    };
    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    cell.push('"');
                }
                '"' => in_quotes = false,
                '\n' => {
                    line += 1;
                    cell.push('\n');
                }
                _ => cell.push(c),
            }
            continue;
        }
        match c {
            '"' if cell.trim().is_empty() => {
                cell.clear();
                in_quotes = true;
            }
            c if c == delim => cells.push(clean_cell(&std::mem::take(&mut cell))),
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' | '\r' => {
                finish(&mut cells, &mut cell, &mut out, start_line);
                line += 1;
                start_line = line;
                if max.is_some_and(|m| out.len() >= m) {
                    return out;
                }
            }
            _ => cell.push(c),
        }
    }
    if !cell.is_empty() || !cells.is_empty() {
        finish(&mut cells, &mut cell, &mut out, start_line);
    }
    if let Some(m) = max {
        out.truncate(m);
    }
    out
}

/// Text to records with the delimiter: `sep=` line handled.
fn records_of(text: &str, delim: char, max: Option<usize>) -> Vec<Record> {
    match sep_line(text) {
        Some((_, rest)) => {
            let mut r = parse_records(rest, delim, max);
            for rec in &mut r {
                rec.line += 1;
            }
            r
        }
        None => parse_records(text, delim, max),
    }
}

const DELIMITERS: [char; 4] = [',', ';', '\t', '|'];

/// The delimiter that splits the first records into the same number (> 1) of cells most often.
fn sniff_delimiter(text: &str) -> char {
    if let Some((c, _)) = sep_line(text) {
        return c;
    }
    let mut best = (',', 0usize);
    for d in DELIMITERS {
        let recs = parse_records(text, d, Some(SNIFF_RECORDS));
        let mut freq: BTreeMap<usize, usize> = BTreeMap::new();
        for r in &recs {
            *freq.entry(r.cells.len()).or_default() += 1;
        }
        let Some((&width, &count)) = freq.iter().filter(|(w, _)| **w > 1).max_by_key(|(w, c)| (**c, **w)) else { continue };
        let score = count * 1000 + width;
        if score > best.1 {
            best = (d, score);
        }
    }
    best.0
}

/// Lower case, letters and digits only, umlauts spelled out: `Off-Block (UTC)` → `offblockutc`.
pub fn norm_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.trim().chars().flat_map(char::to_lowercase) {
        match c {
            'ä' => out.push_str("ae"),
            'ö' => out.push_str("oe"),
            'ü' => out.push_str("ue"),
            'ß' => out.push_str("ss"),
            c if c.is_alphanumeric() => out.push(c),
            _ => {}
        }
    }
    out
}

fn known_name(n: &str) -> bool {
    CsvField::ALL.iter().any(|f| f.synonyms().contains(&n))
}

fn looks_like_value(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && (parse_number(t).is_some() || parse_stamp(t, DateFormat::Auto).is_some())
}

fn detect_header(recs: &[Record]) -> bool {
    let Some(first) = recs.first() else { return true };
    let known = first.cells.iter().filter(|c| known_name(&norm_name(c))).count();
    if known >= 2 {
        return true;
    }
    if first.cells.iter().any(|c| looks_like_value(c)) {
        return false;
    }
    true
}

fn detect_preset(columns: &[String], file_name: Option<&str>) -> CsvPreset {
    let names: Vec<String> = columns.iter().map(|c| norm_name(c)).collect();
    let has = |n: &str| names.iter().any(|x| x == n);
    if ["id", "state", "offblockutc", "onblockutc", "dep", "arr", "blocktime"].iter().all(|n| has(n)) {
        return CsvPreset::Vectasim;
    }
    if ["origin", "destination", "departuretime", "duration"].iter().all(|n| has(n)) {
        return CsvPreset::VolantaImport;
    }
    let file = file_name.map(norm_name).unwrap_or_default();
    if file.contains("stkp") || file.contains("simtoolkit") || names.iter().any(|n| n.contains("stkp") || n.contains("simtoolkit")) {
        return CsvPreset::Simtoolkitpro;
    }
    CsvPreset::Generic
}

/// Field → column from the column names (each column at most once; the most specific
/// synonym wins, so `DepartureTime` is the off-block time and not the departure airport).
pub fn suggest_columns(columns: &[String]) -> BTreeMap<CsvField, usize> {
    let names: Vec<String> = columns.iter().map(|c| norm_name(c)).collect();
    let mut used = vec![false; names.len()];
    let mut out = BTreeMap::new();
    // exact matches first, over all fields, by synonym rank
    let max_rank = CsvField::ALL.iter().map(|f| f.synonyms().len()).max().unwrap_or(0);
    for rank in 0..max_rank {
        for field in CsvField::ALL {
            if out.contains_key(&field) {
                continue;
            }
            let Some(syn) = field.synonyms().get(rank) else { continue };
            if let Some(i) = names.iter().enumerate().position(|(i, n)| !used[i] && n == syn) {
                used[i] = true;
                out.insert(field, i);
            }
        }
    }
    out
}

/// Name of the column at index `i` in a file without a header.
fn column_name(i: usize, lang: Lang) -> String {
    ltr!(lang, "Spalte {}", "Column {}", i + 1)
}

/// Encoding, delimiter, header and preset of a file, with a suggested mapping.
pub fn sniff(bytes: &[u8]) -> CsvProfile {
    sniff_named(bytes, None, Lang::De)
}

/// [`sniff`] with the file name as a hint for the preset (`…stkp….csv`); `lang` names
/// columns without a header (`Spalte 1` / `Column 1`).
pub fn sniff_named(bytes: &[u8], file_name: Option<&str>, lang: Lang) -> CsvProfile {
    let (text, encoding) = decode(bytes, None);
    let delim = sniff_delimiter(&text);
    let head = records_of(&text, delim, Some(SNIFF_RECORDS));
    let has_header = detect_header(&head);
    let all = records_of(&text, delim, None);
    let width = all.iter().map(|r| r.cells.len()).max().unwrap_or(0);
    let columns: Vec<String> = match (has_header, all.first()) {
        (true, Some(h)) => {
            (0..width).map(|i| h.cells.get(i).cloned().filter(|c| !c.is_empty()).unwrap_or_else(|| column_name(i, lang))).collect()
        }
        _ => (0..width).map(|i| column_name(i, lang)).collect(),
    };
    let data = if has_header { all.get(1..).unwrap_or(&[]) } else { &all[..] };
    let detected_preset = if has_header { detect_preset(&columns, file_name) } else { CsvPreset::Generic };
    let suggested = ColumnMapping {
        preset: detected_preset,
        delimiter: Some(delim.to_string()),
        has_header: Some(has_header),
        encoding: Some(encoding),
        columns: if has_header { suggest_columns(&columns) } else { BTreeMap::new() },
        ..ColumnMapping::default()
    };
    CsvProfile {
        delimiter: delim.to_string(),
        has_header,
        encoding,
        columns,
        sample_rows: data.iter().take(SAMPLE_ROWS).map(|r| r.cells.clone()).collect(),
        detected_preset,
        row_count: data.len(),
        suggested,
    }
}

// ---- values ---------------------------------------------------------------------------------

/// A number with `.` or `,` decimals, thousands separators and a unit suffix (`1.234,5 kg`,
/// `-142 fpm`, `1,234.5`).
pub fn parse_number(raw: &str) -> Option<f64> {
    let t = raw.trim();
    let t = t.strip_prefix('\u{2212}').map(|r| format!("-{r}")).unwrap_or_else(|| t.to_string());
    let body: String = t.chars().take_while(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | ',' | ' ' | '\u{a0}' | '\'')).collect();
    let rest = &t[body.len()..];
    // a unit may follow, nothing else that looks like part of the number
    if rest.chars().next().is_some_and(|c| c.is_ascii_digit() || c == ':') {
        return None;
    }
    let body: String = body.chars().filter(|c| !matches!(c, ' ' | '\u{a0}' | '\'')).collect();
    if body.is_empty() || !body.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let (dots, commas) = (body.matches('.').count(), body.matches(',').count());
    let normal = match (dots, commas) {
        (_, 0) if dots <= 1 => body,
        (0, 1) => body.replace(',', "."),
        (0, _) => body.replace(',', ""),
        (_, 0) => body.replace('.', ""),
        _ => {
            // both: the last one is the decimal separator
            if body.rfind(',') > body.rfind('.') { body.replace('.', "").replace(',', ".") } else { body.replace(',', "") }
        }
    };
    normal.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Minutes of `1:35`, `01:35:20`, `1h 35m`, `95` (minutes) or `1.58` (hours with `Hours`).
pub fn parse_duration_min(raw: &str, unit: DurationUnit) -> Option<f64> {
    let t = raw.trim().to_ascii_lowercase();
    if t.is_empty() {
        return None;
    }
    if t.contains(':') {
        let parts: Vec<&str> = t.split(':').map(str::trim).collect();
        let nums: Option<Vec<f64>> = parts.iter().map(|p| p.parse::<f64>().ok().filter(|v| *v >= 0.0)).collect();
        let nums = nums?;
        return match nums.as_slice() {
            [h, m] if *m < 60.0 => Some(h * 60.0 + m),
            [h, m, s] if *m < 60.0 && *s < 60.0 => Some(h * 60.0 + m + s / 60.0),
            _ => None,
        };
    }
    if let Some((h, rest)) = t.split_once('h') {
        let h = h.trim().parse::<f64>().ok()?;
        let m = rest.trim().trim_end_matches("min").trim_end_matches('m').trim();
        let m = if m.is_empty() { 0.0 } else { m.parse::<f64>().ok()? };
        return Some(h * 60.0 + m);
    }
    if let Some(m) = t.strip_suffix("min").or_else(|| t.strip_suffix('m')) {
        return parse_number(m).filter(|v| *v >= 0.0);
    }
    let v = parse_number(&t).filter(|v| *v >= 0.0)?;
    Some(match unit {
        DurationUnit::Minutes => v,
        DurationUnit::Hours => v * 60.0,
    })
}

/// Days since 1970-01-01 (proleptic Gregorian).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

fn valid_date(y: i64, m: u32, d: u32) -> Option<i64> {
    ((1900..=2200).contains(&y) && (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)).then(|| days_from_civil(y, m, d))
}

/// A parsed date/time cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stamp {
    /// Date and time; `offset_min` when the value names its zone (`Z` = 0).
    DateTime { naive_ms: i64, offset_min: Option<i32> },
    /// Only a date (midnight).
    Date { days: i64 },
    /// Only a time of day.
    Time { ms_of_day: i64, offset_min: Option<i32> },
}

fn parse_date_part(s: &str, fmt: DateFormat) -> Option<i64> {
    let sep = s.chars().find(|c| matches!(c, '-' | '.' | '/'))?;
    let parts: Vec<&str> = s.split(sep).collect();
    let [a, b, c] = parts.as_slice() else { return None };
    if [a, b, c].iter().any(|p| p.is_empty() || !p.chars().all(|ch| ch.is_ascii_digit())) {
        return None;
    }
    let num = |p: &str| p.parse::<i64>().ok();
    let year = |p: &str| -> Option<i64> {
        match p.len() {
            4 => num(p),
            2 => num(p).map(|y| 2000 + y),
            _ => None,
        }
    };
    let ymd = || valid_date(if a.len() == 4 { num(a)? } else { return None }, num(b)? as u32, num(c)? as u32);
    let dmy = || valid_date(year(c)?, num(b)? as u32, num(a)? as u32);
    let mdy = || valid_date(year(c)?, num(a)? as u32, num(b)? as u32);
    match fmt {
        DateFormat::Iso => ymd(),
        DateFormat::Dmy => dmy(),
        DateFormat::Mdy => mdy(),
        DateFormat::EpochS | DateFormat::EpochMs => None,
        DateFormat::Auto => {
            if a.len() == 4 {
                ymd()
            } else if sep == '/' {
                if num(a)? > 12 { dmy() } else { mdy() }
            } else {
                dmy()
            }
        }
    }
}

/// `HH:mm[:ss[.fff]]` → ms of the day.
fn parse_time_part(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let h: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let ms: i64 = match parts.get(2) {
        Some(sec) => {
            let (whole, frac) = sec.split_once(['.', ',']).unwrap_or((sec, ""));
            let s: i64 = whole.parse().ok()?;
            if s >= 60 || !frac.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let frac_ms = format!("{frac:0<3}")[..3].parse::<i64>().unwrap_or(0);
            s * 1000 + frac_ms
        }
        None => 0,
    };
    (h < 24 && m < 60 && h >= 0 && m >= 0).then_some(h * 3_600_000 + m * 60_000 + ms)
}

/// `+02:00`, `+0200`, `-05`, `Z`, `UTC`, `GMT` → minutes east of UTC.
fn parse_offset(s: &str) -> Option<i32> {
    let u = s.trim().to_ascii_uppercase();
    if matches!(u.as_str(), "Z" | "UTC" | "GMT") {
        return Some(0);
    }
    let rest = u.strip_prefix("UTC").or_else(|| u.strip_prefix("GMT")).unwrap_or(&u);
    let (sign, digits) = match rest.chars().next()? {
        '+' => (1, &rest[1..]),
        '-' | '\u{2212}' => (-1, &rest[rest.chars().next()?.len_utf8()..]),
        _ => return None,
    };
    let digits: String = digits.chars().filter(|c| *c != ':').collect();
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (h, m) = match digits.len() {
        1 | 2 => (digits.parse::<i32>().ok()?, 0),
        4 => (digits[..2].parse::<i32>().ok()?, digits[2..].parse::<i32>().ok()?),
        _ => return None,
    };
    (h <= 14 && m < 60).then_some(sign * (h * 60 + m))
}

/// Split `14:05:00Z` / `14:05+02:00` into time and zone.
fn split_zone(s: &str) -> (&str, Option<i32>) {
    if let Some(t) = s.strip_suffix(['Z', 'z']) {
        return (t, Some(0));
    }
    if let Some(i) = s.rfind(['+', '-']).filter(|i| *i > 0)
        && let Some(off) = parse_offset(&s[i..])
    {
        return (&s[..i], Some(off));
    }
    (s, None)
}

/// A date, time or both in `fmt` (see [`DateFormat`]).
pub fn parse_stamp(raw: &str, fmt: DateFormat) -> Option<Stamp> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let digits_only = s.chars().all(|c| c.is_ascii_digit());
    let epoch = |v: i64, ms: bool| Some(Stamp::DateTime { naive_ms: if ms { v } else { v * 1000 }, offset_min: Some(0) });
    match fmt {
        DateFormat::EpochS | DateFormat::EpochMs => {
            let v = parse_number(s)?;
            return epoch(v.round() as i64, fmt == DateFormat::EpochMs);
        }
        DateFormat::Auto if digits_only && s.len() >= 9 => {
            let v: i64 = s.parse().ok()?;
            return epoch(v, s.len() >= 12);
        }
        _ => {}
    }
    // `2026-10-18T14:05` -> `2026-10-18 14:05`
    let normalized = match s.find('T') {
        Some(i) if i > 0 && s[..i].chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '.' | '/')) => {
            format!("{} {}", &s[..i], &s[i + 1..])
        }
        _ => s.to_string(),
    };
    let mut tokens: Vec<String> = normalized.split_whitespace().map(str::to_string).collect();
    let mut offset: Option<i32> = None;
    let mut pm: Option<bool> = None;
    // trailing AM/PM and zone tokens (`… 2:05 PM`, `… 14:05 UTC`, `… 14:05 +02:00`)
    while tokens.len() > 1 {
        let last = tokens.last().map(|t| t.to_ascii_uppercase()).unwrap_or_default();
        if last == "AM" || last == "PM" {
            pm = Some(last == "PM");
        } else if matches!(last.as_str(), "Z" | "UTC" | "GMT")
            || last.starts_with(['+', '-', '\u{2212}'])
            || last.starts_with("UTC")
            || last.starts_with("GMT")
        {
            offset = Some(parse_offset(&last)?);
        } else {
            break;
        }
        tokens.pop();
    }
    let apply_pm = |ms: i64| -> Option<i64> {
        match pm {
            None => Some(ms),
            Some(p) => {
                let h = ms / 3_600_000;
                if !(1..=12).contains(&h) {
                    return None;
                }
                let base = ms % 3_600_000 + (h % 12) * 3_600_000;
                Some(if p { base + 12 * 3_600_000 } else { base })
            }
        }
    };
    match tokens.as_slice() {
        [one] => {
            if one.contains(':') {
                let (t, z) = split_zone(one);
                let ms = apply_pm(parse_time_part(t)?)?;
                Some(Stamp::Time { ms_of_day: ms, offset_min: z.or(offset) })
            } else {
                Some(Stamp::Date { days: parse_date_part(one, fmt)? })
            }
        }
        [d, t] => {
            let days = parse_date_part(d, fmt)?;
            let (t, z) = split_zone(t);
            let ms = apply_pm(parse_time_part(t)?)?;
            Some(Stamp::DateTime { naive_ms: days * DAY_MS + ms, offset_min: z.or(offset) })
        }
        _ => None,
    }
}

/// Local → UTC for a value without zone.
fn to_utc(naive_ms: i64, offset_min: Option<i32>, m: &ColumnMapping) -> i64 {
    if let Some(o) = offset_min {
        return naive_ms - o as i64 * 60_000;
    }
    if m.local_offsets.is_empty() {
        return naive_ms - m.utc_offset_min as i64 * 60_000;
    }
    let at = |utc: i64| -> i32 {
        m.local_offsets.iter().rev().find(|s| s.from_ms <= utc).or(m.local_offsets.first()).map(|s| s.offset_min).unwrap_or(0)
    };
    let guess = at(naive_ms);
    let off = at(naive_ms - guess as i64 * 60_000);
    naive_ms - off as i64 * 60_000
}

// ---- rows -----------------------------------------------------------------------------------

fn text_opt(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// An airport code as stored: upper case, 3–7 letters/digits.
fn airport(raw: &str) -> std::result::Result<Option<String>, String> {
    let t = raw.trim().to_ascii_uppercase();
    if t.is_empty() {
        return Ok(None);
    }
    if (3..=7).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric()) { Ok(Some(t)) } else { Err(t) }
}

fn great_circle_nm(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (a.0.to_radians(), a.1.to_radians(), b.0.to_radians(), b.1.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    2.0 * 3440.065 * h.sqrt().asin()
}

/// Coordinates of an airport code (`None` = unknown); the app passes its airport index.
pub type AirportCoords<'a> = &'a dyn Fn(&str) -> Option<(f64, f64)>;

fn no_coords(_: &str) -> Option<(f64, f64)> {
    None
}

const FIELD_LABEL: &[(CsvField, &str, &str)] = &[
    (CsvField::Date, "Datum", "Date"),
    (CsvField::OffBlock, "Off-Block", "Off-block"),
    (CsvField::Takeoff, "Start", "Takeoff"),
    (CsvField::Landing, "Landung", "Landing"),
    (CsvField::OnBlock, "On-Block", "On-block"),
];

fn label(f: CsvField, lang: Lang) -> &'static str {
    FIELD_LABEL.iter().find(|(k, _, _)| *k == f).map(|(_, de, en)| lang.tr(de, en)).unwrap_or(lang.tr("Wert", "Value"))
}

/// One record → flight. Never fails; problems end up in `warnings` / `error` (in `lang`).
fn parse_row(rec: &Record, m: &ColumnMapping, coords: AirportCoords<'_>, lang: Lang) -> ParsedFlight {
    let mut p = ParsedFlight { line: rec.line, ..Default::default() };
    let cell = |f: CsvField| -> &str { m.columns.get(&f).and_then(|i| rec.cells.get(*i)).map(String::as_str).unwrap_or("").trim() };

    // airports
    match airport(cell(CsvField::DepIcao)) {
        Ok(v) => p.dep_icao = v,
        Err(v) => p.error = Some(ltr!(lang, "Abflughafen „{v}“ ist kein Flughafencode", "Departure airport “{v}” is not an airport code")),
    }
    match airport(cell(CsvField::ArrIcao)) {
        Ok(v) => p.arr_icao = v,
        Err(v) => p.error = p.error.take().or(Some(ltr!(lang, "Zielflughafen „{v}“ ist kein Flughafencode", "Destination airport “{v}” is not an airport code"))),
    }

    // text fields
    p.callsign = text_opt(cell(CsvField::Callsign));
    p.flight_number = text_opt(cell(CsvField::FlightNumber));
    p.airline = text_opt(cell(CsvField::Airline));
    p.aircraft_title = text_opt(cell(CsvField::AircraftTitle));
    p.aircraft_icao = text_opt(cell(CsvField::AircraftIcao));
    p.registration = text_opt(cell(CsvField::Registration));
    p.notes = text_opt(cell(CsvField::Notes));
    p.tags = normalize_tags(&cell(CsvField::Tags).split([';', ',']).collect::<Vec<_>>());

    // numbers
    let weight = |v: f64| match m.weight_unit {
        WeightUnit::Kg => v,
        WeightUnit::Lb => v * LB_TO_KG,
    };
    let number = |p: &mut ParsedFlight, f: CsvField, what: &str| -> Option<f64> {
        let raw = cell(f);
        if raw.is_empty() {
            return None;
        }
        let v = parse_number(raw);
        if v.is_none() {
            p.warnings.push(ltr!(lang, "{what} „{raw}“ nicht lesbar", "{what} “{raw}” unreadable"));
        }
        v
    };
    p.distance_nm = number(&mut p, CsvField::DistanceNm, lang.tr("Distanz", "Distance")).filter(|v| *v >= 0.0);
    p.max_alt_ft = number(&mut p, CsvField::MaxAltFt, lang.tr("Max. Höhe", "Max. altitude")).filter(|v| *v >= 0.0);
    p.fuel_start_kg = number(&mut p, CsvField::FuelStart, lang.tr("Kraftstoff Start", "Fuel at start")).map(weight);
    p.fuel_end_kg = number(&mut p, CsvField::FuelEnd, lang.tr("Kraftstoff Ende", "Fuel at end")).map(weight);
    p.fuel_used_kg = number(&mut p, CsvField::FuelUsed, lang.tr("Kraftstoffverbrauch", "Fuel used")).map(weight);
    p.landing_rate_fpm = number(&mut p, CsvField::LandingRateFpm, lang.tr("Landerate", "Landing rate"));
    if let Some(r) = number(&mut p, CsvField::Rating, lang.tr("Bewertung", "Rating")) {
        let r = r.round();
        if (1.0..=5.0).contains(&r) {
            p.rating = Some(r as u8);
        }
    }
    let duration = |p: &mut ParsedFlight, f: CsvField, what: &str| -> Option<f64> {
        let raw = cell(f);
        if raw.is_empty() {
            return None;
        }
        let v = parse_duration_min(raw, m.duration_unit);
        if v.is_none() {
            p.warnings.push(ltr!(lang, "{what} „{raw}“ nicht lesbar", "{what} “{raw}” unreadable"));
        }
        v
    };
    p.block_min = duration(&mut p, CsvField::BlockMin, lang.tr("Blockzeit", "Block time"));
    p.air_min = duration(&mut p, CsvField::AirMin, lang.tr("Flugzeit", "Air time"));

    // times: naive values first (date completes time-only cells), then UTC
    let date_raw = cell(CsvField::Date);
    let mut base_days: Option<i64> = None;
    if !date_raw.is_empty() {
        match parse_stamp(date_raw, m.date_format) {
            Some(Stamp::Date { days }) => base_days = Some(days),
            Some(Stamp::DateTime { naive_ms, .. }) => base_days = Some(naive_ms.div_euclid(DAY_MS)),
            _ => p.error = p.error.take().or(Some(ltr!(lang, "Datum „{date_raw}“ nicht lesbar", "Date “{date_raw}” unreadable"))),
        }
    }
    let mut times: [Option<i64>; 4] = [None; 4];
    let mut only_date = false;
    let mut prev: Option<i64> = None;
    for (slot, f) in [CsvField::OffBlock, CsvField::Takeoff, CsvField::Landing, CsvField::OnBlock].into_iter().enumerate() {
        debug_assert!(f.is_time());
        let raw = cell(f);
        if raw.is_empty() {
            continue;
        }
        let utc = match parse_stamp(raw, m.date_format) {
            Some(Stamp::DateTime { naive_ms, offset_min }) => {
                base_days.get_or_insert(naive_ms.div_euclid(DAY_MS));
                Some(to_utc(naive_ms, offset_min, m))
            }
            Some(Stamp::Date { days }) => {
                base_days.get_or_insert(days);
                if slot == 0 {
                    only_date = true;
                }
                Some(to_utc(days * DAY_MS, None, m))
            }
            Some(Stamp::Time { ms_of_day, offset_min }) => match base_days {
                Some(days) => {
                    let mut v = to_utc(days * DAY_MS + ms_of_day, offset_min, m);
                    // past midnight: a time-only value before the previous one is the next day
                    if let Some(pv) = prev
                        && v < pv
                    {
                        v += DAY_MS;
                    }
                    Some(v)
                }
                None => {
                    p.warnings.push(ltr!(lang, "{} „{raw}“ ohne Datum", "{} “{raw}” without a date", label(f, lang)));
                    None
                }
            },
            None => {
                if slot == 0 {
                    p.error = p.error.take().or(Some(ltr!(lang, "Off-Block-Zeit „{raw}“ nicht lesbar", "Off-block time “{raw}” unreadable")));
                } else {
                    p.warnings.push(ltr!(lang, "{} „{raw}“ nicht lesbar", "{} “{raw}” unreadable", label(f, lang)));
                }
                None
            }
        };
        if let Some(v) = utc {
            prev = Some(v);
        }
        times[slot] = utc;
    }
    // only a date column: the flight starts at midnight of that day
    if times.iter().all(Option::is_none)
        && let Some(days) = base_days
        && p.error.is_none()
    {
        times[0] = Some(to_utc(days * DAY_MS, None, m));
        only_date = true;
    }
    let [mut off, mut takeoff, mut landing, mut on] = times;
    let minutes = |v: f64| (v * 60_000.0).round() as i64;
    // derive what is missing from the durations
    if off.is_none() {
        off = match (on, p.block_min, takeoff) {
            (Some(on), Some(b), _) => Some(on - minutes(b)),
            (_, _, Some(t)) => Some(t),
            _ => None,
        };
    }
    if on.is_none()
        && let (Some(off), Some(b)) = (off, p.block_min)
    {
        on = Some(off + minutes(b));
    }
    if on.is_none()
        && let (Some(off), Some(a)) = (off, p.air_min)
        && takeoff.is_none()
    {
        on = Some(off + minutes(a));
    }
    if takeoff.is_none()
        && landing.is_none()
        && let (Some(off), Some(on), Some(a)) = (off, on, p.air_min)
    {
        // no wheels-off / -on times: the taxi time split evenly around the air time
        let taxi = ((on - off) - minutes(a)).max(0);
        let t = off + taxi / 2;
        takeoff = Some(t);
        landing = Some(t + minutes(a));
    } else if landing.is_none()
        && let (Some(t), Some(a)) = (takeoff, p.air_min)
    {
        landing = Some(t + minutes(a));
    }
    if let (Some(a), Some(b)) = (off, on)
        && b < a
    {
        p.error = p.error.take().or(Some(lang.tr("On-Block liegt vor dem Off-Block", "On-block is before off-block").into()));
    }
    let seq: Vec<i64> = [off, takeoff, landing, on].into_iter().flatten().collect();
    if seq.windows(2).any(|w| w[1] < w[0]) && p.error.is_none() {
        p.warnings.push(
            lang.tr("Zeiten nicht in der Reihenfolge Off-Block ≤ Start ≤ Landung ≤ On-Block", "Times not in the order off-block ≤ takeoff ≤ landing ≤ on-block").into(),
        );
    }
    if let (Some(a), Some(b)) = (off, on)
        && b - a > 2 * DAY_MS
    {
        p.warnings.push(lang.tr("Blockzeit über 48 h", "Block time over 48 h").into());
    }
    if only_date && p.error.is_none() {
        p.warnings.push(lang.tr("nur ein Datum – Uhrzeit 00:00 angenommen", "date only – time 00:00 assumed").into());
    }
    p.off_block_ms = off;
    p.takeoff_ms = takeoff;
    p.landing_ms = landing;
    p.on_block_ms = on;

    if p.error.is_none() {
        p.error = match (&p.dep_icao, &p.arr_icao, off) {
            (None, _, _) => Some(lang.tr("Abflughafen fehlt", "Departure airport missing").into()),
            (_, None, _) => Some(lang.tr("Zielflughafen fehlt", "Destination airport missing").into()),
            (_, _, None) => Some(lang.tr("Off-Block-Zeit bzw. Datum fehlt", "Off-block time or date missing").into()),
            _ => None,
        };
    }
    if let Some(o) = off
        && p.error.is_none()
        && !(days_from_civil(1990, 1, 1) * DAY_MS..=days_from_civil(2100, 1, 1) * DAY_MS).contains(&o)
    {
        p.error = Some(lang.tr("Datum außerhalb 1990–2100", "Date outside 1990–2100").into());
    }

    // distance from the airport index when the file has none
    if p.error.is_none() {
        let (dep, arr) = (p.dep_icao.as_deref().unwrap_or(""), p.arr_icao.as_deref().unwrap_or(""));
        let (a, b) = (coords(dep), coords(arr));
        if p.distance_nm.is_none()
            && let (Some(a), Some(b)) = (a, b)
        {
            p.distance_nm = Some((great_circle_nm(a, b) * 10.0).round() / 10.0);
            p.distance_estimated = true;
        }
    }
    p
}

/// The records of the file as the mapping reads them (header dropped).
fn data_records(bytes: &[u8], m: &ColumnMapping) -> Result<Vec<Record>> {
    let (text, _) = decode(bytes, m.encoding);
    let delim = match m.delimiter.as_deref() {
        Some(d) if d == "\\t" || d == "tab" => '\t',
        Some(d) => {
            let mut c = d.chars();
            match (c.next(), c.next()) {
                (Some(ch), None) => ch,
                _ => return Err(invalid(Invalid::CsvDelimiter { delimiter: d.to_string() })),
            }
        }
        None => sniff_delimiter(&text),
    };
    let mut recs = records_of(&text, delim, None);
    let header = m.has_header.unwrap_or_else(|| detect_header(&recs));
    if header && !recs.is_empty() {
        recs.remove(0);
    }
    Ok(recs)
}

fn check_mapping(m: &ColumnMapping) -> Result<()> {
    for f in [CsvField::DepIcao, CsvField::ArrIcao] {
        if !m.columns.contains_key(&f) {
            return Err(invalid(if f == CsvField::DepIcao { Invalid::CsvNoDepartureColumn } else { Invalid::CsvNoArrivalColumn }));
        }
    }
    if ![CsvField::OffBlock, CsvField::Date, CsvField::OnBlock, CsvField::Takeoff].iter().any(|f| m.columns.contains_key(f)) {
        return Err(invalid(Invalid::CsvNoDateColumn));
    }
    Ok(())
}

/// The first `limit` rows with the mapping, without the logbook (no duplicate check);
/// warnings and errors in `lang`.
pub fn preview(bytes: &[u8], mapping: &ColumnMapping, limit: usize, lang: Lang) -> Result<Vec<ParsedFlight>> {
    check_mapping(mapping)?;
    Ok(data_records(bytes, mapping)?.iter().take(limit).map(|r| parse_row(r, mapping, &no_coords, lang)).collect())
}

/// Same route, off-block within ±15 min of one of `seen` (rows earlier in the file).
fn near_in(seen: &[(String, String, i64)], dep: &str, arr: &str, off: i64) -> bool {
    seen.iter().any(|(d, a, o)| d == dep && a == arr && (o - off).abs() < crate::bundle::DUPLICATE_WINDOW_MS)
}

fn route_of(p: &ParsedFlight) -> Option<(&str, &str, i64)> {
    Some((p.dep_icao.as_deref()?, p.arr_icao.as_deref()?, p.off_block_ms?))
}

/// Notes as stored: the file's notes plus the figures that have no column of their own.
fn notes_of(p: &ParsedFlight, lang: Lang) -> Option<String> {
    let mut lines: Vec<String> = p.notes.iter().cloned().collect();
    if let Some(r) = p.landing_rate_fpm {
        lines.push(ltr!(
            lang,
            "Landerate laut Importdatei: {} fpm (nicht von VectaSim gemessen)",
            "Landing rate per import file: {} fpm (not measured by VectaSim)",
            r.round() as i64
        ));
    }
    if p.fuel_start_kg.is_none()
        && p.fuel_end_kg.is_none()
        && let Some(u) = p.fuel_used_kg
    {
        lines.push(ltr!(lang, "Kraftstoffverbrauch laut Importdatei: {} kg", "Fuel used per import file: {} kg", u.round() as i64));
    }
    let all = lines.join("\n");
    (!all.trim().is_empty()).then(|| all.chars().take(NOTES_MAX_CHARS).collect())
}

/// Type designator and title: an ICAO code goes to `atc_model`, a longer text to the title.
fn aircraft_of(p: &ParsedFlight) -> (Option<String>, Option<String>) {
    let icao = p.aircraft_icao.as_deref().and_then(icao_from_atc_model);
    let title = p.aircraft_title.clone().or_else(|| if icao.is_none() { p.aircraft_icao.clone() } else { None });
    (icao, title)
}

fn insert_parsed(
    conn: &Connection,
    p: &ParsedFlight,
    provider: &str,
    tags: &[String],
    now: i64,
    coords: AirportCoords<'_>,
    lang: Lang,
) -> Result<bool> {
    let id = uuid::Uuid::new_v4().to_string();
    let (icao, title) = aircraft_of(p);
    let reg = p.registration.as_deref().and_then(normalize_registration);
    let mut all_tags: Vec<String> = tags.to_vec();
    all_tags.extend(p.tags.iter().cloned());
    let all_tags = normalize_tags(&all_tags);
    let dep = p.dep_icao.as_deref().unwrap_or_default();
    let arr = p.arr_icao.as_deref().unwrap_or_default();
    let (d, a) = (coords(dep), coords(arr));
    conn.execute(
        "INSERT INTO flights (id, state, phase, created_ms, updated_ms, off_block_ms, takeoff_ms, landing_ms, on_block_ms,
            dep_lat, dep_lon, arr_lat, arr_lon, max_alt_msl_ft, distance_nm, fuel_start_kg, fuel_end_kg,
            aircraft_title, atc_model, atc_id, atc_airline, atc_flight_number, provider, sim_name,
            dep_icao, arr_icao, callsign, notes, tags, rating, airframe_reg)
         VALUES (?1, 'completed', ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
            ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
        params![
            id,
            phase_str(FlightPhase::Shutdown),
            now,
            p.off_block_ms,
            p.takeoff_ms,
            p.landing_ms,
            p.on_block_ms,
            d.map(|c| c.0),
            d.map(|c| c.1),
            a.map(|c| c.0),
            a.map(|c| c.1),
            p.max_alt_ft.unwrap_or(0.0),
            p.distance_nm.unwrap_or(0.0),
            p.fuel_start_kg,
            p.fuel_end_kg,
            title,
            icao,
            reg.clone().or_else(|| p.registration.clone()),
            p.airline,
            p.flight_number,
            provider,
            IMPORT_SIM_NAME,
            dep,
            arr,
            p.callsign,
            notes_of(p, lang),
            (!all_tags.is_empty()).then(|| serde_json::to_string(&all_tags).unwrap_or_default()),
            p.rating,
            reg,
        ],
    )?;
    let Some(reg) = reg else { return Ok(false) };
    let existed: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM airframes WHERE registration = ?1)", params![reg], |r| r.get(0))?;
    let hint = AirframeHint {
        icao_type: icao.unwrap_or_default(),
        title: p.aircraft_title.clone().unwrap_or_default(),
        airline: p.airline.clone().unwrap_or_default(),
    };
    upsert_from_hint(conn, &reg, &hint, now.max(0) as u64)?;
    Ok(!existed)
}

fn push_warning(report: &mut Vec<String>, dropped: &mut usize, w: String) {
    if report.len() < WARNINGS_MAX {
        report.push(w);
    } else {
        *dropped += 1;
    }
}

impl Store {
    /// [`preview`] plus counts over the whole file and the duplicate check against the logbook.
    pub fn preview_csv(
        &self,
        bytes: &[u8],
        mapping: &ColumnMapping,
        opts: &CsvImportOptions,
        limit: usize,
        coords: AirportCoords<'_>,
    ) -> Result<CsvPreview> {
        check_mapping(mapping)?;
        let recs = data_records(bytes, mapping)?;
        let conn = self.conn();
        let mut out = CsvPreview { total_rows: recs.len(), ..Default::default() };
        let mut seen: Vec<(String, String, i64)> = Vec::new();
        for (i, rec) in recs.iter().enumerate() {
            let mut p = parse_row(rec, mapping, if i < limit { coords } else { &no_coords }, opts.lang);
            if p.error.is_some() {
                out.invalid += 1;
            } else {
                out.valid += 1;
                if opts.dedupe
                    && let Some((d, a, o)) = route_of(&p).map(|(d, a, o)| (d.to_string(), a.to_string(), o))
                {
                    p.duplicate = near_in(&seen, &d, &a, o) || route_near(&conn, Some(&d), Some(&a), o)?;
                    seen.push((d, a, o));
                    if p.duplicate {
                        out.duplicates += 1;
                    }
                }
            }
            if i < limit {
                out.rows.push(p);
            }
        }
        Ok(out)
    }

    /// [`Store::import_csv_with`] without airport coordinates (no map route, no distance fallback).
    pub fn import_csv(&self, bytes: &[u8], mapping: &ColumnMapping, opts: &CsvImportOptions) -> Result<CsvImportReport> {
        self.import_csv_with(bytes, mapping, opts, &no_coords, crate::now_ms_i64())
    }

    /// Imports the valid rows as completed flights (see the module docs), 100 per transaction.
    /// `coords` gives the airport positions (map routes, great-circle distance when the file
    /// has none).
    pub fn import_csv_with(
        &self,
        bytes: &[u8],
        mapping: &ColumnMapping,
        opts: &CsvImportOptions,
        coords: AirportCoords<'_>,
        now_ms: i64,
    ) -> Result<CsvImportReport> {
        check_mapping(mapping)?;
        let recs = data_records(bytes, mapping)?;
        let provider = format!("import:{}", mapping.preset.as_str());
        let source = opts.source_tag.trim();
        let tags = normalize_tags(&[IMPORT_TAG, source]);
        let mut report = CsvImportReport { rows: recs.len(), ..Default::default() };
        let mut dropped = 0usize;
        let mut estimated = 0usize;
        for chunk in recs.chunks(BATCH) {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            for rec in chunk {
                let p = parse_row(rec, mapping, coords, opts.lang);
                if let Some(e) = &p.error {
                    report.skipped_invalid += 1;
                    push_warning(&mut report.warnings, &mut dropped, ltr!(opts.lang, "Zeile {}: übersprungen – {e}", "Line {}: skipped – {e}", p.line));
                    continue;
                }
                if opts.dedupe
                    && let Some((d, a, o)) = route_of(&p)
                    && route_near(&tx, Some(d), Some(a), o)?
                {
                    report.skipped_duplicate += 1;
                    continue;
                }
                for w in &p.warnings {
                    push_warning(&mut report.warnings, &mut dropped, ltr!(opts.lang, "Zeile {}: {w}", "Line {}: {w}", p.line));
                }
                estimated += usize::from(p.distance_estimated);
                if insert_parsed(&tx, &p, &provider, &tags, now_ms, coords, opts.lang).map_err(|e| invalid(Invalid::CsvLine { line: p.line, source: Box::new(e) }))? {
                    report.airframes_added += 1;
                }
                report.added += 1;
            }
            tx.commit()?;
        }
        if estimated > 0 {
            let note = match (opts.lang, estimated) {
                (Lang::De, _) => format!("{estimated} Flüge ohne Distanz in der Datei: Großkreis zwischen den Flughäfen eingetragen"),
                (Lang::En, 1) => "1 flight without a distance in the file: great-circle distance between the airports entered".to_string(),
                (Lang::En, _) => format!("{estimated} flights without a distance in the file: great-circle distance between the airports entered"),
            };
            report.warnings.insert(0, note);
        }
        if dropped > 0 {
            report.warnings.push(ltr!(opts.lang, "… und {dropped} weitere Hinweise", "… and {dropped} more notes"));
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_with_quotes_and_line_breaks() {
        let r = parse_records("a,\"b,c\",\"d \"\"x\"\"\"\r\n\r\n1,\"zwei\nZeilen\",3\n", ',', None);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].cells, vec!["a", "b,c", "d \"x\""]);
        assert_eq!(r[1].cells, vec!["1", "zwei\nZeilen", "3"]);
        assert_eq!((r[0].line, r[1].line), (1, 3));
    }

    #[test]
    fn numbers_in_both_notations() {
        assert_eq!(parse_number("1.234,5 kg"), Some(1234.5));
        assert_eq!(parse_number("1,234.5"), Some(1234.5));
        assert_eq!(parse_number("-142 fpm"), Some(-142.0));
        assert_eq!(parse_number("\u{2212}142"), Some(-142.0));
        assert_eq!(parse_number("12,5"), Some(12.5));
        assert_eq!(parse_number("abc"), None);
        assert_eq!(parse_number("12:30"), None);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration_min("1:35", DurationUnit::Minutes), Some(95.0));
        assert_eq!(parse_duration_min("01:35:30", DurationUnit::Minutes), Some(95.5));
        assert_eq!(parse_duration_min("95", DurationUnit::Minutes), Some(95.0));
        assert_eq!(parse_duration_min("1,5", DurationUnit::Hours), Some(90.0));
        assert_eq!(parse_duration_min("1h 35m", DurationUnit::Minutes), Some(95.0));
        assert_eq!(parse_duration_min("1:75", DurationUnit::Minutes), None);
    }

    #[test]
    fn offsets_and_zones() {
        assert_eq!(parse_offset("+02:00"), Some(120));
        assert_eq!(parse_offset("-0530"), Some(-330));
        assert_eq!(parse_offset("Z"), Some(0));
        assert_eq!(split_zone("14:05:00Z"), ("14:05:00", Some(0)));
        assert_eq!(split_zone("14:05+01:00"), ("14:05", Some(60)));
    }
}
