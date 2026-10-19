//! Error codes of the store with their parameters and texts in both UI languages.
//!
//! Every refusal the user can meet (import, export, backup, restore, merge, edits) is a
//! variant of [`Invalid`] with a stable code (`store.flight_not_found`, …) and typed
//! parameters. `Display` is the German text (the reference, also what the log shows);
//! [`StoreError::message`] gives the text in either language, [`StoreError::code`] and
//! [`StoreError::params`] the machine-readable form the app passes on to the frontend
//! (`{ code, params, message }`). Technical errors (SQLite, I/O, JSON, track codec) keep the
//! library's English text as `detail` – `app/src/errors.ts` recognises those by their wording.

use serde_json::{Map, Value, json};
use vectasim_core::Lang;

/// A user-correctable field of a flight (Logbuch → Flug bearbeiten).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Callsign,
    Departure,
    Arrival,
    AircraftTitle,
}

impl Field {
    pub fn code(self) -> &'static str {
        match self {
            Field::Callsign => "callsign",
            Field::Departure => "departure",
            Field::Arrival => "arrival",
            Field::AircraftTitle => "aircraftTitle",
        }
    }

    pub fn label(self, lang: Lang) -> &'static str {
        match self {
            Field::Callsign => lang.tr("Rufzeichen", "Callsign"),
            Field::Departure => lang.tr("Abflug", "Departure"),
            Field::Arrival => lang.tr("Ankunft", "Arrival"),
            Field::AircraftTitle => lang.tr("Flugzeugname", "Aircraft name"),
        }
    }
}

/// The step of a safety copy that failed ([`crate::StoreError::Backup`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupStep {
    CreateDir,
    PathNotUtf8,
    Copy,
    Rename,
}

impl BackupStep {
    pub fn code(self) -> &'static str {
        match self {
            BackupStep::CreateDir => "createDir",
            BackupStep::PathNotUtf8 => "pathNotUtf8",
            BackupStep::Copy => "copy",
            BackupStep::Rename => "rename",
        }
    }

    pub fn label(self, lang: Lang) -> &'static str {
        match self {
            BackupStep::CreateDir => lang.tr("Ordner nicht anlegbar", "folder could not be created"),
            BackupStep::PathNotUtf8 => lang.tr("Pfad nicht darstellbar", "path not representable"),
            BackupStep::Copy => lang.tr("Kopie fehlgeschlagen", "copy failed"),
            BackupStep::Rename => lang.tr("Kopie nicht umbenennbar", "copy could not be renamed"),
        }
    }
}

/// Why the store refused a request (code `store.<snake_case of the variant>`, see [`Invalid::code`]).
#[derive(Debug)]
pub enum Invalid {
    // ---- edits (flight, airframe, runway)
    VappOutOfRange { value: f64, min: f64, max: f64 },
    FlapsOutOfRange { value: i32, max: i32 },
    InvalidRegistration { registration: String },
    IcaoInvalid { field: Field },
    TextTooLong { field: Field, max: usize },
    NotesTooLong { max: usize },
    RatingInvalid,
    RunwayAirportInvalid,
    RunwayIdentInvalid,
    RunwayCoordinatesInvalid,
    RunwayLengthInvalid,
    RunwayWidthInvalid,
    RunwayElevationInvalid,
    RunwayNotSaved,
    // ---- flights, merge, resume
    FlightNotFound,
    MergeSelf,
    MergeTrashed,
    ResumeNotInterrupted,
    MergeNoEnd,
    MergeOverlap,
    MergeGap { minutes: u64, max_minutes: u64 },
    MergePositionUnknown,
    MergeJump { distance_nm: f64, max_nm: f64 },
    LastFlightNotSaved,
    // ---- backup / restore
    FileNotFound { path: String },
    NotADatabase { detail: String },
    BackupCorrupt { detail: String },
    NotVectasimDatabase { detail: String },
    SchemaMissing,
    InMemory,
    ActiveDatabase,
    // ---- .vectasim bundles
    FileOpen { path: String, detail: String },
    NotABundle { detail: String },
    ManifestMissing,
    ManifestUnreadable { detail: String },
    BundleTooNew { format: u32, supported: u32 },
    BundleEntry { entry: String, detail: String },
    BundleEntryTooLarge { entry: String, bytes: Option<u64> },
    BundleLine { entry: String, line: usize, detail: String },
    FlightWithoutId { entry: String, line: usize },
    NotAnImage { entry: String },
    NoBackupDir,
    FlightImport { flight_id: String, source: Box<crate::StoreError> },
    // ---- CSV import
    CsvDelimiter { delimiter: String },
    CsvNoDepartureColumn,
    CsvNoArrivalColumn,
    CsvNoDateColumn,
    CsvLine { line: usize, source: Box<crate::StoreError> },
}

