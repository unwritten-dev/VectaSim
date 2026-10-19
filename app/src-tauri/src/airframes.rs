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
use serde::Serialize;
use vectasim_photos::{Photo, PhotoClient};
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
    /// Photos of other pilots' aircraft (online traffic): kept for this session only, never in
    /// the logbook. Registration → (photo or miss, fetched ms), fresh by the same TTLs.
    traffic: Mutex<HashMap<String, (Option<Photo>, u64)>>,
}

/// What `traffic_photo` answers for an aircraft of the online traffic.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficPhoto {
    pub registration: String,
    /// "found", "none" (Planespotters has no photo), "off" (photos switched off) or "error".
    pub status: &'static str,
    pub url: Option<String>,
    pub thumb_url: Option<String>,
    pub photographer: Option<String>,
    /// Planespotters photo page; the credit links here.
    pub link: Option<String>,
}

impl TrafficPhoto {
    fn of(registration: &str, photo: Option<&Photo>) -> Self {
        Self {
            registration: registration.to_string(),
            status: if photo.is_some() { "found" } else { "none" },
            url: photo.map(|p| p.large_url.clone()),
            thumb_url: photo.map(|p| p.thumb_url.clone()),
            photographer: photo.map(|p| p.photographer.clone()).filter(|s| !s.is_empty()),
            link: photo.map(|p| p.link.clone()).filter(|s| !s.is_empty()),
        }
    }

    fn status(registration: &str, status: &'static str) -> Self {
        Self { status, ..Self::of(registration, None) }
    }
}

impl PhotoState {
    /// A cached traffic lookup while it is fresh (a hit 7 days, a miss 24 h).
    fn cached_traffic(&self, reg: &str, now_ms: u64) -> Option<TrafficPhoto> {
        let cache = self.traffic.lock().unwrap();
        let (photo, at) = cache.get(reg)?;
        let source = if photo.is_some() { vectasim_photos::SOURCE } else { vectasim_photos::SOURCE_NONE };
        vectasim_photos::is_fresh(Some(source), Some(*at), now_ms).then(|| TrafficPhoto::of(reg, photo.as_ref()))
    }

    fn remember_traffic(&self, reg: &str, photo: Option<Photo>, now_ms: u64) -> TrafficPhoto {
        let answer = TrafficPhoto::of(reg, photo.as_ref());
        self.traffic.lock().unwrap().insert(reg.to_string(), (photo, now_ms));
        answer
    }
}

/// Error text for the UI in the backend language (store errors localized, see `lang::ui_error`).
fn err(e: impl std::fmt::Display + 'static) -> String {
    crate::lang::ui_error(e)
}

fn now() -> u64 {
    vectasim_core::now_ms()
}

fn reg_or_err(raw: &str) -> Result<String, String> {
    normalize_registration(raw).ok_or_else(|| {
        let r = raw.trim();
        trf!(
            "„{r}“ ist keine gültige Registrierung (3–8 Zeichen, Buchstaben, Ziffern, Bindestrich)",
            "“{r}” is not a valid registration (3–8 characters, letters, digits, hyphen)"
        )
    })
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

/// Manual create/edit (name, type, airline, notes, Vapp, landing flaps).
#[tauri::command]
pub fn upsert_airframe(edit: AirframeEdit, app: AppHandle, store: State<Store>) -> Result<Airframe, String> {
    reg_or_err(&edit.registration)?;
    let refs_edited = edit.vapp_kt.is_some() || edit.landing_flaps.is_some();
    let before = refs_edited.then(|| store.get_airframe(&edit.registration).ok().flatten().map(|a| (a.vapp_kt, a.landing_flaps)).unwrap_or_default());
    let a = store.upsert_airframe(&edit, now()).map_err(err)?.ok_or(crate::lang::tr("Registrierung ungültig", "Invalid registration"))?;
    changed(&app, &a.registration);
    // a new Vapp / landing flaps re-rate the approaches of this airframe: the strips reload their (recomputed) facts
    if before.is_some_and(|b| b != (a.vapp_kt, a.landing_flaps)) {
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
    let a = store.merge_airframes(&from, &into, now()).map_err(err)?.ok_or(crate::lang::tr("Flugzeug nicht gefunden", "Aircraft not found"))?;
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
            // the registration only at DEBUG (Streamer-Modus: masked in the Diagnosepaket)
            log::info!("planespotters: {}", if photo.is_some() { "photo found" } else { "no photo" });
            log::debug!("planespotters {reg}: {}", if photo.is_some() { "photo found" } else { "no photo" });
            store.set_airframe_photo(&reg, photo.as_ref(), now()).map_err(err)?
        }
        Err(e) => {
            log::warn!("planespotters: {e}");
            log::debug!("planespotters {reg}: lookup failed");
            photos.failed.lock().unwrap().insert(reg.clone(), Instant::now());
            if refresh {
                return Err(trf!("Foto konnte nicht geladen werden: {e}", "Photo could not be loaded: {e}"));
            }
            return Ok(Some(current));
        }
    };
    changed(&app, &reg);
    Ok(stored)
}

