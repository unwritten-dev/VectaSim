//! Streamer-/Datenschutzmodus and the folder for automatically saved landing cards.
//!
//! The Streamer-Modus (`privacy_mode` = "1") is display-only in the UI (format.ts → privacy);
//! on this side it only changes the Diagnosepaket: paths there lose the Windows user name
//! ([`mask_user_paths`], same rule as format.ts → maskPath). The landing card folder
//! (`card_dir`, default `Bilder\VectaSim`) is where exportCard.ts → autoSaveCard writes its PNG
//! through `save_image`.

use crate::data;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use vectasim_store::Store;

pub const SETTING_PRIVACY_MODE: &str = "privacy_mode";
pub const SETTING_CARD_DIR: &str = "card_dir";

/// Streamer-Modus on?
pub fn privacy_mode_on(store: &Store) -> bool {
    store.get_setting(SETTING_PRIVACY_MODE).ok().flatten().as_deref() == Some("1")
}

/// Length of a path separator at `i`: `\\` (Debug-formatted paths), `\` or `/`.
fn sep_at(b: &[u8], i: usize) -> Option<usize> {
    match b.get(i) {
        Some(b'\\') if b.get(i + 1) == Some(&b'\\') => Some(2),
        Some(b'\\') | Some(b'/') => Some(1),
        _ => None,
    }
}

fn starts_with_ci(b: &[u8], i: usize, word: &str) -> bool {
    b.get(i..i + word.len()).is_some_and(|s| s.eq_ignore_ascii_case(word.as_bytes()))
}

/// Characters that end the user-name segment (separators, characters Windows forbids, line ends).
fn ends_name(c: u8) -> bool {
    matches!(c, b'\\' | b'/' | b':' | b'*' | b'?' | b'"' | b'<' | b'>' | b'|' | b'\r' | b'\n')
}