/// `140` or `12,5` / `12.5`.
fn num(lang: Lang, v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{v:.0}") } else { lang.decimal(v, 1) }
}

impl Invalid {
    /// Stable code, `store.` + snake case.
    pub fn code(&self) -> &'static str {
        use Invalid::*;
        match self {
            VappOutOfRange { .. } => "store.vapp_out_of_range",
            FlapsOutOfRange { .. } => "store.flaps_out_of_range",
            InvalidRegistration { .. } => "store.invalid_registration",
            IcaoInvalid { .. } => "store.icao_invalid",
            TextTooLong { .. } => "store.text_too_long",
            NotesTooLong { .. } => "store.notes_too_long",
            RatingInvalid => "store.rating_invalid",
            RunwayAirportInvalid => "store.runway_airport_invalid",
            RunwayIdentInvalid => "store.runway_ident_invalid",
            RunwayCoordinatesInvalid => "store.runway_coordinates_invalid",
            RunwayLengthInvalid => "store.runway_length_invalid",
            RunwayWidthInvalid => "store.runway_width_invalid",
            RunwayElevationInvalid => "store.runway_elevation_invalid",
            RunwayNotSaved => "store.runway_not_saved",
            FlightNotFound => "store.flight_not_found",
            MergeSelf => "store.merge_self",
            MergeTrashed => "store.merge_trashed",
            ResumeNotInterrupted => "store.resume_not_interrupted",
            MergeNoEnd => "store.merge_no_end",
            MergeOverlap => "store.merge_overlap",
            MergeGap { .. } => "store.merge_gap",
            MergePositionUnknown => "store.merge_position_unknown",
            MergeJump { .. } => "store.merge_jump",
            LastFlightNotSaved => "store.last_flight_not_saved",
            FileNotFound { .. } => "store.file_not_found",
            NotADatabase { .. } => "store.not_a_database",
            BackupCorrupt { .. } => "store.backup_corrupt",
            NotVectasimDatabase { .. } => "store.not_vectasim_database",
            SchemaMissing => "store.schema_missing",
            InMemory => "store.in_memory",
            ActiveDatabase => "store.active_database",
            FileOpen { .. } => "store.file_open",
            NotABundle { .. } => "store.not_a_bundle",
            ManifestMissing => "store.manifest_missing",
            ManifestUnreadable { .. } => "store.manifest_unreadable",
            BundleTooNew { .. } => "store.bundle_too_new",
            BundleEntry { .. } => "store.bundle_entry",
            BundleEntryTooLarge { .. } => "store.bundle_entry_too_large",
            BundleLine { .. } => "store.bundle_line",
            FlightWithoutId { .. } => "store.flight_without_id",
            NotAnImage { .. } => "store.not_an_image",
            NoBackupDir => "store.no_backup_dir",
            FlightImport { .. } => "store.flight_import",
            CsvDelimiter { .. } => "store.csv_delimiter",
            CsvNoDepartureColumn => "store.csv_no_departure_column",
            CsvNoArrivalColumn => "store.csv_no_arrival_column",
            CsvNoDateColumn => "store.csv_no_date_column",
            CsvLine { .. } => "store.csv_line",
        }
    }

    /// Parameters (camelCase keys); nested store errors as `{ code, params }` under `cause`.
    pub fn params(&self) -> Map<String, Value> {
        use Invalid::*;
        let v = match self {
            VappOutOfRange { value, min, max } => json!({ "value": value, "min": min, "max": max }),
            FlapsOutOfRange { value, max } => json!({ "value": value, "max": max }),
            InvalidRegistration { registration } => json!({ "registration": registration }),
            IcaoInvalid { field } => json!({ "field": field.code() }),
            TextTooLong { field, max } => json!({ "field": field.code(), "max": max }),
            NotesTooLong { max } => json!({ "max": max }),
            MergeGap { minutes, max_minutes } => json!({ "minutes": minutes, "maxMinutes": max_minutes }),
            MergeJump { distance_nm, max_nm } => json!({ "distanceNm": distance_nm, "maxNm": max_nm }),
            FileNotFound { path } => json!({ "path": path }),
            NotADatabase { detail } | BackupCorrupt { detail } | NotVectasimDatabase { detail } | NotABundle { detail } | ManifestUnreadable { detail } => {
                json!({ "detail": detail })
            }
            FileOpen { path, detail } => json!({ "path": path, "detail": detail }),
            BundleTooNew { format, supported } => json!({ "format": format, "supported": supported }),
            BundleEntry { entry, detail } => json!({ "entry": entry, "detail": detail }),
            BundleEntryTooLarge { entry, bytes } => json!({ "entry": entry, "bytes": bytes }),
            BundleLine { entry, line, detail } => json!({ "entry": entry, "line": line, "detail": detail }),
            FlightWithoutId { entry, line } => json!({ "entry": entry, "line": line }),
            NotAnImage { entry } => json!({ "entry": entry }),
            FlightImport { flight_id, source } => json!({ "flightId": flight_id, "cause": { "code": source.code(), "params": source.params() } }),
            CsvDelimiter { delimiter } => json!({ "delimiter": delimiter }),
            CsvLine { line, source } => json!({ "line": line, "cause": { "code": source.code(), "params": source.params() } }),
            _ => json!({}),
        };
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    /// The user text in `lang`.
    pub fn message(&self, lang: Lang) -> String {
        use Invalid::*;
        let de = lang == Lang::De;
        let s = |d: &str, e: &str| if de { d.to_owned() } else { e.to_owned() };
        match self {
            VappOutOfRange { value, min, max } => {
                let (v, a, b) = (num(lang, *value), num(lang, *min), num(lang, *max));
                if de { format!("Vapp {v} kt liegt außerhalb von {a}–{b} kt") } else { format!("Vapp {v} kt is outside {a}–{b} kt") }
            }
            FlapsOutOfRange { value, max } => {
                if de { format!("Landeklappen-Stufe {value} liegt außerhalb von 0–{max}") } else { format!("Landing flap setting {value} is outside 0–{max}") }
            }
            InvalidRegistration { registration } => {
                if de { format!("ungültige Registrierung: {registration}") } else { format!("invalid registration: {registration}") }
            }
            IcaoInvalid { field } => {
                let f = field.label(lang);
                if de { format!("{f}: ICAO-Code muss aus 4 Buchstaben/Ziffern bestehen") } else { format!("{f}: the ICAO code must be 4 letters/digits") }
            }
            TextTooLong { field, max } => {
                let f = field.label(lang);
                if de { format!("{f}: höchstens {max} Zeichen") } else { format!("{f}: at most {max} characters") }
            }
            NotesTooLong { max } => {
                if de { format!("Notiz zu lang (höchstens {max} Zeichen)") } else { format!("Note too long (at most {max} characters)") }
            }
            RatingInvalid => s("Bewertung muss 1 bis 5 Sterne sein", "Rating must be 1 to 5 stars"),
            RunwayAirportInvalid => s("Flugplatz-Kennung ungültig", "Invalid airport identifier"),
            RunwayIdentInvalid => s("Pistenbezeichnung ungültig", "Invalid runway designator"),
            RunwayCoordinatesInvalid => s("Koordinaten ungültig", "Invalid coordinates"),
            RunwayLengthInvalid => s("Schwelle und Bahnende müssen 100 m bis 8 km auseinanderliegen", "Threshold and runway end must be 100 m to 8 km apart"),
            RunwayWidthInvalid => s("Pistenbreite ungültig (1–200 m)", "Invalid runway width (1–200 m)"),
            RunwayElevationInvalid => s("Höhe ungültig", "Invalid elevation"),
            RunwayNotSaved => s("Piste nicht gespeichert", "Runway not saved"),
            FlightNotFound => s("Flug nicht gefunden", "Flight not found"),
            MergeSelf => s("Ein Flug lässt sich nicht mit sich selbst zusammenführen.", "A flight cannot be merged with itself."),
            MergeTrashed => s("Flüge im Papierkorb lassen sich nicht zusammenführen.", "Flights in the trash cannot be merged."),
            ResumeNotInterrupted => s("Nur ein unterbrochener Flug lässt sich fortsetzen.", "Only an interrupted flight can be resumed."),
            MergeNoEnd => s("Vom ersten Flug ist kein Ende bekannt.", "The end of the first flight is not known."),
            MergeOverlap => s("Der zweite Flug beginnt vor dem Ende des ersten.", "The second flight starts before the first one ends."),
            MergeGap { minutes, max_minutes } => {
                if de {
                    format!("Zwischen den Flügen liegen {minutes} min (höchstens {max_minutes} min).")
                } else {
                    format!("There are {minutes} min between the flights (at most {max_minutes} min).")
                }
            }
            MergePositionUnknown => s("Die Position am Übergang ist nicht bekannt.", "The position at the transition is not known."),
            MergeJump { distance_nm, max_nm } => {
                let (d, m) = (lang.decimal(*distance_nm, 1), num(lang, *max_nm));
                if de { format!("Die Positionen liegen {d} nm auseinander (höchstens {m} nm).") } else { format!("The positions are {d} nm apart (at most {m} nm).") }
            }
            LastFlightNotSaved => s("Das Ende des letzten Flugs ist noch nicht gespeichert.", "The end of the last flight is not saved yet."),
            FileNotFound { path } => if de { format!("Datei nicht gefunden: {path}") } else { format!("File not found: {path}") },
            NotADatabase { detail } => if de { format!("keine lesbare Datenbank: {detail}") } else { format!("not a readable database: {detail}") },
            BackupCorrupt { detail } => if de { format!("Sicherung beschädigt: {detail}") } else { format!("Backup damaged: {detail}") },
            NotVectasimDatabase { detail } => {
                if de { format!("keine VectaSim-Datenbank: {detail}") } else { format!("not a VectaSim database: {detail}") }
            }
            SchemaMissing => s("keine VectaSim-Datenbank (Schema fehlt)", "not a VectaSim database (schema missing)"),
            InMemory => s("Logbuch ohne Datei (im Speicher)", "Logbook without a file (in memory)"),
            ActiveDatabase => s("Das ist die aktive Datenbank, keine Sicherung.", "This is the active database, not a backup."),
            FileOpen { path, detail } => format!("{path}: {detail}"),
            NotABundle { detail } => if de { format!("keine VectaSim-Exportdatei: {detail}") } else { format!("not a VectaSim export file: {detail}") },
            ManifestMissing => s("keine VectaSim-Exportdatei (manifest.json fehlt)", "not a VectaSim export file (manifest.json missing)"),
            ManifestUnreadable { detail } => if de { format!("manifest.json unlesbar: {detail}") } else { format!("manifest.json unreadable: {detail}") },
            BundleTooNew { format, supported } => {
                if de {
                    format!("Die Datei stammt von einer neueren VectaSim-Version (Exportformat {format}, diese Version kennt bis {supported}). Bitte VectaSim aktualisieren.")
                } else {
                    format!("The file comes from a newer VectaSim version (export format {format}, this version knows up to {supported}). Please update VectaSim.")
                }
            }
            BundleEntry { entry, detail } => format!("{entry}: {detail}"),
            BundleEntryTooLarge { entry, bytes } => match (de, bytes) {
                (true, Some(b)) => format!("{entry} ist zu groß ({b} Bytes)"),
                (true, None) => format!("{entry} ist zu groß"),
                (false, Some(b)) => format!("{entry} is too large ({b} bytes)"),
                (false, None) => format!("{entry} is too large"),
            },
            BundleLine { entry, line, detail } => if de { format!("{entry}, Zeile {line}: {detail}") } else { format!("{entry}, line {line}: {detail}") },
            FlightWithoutId { entry, line } => {
                if de { format!("{entry}, Zeile {line}: Flug ohne id") } else { format!("{entry}, line {line}: flight without id") }
            }
            NotAnImage { entry } => if de { format!("{entry}: kein Bildformat") } else { format!("{entry}: not an image format") },
            NoBackupDir => s("Kein Sicherungsordner für die Sicherung vor dem Ersetzen", "No backup folder for the backup before replacing"),
            FlightImport { flight_id, source } => {
                let m = source.message(lang);
                if de { format!("Flug {flight_id}: {m}") } else { format!("Flight {flight_id}: {m}") }
            }
            CsvDelimiter { delimiter } => {
                if de { format!("Trennzeichen „{delimiter}“: genau ein Zeichen") } else { format!("Delimiter “{delimiter}”: exactly one character") }
            }
            CsvNoDepartureColumn => s("Keine Spalte für den Abflughafen zugeordnet", "No column assigned to the departure airport"),
            CsvNoArrivalColumn => s("Keine Spalte für den Zielflughafen zugeordnet", "No column assigned to the destination airport"),
            CsvNoDateColumn => s("Keine Spalte für Datum oder Off-Block zugeordnet", "No column assigned to the date or off-block"),
            CsvLine { line, source } => {
                let m = source.message(lang);
                if de { format!("Zeile {line}: {m}") } else { format!("Line {line}: {m}") }
            }
        }
    }
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message(Lang::De))
    }
}

