//! Online networks (VATSIM and IVAO traffic/ATC) and METAR weather for the webview.
//!
//! One `OnlineFeed` poller per network runs while the user has that network enabled; every map
//! query is answered from the cached snapshots (both merged, each entry tagged with its
//! network), so panning never causes a request. The enable flags live in the settings table
//! (`online_vatsim`, `online_ivao`; IVAO defaults to off, so existing installs keep the
//! VATSIM-only behaviour) and are restored at startup. Each poll of either feed emits
//! `online:summary` ([`OnlineSummary`]: totals plus one status per network).
//!
//! *Enabled* (Settings → Online, `online_set_networks` / `online_set_enabled`) and *shown on the
//! map* (the map's traffic toggle, `online_set_shown`, setting `online_shown`) are separate: an
//! enabled network is polled from app start on – every 15 s while its traffic is shown, every
//! 60 s in the background (hidden, or the window hidden) – so its track history (the altitude
//! curtain of a clicked aircraft) covers up to two hours. Hiding never stops a feed; disabling
//! does and drops its history.

use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use vectasim_data::{Airport, AirportIndex, haversine_nm};
use vectasim_online::{Controller, FeedStatus, Metar, MetarClient, NearbyPilot, Network, OnlineFeed, Pilot, TrackFix};
use vectasim_route::{RouteCache, RouteResolution};
use vectasim_store::{MetarSlot, Store};

pub const SETTING_VATSIM: &str = "online_vatsim";
pub const SETTING_IVAO: &str = "online_ivao";
/// Networks whose traffic the map shows ("vatsim", "ivao", "vatsim,ivao"; "" = hidden). Missing
/// (installs from before the split): the enabled networks, as the map showed them then.
pub const SETTING_SHOWN: &str = "online_shown";
const DEFAULT_PILOT_LIMIT: usize = 1500;
const CONTROLLER_LIMIT: usize = 300;
/// The map asks for at most this many airports per view; more would also break the NOAA batch size.
const METAR_LIMIT: usize = vectasim_online::metar::MAX_BATCH;
/// Neighbour stations for the wind when the airport itself has no METAR.
const METAR_NEIGHBOUR_NM: f64 = 25.0;
/// A captured position belongs to an airport within this distance.
const CAPTURE_AIRPORT_NM: f64 = 5.0;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

pub struct OnlineState {
    pub vatsim: OnlineFeed,
    pub ivao: OnlineFeed,
    pub metar: MetarClient,
    /// Resolved filed routes of clicked traffic, for this app session (`traffic_route_resolve`).
    pub routes: Arc<RouteCache>,
}

impl Default for OnlineState {
    fn default() -> Self {
        Self { vatsim: OnlineFeed::vatsim(), ivao: OnlineFeed::ivao(), metar: MetarClient::new(), routes: Arc::default() }
    }
}

impl OnlineState {
    pub fn feed(&self, network: Network) -> &OnlineFeed {
        match network {
            Network::Vatsim => &self.vatsim,
            Network::Ivao => &self.ivao,
        }
    }

    fn feeds(&self) -> [&OnlineFeed; 2] {
        [&self.vatsim, &self.ivao]
    }

    /// Totals over the enabled networks plus each network's own status.
    pub fn summary(&self) -> OnlineSummary {
        OnlineSummary::from_statuses(self.feeds().map(|f| f.status()).to_vec(), vectasim_core::now_ms())
    }

    /// The window is visible (`set_ui_visible`); hidden, the feeds poll at the background rate.
    pub fn set_ui_visible(&self, visible: bool) {
        for f in self.feeds() {
            f.set_ui_visible(visible);
        }
    }
}

/// The stored `online_shown` value: None when the setting was never written.
pub fn parse_shown(value: Option<&str>) -> Option<Vec<Network>> {
    value.map(|v| v.split(',').filter_map(|n| Network::from_id(n.trim())).collect())
}

fn shown_value(networks: &[Network]) -> String {
    Network::ALL.iter().filter(|n| networks.contains(*n)).map(|n| n.id()).collect::<Vec<_>>().join(",")
}

