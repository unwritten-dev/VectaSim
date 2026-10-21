//! Airframes: one row per aircraft registration, so every flight with the same
//! registration (from the SimBrief OFP, the sim's ATC ID or picked by hand)
//! books onto the same aircraft. Photos are cached on the row (see the app's
//! `vectasim-photos` client); the store only keeps what was found.

use crate::Result;
use crate::store::{RATED_LANDING_RATE_SQL, Store, counts_in_stats_sql};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

/// ATC IDs the sims ship as placeholders; they say nothing about the airframe.
const PLACEHOLDER_IDS: &[&str] = &["ASXGS", "ASOBO", "N12345", "NONE", "UNKNOWN", "TEST", "XXXX", "XXXXX", "ABC", "ABCD", "ABCDE"];

/// Upper-case, spaces removed. `None` when the result is not a plausible
/// registration: 3–8 chars of letters, digits and inner hyphens, with at least
/// one letter, and not a known sim placeholder.
pub fn normalize_registration(raw: &str) -> Option<String> {
    let reg: String = raw.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    let len = reg.chars().count();
    if !(3..=8).contains(&len) {
        return None;
    }
    if !reg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    if reg.starts_with('-') || reg.ends_with('-') || reg.contains("--") {
        return None;
    }
    if !reg.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if PLACEHOLDER_IDS.contains(&reg.replace('-', "").as_str()) {
        return None;
    }
    Some(reg)
}

/// Which registration a flight books onto: the OFP's, else the sim's ATC ID, else none.
pub fn resolve_registration(ofp_registration: Option<&str>, atc_id: Option<&str>) -> Option<String> {
    ofp_registration.and_then(normalize_registration).or_else(|| atc_id.and_then(normalize_registration))
}

/// MSFS `ATC MODEL` (`TT:ATCCOM.AC_MODEL_A20N.0.text`, `$$:A320`, `A20N`) → ICAO type designator.
/// Same rule as the UI's `icaoFromAtcModel`.
pub fn icao_from_atc_model(raw: &str) -> Option<String> {
    let up = raw.trim().to_uppercase();
    if let Some(i) = up.find("AC_MODEL_") {
        let code: String = up[i + 9..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if (2..=4).contains(&code.len()) {
            return Some(code);
        }
    }
    let t = up.strip_prefix("$$:").unwrap_or(&up).trim();
    ((2..=4).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric())).then(|| t.to_string())
}

/// What a flight knows about its airframe; empty strings mean "unknown".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AirframeHint {
    pub icao_type: String,
    pub title: String,
    pub airline: String,
}

/// Registration and type facts out of a stored OFP document (`Ofp` serialised camelCase).
pub(crate) fn ofp_facts(ofp_json: &str) -> (Option<String>, AirframeHint) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(ofp_json) else { return (None, AirframeHint::default()) };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().trim().to_string();
    let reg = s("registration");
    (
        (!reg.is_empty()).then_some(reg),
        AirframeHint { icao_type: s("aircraftIcao").to_uppercase(), title: s("aircraftName"), airline: s("airlineIcao").to_uppercase() },
    )
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Airframe {
    pub registration: String,
    pub icao_type: Option<String>,
    pub title: Option<String>,
    pub airline: Option<String>,
    pub custom_name: Option<String>,
    pub notes: Option<String>,
    pub image_url: Option<String>,
    pub image_thumb_url: Option<String>,
    /// Photographer (Planespotters) or "Eigenes Bild".
    pub image_credit: Option<String>,
    /// Page the credit links to.
    pub image_link: Option<String>,
    /// planespotters | user | none (looked up, nothing found)
    pub image_source: Option<String>,
    /// When the photo lookup last ran (hit or miss).
    pub image_fetched_ms: Option<u64>,
    /// Pilot's approach speed for this airframe, KIAS (schema v11). The approach and landing
    /// assessment take it as the reference speed (`AircraftRef::vapp_kt`); `None` = the flown median.
    #[serde(default)]
    pub vapp_kt: Option<f64>,
    /// Pilot's landing flap handle index for this airframe (schema v15), e.g. 3 for an A320
    /// landing in CONF 3. The approach assessment checks it at 1000/500 ft
    /// (`AircraftRef::landing_flaps_index`); `None` = the last handle position.
    #[serde(default)]
    pub landing_flaps: Option<i32>,
    pub created_ms: u64,
    pub updated_ms: u64,
}

