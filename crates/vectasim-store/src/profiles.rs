//! Approach assessment profiles in the store (`vectasim_core::approach_profile`): the pilot's
//! custom profiles (setting `approach.custom_profiles`, a JSON array of profiles – they are
//! settings, not logbook data, and stay out of the `.vectasim` export like every setting) and
//! what a flight's profile is resolved from (the airframe's choice, its ICAO type).
//!
//! Importing a profile again with the same id replaces it; replacing or deleting one drops the
//! cached approach facts and flight metrics assessed with it, so they are recomputed lazily
//! (the same way a Vapp change does). Deleting also puts airframes that used it back on
//! "automatic".

use crate::airframe::{icao_from_atc_model, ofp_facts};
use crate::{Invalid, Result, Store};
use rusqlite::{OptionalExtension, params};
use vectasim_core::approach_profile::{
    self, ApproachProfile, CUSTOM_MAX, CUSTOM_MAX_BYTES, CustomProfileDoc, EngineClass, ProfileError, ProfileOrigin,
};

const SETTING_KEY: &str = "approach.custom_profiles";

/// What a flight's profile is resolved from, as far as the logbook knows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileInputs {
    /// `airframes.approach_profile` of the airframe the flight is booked onto.
    pub airframe_choice: Option<String>,
    /// The airframe's ICAO type, else the sim's ATC model, else the OFP's type.
    pub icao_type: Option<String>,
}

fn invalid(cause: ProfileError) -> crate::StoreError {
    Invalid::ApproachProfileInvalid { cause }.into()
}

/// Parse and check an import file (`docs/approach-profiles.md`).
pub fn parse_custom_profile(json: &str) -> Result<ApproachProfile> {
    if json.len() > CUSTOM_MAX_BYTES {
        return Err(invalid(ProfileError::TooLarge { max_bytes: CUSTOM_MAX_BYTES }));
    }
    let doc: CustomProfileDoc =
        serde_json::from_str(json.trim_start_matches('\u{feff}')).map_err(|e| invalid(ProfileError::Format { detail: e.to_string() }))?;
    approach_profile::validate(doc).map_err(invalid)
}

impl Store {
    /// The pilot's custom profiles, in import order. Entries that no longer pass the
    /// validation (edited by hand) are left out with a warning.
    pub fn custom_approach_profiles(&self) -> Result<Vec<ApproachProfile>> {
        let Some(raw) = self.get_setting(SETTING_KEY)? else { return Ok(Vec::new()) };
        let list: Vec<ApproachProfile> = serde_json::from_str(&raw).unwrap_or_else(|e| {
            log::warn!("approach profiles: setting {SETTING_KEY} unreadable: {e}");
            Vec::new()
        });
        Ok(list
            .into_iter()
            .filter_map(|p| {
                let doc =
                    CustomProfileDoc { id: p.id.clone(), name: p.name, based_on: p.based_on, source: p.source, overrides: p.overrides };
                approach_profile::validate(doc).inspect_err(|e| log::warn!("approach profile {} dropped: {e}", p.id)).ok()
            })
            .collect())
    }

    fn put_custom_approach_profiles(&self, list: &[ApproachProfile]) -> Result<()> {
        self.set_setting(SETTING_KEY, &serde_json::to_string(list)?)
    }

    /// A built-in id or one of the custom profiles.
    pub fn approach_profile_exists(&self, id: &str) -> Result<bool> {
        Ok(approach_profile::is_builtin(id) || self.custom_approach_profiles()?.iter().any(|p| p.id == id))
    }

    /// Import a custom profile from its JSON file. Returns it and whether it replaced one with
    /// the same id (whose cached results are then recomputed).
    pub fn import_approach_profile(&self, json: &str) -> Result<(ApproachProfile, bool)> {
        let p = parse_custom_profile(json)?;
        let mut list = self.custom_approach_profiles()?;
        let replaced = if let Some(slot) = list.iter_mut().find(|x| x.id == p.id) {
            *slot = p.clone();
            true
        } else {
            if list.len() >= CUSTOM_MAX {
                return Err(invalid(ProfileError::TooMany { max: CUSTOM_MAX }));
            }
            list.push(p.clone());
            false
        };
        self.put_custom_approach_profiles(&list)?;
        if replaced {
            self.invalidate_profile_results(&p.id)?;
        }
        Ok((p, replaced))
    }

