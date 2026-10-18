//! Airframes (one per registration) and their photos for the webview.
//!
//! Photos come from the Planespotters.net public API via `vectasim-photos`; the
//! airframe row is the cache (7 days for a hit, 24 h for a miss). The UI asks
//! lazily (`airframe_photo`) when it shows an airframe without a fresh photo;
//! concurrent asks for the same registration share one request, and a failed
//! request is not retried for `FAIL_BACKOFF`. Every change emits
//! `airframes:changed` with the registration.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use vectasim_photos::PhotoClient;
use vectasim_store::{Airframe, AirframeEdit, AirframePhoto, AirframeRow, FlightRow, Store, normalize_registration};

/// "0" turns the Planespotters lookups off; anything else (or unset) is on.
pub const SETTING_PHOTOS: &str = "airframe_photos";
const FAIL_BACKOFF: Duration = Duration::from_secs(600);
const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif"];
const SOURCE_USER: &str = "user";

#[derive(Default)]
pub struct PhotoState {
    client: PhotoClient,
    inflight: Mutex<HashSet<String>>,
    failed: Mutex<HashMap<String, Instant>>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now() -> u64 {
    vectasim_core::now_ms()
}

fn reg_or_err(raw: &str) -> Result<String, String> {
    normalize_registration(raw).ok_or_else(|| format!("„{}“ ist keine gültige Registrierung (3–8 Zeichen, Buchstaben, Ziffern, Bindestrich)", raw.trim()))
}

fn changed(app: &AppHandle, reg: &str) {
    let _ = app.emit("airframes:changed", reg);
}

pub fn photos_enabled(store: &Store) -> bool {
    store.get_setting(SETTING_PHOTOS).ok().flatten().as_deref() != Some("0")
}

#[tauri::command]
pub fn list_airframes(include_demo: Option<bool>, store: State<Store>) -> Result<Vec<AirframeRow>, String> {
    store.list_airframes(include_demo.unwrap_or(true)).map_err(err)
}

/// One airframe with its logbook aggregates.
#[tauri::command]
pub fn get_airframe(registration: String, include_demo: Option<bool>, store: State<Store>) -> Result<Option<AirframeRow>, String> {
    store.get_airframe_row(&registration, include_demo.unwrap_or(true)).map_err(err)
}

#[tauri::command]
pub fn airframe_flights(registration: String, limit: Option<u32>, store: State<Store>) -> Result<Vec<FlightRow>, String> {
    store.airframe_flights(&registration, limit.unwrap_or(500)).map_err(err)
}

/// Airframe of the flight being recorded, if it is booked onto one.
#[tauri::command]
pub fn active_airframe(store: State<Store>) -> Result<Option<Airframe>, String> {
    let Some(id) = store.active_flight_id().map_err(err)? else { return Ok(None) };
    let Some(detail) = store.get_flight(&id).map_err(err)? else { return Ok(None) };
    match detail.flight.airframe_reg {
        Some(reg) => store.get_airframe(&reg).map_err(err),
        None => Ok(None),
    }
}

/// Manual create/edit (name, type, airline, notes, Vapp).
#[tauri::command]
pub fn upsert_airframe(edit: AirframeEdit, app: AppHandle, store: State<Store>) -> Result<Airframe, String> {
    reg_or_err(&edit.registration)?;
    let before = edit.vapp_kt.is_some().then(|| store.get_airframe(&edit.registration).ok().flatten().and_then(|a| a.vapp_kt));
    let a = store.upsert_airframe(&edit, now()).map_err(err)?.ok_or("Registrierung ungültig")?;
    changed(&app, &a.registration);
    // a new Vapp re-rates the approaches of this airframe: the strips reload their (recomputed) facts
    if before.is_some_and(|b| b != a.vapp_kt) {
        let _ = app.emit("approach:facts", a.registration.as_str());
    }
    Ok(a)
}

/// Re-book a flight (also a past one) onto another airframe; `null` unbooks it.
#[tauri::command]
pub fn set_flight_airframe(flight_id: String, registration: Option<String>, app: AppHandle, store: State<Store>) -> Result<bool, String> {
    if let Some(r) = registration.as_deref().filter(|r| !r.trim().is_empty()) {
        reg_or_err(r)?;
    }
    let ok = store.set_flight_airframe(&flight_id, registration.as_deref(), now()).map_err(err)?;
    if ok {
        let _ = app.emit("logbook:changed", ());
        changed(&app, registration.as_deref().unwrap_or_default());
    }
    Ok(ok)
}

#[tauri::command]
pub fn merge_airframes(from: String, into: String, app: AppHandle, store: State<Store>) -> Result<Airframe, String> {
    reg_or_err(&from)?;
    reg_or_err(&into)?;
    let a = store.merge_airframes(&from, &into, now()).map_err(err)?.ok_or("Flugzeug nicht gefunden")?;
    let _ = app.emit("logbook:changed", ());
    changed(&app, &a.registration);
    Ok(a)
}

#[tauri::command]
pub fn delete_airframe(registration: String, app: AppHandle, store: State<Store>) -> Result<bool, String> {
    let ok = store.delete_airframe(&registration).map_err(err)?;
    if ok {
        let _ = app.emit("logbook:changed", ());
        changed(&app, &registration);
    }
    Ok(ok)
}

/// The airframe with a photo if one can be had: the cached one while fresh, else
/// a Planespotters lookup (when enabled). `refresh` forces the lookup, also over a
/// picked image. Returns the row as it is now; a lookup another caller already
/// runs is not repeated (the UI hears `airframes:changed` when it lands).
#[tauri::command]
pub async fn airframe_photo(
    registration: String,
    refresh: Option<bool>,
    app: AppHandle,
    store: State<'_, Store>,
    photos: State<'_, PhotoState>,
) -> Result<Option<Airframe>, String> {
    let reg = reg_or_err(&registration)?;
    let refresh = refresh.unwrap_or(false);
    let current = store.get_airframe(&reg).map_err(err)?;
    let Some(current) = current else { return Ok(None) };
    if !photos_enabled(&store) && !refresh {
        return Ok(Some(current));
    }
    if !refresh && vectasim_photos::is_fresh(current.image_source.as_deref(), current.image_fetched_ms, now()) {
        return Ok(Some(current));
    }
    if !refresh && photos.failed.lock().unwrap().get(&reg).is_some_and(|t| t.elapsed() < FAIL_BACKOFF) {
        return Ok(Some(current));
    }
    if !photos.inflight.lock().unwrap().insert(reg.clone()) {
        return Ok(Some(current));
    }
    let result = photos.client.by_registration(&reg).await;
    photos.inflight.lock().unwrap().remove(&reg);
    let stored = match result {
        Ok(found) => {
            photos.failed.lock().unwrap().remove(&reg);
            if found.is_none() && current.image_source.as_deref() == Some(SOURCE_USER) {
                return Ok(Some(current)); // nothing better than the picked image
            }
            let photo = found.map(|p| AirframePhoto {
                credit: p.photographer.clone(),
                url: p.large_url,
                thumb_url: p.thumb_url,
                link: p.link,
                source: vectasim_photos::SOURCE.into(),
            });
            log::info!("planespotters {reg}: {}", if photo.is_some() { "photo found" } else { "no photo" });
            store.set_airframe_photo(&reg, photo.as_ref(), now()).map_err(err)?
        }
        Err(e) => {
            log::warn!("planespotters {reg}: {e}");
            photos.failed.lock().unwrap().insert(reg.clone(), Instant::now());
            if refresh {
                return Err(format!("Foto konnte nicht geladen werden: {e}"));
            }
            return Ok(Some(current));
        }
    };
    changed(&app, &reg);
    Ok(stored)
}

fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("airframes"))
}

