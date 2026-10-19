//! PIREP export: the UI builds the `pirep/v1` JSON (app/src/pirep.ts) and this module only
//! writes it to the path from the save dialog, with the same path check as `save_export`.

use crate::data;

/// Generous upper bound: a PIREP is a few kB; anything larger is not one of ours.
const MAX_PIREP_BYTES: usize = 256 * 1024;
const SCHEMA: &str = "pirep/v1";

/// The document as it will be written: valid JSON, an object with `"schema": "pirep/v1"`.
fn validate(json: &str) -> Result<String, String> {
    if json.len() > MAX_PIREP_BYTES {
        let kb = json.len() / 1024;
        return Err(trf!("PIREP zu groß ({kb} kB)", "PIREP too large ({kb} kB)"));
    }
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| trf!("PIREP ist kein gültiges JSON: {e}", "PIREP is not valid JSON: {e}"))?;
    match v.get("schema").and_then(|s| s.as_str()) {
        Some(SCHEMA) => {}
        other => {
            let found = other.unwrap_or(crate::lang::tr("fehlt", "missing"));
            return Err(trf!("PIREP-Schema {found} nicht unterstützt (erwartet {SCHEMA})", "PIREP schema {found} not supported (expected {SCHEMA})"));
        }
    }
    // written as the UI formatted it (key order kept), with one trailing newline
    let mut out = json.trim_end().to_owned();
    out.push('\n');
    Ok(out)
}

/// PIREP (JSON from the UI) written to the path from the save dialog; only `.json`.
#[tauri::command]
pub async fn save_pirep_json(path: String, json: String) -> Result<(), String> {
    let target = data::allowed_target(&path, &["json"])?;
    let body = validate(&json)?;
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, body).map_err(|e| format!("{}: {e}", target.display())))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_pirep_as_written() {
        let json = "{\n  \"schema\": \"pirep/v1\",\n  \"callsign\": \"DLH4YA\",\n  \"aircraft\": {}\n}";
        assert_eq!(validate(json).unwrap(), format!("{json}\n"));
        assert_eq!(validate("{\"schema\":\"pirep/v1\"}\n\n").unwrap(), "{\"schema\":\"pirep/v1\"}\n");
    }

    #[test]
    fn rejects_other_documents() {
        assert!(validate("not json").unwrap_err().contains("kein gültiges JSON"));
        assert!(validate(r#"{"schema":"pirep/v2"}"#).unwrap_err().contains("pirep/v2"));
        assert!(validate(r#"{"callsign":"X"}"#).unwrap_err().contains("fehlt"));
        assert!(validate(r#"["schema"]"#).is_err());
        let big = format!(r#"{{"schema":"pirep/v1","pad":"{}"}}"#, "x".repeat(MAX_PIREP_BYTES));
        assert!(validate(&big).unwrap_err().contains("zu groß"));
    }

    #[test]
    fn path_check_is_the_export_one() {
        let forbidden = [std::path::PathBuf::from(if cfg!(windows) { r"C:\Windows" } else { "/usr" })];
        let ok = if cfg!(windows) { r"C:\Users\pilot\pirep.json" } else { "/home/pilot/pirep.json" };
        assert!(data::check_path(ok, &["json"], &forbidden).is_ok());
        let wrong_ext = if cfg!(windows) { r"C:\Users\pilot\pirep.exe" } else { "/home/pilot/pirep.exe" };
        assert!(data::check_path(wrong_ext, &["json"], &forbidden).is_err());
        assert!(data::check_path("pirep.json", &["json"], &forbidden).is_err());
        let sys = if cfg!(windows) { r"C:\Windows\pirep.json" } else { "/usr/pirep.json" };
        assert!(data::check_path(sys, &["json"], &forbidden).is_err());
    }
}
