//! Notizen & Tags: what the pilot adds to a recorded flight (notes, tags, a rating and
//! corrections of callsign, airports, aircraft name and registration). Every change emits
//! `logbook:changed`; a changed registration re-books the flight and also emits
//! `airframes:changed` (old and new registration).

use tauri::{AppHandle, Emitter, State};
use vectasim_store::{FlightRow, FlightUserEdit, Store, TagCount};

/// Apply `edit` to flight `id` (`None` fields stay, `""` / `[]` / `0` clear). Returns the
/// updated row; errors carry the German validation message for the form.
#[tauri::command]
pub async fn update_flight_user(id: String, edit: FlightUserEdit, app: AppHandle, store: State<'_, Store>) -> Result<FlightRow, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let before = store.get_flight(&id).map_err(|e| e.to_string())?.map(|d| d.flight.airframe_reg);
        let Some(before) = before else { return Err("Flug nicht gefunden".to_string()) };
        let row = store.update_flight_user(&id, &edit, vectasim_core::now_ms()).map_err(|e| e.to_string())?.ok_or("Flug nicht gefunden")?;
        let _ = app.emit("logbook:changed", ());
        if before != row.airframe_reg {
            for reg in [before.as_deref(), row.airframe_reg.as_deref()].into_iter().flatten() {
                let _ = app.emit("airframes:changed", reg);
            }
        }
        Ok(row)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every tag of the logbook with its number of flights (most used first) for the
/// autocomplete and the logbook filter.
#[tauri::command]
pub async fn list_tags(store: State<'_, Store>) -> Result<Vec<TagCount>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.list_tags().map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}
