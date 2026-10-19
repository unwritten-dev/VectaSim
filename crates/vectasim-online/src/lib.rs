//! Online-network traffic and weather for the live map.
//!
//! * [`OnlineFeed`] polls one network's public data file: the VATSIM v3 data file
//!   (`vatsim.rs`) or the IVAO Whazzup v2 file (`ivao.rs`). Both are regenerated
//!   every 15 s, so polling faster only burns their bandwidth and ours (IVAO bans
//!   IPs that do); the feed enforces that floor even across stop/start and backs
//!   off on errors. One poller per network serves every map view through the
//!   cached [`OnlineSnapshot`]. Both parse into the same model (`model.rs`), each
//!   entry tagged with its [`Network`].
//! * [`MetarClient`] fetches METARs from aviationweather.gov (NOAA, JSON) with a
//!   per-ICAO cache and falls back to VATSIM's METAR text endpoint, which
//!   carries the same reports but without structure.
//! * [`metar::decode`] is a deliberately small METAR decoder: just what the
//!   flight bar and map badges show (wind, visibility, QNH, temperature,
//!   ceiling → flight category). We decode the raw text ourselves rather than
//!   trusting the NOAA JSON fields so both sources produce identical results.

pub mod feed;
pub mod history;
pub mod ivao;
pub mod metar;
pub mod model;
pub mod vatsim;

pub use feed::{FeedStatus, OnlineFeed, VatsimFeed, backoff_delay};
pub use history::{TrackFix, TrackHistory};
pub use ivao::parse_ivao_json;
pub use metar::{FlightCategory, Metar, MetarClient, Wind};
pub use model::{
    Controller, Facility, NearbyPilot, Network, OnlineSnapshot, Pilot, Prefile, VatsimSnapshot, haversine_nm, nearest_pilots,
    pilots_in_bbox,
};
pub use vatsim::parse_vatsim_json;

pub(crate) const USER_AGENT: &str = concat!("VectaSim/", env!("CARGO_PKG_VERSION"), " (+https://github.com/unwritten-dev/VectaSim)");

#[derive(Debug, thiserror::Error)]
pub enum OnlineError {
    #[error("HTTP {status} from {url}")]
    Http { status: u16, url: String },
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("could not parse response: {0}")]
    Parse(String),
    #[error("rate limit reached, try again shortly")]
    RateLimited,
    #[error("response larger than {limit} bytes")]
    TooLarge { limit: usize },
}

/// Largest network data file accepted (VATSIM v3 / IVAO Whazzup, decompressed; a few MiB
/// even at event peaks). A gzip bomb stops here instead of exhausting memory.
pub(crate) const MAX_FEED_BYTES: usize = 16 * 1024 * 1024;
/// Largest other response (VATSIM status, METARs).
pub(crate) const MAX_SMALL_BYTES: usize = 2 * 1024 * 1024;

/// Append `chunk` unless the body would exceed `limit`.
pub(crate) fn push_limited(out: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), OnlineError> {
    if out.len().saturating_add(chunk.len()) > limit {
        return Err(OnlineError::TooLarge { limit });
    }
    out.extend_from_slice(chunk);
    Ok(())
}

/// The (decompressed) body, read chunk by chunk up to `limit` bytes.
pub(crate) async fn read_limited(mut resp: reqwest::Response, limit: usize) -> Result<Vec<u8>, OnlineError> {
    if resp.content_length().is_some_and(|n| n > limit as u64) {
        return Err(OnlineError::TooLarge { limit });
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        push_limited(&mut out, &chunk, limit)?;
    }
    Ok(out)
}

/// The shared client settings: HTTPS only (also for redirects), user agent, timeout.
pub(crate) fn client(timeout: std::time::Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_capped() {
        let mut out = Vec::new();
        push_limited(&mut out, b"abcd", 6).unwrap();
        push_limited(&mut out, b"ef", 6).unwrap();
        assert!(matches!(push_limited(&mut out, b"g", 6), Err(OnlineError::TooLarge { limit: 6 })));
        assert_eq!(out, b"abcdef");
    }
}
