//! Tray icon and minimise-to-tray (Einstellungen → Integrationen, setting `tray_minimize`,
//! default off).
//!
//! With the setting on there is a tray icon (the window icon) whose tooltip is the short status
//! ("VectaSim · Aufzeichnung läuft · Reiseflug") and whose menu offers „Öffnen“, the recording
//! state (disabled line), „Debug-Modus“ (same switch as Einstellungen → Diagnose) and „Beenden“.
//! Minimising the window then hides it into the tray; a double click on the icon (or „Öffnen“)
//! brings it back. „Beenden“ shows the window and asks it to close, so the close guard of a
//! running recording still asks first. Switched off, the icon goes away at once.

use crate::manager::{ProviderManager, StatusSnapshot};
use crate::notify::focus_main;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent, Wry};
use vectasim_core::{FlightPhase, FlightState};
use vectasim_store::Store;

pub const SETTING_TRAY: &str = "tray_minimize";
const TRAY_ID: &str = "main";
const REFRESH: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Items {
    status: MenuItem<Wry>,
    debug: CheckMenuItem<Wry>,
    last_text: String,
}

#[derive(Default)]
pub struct TrayState(Mutex<Option<Items>>);

fn lock(s: &TrayState) -> std::sync::MutexGuard<'_, Option<Items>> {
    s.0.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn enabled(store: &Store) -> bool {
    store.get_setting(SETTING_TRAY).ok().flatten().as_deref() == Some("1")
}

fn phase_label(p: FlightPhase) -> &'static str {
    match p {
        FlightPhase::Preflight => "Vorbereitung",
        FlightPhase::Pushback => "Pushback",
        FlightPhase::TaxiOut => "Rollen",
        FlightPhase::Takeoff => "Start",
        FlightPhase::Climb => "Steigflug",
        FlightPhase::Cruise => "Reiseflug",
        FlightPhase::Descent => "Sinkflug",
        FlightPhase::Approach => "Anflug",
        FlightPhase::Final => "Endanflug",
        FlightPhase::Landing => "Landung",
        FlightPhase::TaxiIn => "Rollen zum Gate",
        FlightPhase::Shutdown => "Abgestellt",
    }
}

fn recording(s: &StatusSnapshot) -> bool {
    s.flight.as_ref().is_some_and(|f| f.state == FlightState::Active)
}

/// Menu line: „Aufzeichnung: läuft“ / „Aufzeichnung: bereit“ / „Aufzeichnung: wartet auf Simulator“.
pub fn menu_text(s: &StatusSnapshot) -> String {
    let what = if recording(s) {
        "läuft"
    } else if s.state == "connected" {
        "bereit"
    } else {
        "wartet auf Simulator"
    };
    format!("Aufzeichnung: {what}")
}

/// Tooltip: the short status.
pub fn tooltip(s: &StatusSnapshot) -> String {
    let demo = if s.provider == "mock" || s.provider == "replay" { " (Demo)" } else { "" };
    let what = match s.flight.as_ref().filter(|_| recording(s)) {
        Some(f) => format!("Aufzeichnung läuft · {}", phase_label(f.phase)),
        None if s.state == "connected" => "verbunden, bereit".to_owned(),
        None => "wartet auf Simulator".to_owned(),
    };
    format!("VectaSim · {what}{demo}")
}

fn toggle_debug(app: &AppHandle) {
    let (Some(store), Some(manager)) = (app.try_state::<Store>(), app.try_state::<ProviderManager>()) else { return };
    let on = !crate::debug_mode_on(&store);
    if let Err(e) = store.set_setting(crate::SETTING_DEBUG_MODE, if on { "1" } else { "0" }) {
        log::warn!("debug mode not switched from the tray: {e}");
        return;
    }
    crate::apply_debug_mode(app, &store, &manager);
    log::info!("debug mode {} (tray)", if on { "on" } else { "off" });
    let _ = app.emit("debug:changed", on);
    let debug = lock(&app.state::<TrayState>()).as_ref().map(|i| i.debug.clone());
    if let Some(d) = debug {
        let _ = d.set_checked(on);
    }
}

