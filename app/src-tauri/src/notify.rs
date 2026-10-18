//! Windows notifications (Einstellungen → Integrationen → Benachrichtigungen).
//!
//! Settings: `notifications` (master switch, default on) and one per kind – `notify_landing`,
//! `notify_saved`, `notify_connection`, `notify_update` (each default on). A notification is
//! shown only while the main window is not focused (minimised, in the tray, behind the sim):
//! with the window in front the in-app toast says the same. Texts are German and never carry a
//! registration or callsign, so they are safe in the Streamer-Modus as well.
//!
//! A click on the toast brings the window back ([`on_click_focus`]); Windows reports that only
//! while the toast is on screen, not from the Action Center (plugin limitation). In a dev build
//! the toast carries PowerShell's name and icon; installed builds use VectaSim's.
//!
//! Sources: the provider forwarder (landing, flight saved, connection lost/back – see
//! `manager::Outbox::notify`) and the frontend (update available, command [`notify`]).

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use vectasim_store::Store;

pub const SETTING_NOTIFICATIONS: &str = "notifications";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Landing,
    Saved,
    Connection,
    Update,
    /// "Test senden": ignores focus and the per-kind switches.
    Test,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "landing" => Self::Landing,
            "saved" => Self::Saved,
            "connection" => Self::Connection,
            "update" => Self::Update,
            "test" => Self::Test,
            _ => return None,
        })
    }

    pub fn setting(self) -> Option<&'static str> {
        match self {
            Self::Landing => Some("notify_landing"),
            Self::Saved => Some("notify_saved"),
            Self::Connection => Some("notify_connection"),
            Self::Update => Some("notify_update"),
            Self::Test => None,
        }
    }
}

fn on(store: &Store, key: &str) -> bool {
    store.get_setting(key).ok().flatten().as_deref() != Some("0")
}

/// Master switch and the kind's own switch.
pub fn kind_enabled(store: &Store, kind: Kind) -> bool {
    on(store, SETTING_NOTIFICATIONS) && kind.setting().is_none_or(|k| on(store, k))
}

fn window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// Shows a notification when the settings allow it and the window is not focused.
/// True when one was shown.
pub fn send<R: Runtime>(app: &AppHandle<R>, kind: Kind, title: &str, body: &str) -> bool {
    let Some(store) = app.try_state::<Store>() else { return false };
    if kind != Kind::Test && (!kind_enabled(&store, kind) || window_focused(app)) {
        return false;
    }
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => {
            log::debug!("notification shown: {kind:?}");
            true
        }
        Err(e) => {
            log::warn!("notification failed: {e}");
            false
        }
    }
}

/// Window back to the front: shown (tray), restored, focused.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(m) = app.try_state::<crate::manager::ProviderManager>() {
        m.set_ui_visible(true);
    }
}

/// A click on one of our notifications focuses the window (from `setup`).
pub fn on_click_focus<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |_| {
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || focus_main(&h));
    });
}

/// "Gelandet · −155 fpm", plus g-load and bounces.
pub fn landing_text(rate_fpm: f64, peak_g: f64, bounces: u32, touch_and_go: bool) -> (String, String) {
    let n = rate_fpm.round();
    let rate = if n < 0.0 { format!("\u{2212}{:.0} fpm", -n) } else { format!("{n:.0} fpm") };
    let what = if touch_and_go { "Touch-and-go" } else { "Gelandet" };
    let bounce = match bounces {
        0 => "keine Bounces".to_owned(),
        1 => "1 Bounce".to_owned(),
        n => format!("{n} Bounces"),
    };
    // German decimal comma, like the UI
    let g = format!("{peak_g:.2}").replace('.', ",");
    (format!("{what} · {rate}"), format!("g-Last {g} · {bounce}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyResult {
    pub shown: bool,
}

/// Frontend → `invoke("notify", { kind, title, body })` (update available, …). Same rules as
/// the backend's own notifications; returns whether one was shown.
#[tauri::command]
pub fn notify(kind: String, title: String, body: String, app: AppHandle) -> Result<NotifyResult, String> {
    let kind = Kind::parse(&kind).ok_or_else(|| format!("unbekannte Benachrichtigung: {kind}"))?;
    Ok(NotifyResult { shown: send(&app, kind, &title, &body) })
}

/// „Test senden“ in Einstellungen → Integrationen.
#[tauri::command]
pub fn notify_test(app: AppHandle) -> NotifyResult {
    NotifyResult { shown: send(&app, Kind::Test, "VectaSim", "So sehen Benachrichtigungen aus – etwa nach der Landung.") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_default_on_and_master_wins() {
        let store = Store::open_in_memory().unwrap();
        assert!(kind_enabled(&store, Kind::Landing));
        store.set_setting("notify_landing", "0").unwrap();
        assert!(!kind_enabled(&store, Kind::Landing));
        assert!(kind_enabled(&store, Kind::Saved));
        store.set_setting(SETTING_NOTIFICATIONS, "0").unwrap();
        assert!(!kind_enabled(&store, Kind::Saved));
        assert!(Kind::parse("bogus").is_none());
        assert_eq!(Kind::parse("update"), Some(Kind::Update));
    }

    #[test]
    fn landing_text_is_german_and_signed() {
        let (t, b) = landing_text(-155.4, 1.234, 0, false);
        assert_eq!(t, "Gelandet · −155 fpm");
        assert_eq!(b, "g-Last 1,23 · keine Bounces");
        assert_eq!(landing_text(-80.0, 1.1, 2, true).0, "Touch-and-go · −80 fpm");
    }
}
