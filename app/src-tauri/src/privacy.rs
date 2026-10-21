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
/// `_`/`-` part of it) that is one of them becomes `***` – in any case and whatever the dashes:
/// words are compared without `-`/`_`, so `D-AIBL` in the list also hides `DAIBL`, `d_aibl`, and
/// `DAIBL` in the list (an MSFS ATC ID) also hides `D-AIBL`. Two words with one space between
/// them are tried as one (`D AIBL`, `DLH 4AB`). Linear in the text: a run of `-`-parts is
/// at most [`Redactor::max_parts`] long (4000 dashes took 55 s when every run was tried).
/// IATA forms of a callsign (`LH4AB` for `DLH4AB`) are not derived (no airline table here).
#[derive(Debug, Default, Clone)]
pub struct Redactor {
    words: std::collections::HashSet<String>,
    /// Most `-`-parts a hit can span: the most parts of a list entry, plus one for a dash a
    /// dashless entry may have in the text (`DAIBL` → `D-AIBL`).
    max_parts: usize,
}

/// Comparison key: upper case, without `-` and `_`.
fn redact_key(w: &str) -> String {
    w.chars().filter(|&c| c != '-' && c != '_').map(|c| c.to_ascii_uppercase()).collect()
}

impl Redactor {
    pub fn new<I: IntoIterator<Item = S>, S: AsRef<str>>(words: I) -> Self {
        let mut set = std::collections::HashSet::new();
        let mut max_parts = 0;
        for w in words {
            // a list entry with spaces or `_` (`D AIBL`) counts like the dashed form
            let w = w.as_ref().trim().replace([' ', '_'], "-");
            if !w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                continue;
            }
            let key = redact_key(&w);
            // shorter values (or pure numbers like a flight number) would hit ordinary words
            if key.len() < 3 || !key.chars().any(|c| c.is_ascii_alphabetic()) {
                continue;
            }
            max_parts = max_parts.max(w.split('-').filter(|p| !p.is_empty()).count() + 1);
            set.insert(key);
        }
        Redactor { words: set, max_parts }
    }

    fn hit(&self, w: &str) -> bool {
        !w.is_empty() && self.words.contains(&redact_key(w))
    }

    /// One word: whole, else each `_`-part, else the longest runs of `-`-parts that are a hit
    /// (`X-D-AIBL` → `X-***`). A run has at most `max_parts` non-empty parts.
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
            let mut key = String::new();
            while i < parts.len() {
                if i > 0 {
                    out.push('-');
                }
                // the longest hit among parts[i..=j], j < i + max_parts, built up part by part
                key.clear();
                let mut best = None;
                for (j, part) in parts.iter().enumerate().skip(i).take(self.max_parts) {
                    if part.is_empty() {
                        break;
                    }
                    key.extend(part.chars().map(|c| c.to_ascii_uppercase()));
                    if self.words.contains(&key) {
                        best = Some(j);
                    }
                }
                match best {
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
        // the words, as byte ranges
        let mut spans: Vec<(usize, usize)> = Vec::new();
        let mut start: Option<usize> = None;
        for (i, c) in text.char_indices() {
            match (is_word(c), start) {
                (true, None) => start = Some(i),
                (false, Some(s)) => {
                    spans.push((s, i));
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(s) = start {
            spans.push((s, text.len()));
        }
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        let mut k = 0;
        while k < spans.len() {
            let (s, e) = spans[k];
            out.push_str(&text[copied..s]);
            // `D AIBL`: this word, one space and the next word as one
            if let Some(&(s2, e2)) = spans.get(k + 1)
                && s2 == e + 1
                && text.as_bytes()[e] == b' '
                && !self.hit(&text[s..e])
                && !self.hit(&text[s2..e2])
                && self.words.contains(&(redact_key(&text[s..e]) + &redact_key(&text[s2..e2])))
            {
                out.push_str("***");
                copied = e2;
                k += 2;
                continue;
            }
            self.mask_word(&text[s..e], &mut out);
            copied = e;
            k += 1;
        }
        out.push_str(&text[copied..]);
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
/// also creates it and opens it in the Explorer (Settings → Display → “Open”).
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
    fn redactor_finds_every_spelling() {
        // stored without the dash (MSFS ATC ID), written with it in a log – and the other way round
        let r = Redactor::new(["DAIBL", "N-12345", "dlh4ab"]);
        assert_eq!(r.mask("planespotters D-AIBL: ok, d-aibl, DAIBL, d_aibl"), "planespotters ***: ok, ***, ***, ***");
        assert_eq!(r.mask("N12345 n-12345 X-N12345"), "*** *** X-***");
        // spaced forms
        assert_eq!(r.mask("reg D AIBL, cs DLH 4AB, N 12345."), "reg ***, cs ***, ***.");
        assert_eq!(r.mask("D  AIBL"), "D  AIBL", "two spaces are two words");
        // lower case and mixed dashes
        assert_eq!(r.mask("ofp dlh4ab / Dlh4Ab"), "ofp *** / ***");
        // list entries with spaces or underscores count like the dashed form
        assert_eq!(Redactor::new(["D AIBL"]).mask("D-AIBL DAIBL"), "*** ***");
        // ordinary words and parts of words stay
        assert_eq!(r.mask("D AIBLX DAIBLE a b c 12345"), "D AIBLX DAIBLE a b c 12345");
        // the text around is copied as is, also non-ASCII
        assert_eq!(r.mask("Jörg: D AIBL → ok"), "Jörg: *** → ok");
    }

    #[test]
    fn redactor_is_linear_on_long_dash_words() {
        // 4000 dashes once took 55 s (cubic in the number of parts)
        let r = Redactor::new(["D-AIBL", "DLH4AB", "N-123-AB"]);
        let dashes = "-".repeat(4000);
        let a_dash = "a-".repeat(4000);
        let mixed = "D-AIBL-".repeat(2000);
        for text in [dashes.as_str(), a_dash.as_str(), mixed.as_str()] {
            // the best of five runs, so a busy machine (parallel tests, a debug build) does not fail it
            let (took, out) = (0..5)
                .map(|_| {
                    let started = std::time::Instant::now();
                    let out = r.mask(text);
                    (started.elapsed(), out)
                })
                .min_by_key(|(t, _)| *t)
                .unwrap();
            assert!(took < std::time::Duration::from_millis(50), "{} chars took {took:?}", text.len());
            assert!(!out.contains("D-AIBL") && !out.contains("AIBL"), "hits inside long words are still found");
        }
        assert_eq!(r.mask(&dashes), dashes);
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
