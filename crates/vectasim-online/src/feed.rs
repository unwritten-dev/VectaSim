//! Background poller for one online network's data file (VATSIM v3 or IVAO Whazzup v2).
//!
//! Both networks regenerate their file every 15 s, and both ask clients not to download it more
//! often (IVAO bans IPs that do, see `ivao.rs`). The feed enforces that floor even across
//! stop/start and backs off on errors. One poller per network serves every map view through the
//! cached [`OnlineSnapshot`].

use serde::Serialize;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crate::history::{TrackFix, TrackHistory};
use crate::model::{Facility, NearbyPilot, Network, OnlineSnapshot, Pilot};
use crate::{OnlineError, ivao, vatsim};

/// Both networks regenerate their data file every 15 s; anything faster returns the same bytes
/// (and on IVAO risks an IP ban).
pub const MIN_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Backoff ceiling when the feed keeps failing (network down, outage).
pub const MAX_POLL_INTERVAL: Duration = Duration::from_secs(300);
/// The IVAO file is ~1.2 MB (≈200 kB gzip); give slow lines a bit more than VATSIM needs.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// What the UI shows about the feed; emitted after every poll.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub network: Network,
    pub enabled: bool,
    pub pilots: usize,
    pub controllers: usize,
    pub atis: usize,
    pub prefiles: usize,
    pub update_timestamp: Option<String>,
    pub fetched_ms: Option<u64>,
    /// URL of the last download (Diagnose: where the data comes from).
    pub source: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_errors: u32,
    /// Seconds until the next poll (15 normally, more while backing off).
    pub next_poll_s: u64,
}

impl FeedStatus {
    pub fn idle(network: Network) -> Self {
        Self {
            network,
            enabled: false,
            pilots: 0,
            controllers: 0,
            atis: 0,
            prefiles: 0,
            update_timestamp: None,
            fetched_ms: None,
            source: None,
            last_error: None,
            consecutive_errors: 0,
            next_poll_s: MIN_POLL_INTERVAL.as_secs(),
        }
    }
}

impl Default for FeedStatus {
    fn default() -> Self {
        Self::idle(Network::Vatsim)
    }
}

pub type UpdateCallback = Arc<dyn Fn(&FeedStatus) + Send + Sync>;

pub(crate) struct Inner {
    pub(crate) network: Network,
    pub(crate) client: reqwest::Client,
    /// VATSIM: the data URL discovered through status.json (cached until a fetch fails).
    pub(crate) data_url: Mutex<Option<String>>,
    snapshot: RwLock<Option<Arc<OnlineSnapshot>>>,
    /// Flown track per pilot from the snapshots (history.rs; bounded, cleared by `stop`).
    history: Mutex<TrackHistory>,
    status: Mutex<FeedStatus>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Survives stop/start so toggling the setting cannot hammer the endpoint.
    last_fetch: Mutex<Option<Instant>>,
}

/// Background poller for one network. Cheap to clone; all clones share one task and snapshot.
#[derive(Clone)]
pub struct OnlineFeed {
    inner: Arc<Inner>,
}

/// The former name, from when VATSIM was the only network.
pub type VatsimFeed = OnlineFeed;

/// Exponential backoff: 15 s, 30 s, 60 s … capped at five minutes.
pub fn backoff_delay(consecutive_errors: u32) -> Duration {
    let factor = 1u32 << consecutive_errors.min(5);
    (MIN_POLL_INTERVAL * factor).min(MAX_POLL_INTERVAL)
}

impl OnlineFeed {
    pub fn new(network: Network) -> Self {
        let client = crate::client(REQUEST_TIMEOUT);
        Self {
            inner: Arc::new(Inner {
                network,
                client,
                data_url: Mutex::new(None),
                snapshot: RwLock::new(None),
                history: Mutex::new(TrackHistory::default()),
                status: Mutex::new(FeedStatus::idle(network)),
                task: Mutex::new(None),
                last_fetch: Mutex::new(None),
            }),
        }
    }

