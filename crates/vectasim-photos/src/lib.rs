//! Aircraft photos by registration from the Planespotters.net public API.
//!
//! `GET https://api.planespotters.net/pub/photos/reg/{REG}` (or `/hex/{ICAO24}`)
//! returns the photos of an airframe; we keep the first one. Planespotters'
//! rules for the public API, which this client follows:
//!
//! * a descriptive User-Agent ([`USER_AGENT`]),
//! * no more than about one request per second ([`MIN_INTERVAL`], enforced
//!   across all callers of one [`PhotoClient`]),
//! * results are cached instead of re-asked: a found photo for [`HIT_TTL_MS`]
//!   (7 days), a miss for [`MISS_TTL_MS`] (24 h) — see [`is_fresh`]. The cache
//!   itself is the airframe row in the logbook; this crate only decides,
//! * every photo is shown with its credit ("© photographer · Planespotters.net")
//!   linking to the photo page ([`Photo::credit_line`]).

use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const USER_AGENT: &str = concat!(
    "VectaSim/",
    env!("CARGO_PKG_VERSION"),
    " (desktop flight-sim logbook; aircraft photos by registration; +https://github.com/unwritten-dev/VectaSim)"
);
const BASE_URL: &str = "https://api.planespotters.net/pub/photos";
pub const MIN_INTERVAL: Duration = Duration::from_millis(1_100);
const TIMEOUT: Duration = Duration::from_secs(15);
/// A found photo is re-checked after a week.
pub const HIT_TTL_MS: u64 = 7 * 24 * 3600 * 1000;
/// "No photo for this registration" is re-checked after a day.
pub const MISS_TTL_MS: u64 = 24 * 3600 * 1000;
pub const SOURCE: &str = "planespotters";
pub const SOURCE_NONE: &str = "none";

#[derive(Debug, thiserror::Error)]
pub enum PhotoError {
    #[error("HTTP {status} from Planespotters")]
    Http { status: u16 },
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("could not parse Planespotters response: {0}")]
    Parse(String),
    #[error("Planespotters: {0}")]
    Api(String),
    #[error("Planespotters response larger than {limit} bytes")]
    TooLarge { limit: usize },
}

/// Largest API answer accepted (a photo list is a few KiB).
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// The (decompressed) body, read chunk by chunk up to `limit` bytes.
async fn read_limited(mut resp: reqwest::Response, limit: usize) -> Result<Vec<u8>, PhotoError> {
    if resp.content_length().is_some_and(|n| n > limit as u64) {
        return Err(PhotoError::TooLarge { limit });
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if out.len() + chunk.len() > limit {
            return Err(PhotoError::TooLarge { limit });
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// The photo we show for an airframe.
#[derive(Clone, Debug, PartialEq)]
pub struct Photo {
    /// `thumbnail_large` (≈ 420 px wide), used for the detail panel.
    pub large_url: String,
    /// `thumbnail` (≈ 200 px), used in lists.
    pub thumb_url: String,
    pub photographer: String,
    /// Planespotters photo page; the credit must link here.
    pub link: String,
}

impl Photo {
    pub fn credit_line(&self) -> String {
        if self.photographer.is_empty() { "© Planespotters.net".into() } else { format!("© {} · Planespotters.net", self.photographer) }
    }
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    photos: Vec<RawPhoto>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct RawPhoto {
    #[serde(default)]
    thumbnail: Option<RawImage>,
    #[serde(default)]
    thumbnail_large: Option<RawImage>,
    #[serde(default)]
    link: String,
    #[serde(default)]
    photographer: String,
}

#[derive(Deserialize)]
struct RawImage {
    src: String,
}

/// First usable photo of a Planespotters response; `Ok(None)` when there is none.
pub fn parse_photos(body: &str) -> Result<Option<Photo>, PhotoError> {
    let r: Response = serde_json::from_str(body).map_err(|e| PhotoError::Parse(e.to_string()))?;
    if let Some(err) = r.error.filter(|e| !e.trim().is_empty()) {
        return Err(PhotoError::Api(err));
    }
    Ok(r.photos.into_iter().find_map(|p| {
        let large = p.thumbnail_large.map(|i| i.src).filter(|s| !s.is_empty());
        let small = p.thumbnail.map(|i| i.src).filter(|s| !s.is_empty());
        let large_url = large.clone().or_else(|| small.clone())?;
        Some(Photo { thumb_url: small.unwrap_or_else(|| large_url.clone()), large_url, photographer: p.photographer.trim().into(), link: p.link })
    }))
}

/// Whether a cached lookup is still good. `source` is what the airframe row says
/// (`planespotters`, `none` for a miss, `user` for a picked image – never stale).
pub fn is_fresh(source: Option<&str>, fetched_ms: Option<u64>, now_ms: u64) -> bool {
    match (source, fetched_ms) {
        (Some("user"), _) => true,
        (Some(SOURCE), Some(t)) => now_ms.saturating_sub(t) < HIT_TTL_MS,
        (Some(SOURCE_NONE), Some(t)) => now_ms.saturating_sub(t) < MISS_TTL_MS,
        _ => false,
    }
}

/// Planespotters keys by registration as painted; we normalise to upper case without spaces.
fn path_segment(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>().to_uppercase()
}

pub struct PhotoClient {
    http: reqwest::Client,
    base: String,
    last_request: Mutex<Option<Instant>>,
}

impl Default for PhotoClient {
    fn default() -> Self {
        Self::new(BASE_URL)
    }
}

impl PhotoClient {
    pub fn new(base: &str) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .https_only(true)
            .connect_timeout(Duration::from_secs(10))
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Self { http, base: base.trim_end_matches('/').to_string(), last_request: Mutex::new(None) }
    }

    pub async fn by_registration(&self, registration: &str) -> Result<Option<Photo>, PhotoError> {
        self.get(&format!("{}/reg/{}", self.base, path_segment(registration))).await
    }

    pub async fn by_hex(&self, icao24: &str) -> Result<Option<Photo>, PhotoError> {
        self.get(&format!("{}/hex/{}", self.base, path_segment(icao24))).await
    }

    /// Waits until a request is allowed; holding the lock across the request keeps
    /// concurrent callers in a queue at ≤ 1 request per `MIN_INTERVAL`.
    async fn get(&self, url: &str) -> Result<Option<Photo>, PhotoError> {
        let mut last = self.last_request.lock().await;
        if let Some(t) = *last {
            let wait = MIN_INTERVAL.saturating_sub(t.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        *last = Some(Instant::now());
        log::debug!("planespotters: GET {url}");
        let resp = self.http.get(url).send().await?;
        let status = resp.status();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(PhotoError::Http { status: status.as_u16() });
        }
        parse_photos(&String::from_utf8_lossy(&read_limited(resp, MAX_BODY_BYTES).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_is_normalised() {
        assert_eq!(path_segment(" d-aina "), "D-AINA");
        assert_eq!(path_segment("n/123?x"), "N123X");
    }

    #[test]
    fn user_agent_is_descriptive() {
        assert!(USER_AGENT.starts_with("VectaSim/"));
        assert!(USER_AGENT.contains("+https://github.com/unwritten-dev/VectaSim"));
    }
}