/// Airframe with logbook aggregates for the fleet list.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirframeRow {
    #[serde(flatten)]
    pub airframe: Airframe,
    /// Flights counted (demo flights only with `include_demo`).
    pub flights: u64,
    /// All flights booked onto it, demo or not.
    pub total_flights: u64,
    pub block_time_ms: u64,
    pub flight_time_ms: u64,
    pub distance_nm: f64,
    pub landings: u64,
    pub avg_landing_vs_fpm: Option<f64>,
    pub last_flown_ms: Option<u64>,
}

/// Manual create/edit. `None` leaves a field as it is, `Some("")` clears it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirframeEdit {
    pub registration: String,
    pub icao_type: Option<String>,
    pub title: Option<String>,
    pub airline: Option<String>,
    pub custom_name: Option<String>,
    pub notes: Option<String>,
    /// Vapp in KIAS: `None` leaves it, `Some(v)` with v <= 0 clears it, otherwise
    /// [`VAPP_MIN_KT`]..=[`VAPP_MAX_KT`] (anything else is refused).
    #[serde(default)]
    pub vapp_kt: Option<f64>,
    /// Landing flap handle index: `None` leaves it, `Some(v)` with v < 0 clears it, otherwise
    /// 0..=[`LANDING_FLAPS_MAX`].
    #[serde(default)]
    pub landing_flaps: Option<i32>,
}

/// Plausible range of a manually entered Vapp, KIAS.
pub const VAPP_MIN_KT: f64 = 40.0;
pub const VAPP_MAX_KT: f64 = 250.0;
/// Highest landing flap handle index accepted (MSFS aircraft have at most ~10 handle positions).
pub const LANDING_FLAPS_MAX: i32 = 10;

/// The photo facts the store keeps; written by `set_airframe_photo`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AirframePhoto {
    pub url: String,
    pub thumb_url: String,
    pub credit: String,
    pub link: String,
    pub source: String,
}

pub(crate) const MIGRATION_V6: &str = r#"
CREATE TABLE IF NOT EXISTS airframes (
    registration     TEXT PRIMARY KEY,   -- normalised: upper case, no spaces
    icao_type        TEXT,
    title            TEXT,
    airline          TEXT,
    custom_name      TEXT,
    notes            TEXT,
    image_url        TEXT,
    image_thumb_url  TEXT,
    image_credit     TEXT,
    image_link       TEXT,
    image_source     TEXT,
    image_fetched_ms INTEGER,
    created_ms       INTEGER NOT NULL,
    updated_ms       INTEGER NOT NULL
);
ALTER TABLE flights ADD COLUMN airframe_reg TEXT;
CREATE INDEX IF NOT EXISTS flights_airframe ON flights(airframe_reg);
"#;

/// v11: the pilot's Vapp per airframe (KIAS), reference speed of the approach assessment.
pub(crate) const MIGRATION_V11: &str = "ALTER TABLE airframes ADD COLUMN vapp_kt REAL;";

/// v15: the pilot's landing flap handle index per airframe (approach assessment).
pub(crate) const MIGRATION_V15: &str = "ALTER TABLE airframes ADD COLUMN landing_flaps INTEGER;";

const AIRFRAME_COLS: &str = "a.registration, a.icao_type, a.title, a.airline, a.custom_name, a.notes, a.image_url,
    a.image_thumb_url, a.image_credit, a.image_link, a.image_source, a.image_fetched_ms, a.created_ms, a.updated_ms, a.vapp_kt, a.landing_flaps";

const DEMO_F2: &str = "(?1 OR COALESCE(f2.provider, '') <> 'mock')";