impl crate::StoreError {
    /// Stable code: `store.<…>` for [`Invalid`], else `store.sqlite` | `store.track` |
    /// `store.io` | `store.json` | `store.newer_schema` | `store.migration_failed` | `store.backup_failed`.
    pub fn code(&self) -> &'static str {
        use crate::StoreError::*;
        match self {
            Sqlite(_) => "store.sqlite",
            Track(_) => "store.track",
            Io(_) => "store.io",
            Json(_) => "store.json",
            Invalid(i) => i.code(),
            NewerSchema { .. } => "store.newer_schema",
            Migration { .. } => "store.migration_failed",
            Backup { .. } => "store.backup_failed",
        }
    }

    /// Parameters of [`Self::code`]; technical errors carry their library text as `detail`.
    pub fn params(&self) -> Map<String, Value> {
        use crate::StoreError::*;
        let v = match self {
            Sqlite(e) => json!({ "detail": e.to_string() }),
            Track(e) => json!({ "detail": e.to_string() }),
            Io(e) => json!({ "detail": e.to_string() }),
            Json(e) => json!({ "detail": e.to_string() }),
            Invalid(i) => return i.params(),
            NewerSchema { found, supported } => json!({ "found": found, "supported": supported }),
            Migration { from, to, message, backup } => {
                json!({ "from": from, "to": to, "detail": message, "backup": backup.as_ref().map(|b| b.display().to_string()) })
            }
            Backup { step, dir, detail } => json!({ "step": step.code(), "dir": dir.display().to_string(), "detail": detail }),
        };
        match v {
            Value::Object(m) => m,
            _ => Map::new(),
        }
    }

    /// The text in `lang`. Technical errors keep the library's (English) wording in both.
    pub fn message(&self, lang: Lang) -> String {
        use crate::StoreError::*;
        match self {
            Invalid(i) => i.message(lang),
            NewerSchema { found, supported } => match lang {
                Lang::De => format!("Datenbankschema v{found} ist neuer als diese Version unterstützt (v{supported})"),
                Lang::En => self.to_string(),
            },
            Migration { from, to, message, .. } => match lang {
                Lang::De => format!("Umstellung v{from} → v{to} fehlgeschlagen (zurückgenommen): {message}"),
                Lang::En => self.to_string(),
            },
            Backup { step, dir, detail } => match lang {
                Lang::De => format!("Sicherung fehlgeschlagen: {} ({}): {detail}", step.label(lang), dir.display()),
                Lang::En => format!("backup failed: {} ({}): {detail}", step.label(lang), dir.display()),
            },
            other => other.to_string(),
        }
    }
}

