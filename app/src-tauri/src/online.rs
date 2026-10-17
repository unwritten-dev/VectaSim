//! Online networks (VATSIM traffic/ATC) and METAR weather for the webview.
//!
//! One `VatsimFeed` poller runs while the user has VATSIM enabled; every map
//! query is answered from its cached snapshot, so panning never causes a
//! request. The enable flag lives in the settings table (`online_vatsim`) and
//! is restored at startup. Each poll emits `online:summary` (FeedStatus).

use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use vectasim_data::{Airport, AirportIndex, haversine_nm};
use vectasim_online::{Controller, FeedStatus, Metar, MetarClient, NearbyPilot, Pilot, VatsimFeed};
use vectasim_store::{MetarSlot, Store};

pub const SETTING_VATSIM: &str = "online_vatsim";
const DEFAULT_PILOT_LIMIT: usize = 1500;
const CONTROLLER_LIMIT: usize = 300;
/// The map asks for at most this many airports per view; more would also break the NOAA batch size.
const METAR_LIMIT: usize = vectasim_online::metar::MAX_BATCH;
/// Neighbour stations for the wind when the airport itself has no METAR.
const METAR_NEIGHBOUR_NM: f64 = 25.0;
/// A captured position belongs to an airport within this distance.
const CAPTURE_AIRPORT_NM: f64 = 5.0;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct OnlineState {
    pub vatsim: VatsimFeed,
    pub metar: MetarClient,
}

/// An airport-based controller (DEL/GND/TWR/APP/ATIS) placed at its airport.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedController {
    #[serde(flatten)]
    pub controller: Controller,
    pub airport: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineView {
    pub pilots: Vec<Pilot>,
    /// True when more pilots were in view than `limit`.
    pub pilots_truncated: bool,
    pub controllers: Vec<LocatedController>,
    /// CTR/FSS stations that probably cover the view (see `enroute_in_view`).
    pub enroute: Vec<Controller>,
    pub summary: FeedStatus,
}

pub fn start_vatsim(app: &AppHandle, feed: &VatsimFeed) {
    let app = app.clone();
    feed.start(tauri::async_runtime::handle().inner(), Arc::new(move |st: &FeedStatus| {
        let _ = app.emit("online:summary", st);
    }));
}

/// Resolve a controller's callsign prefix to an airport: ICAO directly, or the
/// US convention of 3-letter FAA ids ("JFK_TWR" → KJFK).
fn locate<'a>(airports: &'a AirportIndex, prefix: &str) -> Option<&'a vectasim_data::Airport> {
    match prefix.len() {
        4 => airports.get(prefix),
        3 => airports.get(&format!("K{prefix}")),
        _ => None,
    }
}

fn in_box(lat: f64, lon: f64, min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64) -> bool {
    let lon_ok = if min_lon <= max_lon { lon >= min_lon && lon <= max_lon } else { lon >= min_lon || lon <= max_lon };
    lat >= min_lat && lat <= max_lat && lon_ok
}

/// Without FIR polygons we guess which centre stations matter for the view:
/// a 4-letter FIR prefix ("EDGG") counts when airports of its ICAO region
/// ("ED…") are in view; a 3-letter US ARTCC-style prefix ("BOS") counts when
/// the matching K-airport is within a few degrees of the view.
fn enroute_in_view(
    controllers: &[Controller],
    airports: &AirportIndex,
    (min_lon, min_lat, max_lon, max_lat): (f64, f64, f64, f64),
) -> Vec<Controller> {
    let regions: HashSet<String> =
        airports.in_bbox(min_lon, min_lat, max_lon, max_lat, 400).iter().filter_map(|a| a.ident.get(..2).map(str::to_string)).collect();
    let pad = 5.0;
    let (pmin_lon, pmax_lon) =
        if max_lon - min_lon + 2.0 * pad >= 360.0 { (-180.0, 180.0) } else { (wrap(min_lon - pad), wrap(max_lon + pad)) };
    let mut out: Vec<Controller> = controllers
        .iter()
        .filter(|c| c.facility.is_enroute())
        .filter(|c| {
            let p = c.station_prefix();
            match p.len() {
                4 => p.get(..2).is_some_and(|r| regions.contains(r)),
                3 => locate(airports, p)
                    .is_some_and(|a| in_box(a.latitude, a.longitude, pmin_lon, min_lat - pad, pmax_lon, max_lat + pad)),
                _ => false,
            }
        })
        .cloned()
        .collect();
    out.sort_by(|a, b| a.callsign.cmp(&b.callsign));
    out
}

fn wrap(lon: f64) -> f64 {
    if lon > 180.0 {
        lon - 360.0
    } else if lon < -180.0 {
        lon + 360.0
    } else {
        lon
    }
}

/// The airport plus up to 7 larger neighbours within ~25 nm, nearest first.
pub fn metar_candidates(airports: &AirportIndex, a: &Airport) -> Vec<String> {
    let dlat = METAR_NEIGHBOUR_NM / 60.0;
    let dlon = dlat / a.latitude.to_radians().cos().max(0.2);
    let mut near: Vec<(f64, String)> = airports
        .in_bbox(a.longitude - dlon, a.latitude - dlat, a.longitude + dlon, a.latitude + dlat, 80)
        .into_iter()
        .filter(|n| n.ident != a.ident && (n.kind == "large" || n.kind == "medium") && n.ident.len() == 4)
        .map(|n| (haversine_nm(a.latitude, a.longitude, n.latitude, n.longitude), n.ident.clone()))
        .filter(|(d, _)| *d <= METAR_NEIGHBOUR_NM)
        .collect();
    near.sort_by(|x, y| x.0.total_cmp(&y.0));
    std::iter::once(a.ident.clone()).chain(near.into_iter().take(7).map(|(_, i)| i)).collect()
}

