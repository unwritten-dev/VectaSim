//! Background poller for one online network's data file (VATSIM v3 or IVAO Whazzup v2).
//!
//! Both networks regenerate their file every 15 s, and both ask clients not to download it more
//! often (IVAO bans IPs that do, see `ivao.rs`). The feed enforces that floor even across
//! stop/start and backs off on errors. One poller per network serves every map view through the
//! cached [`OnlineSnapshot`].
//!
//! The poller runs while the network is *enabled* (Settings), whether or not its traffic is
//! *shown* on the map: hidden (or with the window hidden) it polls every
//! [`BACKGROUND_POLL_INTERVAL`] and keeps recording the flown tracks (history.rs), so a click
//! on an aircraft after switching the traffic on shows its last two hours, not only the minutes
//! since. Showing the traffic again wakes the poller and returns it to the 15 s rate.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::Notify;
// tokio's clock (not std's): the wait for the next poll can be tested with paused time
use tokio::time::Instant;

use crate::history::{TrackFix, TrackHistory};
use crate::model::{Facility, NearbyPilot, Network, OnlineSnapshot, Pilot};
use crate::{OnlineError, ivao, vatsim};

/// Both networks regenerate their data file every 15 s; anything faster returns the same bytes
/// (and on IVAO risks an IP ban).
pub const MIN_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Backoff ceiling when the feed keeps failing (network down, outage).
pub const MAX_POLL_INTERVAL: Duration = Duration::from_secs(300);
/// Poll interval while the traffic is not shown on the map or the window is hidden: enough for
/// the track history (history.rs), a quarter of the downloads.
pub const BACKGROUND_POLL_INTERVAL: Duration = Duration::from_secs(60);
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
    /// Seconds until the next poll (15 shown, 60 in the background, more while backing off).
    pub next_poll_s: u64,
    /// The network's traffic is shown on the map (the map's traffic toggle; kept while disabled).
    pub shown: bool,
    /// Polling at the background rate (traffic not shown on the map, or the window hidden).
    pub background: bool,
    /// The background rate in seconds ([`BACKGROUND_POLL_INTERVAL`]).
    pub background_poll_s: u64,
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
            shown: false,
            background: true,
            background_poll_s: BACKGROUND_POLL_INTERVAL.as_secs(),
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
    /// Flown track per pilot from the snapshots (history.rs; bounded, cleared by `stop` only –
    /// hiding the traffic keeps it).
    history: Mutex<TrackHistory>,
    status: Mutex<FeedStatus>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Survives stop/start so toggling the setting cannot hammer the endpoint.
    last_fetch: Mutex<Option<Instant>>,
    /// Traffic shown on the map (survives stop/start: it is the map's choice, not the feed's).
    shown: AtomicBool,
    /// The app window is visible (`set_ui_visible`).
    ui_visible: AtomicBool,
    /// Wakes the sleeping poller when the rate changes (traffic shown again, window visible).
    wake: Notify,
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