fn row_to_airframe(r: &Row<'_>) -> rusqlite::Result<Airframe> {
    Ok(Airframe {
        registration: r.get(0)?,
        icao_type: r.get(1)?,
        title: r.get(2)?,
        airline: r.get(3)?,
        custom_name: r.get(4)?,
        notes: r.get(5)?,
        image_url: r.get(6)?,
        image_thumb_url: r.get(7)?,
        image_credit: r.get(8)?,
        image_link: r.get(9)?,
        image_source: r.get(10)?,
        image_fetched_ms: r.get::<_, Option<i64>>(11)?.map(|v| v as u64),
        created_ms: r.get::<_, i64>(12)? as u64,
        updated_ms: r.get::<_, i64>(13)? as u64,
        vapp_kt: r.get(14)?,
        landing_flaps: r.get(15)?,
    })
}

fn non_empty(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty()).then_some(t)
}

/// Create the row or fill its gaps from what a flight knows. Facts already on the
/// row (and the user's name/notes) are never overwritten.
pub(crate) fn upsert_from_hint(conn: &Connection, reg: &str, hint: &AirframeHint, now_ms: u64) -> Result<()> {
    conn.execute(
        "INSERT INTO airframes (registration, icao_type, title, airline, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(registration) DO UPDATE SET
            icao_type = COALESCE(airframes.icao_type, excluded.icao_type),
            title = COALESCE(airframes.title, excluded.title),
            airline = COALESCE(airframes.airline, excluded.airline)",
        params![reg, non_empty(&hint.icao_type), non_empty(&hint.title), non_empty(&hint.airline), now_ms as i64],
    )?;
    Ok(())
}

/// What a flight row says about its airframe.
struct FlightFacts {
    id: String,
    ofp_json: Option<String>,
    atc_id: Option<String>,
    atc_model: Option<String>,
    title: Option<String>,
    airline: Option<String>,
    created_ms: i64,
}

const FLIGHT_FACTS_SQL: &str = "SELECT id, ofp_json, atc_id, atc_model, aircraft_title, atc_airline, created_ms FROM flights";

fn row_to_facts(r: &Row<'_>) -> rusqlite::Result<FlightFacts> {
    Ok(FlightFacts {
        id: r.get(0)?,
        ofp_json: r.get(1)?,
        atc_id: r.get(2)?,
        atc_model: r.get(3)?,
        title: r.get(4)?,
        airline: r.get(5)?,
        created_ms: r.get(6)?,
    })
}

impl FlightFacts {
    /// OFP registration (if any) and the type facts: the OFP's first, the sim's fill gaps.
    fn hint(&self) -> (Option<String>, AirframeHint) {
        let (ofp_reg, ofp_hint) = self.ofp_json.as_deref().map(ofp_facts).unwrap_or_default();
        let from_sim = AirframeHint {
            icao_type: self.atc_model.as_deref().and_then(icao_from_atc_model).unwrap_or_default(),
            title: self.title.clone().unwrap_or_default(),
            airline: self.airline.clone().unwrap_or_default(),
        };
        (ofp_reg, merge_hint(ofp_hint, &from_sim))
    }
}