/// Nearest report with a wind group (by station position) with its distance from `a`.
pub fn nearest_report(airports: &AirportIndex, found: Vec<Metar>, a: &Airport) -> Option<(Metar, f64)> {
    found
        .into_iter()
        .filter(|m| m.wind.is_some())
        .filter_map(|m| {
            let s = airports.get(&m.station)?;
            let d = haversine_nm(a.latitude, a.longitude, s.latitude, s.longitude);
            Some((m, d))
        })
        .min_by(|x, y| x.1.total_cmp(&y.1))
}

/// Fetch (through the cache) the METAR of the airport at a position – or of its nearest
/// reporting neighbour – and store it with the flight. Runs in the background; offline
/// or nowhere near an airport it just logs and leaves the flight without one.
pub fn capture_metar(app: &AppHandle, store: Store, flight_id: String, slot: MetarSlot, lat: f64, lon: f64, at_ms: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let airports = app.state::<Arc<AirportIndex>>().inner().clone();
        let Some(near) = airports.nearest(lat, lon, CAPTURE_AIRPORT_NM) else {
            log::info!("no airport near {lat:.4},{lon:.4} – no {slot:?} METAR");
            return;
        };
        let online = app.state::<OnlineState>();
        let wanted = metar_candidates(&airports, &near.airport);
        let found = match tokio::time::timeout(CAPTURE_TIMEOUT, online.metar.get_many(&wanted)).await {
            Ok(Ok(found)) => found,
            Ok(Err(e)) => {
                log::warn!("{slot:?} METAR for {}: {e}", near.airport.ident);
                return;
            }
            Err(_) => {
                log::warn!("{slot:?} METAR for {}: timed out", near.airport.ident);
                return;
            }
        };
        let Some((m, _)) = nearest_report(&airports, found, &near.airport) else {
            log::info!("no METAR for {} and its neighbours", near.airport.ident);
            return;
        };
        match store.set_flight_metar(&flight_id, slot, &m.raw, at_ms) {
            Ok(_) => {
                log::info!("{slot:?} METAR stored for flight {flight_id}: {}", m.raw);
                let _ = app.emit("logbook:changed", ());
            }
            Err(e) => log::error!("storing {slot:?} METAR: {e}"),
        }
    });
}

#[tauri::command]
pub fn online_set_enabled(
    network: String,
    enabled: bool,
    app: AppHandle,
    store: State<Store>,
    online: State<OnlineState>,
) -> Result<FeedStatus, String> {
    if network != "vatsim" {
        return Err(format!("unbekanntes Netzwerk '{network}'"));
    }
    store.set_setting(SETTING_VATSIM, if enabled { "1" } else { "0" }).map_err(|e| e.to_string())?;
    if enabled {
        start_vatsim(&app, &online.vatsim);
    } else {
        online.vatsim.stop();
    }
    let st = online.vatsim.status();
    let _ = app.emit("online:summary", &st);
    Ok(st)
}

#[tauri::command]
pub fn online_summary(online: State<OnlineState>) -> FeedStatus {
    online.vatsim.status()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn online_snapshot_in_bbox(
    min_lon: f64,
    min_lat: f64,
    max_lon: f64,
    max_lat: f64,
    limit: Option<usize>,
    online: State<OnlineState>,
    airports: State<Arc<AirportIndex>>,
) -> OnlineView {
    let summary = online.vatsim.status();
    let Some(snap) = online.vatsim.snapshot() else {
        return OnlineView { pilots: vec![], pilots_truncated: false, controllers: vec![], enroute: vec![], summary };
    };
    let limit = limit.unwrap_or(DEFAULT_PILOT_LIMIT);
    let pilots: Vec<Pilot> = snap.pilots_in_bbox(min_lon, min_lat, max_lon, max_lat, limit + 1).into_iter().cloned().collect();
    let pilots_truncated = pilots.len() > limit;
    let pilots = pilots.into_iter().take(limit).collect();

    let controllers = snap
        .controllers
        .iter()
        .filter(|c| !c.facility.is_enroute())
        .filter_map(|c| {
            let a = locate(&airports, c.station_prefix())?;
            in_box(a.latitude, a.longitude, min_lon, min_lat, max_lon, max_lat).then(|| LocatedController {
                controller: c.clone(),
                airport: a.ident.clone(),
                latitude: a.latitude,
                longitude: a.longitude,
            })
        })
        .take(CONTROLLER_LIMIT)
        .collect();
    let enroute = enroute_in_view(&snap.controllers, &airports, (min_lon, min_lat, max_lon, max_lat));
    OnlineView { pilots, pilots_truncated, controllers, enroute, summary }
}

#[tauri::command]
pub fn online_pilot(cid: u64, online: State<OnlineState>) -> Option<Pilot> {
    online.vatsim.pilot(cid)
}

#[tauri::command]
pub fn online_nearby(lat: f64, lon: f64, n: Option<usize>, online: State<OnlineState>) -> Vec<NearbyPilot> {
    online.vatsim.nearest_pilots(lat, lon, n.unwrap_or(10).min(50))
}

#[tauri::command]
pub async fn metar(icao: String, online: State<'_, OnlineState>) -> Result<Option<Metar>, String> {
    online.metar.get(&icao).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn metars(icaos: Vec<String>, online: State<'_, OnlineState>) -> Result<Vec<Metar>, String> {
    let icaos: Vec<String> = icaos.into_iter().take(METAR_LIMIT).collect();
    online.metar.get_many(&icaos).await.map_err(|e| e.to_string())
}