/// Time between two polls: 15 s while the traffic is shown and the window visible
/// (`foreground`), 60 s in the background; after errors the backoff, never faster than that.
pub fn poll_interval(foreground: bool, consecutive_errors: u32) -> Duration {
    let base = if foreground { MIN_POLL_INTERVAL } else { BACKGROUND_POLL_INTERVAL };
    if consecutive_errors == 0 { base } else { backoff_delay(consecutive_errors).max(base) }
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
                shown: AtomicBool::new(false),
                ui_visible: AtomicBool::new(true),
                wake: Notify::new(),
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
        let mut st = self.inner.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        st.shown = self.is_shown();
        st.background = !self.inner.foreground();
        st
    }

    /// The network's traffic is shown on the map.
    pub fn is_shown(&self) -> bool {
        self.inner.shown.load(Ordering::Relaxed)
    }

    /// The map shows (true) or hides this network's traffic. Hiding only slows the poller to the
    /// background rate – snapshot and track history stay; showing wakes it (15 s again).
    pub fn set_shown(&self, shown: bool) {
        if self.inner.shown.swap(shown, Ordering::Relaxed) != shown {
            self.rate_changed();
        }
    }

    /// The app window is visible; while hidden the poller runs at the background rate.
    pub fn set_ui_visible(&self, visible: bool) {
        if self.inner.ui_visible.swap(visible, Ordering::Relaxed) != visible {
            self.rate_changed();
        }
    }

    /// The interval the poller uses now (shown / hidden / backing off).
    pub fn poll_interval(&self) -> Duration {
        self.inner.interval()
    }

    fn rate_changed(&self) {
        let d = self.inner.interval();
        self.inner.status.lock().unwrap_or_else(|e| e.into_inner()).next_poll_s = d.as_secs();
        self.inner.wake.notify_waiters();
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

    /// Stop polling and drop snapshot and track history (the network was disabled), so a
    /// disabled network shows no stale traffic. Hiding the traffic on the map never calls this.
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

impl Inner {
    /// Traffic shown and the window visible: the 15 s rate.
    fn foreground(&self) -> bool {
        self.shown.load(Ordering::Relaxed) && self.ui_visible.load(Ordering::Relaxed)
    }

    fn interval(&self) -> Duration {
        let errors = self.status.lock().unwrap_or_else(|e| e.into_inner()).consecutive_errors;
        poll_interval(self.foreground(), errors)
    }

    /// Sleep until `interval` after the last download, re-evaluated whenever the rate changes:
    /// showing the traffic cuts a 60 s wait short (never below the 15 s floor).
    async fn wait_until_due(&self, interval: fn(&Self) -> Duration) {
        loop {
            // registered before the deadline is read, so a change in between is not missed
            let woken = self.wake.notified();
            let Some(last) = *self.last_fetch.lock().unwrap_or_else(|e| e.into_inner()) else { return };
            let due = last + interval(self);
            if Instant::now() >= due {
                return;
            }
            tokio::select! {
                _ = tokio::time::sleep_until(due) => return,
                _ = woken => {}
            }
        }
    }
}

async fn poll_loop(inner: Arc<Inner>, on_update: UpdateCallback) {
    let label = inner.network.label();
    // just (re)started: only the 15 s floor since the last download applies
    inner.wait_until_due(|_| MIN_POLL_INTERVAL).await;
    loop {
        *inner.last_fetch.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());

        let result = fetch_once(&inner).await;
        let feed = OnlineFeed { inner: inner.clone() };
        match result {
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
                st.next_poll_s = poll_interval(inner.foreground(), 0).as_secs();
            }
            Err(e) => {
                log::warn!("{label} feed: {e}");
                let mut st = inner.status.lock().unwrap_or_else(|e| e.into_inner());
                st.consecutive_errors += 1;
                st.last_error = Some(e.to_string());
                st.next_poll_s = poll_interval(inner.foreground(), st.consecutive_errors).as_secs();
                // A failing discovered URL may have moved; rediscover next time.
                *inner.data_url.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
        }
        on_update(&feed.status());
        inner.wait_until_due(Inner::interval).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting(feed: &OnlineFeed) -> tokio::task::JoinHandle<Duration> {
        let inner = feed.inner.clone();
        tokio::spawn(async move {
            let start = Instant::now();
            inner.wait_until_due(Inner::interval).await;
            start.elapsed()
        })
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn hidden_waits_the_background_rate_and_showing_cuts_it_short() {
        let feed = OnlineFeed::vatsim();
        *feed.inner.last_fetch.lock().unwrap() = Some(Instant::now());
        // hidden: the next poll is 60 s after the last one
        assert_eq!(waiting(&feed).await.unwrap(), BACKGROUND_POLL_INTERVAL);

        // shown after 5 s of a 60 s wait: the poll comes 15 s after the last one, not 60
        *feed.inner.last_fetch.lock().unwrap() = Some(Instant::now());
        let h = waiting(&feed);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!h.is_finished());
        feed.set_shown(true);
        assert_eq!(h.await.unwrap(), MIN_POLL_INTERVAL);

        // shown 40 s after the last poll: due at once
        *feed.inner.last_fetch.lock().unwrap() = Some(Instant::now());
        feed.set_shown(false);
        let h = waiting(&feed);
        tokio::time::sleep(Duration::from_secs(40)).await;
        feed.set_shown(true);
        assert_eq!(h.await.unwrap(), Duration::from_secs(40));

        // never started: no wait
        let fresh = OnlineFeed::ivao();
        assert_eq!(waiting(&fresh).await.unwrap(), Duration::ZERO);
    }
}
