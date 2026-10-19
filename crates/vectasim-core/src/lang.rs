//! UI language of the backend texts (notifications, tray, Discord, overlay pages, store error
//! messages). German is the reference language, English the second one; the frontend has its
//! own catalogue (`app/src/i18n`). The app resolves the setting `language` (`de` | `en` |
//! `system`) into a [`Lang`] (`app/src-tauri/src/lang.rs`); everything here is pure.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    #[default]
    De,
    En,
}

impl Lang {
    /// `de` | `en` (also the value of the HTML `lang` attribute).
    pub fn code(self) -> &'static str {
        match self {
            Lang::De => "de",
            Lang::En => "en",
        }
    }

    /// Exactly `de` or `en` (case and surrounding blanks ignored); anything else is `None`.
    pub fn parse(s: &str) -> Option<Lang> {
        match s.trim().to_ascii_lowercase().as_str() {
            "de" => Some(Lang::De),
            "en" => Some(Lang::En),
            _ => None,
        }
    }

    /// A BCP-47/POSIX locale (`de-DE`, `en_US.UTF-8`, `de-AT`) → its language; neither German
    /// nor English → `None` (the caller falls back to German).
    pub fn from_locale(locale: &str) -> Option<Lang> {
        let primary = locale.trim().split(['-', '_', '.', '@']).next().unwrap_or("");
        Lang::parse(primary)
    }

    /// The text for this language: `lang.tr("Öffnen", "Open")`.
    pub fn tr<'a>(self, de: &'a str, en: &'a str) -> &'a str {
        match self {
            Lang::De => de,
            Lang::En => en,
        }
    }

    /// Decimal number as the UI writes it: `1,23` (de) / `1.23` (en).
    pub fn decimal(self, v: f64, digits: usize) -> String {
        let s = format!("{v:.digits$}");
        match self {
            Lang::De => s.replace('.', ","),
            Lang::En => s,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_locale() {
        assert_eq!(Lang::parse(" EN "), Some(Lang::En));
        assert_eq!(Lang::parse("system"), None);
        assert_eq!(Lang::from_locale("de-AT"), Some(Lang::De));
        assert_eq!(Lang::from_locale("en_US.UTF-8"), Some(Lang::En));
        assert_eq!(Lang::from_locale("fr-FR"), None);
        assert_eq!(Lang::default(), Lang::De);
    }

    #[test]
    fn tr_and_decimal() {
        assert_eq!(Lang::En.tr("Öffnen", "Open"), "Open");
        assert_eq!(Lang::De.decimal(1.234, 2), "1,23");
        assert_eq!(Lang::En.decimal(1.234, 2), "1.23");
    }
}