fn choice_id(on: &[&FeedStatus]) -> &'static str {
    match on {
        [] => "off",
        [one] => one.network.id(),
        _ => "both",
    }
}

pub fn setting_key(network: Network) -> &'static str {
    match network {
        Network::Vatsim => SETTING_VATSIM,
        Network::Ivao => SETTING_IVAO,
    }
}

/// One network's feed status with its age, for the map, the online panel and Diagnose.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    #[serde(flatten)]
    pub status: FeedStatus,
    pub label: &'static str,
    /// Seconds since the last successful download (None before the first).
    pub age_s: Option<u64>,
}

/// What `online:summary` and `online_summary` deliver. The top-level fields keep the shape of the
/// former VATSIM-only status (totals over the enabled networks), so consumers that only ask
/// "on? how many? error?" work unchanged; `networks` has the per-network detail.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSummary {
    /// Enabled networks: "off", "vatsim", "ivao" or "both".
    pub network: &'static str,
    /// Networks enabled *and* shown on the map (what the map draws): "off", "vatsim", "ivao", "both".
    pub shown: &'static str,
    pub enabled: bool,
    pub pilots: usize,
    pub controllers: usize,
    pub atis: usize,
    pub prefiles: usize,
    pub update_timestamp: Option<String>,
    /// Oldest successful download among the enabled networks (None until each has one).
    pub fetched_ms: Option<u64>,
    /// First error among the enabled networks, prefixed with its network ("IVAO: …").
    pub last_error: Option<String>,
    pub consecutive_errors: u32,
    pub next_poll_s: u64,
    pub networks: Vec<NetworkStatus>,
}

impl OnlineSummary {
    pub fn from_statuses(statuses: Vec<FeedStatus>, now: u64) -> Self {
        let on: Vec<&FeedStatus> = statuses.iter().filter(|s| s.enabled).collect();
        let network = choice_id(&on);
        let shown = choice_id(&on.iter().copied().filter(|s| s.shown).collect::<Vec<_>>());
        let failing = on.iter().find(|s| s.last_error.is_some());
        let fetched_ms =
            if on.is_empty() || on.iter().any(|s| s.fetched_ms.is_none()) { None } else { on.iter().filter_map(|s| s.fetched_ms).min() };
        Self {
            network,
            shown,
            enabled: !on.is_empty(),
            pilots: on.iter().map(|s| s.pilots).sum(),
            controllers: on.iter().map(|s| s.controllers).sum(),
            atis: on.iter().map(|s| s.atis).sum(),
            prefiles: on.iter().map(|s| s.prefiles).sum(),
            update_timestamp: on.iter().filter_map(|s| s.update_timestamp.clone()).min(),
            fetched_ms,
            last_error: failing.and_then(|s| s.last_error.as_ref().map(|e| format!("{}: {e}", s.network.label()))),
            consecutive_errors: on.iter().map(|s| s.consecutive_errors).max().unwrap_or(0),
            next_poll_s: failing.map(|s| s.next_poll_s).or_else(|| on.iter().map(|s| s.next_poll_s).min()).unwrap_or(15),
            networks: statuses
                .into_iter()
                .map(|s| NetworkStatus { label: s.network.label(), age_s: s.fetched_ms.map(|f| now.saturating_sub(f) / 1000), status: s })
                .collect(),
        }
    }
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
    pub summary: OnlineSummary,
}

/// Start one network's poller; every poll (success or not) emits the combined summary.
pub fn start_feed(app: &AppHandle, feed: &OnlineFeed) {
    let app = app.clone();
    feed.start(tauri::async_runtime::handle().inner(), Arc::new(move |_: &FeedStatus| {
        let _ = app.emit("online:summary", app.state::<OnlineState>().summary());
    }));
}

