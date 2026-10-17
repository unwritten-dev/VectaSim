//! VATSIM v3 data feed: model, parser and the background poller.
//!
//! The data file (~5 MB, a few MB less with gzip) lists every connected pilot,
//! controller, ATIS and prefile. We keep only the fields the map needs and
//! drop observers and controllers that are not on a frequency, so a snapshot
//! stays well under a megabyte in memory.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::{OnlineError, USER_AGENT, now_ms};

/// VATSIM regenerates the data file every 15 s; anything faster returns the same bytes.
pub const MIN_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Backoff ceiling when the feed keeps failing (network down, VATSIM outage).
pub const MAX_POLL_INTERVAL: Duration = Duration::from_secs(300);

const STATUS_URL: &str = "https://status.vatsim.net/status.json";
const DEFAULT_DATA_URL: &str = "https://data.vatsim.net/v3/vatsim-data.json";
/// VATSIM's placeholder frequency for controllers who are logged in but not on a position.
const NO_FREQUENCY: &str = "199.998";

// ---- public model -------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pilot {
    pub cid: u64,
    pub callsign: String,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_ft: i32,
    pub ground_speed_kt: i32,
    pub heading_deg: i32,
    pub transponder: String,
    /// ICAO type designator from the flight plan ("B738"); empty without a flight plan.
    pub aircraft_short: String,
    pub departure: String,
    pub arrival: String,
    pub route: String,
    /// "I" or "V" from the flight plan.
    pub flight_rules: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Facility {
    Fss,
    Del,
    Gnd,
    Twr,
    App,
    Ctr,
    Atis,
}

impl Facility {
    fn from_code(code: i64) -> Option<Facility> {
        Some(match code {
            1 => Facility::Fss,
            2 => Facility::Del,
            3 => Facility::Gnd,
            4 => Facility::Twr,
            5 => Facility::App,
            6 => Facility::Ctr,
            _ => return None, // 0 = observer
        })
    }