/// Window asked to close: the frontend's close guard decides.
fn quit(app: &AppHandle) {
    focus_main(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

fn create(app: &AppHandle) -> tauri::Result<()> {
    let debug_on = app.try_state::<Store>().is_some_and(|s| crate::debug_mode_on(&s));
    let snap = app.state::<ProviderManager>().snapshot();
    let open = MenuItem::with_id(app, "tray-open", "Öffnen", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "tray-status", menu_text(&snap), false, None::<&str>)?;
    let debug = CheckMenuItem::with_id(app, "tray-debug", "Debug-Modus", true, debug_on, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &status, &PredefinedMenuItem::separator(app)?, &debug, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(&snap))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "tray-open" => focus_main(app),
            "tray-debug" => toggle_debug(app),
            "tray-quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = ev {
                focus_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    *lock(&app.state::<TrayState>()) = Some(Items { status, debug, last_text: tooltip(&snap) });
    Ok(())
}

/// Icon on or off as the setting says (start, and after the switch in Einstellungen).
pub fn apply(app: &AppHandle) {
    let on = app.try_state::<Store>().is_some_and(|s| enabled(&s));
    let exists = app.tray_by_id(TRAY_ID).is_some();
    if on && !exists {
        match create(app) {
            Ok(()) => log::info!("tray icon on"),
            Err(e) => log::warn!("tray icon not created: {e}"),
        }
    } else if !on && exists {
        let _ = app.remove_tray_by_id(TRAY_ID);
        *lock(&app.state::<TrayState>()) = None;
        // nothing to bring a hidden window back with any more
        focus_main(app);
        log::info!("tray icon off");
    }
}

/// Keeps tooltip, status line and debug check in step with the app (from `setup`).
pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("tray-status".into()).spawn(move || {
        loop {
            std::thread::sleep(REFRESH);
            let snap = app.state::<ProviderManager>().snapshot();
            let tip = tooltip(&snap);
            let debug_on = app.try_state::<Store>().is_some_and(|s| crate::debug_mode_on(&s));
            // copies out of the lock: menu calls from this thread wait for the main thread,
            // which may itself be waiting for the lock (tray menu click)
            let (status, debug, changed) = {
                let state = app.state::<TrayState>();
                let mut guard = lock(&state);
                let Some(items) = guard.as_mut() else { continue };
                let changed = items.last_text != tip;
                items.last_text.clone_from(&tip);
                (items.status.clone(), items.debug.clone(), changed)
            };
            if changed {
                if let Some(tray) = app.tray_by_id(TRAY_ID) {
                    let _ = tray.set_tooltip(Some(&tip));
                }
                let _ = status.set_text(menu_text(&snap));
            }
            if debug.is_checked().is_ok_and(|c| c != debug_on) {
                let _ = debug.set_checked(debug_on);
            }
        }
    });
    if let Err(e) = spawned {
        log::error!("tray status thread not started: {e}");
    }
}

/// Minimised with the tray on: hide the window into the tray (Builder::on_window_event).
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Resized(_)) || window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    if app.tray_by_id(TRAY_ID).is_none() || !window.is_minimized().unwrap_or(false) {
        return;
    }
    let _ = window.hide();
    app.state::<ProviderManager>().set_ui_visible(false);
}

/// Einstellungen → Integrationen → Tray switch.
#[tauri::command]
pub fn set_tray_enabled(on: bool, app: AppHandle, store: tauri::State<'_, Store>) -> Result<bool, String> {
    store.set_setting(SETTING_TRAY, if on { "1" } else { "0" }).map_err(|e| e.to_string())?;
    apply(&app);
    Ok(app.tray_by_id(TRAY_ID).is_some())
}

/// Whether the tray icon exists right now.
#[tauri::command]
pub fn tray_active(app: AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use vectasim_core::FlightSummary;

    #[test]
    fn status_texts() {
        let mut s = StatusSnapshot { provider: "simconnect".into(), state: "connecting".into(), ..Default::default() };
        assert_eq!(menu_text(&s), "Aufzeichnung: wartet auf Simulator");
        assert_eq!(tooltip(&s), "VectaSim · wartet auf Simulator");
        s.state = "connected".into();
        assert_eq!(menu_text(&s), "Aufzeichnung: bereit");
        s.flight = Some(FlightSummary { state: FlightState::Active, phase: FlightPhase::Cruise, ..Default::default() });
        assert_eq!(menu_text(&s), "Aufzeichnung: läuft");
        assert_eq!(tooltip(&s), "VectaSim · Aufzeichnung läuft · Reiseflug");
        s.provider = "mock".into();
        assert!(tooltip(&s).ends_with("(Demo)"));
    }
}