/// One-off part of the v6 migration: book existing flights onto airframes with the
/// same rule the recorder uses (OFP registration, else a registration-like ATC ID).
pub(crate) fn backfill(conn: &Connection) -> Result<usize> {
    let rows = {
        let mut stmt = conn.prepare(&format!("{FLIGHT_FACTS_SQL} WHERE airframe_reg IS NULL ORDER BY created_ms"))?;
        stmt.query_map([], row_to_facts)?.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut booked = 0;
    for f in rows {
        let (ofp_reg, hint) = f.hint();
        let Some(reg) = resolve_registration(ofp_reg.as_deref(), f.atc_id.as_deref()) else { continue };
        upsert_from_hint(conn, &reg, &hint, f.created_ms.max(0) as u64)?;
        conn.execute("UPDATE flights SET airframe_reg = ?2 WHERE id = ?1", params![f.id, reg])?;
        booked += 1;
    }
    Ok(booked)
}

/// `a` wins per field, `b` fills its gaps.
pub(crate) fn merge_hint(a: AirframeHint, b: &AirframeHint) -> AirframeHint {
    let pick = |x: String, y: &str| if x.trim().is_empty() { y.to_string() } else { x };
    AirframeHint { icao_type: pick(a.icao_type, &b.icao_type), title: pick(a.title, &b.title), airline: pick(a.airline, &b.airline) }
}

impl Store {
    /// Book a flight onto an airframe (creating/filling it) — used by the recorder.
    pub(crate) fn book_flight_airframe(&self, flight_id: &str, reg: &str, hint: &AirframeHint, now_ms: u64) -> Result<()> {
        let conn = self.conn();
        upsert_from_hint(&conn, reg, hint, now_ms)?;
        conn.execute("UPDATE flights SET airframe_reg = ?2 WHERE id = ?1", params![flight_id, reg])?;
        Ok(())
    }

    pub(crate) fn flight_airframe_reg(&self, flight_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT airframe_reg FROM flights WHERE id = ?1", params![flight_id], |r| r.get(0))
            .optional()?
            .flatten())
    }

    /// All airframes with aggregates; demo (mock) flights count only with `include_demo`.
    pub fn list_airframes(&self, include_demo: bool) -> Result<Vec<AirframeRow>> {
        let conn = self.conn();
        let counts = counts_in_stats_sql("f");
        let mut stmt = conn.prepare(&format!(
            "SELECT {AIRFRAME_COLS},
                COUNT(f.id),
                COALESCE(SUM(CASE WHEN f.on_block_ms IS NOT NULL AND f.off_block_ms IS NOT NULL THEN f.on_block_ms - f.off_block_ms END), 0),
                COALESCE(SUM(CASE WHEN f.landing_ms IS NOT NULL AND f.takeoff_ms IS NOT NULL THEN f.landing_ms - f.takeoff_ms END), 0),
                COALESCE(SUM(f.distance_nm), 0),
                (SELECT COUNT(*) FROM touchdowns t JOIN flights f2 ON f2.id = t.flight_id
                    WHERE f2.airframe_reg = a.registration AND f2.deleted_ms IS NULL AND f2.state <> 'discarded' AND t.touch_and_go = 0 AND {DEMO_F2}),
                (SELECT AVG({RATED_LANDING_RATE_SQL}) FROM touchdowns t JOIN flights f2 ON f2.id = t.flight_id
                    WHERE f2.airframe_reg = a.registration AND f2.deleted_ms IS NULL AND f2.state <> 'discarded' AND t.touch_and_go = 0 AND {DEMO_F2}),
                MAX(COALESCE(f.off_block_ms, f.created_ms)),
                (SELECT COUNT(*) FROM flights f3 WHERE f3.airframe_reg = a.registration AND f3.deleted_ms IS NULL)
             FROM airframes a LEFT JOIN flights f ON f.airframe_reg = a.registration AND f.deleted_ms IS NULL
                AND {counts} AND (?1 OR COALESCE(f.provider, '') <> 'mock')
             GROUP BY a.registration
             ORDER BY MAX(COALESCE(f.off_block_ms, f.created_ms)) IS NULL, MAX(COALESCE(f.off_block_ms, f.created_ms)) DESC,
                a.registration"
        ))?;
        let rows = stmt.query_map(params![include_demo], |r| {
            Ok(AirframeRow {
                airframe: row_to_airframe(r)?,
                flights: r.get::<_, i64>(16)? as u64,
                total_flights: r.get::<_, i64>(23)? as u64,
                block_time_ms: r.get::<_, i64>(17)?.max(0) as u64,
                flight_time_ms: r.get::<_, i64>(18)?.max(0) as u64,
                distance_nm: r.get(19)?,
                landings: r.get::<_, i64>(20)? as u64,
                avg_landing_vs_fpm: r.get(21)?,
                last_flown_ms: r.get::<_, Option<i64>>(22)?.map(|v| v as u64),
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_airframe(&self, registration: &str) -> Result<Option<Airframe>> {
        let Some(reg) = normalize_registration(registration) else { return Ok(None) };
        Ok(self
            .conn()
            .query_row(&format!("SELECT {AIRFRAME_COLS} FROM airframes a WHERE a.registration = ?1"), params![reg], row_to_airframe)
            .optional()?)
    }

    /// The aggregated fleet row of one airframe.
    pub fn get_airframe_row(&self, registration: &str, include_demo: bool) -> Result<Option<AirframeRow>> {
        let Some(reg) = normalize_registration(registration) else { return Ok(None) };
        Ok(self.list_airframes(include_demo)?.into_iter().find(|a| a.airframe.registration == reg))
    }

    /// Manual create/edit. Returns `None` for a registration that fails validation; an
    /// implausible Vapp is refused ([`crate::StoreError::Invalid`]) before anything is written.
    pub fn upsert_airframe(&self, edit: &AirframeEdit, now_ms: u64) -> Result<Option<Airframe>> {
        let Some(reg) = normalize_registration(&edit.registration) else { return Ok(None) };
        // Some(Some(v)) = set, Some(None) = clear, None = leave
        let vapp: Option<Option<f64>> = match edit.vapp_kt {
            None => None,
            Some(v) if !v.is_finite() || v <= 0.0 => Some(None),
            Some(v) if (VAPP_MIN_KT..=VAPP_MAX_KT).contains(&v) => Some(Some(v)),
            Some(v) => {
                return Err(crate::Invalid::VappOutOfRange { value: v, min: VAPP_MIN_KT, max: VAPP_MAX_KT }.into());
            }
        };
        let flaps: Option<Option<i32>> = match edit.landing_flaps {
            None => None,
            Some(v) if v < 0 => Some(None),
            Some(v) if v <= LANDING_FLAPS_MAX => Some(Some(v)),
            Some(v) => return Err(crate::Invalid::FlapsOutOfRange { value: v, max: LANDING_FLAPS_MAX }.into()),
        };
        {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO airframes (registration, created_ms, updated_ms) VALUES (?1, ?2, ?2)
                 ON CONFLICT(registration) DO NOTHING",
                params![reg, now_ms as i64],
            )?;
            let set = |col: &str, v: &Option<String>| -> Result<()> {
                if let Some(v) = v {
                    let mut v = v.trim().to_string();
                    if col == "icao_type" {
                        v = v.to_uppercase();
                    }
                    conn.execute(
                        &format!("UPDATE airframes SET {col} = ?2, updated_ms = ?3 WHERE registration = ?1"),
                        params![reg, non_empty(&v), now_ms as i64],
                    )?;
                }
                Ok(())
            };
            set("icao_type", &edit.icao_type)?;
            set("title", &edit.title)?;
            set("airline", &edit.airline)?;
            set("custom_name", &edit.custom_name)?;
            set("notes", &edit.notes)?;
            if let Some(v) = vapp {
                let before: Option<f64> = conn.query_row("SELECT vapp_kt FROM airframes WHERE registration = ?1", params![reg], |r| r.get(0))?;
                if before != v {
                    conn.execute("UPDATE airframes SET vapp_kt = ?2, updated_ms = ?3 WHERE registration = ?1", params![reg, v, now_ms as i64])?;
                    // the cached approach facts were assessed against the old reference: recomputed lazily
                    conn.execute(
                        "DELETE FROM approach_facts WHERE flight_id IN (SELECT id FROM flights WHERE airframe_reg = ?1)",
                        params![reg],
                    )?;
                    conn.execute(
                        "DELETE FROM flight_metrics WHERE flight_id IN (SELECT id FROM flights WHERE airframe_reg = ?1)",
                        params![reg],
                    )?;
                }
            }
            if let Some(v) = flaps {
                let before: Option<i32> = conn.query_row("SELECT landing_flaps FROM airframes WHERE registration = ?1", params![reg], |r| r.get(0))?;
                if before != v {
                    conn.execute("UPDATE airframes SET landing_flaps = ?2, updated_ms = ?3 WHERE registration = ?1", params![reg, v, now_ms as i64])?;
                    // same as the Vapp: the gate checks change
                    conn.execute(
                        "DELETE FROM approach_facts WHERE flight_id IN (SELECT id FROM flights WHERE airframe_reg = ?1)",
                        params![reg],
                    )?;
                    conn.execute(
                        "DELETE FROM flight_metrics WHERE flight_id IN (SELECT id FROM flights WHERE airframe_reg = ?1)",
                        params![reg],
                    )?;
                }
            }
        }
        self.get_airframe(&reg)
    }

    /// The registration the recorder would book a flight onto (OFP, else a registration-like
    /// ATC ID), ignoring any correction or manual booking.
    pub(crate) fn original_flight_registration(&self, flight_id: &str) -> Result<Option<String>> {
        let conn = self.conn();
        let facts = conn.query_row(&format!("{FLIGHT_FACTS_SQL} WHERE id = ?1"), params![flight_id], row_to_facts).optional()?;
        Ok(facts.and_then(|f| {
            let (ofp_reg, _) = f.hint();
            resolve_registration(ofp_reg.as_deref(), f.atc_id.as_deref())
        }))
    }

    /// Manually (re)book a flight; `None` removes it from any airframe. Errors on an invalid registration.
    pub fn set_flight_airframe(&self, flight_id: &str, registration: Option<&str>, now_ms: u64) -> Result<bool> {
        let conn = self.conn();
        let Some(raw) = registration.filter(|r| !r.trim().is_empty()) else {
            return Ok(conn.execute(
                "UPDATE flights SET airframe_reg = NULL, updated_ms = MAX(updated_ms, ?2) WHERE id = ?1",
                params![flight_id, now_ms as i64],
            )? > 0);
        };
        let reg = normalize_registration(raw).ok_or_else(|| crate::StoreError::from(crate::Invalid::InvalidRegistration { registration: raw.to_string() }))?;
        let facts = conn.query_row(&format!("{FLIGHT_FACTS_SQL} WHERE id = ?1"), params![flight_id], row_to_facts).optional()?;
        let Some(facts) = facts else { return Ok(false) };
        // A new airframe takes its type from the flight; an existing one keeps its own.
        let (_, hint) = facts.hint();
        upsert_from_hint(&conn, &reg, &hint, now_ms)?;
        // bumping updated_ms lets open views reload the flight
        Ok(conn.execute(
            "UPDATE flights SET airframe_reg = ?2, updated_ms = MAX(updated_ms, ?3) WHERE id = ?1",
            params![flight_id, reg, now_ms as i64],
        )? > 0)
    }

    /// Move all flights of `from` onto `into` and delete `from`. `into` keeps its own
    /// facts and only fills gaps from `from` (type, title, airline, name, notes); its photo stays its own.
    pub fn merge_airframes(&self, from: &str, into: &str, now_ms: u64) -> Result<Option<Airframe>> {
        let (Some(from), Some(into)) = (normalize_registration(from), normalize_registration(into)) else { return Ok(None) };
        if from == into {
            return self.get_airframe(&into);
        }
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let exists: bool =
                tx.query_row("SELECT COUNT(*) FROM airframes WHERE registration = ?1", params![from], |r| r.get::<_, i64>(0))? > 0;
            if !exists {
                return Ok(None);
            }
            tx.execute(
                "INSERT INTO airframes (registration, created_ms, updated_ms)
                 SELECT ?2, created_ms, ?3 FROM airframes WHERE registration = ?1
                 ON CONFLICT(registration) DO NOTHING",
                params![from, into, now_ms as i64],
            )?;
            tx.execute(
                "UPDATE airframes SET
                    icao_type = COALESCE(icao_type, (SELECT icao_type FROM airframes WHERE registration = ?1)),
                    title = COALESCE(title, (SELECT title FROM airframes WHERE registration = ?1)),
                    airline = COALESCE(airline, (SELECT airline FROM airframes WHERE registration = ?1)),
                    custom_name = COALESCE(custom_name, (SELECT custom_name FROM airframes WHERE registration = ?1)),
                    notes = COALESCE(notes, (SELECT notes FROM airframes WHERE registration = ?1)),
                    vapp_kt = COALESCE(vapp_kt, (SELECT vapp_kt FROM airframes WHERE registration = ?1)),
                    landing_flaps = COALESCE(landing_flaps, (SELECT landing_flaps FROM airframes WHERE registration = ?1)),
                    created_ms = MIN(created_ms, (SELECT created_ms FROM airframes WHERE registration = ?1)),
                    updated_ms = ?3
                 WHERE registration = ?2",
                params![from, into, now_ms as i64],
            )?;
            tx.execute(
                "UPDATE flights SET airframe_reg = ?2, updated_ms = MAX(updated_ms, ?3) WHERE airframe_reg = ?1",
                params![from, into, now_ms as i64],
            )?;
            tx.execute("DELETE FROM airframes WHERE registration = ?1", params![from])?;
            tx.commit()?;
        }
        self.get_airframe(&into)
    }

    /// Delete an airframe; its flights stay in the logbook, unbooked.
    pub fn delete_airframe(&self, registration: &str) -> Result<bool> {
        let Some(reg) = normalize_registration(registration) else { return Ok(false) };
        let conn = self.conn();
        conn.execute(
            "UPDATE flights SET airframe_reg = NULL, updated_ms = MAX(updated_ms, ?2) WHERE airframe_reg = ?1",
            params![reg, crate::now_ms_i64()],
        )?;
        Ok(conn.execute("DELETE FROM airframes WHERE registration = ?1", params![reg])? > 0)
    }

    /// Record a photo lookup: `Some` stores the photo, `None` stores a miss.
    pub fn set_airframe_photo(&self, registration: &str, photo: Option<&AirframePhoto>, now_ms: u64) -> Result<Option<Airframe>> {
        let Some(reg) = normalize_registration(registration) else { return Ok(None) };
        {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO airframes (registration, created_ms, updated_ms) VALUES (?1, ?2, ?2)
                 ON CONFLICT(registration) DO NOTHING",
                params![reg, now_ms as i64],
            )?;
            match photo {
                Some(p) => conn.execute(
                    "UPDATE airframes SET image_url = ?2, image_thumb_url = ?3, image_credit = ?4, image_link = ?5,
                        image_source = ?6, image_fetched_ms = ?7, updated_ms = ?7 WHERE registration = ?1",
                    params![reg, p.url, non_empty(&p.thumb_url), non_empty(&p.credit), non_empty(&p.link), p.source, now_ms as i64],
                )?,
                None => conn.execute(
                    "UPDATE airframes SET image_url = NULL, image_thumb_url = NULL, image_credit = NULL, image_link = NULL,
                        image_source = 'none', image_fetched_ms = ?2, updated_ms = ?2 WHERE registration = ?1",
                    params![reg, now_ms as i64],
                )?,
            };
        }
        self.get_airframe(&reg)
    }

    /// The Vapp (KIAS) of the airframe a flight is booked onto, if the pilot entered one.
    pub fn flight_vapp_kt(&self, flight_id: &str) -> Result<Option<f64>> {
        Ok(self.flight_airframe_refs(flight_id)?.0)
    }

    /// Vapp (KIAS) and landing flap index of the airframe a flight is booked onto, as far as
    /// the pilot entered them.
    pub fn flight_airframe_refs(&self, flight_id: &str) -> Result<(Option<f64>, Option<i32>)> {
        Ok(self
            .conn()
            .query_row(
                "SELECT a.vapp_kt, a.landing_flaps FROM flights f JOIN airframes a ON a.registration = f.airframe_reg WHERE f.id = ?1",
                params![flight_id],
                |r| Ok((r.get::<_, Option<f64>>(0)?, r.get::<_, Option<i32>>(1)?)),
            )
            .optional()?
            .unwrap_or_default())
    }

    /// Flights booked onto an airframe, newest first.
    pub fn airframe_flights(&self, registration: &str, limit: u32) -> Result<Vec<crate::FlightRow>> {
        let Some(reg) = normalize_registration(registration) else { return Ok(Vec::new()) };
        self.list_flights_where("f.airframe_reg = ?1", &reg, limit)
    }
}
