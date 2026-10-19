//! Backend language (notifications, tray, Discord, dialogs, overlay default, error messages).
//!
//! The setting `language` (`de` | `en` | `system`, written by the frontend through
//! `set_setting`, default `system`) is read once at start ([`init`]) and again whenever
//! `set_setting("language", …)` runs ([`apply_setting`]); the result is cached in a process-wide
//! atomic, so [`current`] costs nothing and needs no store. `system` (and anything unknown)
//! follows the Windows display language (`GetUserDefaultUILanguage`); neither German nor
//! English → German, the reference language. Before [`init`] (e.g. the dialog when the logbook
//! cannot be opened) the system language applies.

use std::sync::atomic::{AtomicU8, Ordering};
pub use vectasim_core::Lang;
use vectasim_store::{Store, StoreError};

pub const SETTING_LANGUAGE: &str = "language";

/// 0 = not resolved yet, 1 = de, 2 = en.
static CURRENT: AtomicU8 = AtomicU8::new(0);

fn encode(l: Lang) -> u8 {
    match l {
        Lang::De => 1,
        Lang::En => 2,
    }
}

/// The setting's value (`None` = not set) and the system language → the language to use.
pub fn resolve(setting: Option<&str>, system: Option<Lang>) -> Lang {
    setting.and_then(Lang::parse).or(system).unwrap_or(Lang::De)
}

/// Primary language of a Windows LANGID (low 10 bits): 0x07 German, 0x09 English.
pub fn from_langid(id: u16) -> Option<Lang> {
    match id & 0x3ff {
        0x07 => Some(Lang::De),
        0x09 => Some(Lang::En),
        _ => None,
    }
}

#[cfg(windows)]
pub fn system() -> Option<Lang> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }
    // SAFETY: no arguments, no pointers; returns the user's UI language id.
    from_langid(unsafe { GetUserDefaultUILanguage() })
}

#[cfg(not(windows))]
pub fn system() -> Option<Lang> {
    ["LC_ALL", "LC_MESSAGES", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty())).and_then(|v| Lang::from_locale(&v))
}

fn set(l: Lang) {
    CURRENT.store(encode(l), Ordering::Relaxed);
}

/// The backend language right now.
pub fn current() -> Lang {
    match CURRENT.load(Ordering::Relaxed) {
        1 => Lang::De,
        2 => Lang::En,
        _ => {
            // tests compare German texts; the machine's language must not leak in
            let l = if cfg!(test) { Lang::De } else { resolve(None, system()) };
            set(l);
            l
        }
    }
}

/// Reads the setting from the store (start).
pub fn init(store: &Store) -> Lang {
    let setting = store.get_setting(SETTING_LANGUAGE).ok().flatten();
    apply_setting(setting.as_deref())
}

/// After `set_setting("language", value)`: re-resolve and cache. Returns the new language.
pub fn apply_setting(value: Option<&str>) -> Lang {
    let l = resolve(value, system());
    let before = CURRENT.swap(encode(l), Ordering::Relaxed);
    if before != encode(l) {
        log::info!("backend language: {}", l.code());
    }
    l
}

/// `lang::tr("Öffnen", "Open")` in the current language.
pub fn tr(de: &'static str, en: &'static str) -> &'static str {
    current().tr(de, en)
}

/// `trf!("Datei nicht gefunden: {p}", "File not found: {p}")` – `format!` in the current language.
macro_rules! trf {
    ($de:literal, $en:literal $(,)?) => {
        match $crate::lang::current() {
            $crate::lang::Lang::De => format!($de),
            $crate::lang::Lang::En => format!($en),
        }
    };
}

/// Error text for the frontend in the current language: a [`StoreError`] gives its
/// localized message (code and parameters: [`StoreError::code`]/[`StoreError::params`]),
/// anything else its `Display`.
pub fn ui_error<E: std::fmt::Display + 'static>(e: E) -> String {
    match (&e as &dyn std::any::Any).downcast_ref::<StoreError>() {
        Some(s) => s.message(current()),
        None => e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_wins_then_system_then_german() {
        assert_eq!(resolve(Some("en"), Some(Lang::De)), Lang::En);
        assert_eq!(resolve(Some("de"), Some(Lang::En)), Lang::De);
        assert_eq!(resolve(Some("system"), Some(Lang::En)), Lang::En);
        assert_eq!(resolve(None, Some(Lang::En)), Lang::En);
        assert_eq!(resolve(Some("system"), None), Lang::De);
        assert_eq!(resolve(Some("fr"), None), Lang::De);
    }

    #[test]
    fn windows_language_ids() {
        assert_eq!(from_langid(0x0407), Some(Lang::De)); // de-DE
        assert_eq!(from_langid(0x0C07), Some(Lang::De)); // de-AT
        assert_eq!(from_langid(0x0409), Some(Lang::En)); // en-US
        assert_eq!(from_langid(0x0809), Some(Lang::En)); // en-GB
        assert_eq!(from_langid(0x040C), None); // fr-FR
    }

    #[test]
    fn ui_error_localizes_store_errors_only() {
        let e = StoreError::from(vectasim_store::Invalid::FlightNotFound);
        assert_eq!(ui_error(e), "Flug nicht gefunden");
        assert_eq!(ui_error("plain".to_string()), "plain");
        assert_eq!(StoreError::from(vectasim_store::Invalid::FlightNotFound).message(Lang::En), "Flight not found");
    }

    #[test]
    fn system_language_is_readable() {
        // whatever the machine says, the call must not fail and resolves to de or en
        let l = resolve(Some("system"), system());
        assert!(matches!(l, Lang::De | Lang::En));
    }
}