/// Photo of another pilot's aircraft (online traffic card) by its registration, from
/// Planespotters through the same client – and so the same ≤ 1 request/s queue – as the
/// fleet's photos. Nothing is written to the logbook; the session cache keeps the answer for
/// the usual TTLs, a failed lookup is not repeated for `FAIL_BACKOFF`. With the photo setting
/// off it answers "off" without asking anyone.
#[tauri::command]
pub async fn traffic_photo(registration: String, store: State<'_, Store>, photos: State<'_, PhotoState>) -> Result<TrafficPhoto, String> {
    let reg = reg_or_err(&registration)?;
    if !photos_enabled(&store) {
        return Ok(TrafficPhoto::status(&reg, "off"));
    }
    if let Some(hit) = photos.cached_traffic(&reg, now()) {
        return Ok(hit);
    }
    let key = format!("traffic:{reg}");
    if photos.failed.lock().unwrap().get(&key).is_some_and(|t| t.elapsed() < FAIL_BACKOFF) {
        return Ok(TrafficPhoto::status(&reg, "error"));
    }
    match photos.client.by_registration(&reg).await {
        Ok(found) => {
            log::debug!("planespotters traffic {reg}: {}", if found.is_some() { "photo found" } else { "no photo" });
            Ok(photos.remember_traffic(&reg, found, now()))
        }
        Err(e) => {
            log::warn!("planespotters traffic: {e}");
            log::debug!("planespotters traffic {reg}: lookup failed");
            photos.failed.lock().unwrap().insert(key, Instant::now());
            Ok(TrafficPhoto::status(&reg, "error"))
        }
    }
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
        return Err(crate::lang::tr("Bitte ein Bild wählen (JPG, PNG, WebP oder GIF).", "Please choose an image (JPG, PNG, WebP or GIF).").into());
    }
    let size = std::fs::metadata(&src).map_err(|e| format!("{path}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(crate::lang::tr("Das Bild ist größer als 15 MB.", "The image is larger than 15 MB.").into());
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
    let a = store.set_airframe_photo(&reg, Some(&photo), now()).map_err(err)?.ok_or(crate::lang::tr("Registrierung ungültig", "Invalid registration"))?;
    changed(&app, &reg);
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo() -> Photo {
        Photo { large_url: "https://t.plnspttrs.net/l.jpg".into(), thumb_url: "https://t.plnspttrs.net/t.jpg".into(), photographer: "Jane Doe".into(), link: "https://www.planespotters.net/photo/1".into() }
    }

    #[test]
    fn traffic_cache_keeps_hits_a_week_and_misses_a_day() {
        let state = PhotoState::default();
        let t0 = 1_000_000_000_000;
        let hit = state.remember_traffic("D-AIZB", Some(photo()), t0);
        assert_eq!(hit.status, "found");
        assert_eq!(hit.photographer.as_deref(), Some("Jane Doe"));
        assert_eq!(state.cached_traffic("D-AIZB", t0 + 6 * 24 * 3600 * 1000), Some(hit));
        assert_eq!(state.cached_traffic("D-AIZB", t0 + vectasim_photos::HIT_TTL_MS), None);

        let miss = state.remember_traffic("G-EUUA", None, t0);
        assert_eq!((miss.status, miss.url.as_deref()), ("none", None));
        assert!(state.cached_traffic("G-EUUA", t0 + 3600 * 1000).is_some());
        assert_eq!(state.cached_traffic("G-EUUA", t0 + vectasim_photos::MISS_TTL_MS), None);
        assert_eq!(state.cached_traffic("OE-LBA", t0), None);
    }

    #[test]
    fn traffic_photo_serialises_for_the_card() {
        let v = serde_json::to_value(TrafficPhoto::of("D-AIZB", Some(&photo()))).unwrap();
        assert_eq!(v["thumbUrl"], "https://t.plnspttrs.net/t.jpg");
        assert_eq!(v["status"], "found");
        let off = serde_json::to_value(TrafficPhoto::status("D-AIZB", "off")).unwrap();
        assert_eq!(off["status"], "off");
        assert!(off["url"].is_null());
    }
}