/// Startup: resume the networks the user had on – polled from now on whether or not their
/// traffic is shown, so the track history is there when the map shows it.
pub fn restore(app: &AppHandle, store: &Store) {
    let online = app.state::<OnlineState>();
    let enabled: Vec<Network> =
        Network::ALL.into_iter().filter(|n| store.get_setting(setting_key(*n)).ok().flatten().as_deref() == Some("1")).collect();
    let shown = parse_shown(store.get_setting(SETTING_SHOWN).ok().flatten().as_deref()).unwrap_or_else(|| enabled.clone());
    for network in Network::ALL {
        let on = enabled.contains(&network);
        if network == Network::Vatsim {
            online.metar.set_vatsim_fallback(on);
        }
        let feed = online.feed(network);
        feed.set_shown(shown.contains(&network));
        if on {
            start_feed(app, feed);
        }
    }
}

fn parse_network(network: &str) -> Result<Network, String> {
    Network::from_id(network).ok_or_else(|| format!("unbekanntes Netzwerk '{network}'"))
}

fn apply_enabled(app: &AppHandle, store: &Store, online: &OnlineState, network: Network, enabled: bool) -> Result<(), String> {
    store.set_setting(setting_key(network), if enabled { "1" } else { "0" }).map_err(|e| e.to_string())?;
    if network == Network::Vatsim {
        // the VATSIM METAR fallback follows the switch: VATSIM off means no VATSIM server at all
        online.metar.set_vatsim_fallback(enabled);
    }
    let feed = online.feed(network);
    if enabled {
        start_feed(app, feed);
    } else {
        feed.stop();
    }
    Ok(())
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
            // the position only at DEBUG (it is where the user flies; Streamer-Modus)
            log::debug!("no airport near {lat:.4},{lon:.4} – no {slot:?} METAR");
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

/// Switch one network ("vatsim" or "ivao") on or off; the other keeps its state.
#[tauri::command]
pub fn online_set_enabled(
    network: String,
    enabled: bool,
    app: AppHandle,
    store: State<Store>,
    online: State<OnlineState>,
) -> Result<OnlineSummary, String> {
    apply_enabled(&app, &store, &online, parse_network(&network)?, enabled)?;
    let summary = online.summary();
    let _ = app.emit("online:summary", &summary);
    Ok(summary)
}

/// Set exactly these networks enabled (Settings → Online; empty = no network). Disabling one
/// stops its poller and drops its snapshot and track history; what the map shows is separate
/// (`online_set_shown`) – until the map's toggle was first used (`online_shown` never written),
/// the map shows the enabled networks, as before the split.
#[tauri::command]
pub fn online_set_networks(
    networks: Vec<String>,
    app: AppHandle,
    store: State<Store>,
    online: State<OnlineState>,
) -> Result<OnlineSummary, String> {
    let wanted = networks.iter().map(|n| parse_network(n)).collect::<Result<Vec<_>, _>>()?;
    let follow_enabled = store.get_setting(SETTING_SHOWN).ok().flatten().is_none();
    for network in Network::ALL {
        apply_enabled(&app, &store, &online, network, wanted.contains(&network))?;
        if follow_enabled {
            online.feed(network).set_shown(wanted.contains(&network));
        }
    }
    let summary = online.summary();
    let _ = app.emit("online:summary", &summary);
    Ok(summary)
}

/// The map's traffic toggle: show exactly these networks' traffic (empty = hide the traffic).
/// Purely visual for enabled networks – hiding only slows their pollers to the background rate
/// and keeps snapshot and history. Showing a network that is disabled enables it (picking
/// traffic on the map is the opt-in to download it).
#[tauri::command]
pub fn online_set_shown(
    networks: Vec<String>,
    app: AppHandle,
    store: State<Store>,
    online: State<OnlineState>,
) -> Result<OnlineSummary, String> {
    let wanted = networks.iter().map(|n| parse_network(n)).collect::<Result<Vec<_>, _>>()?;
    store.set_setting(SETTING_SHOWN, &shown_value(&wanted)).map_err(|e| e.to_string())?;
    for network in Network::ALL {
        let feed = online.feed(network);
        let show = wanted.contains(&network);
        feed.set_shown(show);
        if show && !feed.is_enabled() {
            apply_enabled(&app, &store, &online, network, true)?;
        }
    }
    let summary = online.summary();
    let _ = app.emit("online:summary", &summary);
    Ok(summary)
}

#[tauri::command]
pub fn online_summary(online: State<OnlineState>) -> OnlineSummary {
    online.summary()
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
    let summary = online.summary();
    // only what the map shows: a network enabled for its history alone draws nothing
    let snaps: Vec<_> = online.feeds().iter().filter(|f| f.is_shown()).filter_map(|f| f.snapshot()).collect();
    if snaps.is_empty() {
        return OnlineView { pilots: vec![], pilots_truncated: false, controllers: vec![], enroute: vec![], summary };
    }
    let limit = limit.unwrap_or(DEFAULT_PILOT_LIMIT);
    let all_pilots = snaps.iter().flat_map(|s| s.pilots.iter());
    let pilots: Vec<Pilot> =
        vectasim_online::pilots_in_bbox(all_pilots, min_lon, min_lat, max_lon, max_lat, limit + 1).into_iter().cloned().map(Pilot::lean).collect();
    let pilots_truncated = pilots.len() > limit;
    let pilots = pilots.into_iter().take(limit).collect();

    let all_controllers: Vec<Controller> = snaps.iter().flat_map(|s| s.controllers.iter().cloned()).collect();
    let controllers = all_controllers
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
    let enroute = enroute_in_view(&all_controllers, &airports, (min_lon, min_lat, max_lon, max_lat));
    OnlineView { pilots, pilots_truncated, controllers, enroute, summary }
}

/// A member id is only unique within its network; without `network` VATSIM is asked first.
#[tauri::command]
pub fn online_pilot(cid: u64, network: Option<String>, online: State<OnlineState>) -> Result<Option<Pilot>, String> {
    Ok(match network.as_deref().map(parse_network).transpose()? {
        Some(n) => online.feed(n).pilot(cid),
        None => online.feeds().iter().find_map(|f| f.pilot(cid)),
    })
}

/// The flown track of one pilot as the feed reported it since the app (or the network) started –
/// also while the traffic was hidden on the map (background polling): at most two hours / 480
/// fixes, oldest first (vectasim_online::history). The live map draws the selected aircraft's
/// altitude curtain from it.
#[tauri::command]
pub fn traffic_track(network: String, cid: u64, online: State<OnlineState>) -> Result<Vec<TrackFix>, String> {
    Ok(online.feed(parse_network(&network)?).track(cid))
}

/// Longest route text resolved (a filed route is a few hundred characters).
const ROUTE_MAX_CHARS: usize = 2000;

/// The filed route of a clicked aircraft as map points (TrafficCard "Show route"): resolved off
/// the main thread from the running MSFS (SimConnect facility data, through the provider's own
/// session), an installed X-Plane's nav data and the bundled OurAirports navaids – see
/// `vectasim_route`. Cached per (departure, arrival, route text, simulator connected) for the
/// app session; nothing is sent over the network.
#[tauri::command]
pub async fn traffic_route_resolve(
    dep: String,
    arr: String,
    route: String,
    online: State<'_, OnlineState>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<RouteResolution, String> {
    let route: String = route.chars().take(ROUTE_MAX_CHARS).collect();
    let (dep, arr): (String, String) = (dep.chars().take(8).collect(), arr.chars().take(8).collect());
    let broker = vectasim_simconnect::facility::global();
    let key = RouteCache::key(&dep, &arr, &route, broker.available());
    if let Some(hit) = online.routes.get(&key) {
        return Ok((*hit).clone());
    }
    let (airports, cache) = (airports.inner().clone(), online.routes.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let (r, cacheable) = vectasim_route::resolve_here(&dep, &arr, &route, &airports, broker);
        log::info!(
            "route {dep}→{arr}: {} of {} waypoints, {} airways expanded, sources {:?}, {} ms",
            r.resolved_count,
            r.total,
            r.airways_expanded,
            r.sources,
            started.elapsed().as_millis()
        );
        if cacheable {
            cache.put(key, Arc::new(r.clone()));
        }
        r
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn online_nearby(lat: f64, lon: f64, n: Option<usize>, online: State<OnlineState>) -> Vec<NearbyPilot> {
    let snaps: Vec<_> = online.feeds().iter().filter_map(|f| f.snapshot()).collect();
    vectasim_online::nearest_pilots(snaps.iter().flat_map(|s| s.pilots.iter()), lat, lon, n.unwrap_or(10).min(50))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn on(network: Network, pilots: usize, fetched_ms: Option<u64>, error: Option<&str>) -> FeedStatus {
        FeedStatus {
            enabled: true,
            pilots,
            controllers: 2,
            fetched_ms,
            last_error: error.map(str::to_string),
            next_poll_s: if error.is_some() { 60 } else { 15 },
            ..FeedStatus::idle(network)
        }
    }

    #[test]
    fn shown_setting_round_trip() {
        assert_eq!(parse_shown(None), None);
        assert_eq!(parse_shown(Some("")), Some(vec![]));
        assert_eq!(parse_shown(Some("ivao")), Some(vec![Network::Ivao]));
        assert_eq!(parse_shown(Some("vatsim, ivao,garbage")), Some(vec![Network::Vatsim, Network::Ivao]));
        assert_eq!(shown_value(&[Network::Ivao, Network::Vatsim]), "vatsim,ivao");
        assert_eq!(shown_value(&[]), "");
        assert_eq!(parse_shown(Some(&shown_value(&[Network::Ivao]))), Some(vec![Network::Ivao]));
    }

    #[test]
    fn summary_off_single_and_both() {
        let off = OnlineSummary::from_statuses(vec![FeedStatus::idle(Network::Vatsim), FeedStatus::idle(Network::Ivao)], 0);
        assert_eq!((off.network, off.enabled, off.pilots, off.fetched_ms), ("off", false, 0, None));
        assert_eq!(off.networks.len(), 2);

        // only IVAO on: its numbers, the VATSIM status still listed (Diagnose)
        let ivao = OnlineSummary::from_statuses(vec![FeedStatus::idle(Network::Vatsim), on(Network::Ivao, 7, Some(10_000), None)], 25_000);
        assert_eq!((ivao.network, ivao.pilots, ivao.controllers, ivao.fetched_ms), ("ivao", 7, 2, Some(10_000)));
        assert_eq!(ivao.networks[1].age_s, Some(15));
        assert_eq!(ivao.networks[0].age_s, None);

        // both: totals, oldest download, the failing network named in the error
        let both = OnlineSummary::from_statuses(
            vec![on(Network::Vatsim, 100, Some(20_000), None), on(Network::Ivao, 7, Some(10_000), Some("HTTP 503 from x"))],
            30_000,
        );
        assert_eq!((both.network, both.pilots, both.fetched_ms), ("both", 107, Some(10_000)));
        assert_eq!(both.last_error.as_deref(), Some("IVAO: HTTP 503 from x"));
        assert_eq!(both.next_poll_s, 60);

        // waiting for the first IVAO download: "warte auf ersten Abruf" until both have data
        let waiting = OnlineSummary::from_statuses(vec![on(Network::Vatsim, 100, Some(20_000), None), on(Network::Ivao, 0, None, None)], 30_000);
        assert_eq!(waiting.fetched_ms, None);

        assert_eq!(both.shown, "off");

        // shown on the map: only enabled networks count (IVAO shown but disabled draws nothing)
        let shown = |mut s: FeedStatus| {
            s.shown = true;
            s
        };
        let one = OnlineSummary::from_statuses(
            vec![shown(on(Network::Vatsim, 100, Some(20_000), None)), shown(FeedStatus::idle(Network::Ivao))],
            30_000,
        );
        assert_eq!((one.network, one.shown), ("vatsim", "vatsim"));
        let hidden = OnlineSummary::from_statuses(
            vec![on(Network::Vatsim, 100, Some(20_000), None), shown(on(Network::Ivao, 7, Some(1), None))],
            30_000,
        );
        assert_eq!((hidden.network, hidden.shown), ("both", "ivao"));

        let json = serde_json::to_value(&both).unwrap();
        assert_eq!(json["shown"], "off");
        assert_eq!(json["networks"][1]["backgroundPollS"], 60);
        assert_eq!(json["networks"][1]["network"], "ivao");
        assert_eq!(json["networks"][1]["label"], "IVAO");
        assert_eq!(json["networks"][0]["ageS"], 10);
    }
}