/// Shorthand for the variants with a path parameter.
pub(crate) fn path_text(p: &std::path::Path) -> String {
    p.display().to_string()
}

impl crate::StoreError {
    /// The structured form for an API boundary: `{ code, params, message }` (message in `lang`).
    pub fn to_json(&self, lang: Lang) -> Value {
        json!({ "code": self.code(), "params": self.params(), "message": self.message(lang) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StoreError;

    #[test]
    fn golden_merge_gap() {
        let e = StoreError::from(Invalid::MergeGap { minutes: 75, max_minutes: 60 });
        assert_eq!(e.code(), "store.merge_gap");
        assert_eq!(e.to_string(), "Zwischen den Flügen liegen 75 min (höchstens 60 min).");
        assert_eq!(
            e.to_json(Lang::De),
            json!({ "code": "store.merge_gap", "params": { "minutes": 75, "maxMinutes": 60 }, "message": "Zwischen den Flügen liegen 75 min (höchstens 60 min)." })
        );
        assert_eq!(e.message(Lang::En), "There are 75 min between the flights (at most 60 min).");
    }

    #[test]
    fn golden_csv_line_nests_the_cause() {
        let inner = StoreError::from(Invalid::IcaoInvalid { field: Field::Departure });
        let e = StoreError::from(Invalid::CsvLine { line: 7, source: Box::new(inner) });
        assert_eq!(e.message(Lang::De), "Zeile 7: Abflug: ICAO-Code muss aus 4 Buchstaben/Ziffern bestehen");
        assert_eq!(e.message(Lang::En), "Line 7: Departure: the ICAO code must be 4 letters/digits");
        assert_eq!(
            e.to_json(Lang::En)["params"],
            json!({ "line": 7, "cause": { "code": "store.icao_invalid", "params": { "field": "departure" } } })
        );
    }

    #[test]
    fn numbers_follow_the_language() {
        let e = StoreError::from(Invalid::MergeJump { distance_nm: 7.25, max_nm: 5.0 });
        assert_eq!(e.message(Lang::De), "Die Positionen liegen 7,2 nm auseinander (höchstens 5 nm).");
        assert_eq!(e.message(Lang::En), "The positions are 7.2 nm apart (at most 5 nm).");
        let v = StoreError::from(Invalid::VappOutOfRange { value: 12.5, min: 40.0, max: 250.0 });
        assert_eq!(v.message(Lang::De), "Vapp 12,5 kt liegt außerhalb von 40–250 kt");
    }

    #[test]
    fn technical_errors_keep_their_detail() {
        let e = StoreError::Backup { step: BackupStep::CreateDir, dir: "D:/b".into(), detail: "disk full".into() };
        assert_eq!(e.code(), "store.backup_failed");
        assert_eq!(e.to_string(), "backup failed: Ordner nicht anlegbar (D:/b): disk full");
        assert_eq!(e.message(Lang::En), "backup failed: folder could not be created (D:/b): disk full");
        assert_eq!(e.params()["step"], json!("createDir"));
        let s = StoreError::Sqlite(rusqlite::Error::InvalidQuery);
        assert_eq!(s.code(), "store.sqlite");
        assert_eq!(s.message(Lang::En), s.to_string());
        assert_eq!(StoreError::NewerSchema { found: 11, supported: 10 }.message(Lang::De), "Datenbankschema v11 ist neuer als diese Version unterstützt (v10)");
    }

    #[test]
    fn codes_are_unique_and_prefixed() {
        let all = [
            Invalid::RatingInvalid.code(),
            Invalid::FlightNotFound.code(),
            Invalid::MergeSelf.code(),
            Invalid::ManifestMissing.code(),
            Invalid::CsvNoDateColumn.code(),
            Invalid::RunwayNotSaved.code(),
        ];
        let set: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(set.len(), all.len());
        assert!(all.iter().all(|c| c.starts_with("store.")));
    }
}