/// Removes the Windows user name from every path in `text`:
/// `C:\Users\Max\AppData\Local\…` → `%LOCALAPPDATA%\…`, `…\AppData\Roaming\…` → `%APPDATA%\…`,
/// any other `C:\Users\Max\…` → `%USERPROFILE%\…`. Works inside longer text (log lines) and
/// with `/` or doubled `\\` separators.
pub fn mask_user_paths(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0usize, 0usize);
    while i + 3 < b.len() {
        let hit = (|| {
            if !b[i].is_ascii_alphabetic() || b[i + 1] != b':' || (i > 0 && b[i - 1].is_ascii_alphanumeric()) {
                return None;
            }
            let s = sep_at(b, i + 2)?;
            let mut j = i + 2 + s;
            if !starts_with_ci(b, j, "users") {
                return None;
            }
            j += 5;
            if sep_at(b, j)? != s {
                return None;
            }
            j += s;
            let name_start = j;
            while j < b.len() && !ends_name(b[j]) {
                j += 1;
            }
            if j == name_start {
                return None;
            }
            // optional \AppData\Local or \AppData\Roaming (not LocalLow)
            if sep_at(b, j) == Some(s) && starts_with_ci(b, j + s, "appdata") && sep_at(b, j + s + 7) == Some(s) {
                let k = j + 2 * s + 7;
                let boundary = |e: usize| e >= b.len() || matches!(b[e], b'\\' | b'/' | b'"' | b'\'' | b')' | b' ' | b'\t' | b'\r' | b'\n');
                if starts_with_ci(b, k, "local") && boundary(k + 5) {
                    return Some((k + 5, "%LOCALAPPDATA%"));
                }
                if starts_with_ci(b, k, "roaming") && boundary(k + 7) {
                    return Some((k + 7, "%APPDATA%"));
                }
            }
            Some((j, "%USERPROFILE%"))
        })();
        match hit {
            Some((end, repl)) => {
                out.push_str(&text[copied..i]);
                out.push_str(repl);
                i = end;
                copied = end;
            }
            None => i += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// [`mask_user_paths`] on every string (keys stay) of a JSON value.
pub fn mask_json(v: &mut Value) {
    match v {
        Value::String(s) => {
            let m = mask_user_paths(s);
            if m != *s {
                *s = m;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(mask_json),
        Value::Object(o) => o.values_mut().for_each(mask_json),
        _ => {}
    }
}

// ---- Kennungen ausblenden (Diagnosepaket im Streamer-Modus) ---------------------------------

/// Registrations and callsigns to hide from a text: every word of `[A-Za-z0-9_-]` (and each
/// `_`/`-` part of it) that is one of them, in any case and with `_` for `-` or no dash at all
/// (`D-AIBL`, `d_aibl`, `DAIBL`), becomes `***`. Linear in the text, whatever the number of words.
#[derive(Debug, Default, Clone)]
pub struct Redactor {
    words: std::collections::HashSet<String>,
}

fn redact_key(w: &str) -> String {
    w.to_ascii_uppercase().replace('_', "-")
}

impl Redactor {
    pub fn new<I: IntoIterator<Item = S>, S: AsRef<str>>(words: I) -> Self {
        let mut set = std::collections::HashSet::new();
        for w in words {
            let w = redact_key(w.as_ref().trim());
            // shorter values (or pure numbers like a flight number) would hit ordinary words
            if w.len() < 3 || !w.chars().any(|c| c.is_ascii_alphabetic()) || !w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                continue;
            }
            if w.contains('-') {
                set.insert(w.replace('-', ""));
            }
            set.insert(w);
        }
        Redactor { words: set }
    }

    fn hit(&self, w: &str) -> bool {
        !w.is_empty() && self.words.contains(&redact_key(w))
    }

    /// One word: whole, else each `_`-part, else the longest runs of `-`-parts that are a hit
    /// (`X-D-AIBL` → `X-***`).
    fn mask_word(&self, w: &str, out: &mut String) {
        if self.hit(w) {
            out.push_str("***");
        } else if w.contains('_') {
            for (i, p) in w.split('_').enumerate() {
                if i > 0 {
                    out.push('_');
                }
                self.mask_word(p, out);
            }
        } else if w.contains('-') {
            let parts: Vec<&str> = w.split('-').collect();
            let mut i = 0;
            while i < parts.len() {
                if i > 0 {
                    out.push('-');
                }
                match (i..parts.len()).rev().find(|&j| self.hit(&parts[i..=j].join("-"))) {
                    Some(j) => {
                        out.push_str("***");
                        i = j + 1;
                    }
                    None => {
                        out.push_str(parts[i]);
                        i += 1;
                    }
                }
            }
        } else {
            out.push_str(w);
        }
    }

    pub fn mask(&self, text: &str) -> String {
        if self.words.is_empty() {
            return text.to_string();
        }
        let is_word = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        let mut out = String::with_capacity(text.len());
        let mut start: Option<usize> = None;
        for (i, c) in text.char_indices() {
            match (is_word(c), start) {
                (true, None) => start = Some(i),
                (false, Some(s)) => {
                    self.mask_word(&text[s..i], &mut out);
                    start = None;
                    out.push(c);
                }
                (false, None) => out.push(c),
                (true, Some(_)) => {}
            }
        }
        if let Some(s) = start {
            self.mask_word(&text[s..], &mut out);
        }
        out
    }

    /// [`Redactor::mask`] on every string (keys stay) of a JSON value.
    pub fn mask_json(&self, v: &mut Value) {
        match v {
            Value::String(s) => {
                let m = self.mask(s);
                if m != *s {
                    *s = m;
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|x| self.mask_json(x)),
            Value::Object(o) => o.values_mut().for_each(|x| self.mask_json(x)),
            _ => {}
        }
    }
}

/// Fields that name the aircraft or the flight (title, ATC ID, airline, callsign, registration):
/// non-empty strings under these keys become `***`, wherever they are in `v`.
pub fn mask_identity_fields(v: &mut Value) {
    const KEYS: &[&str] = &[
        "title", "aircraft", "aircraftTitle", "aircraft_title", "atcId", "atc_id", "atcAirline", "atc_airline", "atcFlightNumber",
        "atc_flight_number", "callsign", "registration", "airframeReg", "airframe_reg", "airline",
    ];
    match v {
        Value::Array(a) => a.iter_mut().for_each(mask_identity_fields),
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                match x {
                    Value::String(s) if KEYS.contains(&k.as_str()) && !s.trim().is_empty() => *s = "***".into(),
                    _ => mask_identity_fields(x),
                }
            }
        }
        _ => {}
    }
}

// ---- Landekarte automatisch speichern -------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDirInfo {
    /// The folder in use.
    pub dir: String,
    /// `Bilder\VectaSim`.
    pub default_dir: String,
    pub is_default: bool,
}

/// `%USERPROFILE%\Pictures\VectaSim` (the user's „Bilder“ folder).
pub fn default_card_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().picture_dir().map(|d| d.join("VectaSim")).map_err(|e| e.to_string())
}