    /// Delete a custom profile; airframes that used it go back to automatic. False when there
    /// was none with this id (built-ins cannot be deleted: [`Invalid::ApproachProfileUnknown`]).
    pub fn delete_approach_profile(&self, id: &str) -> Result<bool> {
        if approach_profile::is_builtin(id) {
            return Err(Invalid::ApproachProfileUnknown { id: id.to_string() }.into());
        }
        let mut list = self.custom_approach_profiles()?;
        let before = list.len();
        list.retain(|p| p.id != id);
        if list.len() == before {
            return Ok(false);
        }
        self.put_custom_approach_profiles(&list)?;
        {
            let conn = self.conn();
            conn.execute(
                "DELETE FROM approach_facts WHERE flight_id IN (SELECT f.id FROM flights f JOIN airframes a ON a.registration = f.airframe_reg
                    WHERE a.approach_profile = ?1)",
                params![id],
            )?;
            conn.execute(
                "DELETE FROM flight_metrics WHERE flight_id IN (SELECT f.id FROM flights f JOIN airframes a ON a.registration = f.airframe_reg
                    WHERE a.approach_profile = ?1)",
                params![id],
            )?;
            conn.execute(
                "UPDATE airframes SET approach_profile = NULL, updated_ms = ?2 WHERE approach_profile = ?1",
                params![id, crate::now_ms_i64()],
            )?;
        }
        self.invalidate_profile_results(id)?;
        Ok(true)
    }

    /// Drop the cached approach facts and metrics assessed with profile `id`.
    fn invalidate_profile_results(&self, id: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM approach_facts WHERE flight_id IN (SELECT flight_id FROM approach_facts WHERE profile_id = ?1)",
            params![id],
        )?;
        conn.execute("DELETE FROM flight_metrics WHERE approach_profile = ?1", params![id])?;
        Ok(())
    }

    /// What the logbook knows for a flight's profile (empty for an unknown flight).
    pub fn flight_profile_inputs(&self, flight_id: &str) -> Result<ProfileInputs> {
        let row = self
            .conn()
            .query_row(
                "SELECT a.approach_profile, a.icao_type, f.atc_model, f.ofp_json
                 FROM flights f LEFT JOIN airframes a ON a.registration = f.airframe_reg WHERE f.id = ?1",
                params![flight_id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((choice, airframe_type, atc_model, ofp_json)) = row else { return Ok(ProfileInputs::default()) };
        let non_empty = |s: Option<String>| s.map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
        let icao_type = non_empty(airframe_type)
            .or_else(|| atc_model.as_deref().and_then(icao_from_atc_model))
            .or_else(|| non_empty(ofp_json.as_deref().map(|j| ofp_facts(j).1.icao_type)));
        Ok(ProfileInputs { airframe_choice: choice.filter(|s| !s.trim().is_empty()), icao_type })
    }

    /// The profile a flight is assessed with: airframe choice → ICAO type → `engine` (what the
    /// app could tell from the recording) → generic.
    pub fn resolve_flight_profile(
        &self,
        flight_id: &str,
        engine: Option<EngineClass>,
        engine_count: Option<u32>,
    ) -> Result<(ApproachProfile, ProfileOrigin)> {
        let inputs = self.flight_profile_inputs(flight_id)?;
        let custom = self.custom_approach_profiles()?;
        Ok(approach_profile::resolve(inputs.airframe_choice.as_deref(), inputs.icao_type.as_deref(), engine, engine_count, &custom))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY_VA: &str = r#"{ "id": "my-va", "name": "My VA SOP", "basedOn": "airbus", "source": "SOP 4.2",
        "overrides": { "gateSpeedAboveKt": 8, "thrustCheck": false } }"#;

    #[test]
    fn import_replace_and_delete() {
        let store = Store::open_in_memory().unwrap();
        let (p, replaced) = store.import_approach_profile(MY_VA).unwrap();
        assert!(!replaced);
        assert_eq!((p.id.as_str(), p.based_on.as_deref(), p.builtin), ("my-va", Some("airbus"), false));
        let c = p.config();
        assert_eq!((c.gate_speed_above_kt, c.thrust_check, c.profile_id.as_str()), (8.0, false, "my-va"));
        assert!(store.approach_profile_exists("my-va").unwrap() && store.approach_profile_exists("airbus").unwrap());
        assert!(!store.approach_profile_exists("nope").unwrap());
        let (_, replaced) = store.import_approach_profile(&MY_VA.replace("My VA SOP", "My VA SOP 2")).unwrap();
        assert!(replaced);
        let list = store.custom_approach_profiles().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "My VA SOP 2");
        assert!(store.delete_approach_profile("my-va").unwrap());
        assert!(!store.delete_approach_profile("my-va").unwrap());
        assert!(store.delete_approach_profile("airbus").is_err());
        assert!(store.custom_approach_profiles().unwrap().is_empty());
    }

    #[test]
    fn import_refuses_bad_files_with_a_reason() {
        let store = Store::open_in_memory().unwrap();
        let code = |json: &str| match store.import_approach_profile(json).unwrap_err() {
            crate::StoreError::Invalid(Invalid::ApproachProfileInvalid { cause }) => cause.code(),
            e => panic!("{e}"),
        };
        assert_eq!(code("not json"), "format");
        assert_eq!(code(r#"{ "id": "my-va", "name": "x", "extra": 1 }"#), "format");
        assert_eq!(code(r#"{ "id": "my-va", "name": "x", "overrides": { "glidepathDeg": 3 } }"#), "unknownKey");
        assert_eq!(code(r#"{ "id": "my-va", "name": "x", "overrides": { "hardGateFt": 20 } }"#), "outOfRange");
        assert_eq!(code(r#"{ "id": "generic", "name": "x" }"#), "idReserved");
        assert_eq!(code(r#"{ "id": "My VA", "name": "x" }"#), "idInvalid");
        assert_eq!(code(&format!(r#"{{ "id": "my-va", "name": "x", "source": "{}" }}"#, "a".repeat(20_000))), "tooLarge");
        assert!(store.custom_approach_profiles().unwrap().is_empty());
    }
}