/// Picked images are shown via the asset protocol; only this folder is readable through it.
pub fn allow_image_dir(app: &AppHandle) {
    match images_dir(app) {
        Ok(dir) => {
            if let Err(e) = std::fs::create_dir_all(&dir).map_err(err).and_then(|_| app.asset_protocol_scope().allow_directory(&dir, true).map_err(err)) {
                log::warn!("airframe images unavailable: {e}");
            }
        }
        Err(e) => log::warn!("airframe images unavailable: {e}"),
    }
}

/// Use a picked image file for an airframe: it is copied into app-data/airframes/
/// (the original may move) and shown via the asset protocol.
#[tauri::command]
pub fn set_airframe_image(registration: String, path: String, app: AppHandle, store: State<Store>) -> Result<Airframe, String> {
    let reg = reg_or_err(&registration)?;
    let src = PathBuf::from(&path);
    let ext = src.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("Bitte ein Bild wählen (JPG, PNG, WebP oder GIF).".into());
    }
    let size = std::fs::metadata(&src).map_err(|e| format!("{path}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err("Das Bild ist größer als 15 MB.".into());
    }
    let dir = images_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    // one file per airframe; a new pick replaces the old one (whatever its extension)
    let stem = reg.replace('-', "_");
    for old in IMAGE_EXTENSIONS {
        let _ = std::fs::remove_file(dir.join(format!("{stem}.{old}")));
    }
    let dest = dir.join(format!("{stem}.{ext}"));
    std::fs::copy(&src, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let dest_s = dest.display().to_string();
    let photo = AirframePhoto { url: dest_s.clone(), thumb_url: dest_s, credit: "Eigenes Bild".into(), link: String::new(), source: SOURCE_USER.into() };
    let a = store.set_airframe_photo(&reg, Some(&photo), now()).map_err(err)?.ok_or("Registrierung ungültig")?;
    changed(&app, &reg);
    Ok(a)
}