fn chosen_card_dir(store: &Store) -> Option<String> {
    store.get_setting(SETTING_CARD_DIR).ok().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn card_dir_info(app: &AppHandle, store: &Store) -> Result<CardDirInfo, String> {
    let default = default_card_dir(app)?;
    let chosen = chosen_card_dir(store);
    let dir = chosen.as_ref().map(PathBuf::from).unwrap_or_else(|| default.clone());
    Ok(CardDirInfo { dir: dir.display().to_string(), default_dir: default.display().to_string(), is_default: chosen.is_none() })
}

/// Same rules as [`data::check_path`] for a folder: absolute, without `..`, not inside Windows or
/// the program folders (checked on a probe file name inside it).
fn check_dir(raw: &str, forbidden: &[PathBuf]) -> Result<PathBuf, String> {
    let raw = raw.trim().trim_end_matches(['\\', '/']);
    let probe = Path::new(raw).join("VectaSim_probe.png");
    data::check_path(&probe.to_string_lossy(), data::IMAGE_EXTENSIONS, forbidden).map(|_| PathBuf::from(raw))
}

/// The landing card folder; `create` makes sure it exists (before an automatic save), `open`
/// also creates it and opens it in the Explorer (Einstellungen → Anzeige → „Öffnen“).
#[tauri::command]
pub async fn get_card_dir(create: Option<bool>, open: Option<bool>, app: AppHandle, store: State<'_, Store>) -> Result<CardDirInfo, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let info = card_dir_info(&app, &store)?;
        let open = open.unwrap_or(false);
        if create.unwrap_or(false) || open {
            std::fs::create_dir_all(&info.dir).map_err(|e| format!("{}: {e}", info.dir))?;
        }
        if open {
            app.opener().open_path(info.dir.clone(), None::<&str>).map_err(|e| e.to_string())?;
        }
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Choose (`Some`) or reset to `Bilder\VectaSim` (`None`). The folder must be writable.
#[tauri::command]
pub async fn set_card_dir(path: Option<String>, app: AppHandle, store: State<'_, Store>) -> Result<CardDirInfo, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        let stored = match &path {
            Some(p) => {
                let dir = check_dir(p, &data::forbidden_roots())?;
                std::fs::create_dir_all(&dir).map_err(|e| format!("{p}: {e}"))?;
                let probe = dir.join(".vectasim-write-test");
                std::fs::write(&probe, b"ok").map_err(|e| trf!("Ordner nicht beschreibbar: {p} ({e})", "Folder not writable: {p} ({e})"))?;
                let _ = std::fs::remove_file(probe);
                dir.display().to_string()
            }
            None => String::new(),
        };
        store.set_setting(SETTING_CARD_DIR, &stored).map_err(|e| e.to_string())?;
        log::info!("landing card folder: {}", if stored.is_empty() { "<default>" } else { stored.as_str() });
        card_dir_info(&app, &store)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn masks_user_name_in_paths() {
        assert_eq!(mask_user_paths(r"C:\Users\Max\AppData\Local\io.vectasim.app\logs\vectasim.log"), r"%LOCALAPPDATA%\io.vectasim.app\logs\vectasim.log");
        assert_eq!(mask_user_paths(r"C:\Users\Max Mustermann\AppData\Roaming\io.vectasim.app\vectasim.db"), r"%APPDATA%\io.vectasim.app\vectasim.db");
        assert_eq!(mask_user_paths(r"c:\users\max\Pictures\VectaSim"), r"%USERPROFILE%\Pictures\VectaSim");
        assert_eq!(mask_user_paths(r"C:\Users\Max\AppData\LocalLow\x"), r"%USERPROFILE%\AppData\LocalLow\x");
        assert_eq!(mask_user_paths(r"C:\Users\Max"), "%USERPROFILE%");
        assert_eq!(mask_user_paths("D:/Users/Jörg/AppData/Local/x"), "%LOCALAPPDATA%/x");
        // Debug-formatted paths in log lines
        assert_eq!(mask_user_paths(r#"open "C:\\Users\\Max\\AppData\\Local\\x.vsdump": denied"#), r#"open "%LOCALAPPDATA%\\x.vsdump": denied"#);
        assert_eq!(
            mask_user_paths(r"copy C:\Users\a\x.txt to E:\Users\b\AppData\Roaming"),
            r"copy %USERPROFILE%\x.txt to %APPDATA%"
        );
    }

    #[test]
    fn redactor_hides_registrations_and_callsigns_as_words() {
        let r = Redactor::new(["D-AIBL", "DLH4AB", "12", "123", " "]);
        assert_eq!(r.mask("planespotters D-AIBL: photo found"), "planespotters ***: photo found");
        assert_eq!(r.mask(r"img\D_AIBL.png and daibl, d-aibl"), r"img\***.png and ***, ***");
        assert_eq!(r.mask("SimBrief OFP loaded: DLH4AB EDDF-EGLL"), "SimBrief OFP loaded: *** EDDF-EGLL");
        assert_eq!(r.mask("ring_DLH4AB_x X-D-AIBL-Y"), "ring_***_x X-***-Y");
        assert_eq!(Redactor::new(Vec::<String>::new()).mask("D-AIBL"), "D-AIBL");
        // parts of other words, numbers and too short values stay
        assert_eq!(r.mask("D-AIBLX DAIBLE 123 12 DLH4ABC"), "D-AIBLX DAIBLE 123 12 DLH4ABC");
        let mut v = json!({ "a": ["x D-AIBL y", 1], "b": { "c": "DLH4AB" } });
        r.mask_json(&mut v);
        assert_eq!(v, json!({ "a": ["x *** y", 1], "b": { "c": "***" } }));
    }

    #[test]
    fn identity_fields_are_masked() {
        let mut v = json!({ "recentFlights": [{ "aircraft": "A320 Lufthansa", "dep": "EDDF" }, { "aircraft": null }],
                            "status": { "aircraft": { "title": "T", "atcId": "D-AIBL", "atcModel": "A320", "atcAirline": "" } } });
        mask_identity_fields(&mut v);
        assert_eq!(v, json!({ "recentFlights": [{ "aircraft": "***", "dep": "EDDF" }, { "aircraft": null }],
                              "status": { "aircraft": { "title": "***", "atcId": "***", "atcModel": "A320", "atcAirline": "" } } }));
    }

    #[test]
    fn leaves_other_paths_alone() {
        for s in [r"C:\MSFS SDK\SimConnect.dll", r"C:\Program Files\VectaSim\vectasim.exe", r"C:\Users\", "Users", "", "abc:\\Users\\x"] {
            assert_eq!(mask_user_paths(s), s, "{s}");
        }
    }

    #[test]
    fn masks_every_string_in_json() {
        let mut v = json!({ "path": r"C:\Users\Max\AppData\Roaming\io.vectasim.app\vectasim.db", "n": 3, "list": [r"C:\Users\Max\Desktop"], "o": { "k": "plain" } });
        mask_json(&mut v);
        assert_eq!(v, json!({ "path": r"%APPDATA%\io.vectasim.app\vectasim.db", "n": 3, "list": [r"%USERPROFILE%\Desktop"], "o": { "k": "plain" } }));
    }

    #[test]
    fn card_dir_rules() {
        let forbidden = vec![PathBuf::from(r"C:\Windows")];
        assert!(check_dir(r"C:\Users\Max\Pictures\VectaSim\", &forbidden).is_ok());
        assert!(check_dir(r"relative\dir", &forbidden).is_err());
        assert!(check_dir(r"C:\Users\Max\..\..\Windows", &forbidden).is_err());
        assert!(check_dir(r"C:\Windows\Temp", &forbidden).is_err());
        assert_eq!(check_dir(r" D:\Karten\ ", &forbidden).unwrap(), PathBuf::from(r"D:\Karten"));
    }
}