    pub fn vatsim() -> Self {
        Self::new(Network::Vatsim)
    }

    pub fn ivao() -> Self {
        Self::new(Network::Ivao)
    }

    pub fn network(&self) -> Network {
        self.inner.network
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub fn status(&self) -> FeedStatus {
        self.inner.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn snapshot(&self) -> Option<Arc<OnlineSnapshot>> {
        self.inner.snapshot.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Replace the snapshot (used by the poller; handy for tests and offline demos).
    pub fn set_snapshot(&self, snap: OnlineSnapshot) {
        let mut st = self.inner.status.lock().unwrap_or_else(|e| e.into_inner());
        st.pilots = snap.pilots.len();
        st.atis = snap.controllers.iter().filter(|c| c.facility == Facility::Atis).count();
        st.controllers = snap.controllers.len() - st.atis;
        st.prefiles = snap.prefiles.len();
        st.update_timestamp = Some(snap.update_timestamp.clone());
        st.fetched_ms = Some(snap.fetched_ms);
        self.inner.history.lock().unwrap_or_else(|e| e.into_inner()).record(&snap.pilots, snap.fetched_ms);
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
        log::info!("{} feed started", self.inner.network.label());
    }

    /// Stop polling and drop the snapshot, so a disabled network shows no stale traffic.
    pub fn stop(&self) {
        if let Some(t) = self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            t.abort();
            log::info!("{} feed stopped", self.inner.network.label());
        }
        *self.inner.snapshot.write().unwrap_or_else(|e| e.into_inner()) = None;
        self.inner.history.lock().unwrap_or_else(|e| e.into_inner()).clear();
        *self.inner.status.lock().unwrap_or_else(|e| e.into_inner()) = FeedStatus::idle(self.inner.network);
    }

    pub fn pilot(&self, cid: u64) -> Option<Pilot> {
        self.snapshot()?.pilot(cid).cloned()
    }

    /// The pilot's flown track from the snapshots so far, oldest first (history.rs).
    pub fn track(&self, cid: u64) -> Vec<TrackFix> {
        self.inner.history.lock().unwrap_or_else(|e| e.into_inner()).track(cid)
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
    let label = inner.network.label();
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
        let feed = OnlineFeed { inner: inner.clone() };
        let delay = match result {
            Ok((snap, url)) => {
                // stop() may have run while the request was in flight; don't resurrect its data.
                if !inner.status.lock().unwrap_or_else(|e| e.into_inner()).enabled {
                    return;
                }
                feed.set_snapshot(snap);
                let mut st = inner.status.lock().unwrap_or_else(|e| e.into_inner());
                st.source = Some(url);
                st.last_error = None;
                st.consecutive_errors = 0;
                st.next_poll_s = MIN_POLL_INTERVAL.as_secs();
                MIN_POLL_INTERVAL
            }
            Err(e) => {
                log::warn!("{label} feed: {e}");
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

/// One download and parse; returns the snapshot and the URL it came from.
async fn fetch_once(inner: &Inner) -> Result<(OnlineSnapshot, String), OnlineError> {
    let url = match inner.network {
        Network::Vatsim => vatsim::data_url(inner).await,
        Network::Ivao => ivao::DATA_URL.to_string(),
    };
    let resp = inner.client.get(&url).send().await?;
    if resp.status().as_u16() == 429 {
        return Err(OnlineError::RateLimited);
    }
    if !resp.status().is_success() {
        return Err(OnlineError::Http { status: resp.status().as_u16(), url });
    }
    let bytes = crate::read_limited(resp, crate::MAX_FEED_BYTES).await?;
    let snap = match inner.network {
        Network::Vatsim => vatsim::parse_vatsim_json(&bytes)?,
        Network::Ivao => ivao::parse_ivao_json(&bytes)?,
    };
    Ok((snap, url))
}