    /// Centre and flight-service stations cover a FIR, not an airport. We have no
    /// FIR polygons, so the UI lists these instead of placing them on the map.
    pub fn is_enroute(self) -> bool {
        matches!(self, Facility::Fss | Facility::Ctr)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    pub cid: u64,
    pub callsign: String,
    pub frequency: String,
    pub facility: Facility,
    pub visual_range_nm: u32,
    pub text_atis: Vec<String>,
    /// Current ATIS letter, only for ATIS stations.
    pub atis_code: Option<String>,
}

impl Controller {
    /// The part before the first underscore: "EDDF" for "EDDF_N_APP", "EDGG" for "EDGG_CTR".
    /// Usually an ICAO code, sometimes a 3-letter IATA/FAA id ("JFK_TWR", "NY_CTR").
    pub fn station_prefix(&self) -> &str {
        self.callsign.split('_').next().unwrap_or(&self.callsign)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefile {
    pub cid: u64,
    pub callsign: String,
    pub aircraft_short: String,
    pub departure: String,
    pub arrival: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyPilot {
    #[serde(flatten)]
    pub pilot: Pilot,
    pub distance_nm: f64,
}

/// One parsed data file.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VatsimSnapshot {
    /// `general.update_timestamp` as VATSIM wrote it (ISO 8601, UTC).
    pub update_timestamp: String,
    /// Local wall clock when we received it (Unix ms).
    pub fetched_ms: u64,
    pub pilots: Vec<Pilot>,
    /// Controllers and ATIS stations on a frequency.
    pub controllers: Vec<Controller>,
    pub prefiles: Vec<Prefile>,
}

impl VatsimSnapshot {
    pub fn pilot(&self, cid: u64) -> Option<&Pilot> {
        self.pilots.iter().find(|p| p.cid == cid)
    }

    /// Pilots inside the box. Handles boxes crossing the antimeridian (`min_lon > max_lon`).
    /// When more than `limit` match, the ones closest to the box centre win so a
    /// zoomed-out view still shows the traffic the user is looking at.
    pub fn pilots_in_bbox(&self, min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64, limit: usize) -> Vec<&Pilot> {
        let in_lon = |lon: f64| if min_lon <= max_lon { lon >= min_lon && lon <= max_lon } else { lon >= min_lon || lon <= max_lon };
        let mut found: Vec<&Pilot> =
            self.pilots.iter().filter(|p| p.latitude >= min_lat && p.latitude <= max_lat && in_lon(p.longitude)).collect();
        if found.len() > limit {
            let clat = (min_lat + max_lat) / 2.0;
            let mut clon = (min_lon + max_lon) / 2.0;
            if min_lon > max_lon {
                clon = if clon > 0.0 { clon - 180.0 } else { clon + 180.0 };
            }
            found.sort_by(|a, b| {
                haversine_nm(clat, clon, a.latitude, a.longitude).total_cmp(&haversine_nm(clat, clon, b.latitude, b.longitude))
            });
            found.truncate(limit);
        }
        found
    }

    /// The `n` pilots closest to a point, nearest first.
    pub fn nearest_pilots(&self, lat: f64, lon: f64, n: usize) -> Vec<NearbyPilot> {
        let mut all: Vec<(f64, &Pilot)> = self.pilots.iter().map(|p| (haversine_nm(lat, lon, p.latitude, p.longitude), p)).collect();
        all.sort_by(|a, b| a.0.total_cmp(&b.0));
        all.into_iter().take(n).map(|(d, p)| NearbyPilot { pilot: p.clone(), distance_nm: d }).collect()
    }
}

/// Great-circle distance in nautical miles.
pub fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * 3440.065 * a.sqrt().asin()
}

// ---- raw v3 shapes --------------------------------------------------------------------
// Everything defaulted: VATSIM adds fields freely and leaves flight plans null.

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawData {
    general: RawGeneral,
    pilots: Vec<RawPilot>,
    controllers: Vec<RawController>,
    atis: Vec<RawController>,
    prefiles: Vec<RawPrefile>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawGeneral {
    update_timestamp: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPilot {
    cid: u64,
    callsign: String,
    latitude: f64,
    longitude: f64,
    altitude: f64,
    groundspeed: f64,
    heading: f64,
    transponder: String,
    flight_plan: Option<RawFlightPlan>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawFlightPlan {
    flight_rules: String,
    aircraft_short: String,
    departure: String,
    arrival: String,
    route: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawController {
    cid: u64,
    callsign: String,
    frequency: String,
    facility: i64,
    visual_range: f64,
    text_atis: Option<Vec<String>>,
    atis_code: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawPrefile {
    cid: u64,
    callsign: String,
    flight_plan: Option<RawFlightPlan>,
}

fn controller_from_raw(c: RawController, is_atis: bool) -> Option<Controller> {
    let facility = if is_atis { Facility::Atis } else { Facility::from_code(c.facility)? };
    if c.frequency.is_empty() || c.frequency == NO_FREQUENCY {
        return None;
    }
    Some(Controller {
        cid: c.cid,
        callsign: c.callsign,
        frequency: c.frequency,
        facility,
        visual_range_nm: c.visual_range.max(0.0) as u32,
        text_atis: c.text_atis.unwrap_or_default(),
        atis_code: c.atis_code.filter(|s| !s.is_empty()),
    })
}

/// Parse a v3 data file into a snapshot (fetch time set to now).
pub fn parse_vatsim_json(bytes: &[u8]) -> Result<VatsimSnapshot, OnlineError> {
    let raw: RawData = serde_json::from_slice(bytes).map_err(|e| OnlineError::Parse(e.to_string()))?;
    let pilots = raw
        .pilots
        .into_iter()
        .map(|p| {
            let fp = p.flight_plan.unwrap_or_default();
            Pilot {
                cid: p.cid,
                callsign: p.callsign,
                latitude: p.latitude,
                longitude: p.longitude,
                altitude_ft: p.altitude.round() as i32,
                ground_speed_kt: p.groundspeed.round() as i32,
                heading_deg: p.heading.round() as i32,
                transponder: p.transponder,
                aircraft_short: fp.aircraft_short,
                departure: fp.departure,
                arrival: fp.arrival,
                route: fp.route,
                flight_rules: fp.flight_rules,
            }
        })
        .collect();
    let controllers = raw
        .controllers
        .into_iter()
        .filter_map(|c| controller_from_raw(c, false))
        .chain(raw.atis.into_iter().filter_map(|c| controller_from_raw(c, true)))
        .collect();
    let prefiles = raw
        .prefiles
        .into_iter()
        .map(|p| {
            let fp = p.flight_plan.unwrap_or_default();
            Prefile { cid: p.cid, callsign: p.callsign, aircraft_short: fp.aircraft_short, departure: fp.departure, arrival: fp.arrival }
        })
        .collect();
    Ok(VatsimSnapshot { update_timestamp: raw.general.update_timestamp, fetched_ms: now_ms(), pilots, controllers, prefiles })
}

// ---- poller -------------------------------------------------------------------------

/// What the UI shows about the feed; emitted after every poll.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub network: &'static str,
    pub enabled: bool,
    pub pilots: usize,
    pub controllers: usize,
    pub atis: usize,
    pub prefiles: usize,
    pub update_timestamp: Option<String>,
    pub fetched_ms: Option<u64>,
    pub last_error: Option<String>,
    pub consecutive_errors: u32,
    /// Seconds until the next poll (15 normally, more while backing off).
    pub next_poll_s: u64,
}

impl Default for FeedStatus {
    fn default() -> Self {
        Self {
            network: "vatsim",
            enabled: false,
            pilots: 0,
            controllers: 0,
            atis: 0,
            prefiles: 0,
            update_timestamp: None,
            fetched_ms: None,
            last_error: None,
            consecutive_errors: 0,
            next_poll_s: MIN_POLL_INTERVAL.as_secs(),
        }
    }
}

pub type UpdateCallback = Arc<dyn Fn(&FeedStatus) + Send + Sync>;

struct Inner {
    client: reqwest::Client,
    data_url: Mutex<Option<String>>,
    snapshot: RwLock<Option<Arc<VatsimSnapshot>>>,
    status: Mutex<FeedStatus>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Survives stop/start so toggling the setting cannot hammer the endpoint.
    last_fetch: Mutex<Option<Instant>>,
}

/// Background VATSIM poller. Cheap to clone; all clones share one task and snapshot.
#[derive(Clone)]
pub struct VatsimFeed {
    inner: Arc<Inner>,
}

impl Default for VatsimFeed {
    fn default() -> Self {
        Self::new()
    }
}

/// Exponential backoff: 15 s, 30 s, 60 s … capped at five minutes.
pub fn backoff_delay(consecutive_errors: u32) -> Duration {
    let factor = 1u32 << consecutive_errors.min(5);
    (MIN_POLL_INTERVAL * factor).min(MAX_POLL_INTERVAL)
}

impl VatsimFeed {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: Arc::new(Inner {
                client,
                data_url: Mutex::new(None),
                snapshot: RwLock::new(None),
                status: Mutex::new(FeedStatus::default()),
                task: Mutex::new(None),
                last_fetch: Mutex::new(None),
            }),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub fn status(&self) -> FeedStatus {
        self.inner.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn snapshot(&self) -> Option<Arc<VatsimSnapshot>> {
        self.inner.snapshot.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Replace the snapshot (used by the poller; handy for tests and offline demos).
    pub fn set_snapshot(&self, snap: VatsimSnapshot) {
        let mut st = self.inner.status.lock().unwrap_or_else(|e| e.into_inner());
        st.pilots = snap.pilots.len();
        st.atis = snap.controllers.iter().filter(|c| c.facility == Facility::Atis).count();
        st.controllers = snap.controllers.len() - st.atis;
        st.prefiles = snap.prefiles.len();
        st.update_timestamp = Some(snap.update_timestamp.clone());
        st.fetched_ms = Some(snap.fetched_ms);
        *self.inner.snapshot.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(snap));
    }

    /// Start polling on `rt` (no-op if already running). `on_update` runs after every poll, success or not.
    pub fn start(&self, rt: &tokio::runtime::Handle, on_update: UpdateCallback) {
        let mut task = self.inner.task.lock().unwrap_or_else(|e| e.into_inner());
        if task.is_some() {
            return;
        }
        {
            let mut st = self.inner.status.lock().unwrap_or_else(|e| e.into_inner());
            st.enabled = true;
            st.last_error = None;
            st.consecutive_errors = 0;
        }
        let inner = self.inner.clone();
        *task = Some(rt.spawn(poll_loop(inner, on_update)));
        log::info!("VATSIM feed started");
    }

    /// Stop polling and drop the snapshot, so a disabled network shows no stale traffic.
    pub fn stop(&self) {
        if let Some(t) = self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            t.abort();
            log::info!("VATSIM feed stopped");
        }
        *self.inner.snapshot.write().unwrap_or_else(|e| e.into_inner()) = None;
        *self.inner.status.lock().unwrap_or_else(|e| e.into_inner()) = FeedStatus::default();
    }

    pub fn pilot(&self, cid: u64) -> Option<Pilot> {
        self.snapshot()?.pilot(cid).cloned()
    }

    pub fn pilots_in_bbox(&self, min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64, limit: usize) -> Vec<Pilot> {
        self.snapshot()
            .map(|s| s.pilots_in_bbox(min_lon, min_lat, max_lon, max_lat, limit).into_iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn nearest_pilots(&self, lat: f64, lon: f64, n: usize) -> Vec<NearbyPilot> {
        self.snapshot().map(|s| s.nearest_pilots(lat, lon, n)).unwrap_or_default()
    }
}

async fn poll_loop(inner: Arc<Inner>, on_update: UpdateCallback) {
    loop {
        // Honour the 15 s floor even if the feed was just restarted.
        let since_last = inner.last_fetch.lock().unwrap_or_else(|e| e.into_inner()).map(|t| t.elapsed());
        if let Some(elapsed) = since_last
            && elapsed < MIN_POLL_INTERVAL
        {
            tokio::time::sleep(MIN_POLL_INTERVAL - elapsed).await;
        }
        *inner.last_fetch.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());

        let result = fetch_once(&inner).await;
        let feed = VatsimFeed { inner: inner.clone() };
        let delay = match result {
            Ok(snap) => {
                // stop() may have run while the request was in flight; don't resurrect its data.
                if !inner.status.lock().unwrap_or_else(|e| e.into_inner()).enabled {
                    return;
                }
                feed.set_snapshot(snap);
                let mut st = inner.status.lock().unwrap_or_else(|e| e.into_inner());
                st.last_error = None;
                st.consecutive_errors = 0;
                st.next_poll_s = MIN_POLL_INTERVAL.as_secs();
                MIN_POLL_INTERVAL
            }
            Err(e) => {
                log::warn!("VATSIM feed: {e}");
                let mut st = inner.status.lock().unwrap_or_else(|e| e.into_inner());
                st.consecutive_errors += 1;
                st.last_error = Some(e.to_string());
                let d = backoff_delay(st.consecutive_errors);
                st.next_poll_s = d.as_secs();
                // A failing discovered URL may have moved; rediscover next time.
                *inner.data_url.lock().unwrap_or_else(|e| e.into_inner()) = None;
                d
            }
        };
        on_update(&feed.status());
        tokio::time::sleep(delay).await;
    }
}

async fn fetch_once(inner: &Inner) -> Result<VatsimSnapshot, OnlineError> {
    let url = data_url(inner).await;
    let resp = inner.client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(OnlineError::Http { status: resp.status().as_u16(), url });
    }
    let bytes = resp.bytes().await?;
    parse_vatsim_json(&bytes)
}

/// The data URL from status.json (VATSIM's documented discovery), cached; the
/// well-known URL if discovery fails so an outage of the status host is harmless.
async fn data_url(inner: &Inner) -> String {
    if let Some(u) = inner.data_url.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return u;
    }
    #[derive(Deserialize)]
    struct Status {
        data: StatusData,
    }
    #[derive(Deserialize)]
    struct StatusData {
        v3: Vec<String>,
    }
    let discovered = async {
        let resp = inner.client.get(STATUS_URL).send().await.ok()?;
        let s: Status = resp.json().await.ok()?;
        s.data.v3.into_iter().find(|u| u.starts_with("https://"))
    }
    .await;
    let url = discovered.unwrap_or_else(|| DEFAULT_DATA_URL.to_string());
    *inner.data_url.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.clone());
    url
}
