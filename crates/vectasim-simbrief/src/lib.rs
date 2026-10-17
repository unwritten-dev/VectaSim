//! SimBrief integration: fetch a pilot's latest OFP and reduce it to the
//! fields a tracker needs (`Ofp`).
//!
//! The public fetcher needs no auth: `xml.fetcher.php?userid=<id>&json=v2`
//! (or `username=`). We call it only on user action, never on a timer, and
//! parse defensively because SimBrief has shipped numbers both as strings and
//! as numbers, and single-element lists as objects. All weights/fuel are
//! normalised to kg; times are Unix seconds (UTC).

pub mod model;
mod raw;

pub use model::{NavFix, Ofp, OfpFuel, OfpTimes, OfpWeights};

use std::time::Duration;

const FETCHER_URL: &str = "https://www.simbrief.com/api/xml.fetcher.php";
const USER_AGENT: &str = concat!("VectaSim/", env!("CARGO_PKG_VERSION"), " (+https://github.com/unwritten-dev/VectaSim)");

#[derive(Debug, thiserror::Error)]
pub enum SimbriefError {
    #[error("no SimBrief pilot id or username configured")]
    NoUser,
    #[error("SimBrief rejected the request (HTTP {status}): {body}")]
    Rejected { status: u16, body: String },
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("could not parse OFP: {0}")]
    Parse(String),
}

/// Which identifier the user gave us. SimBrief accepts both; usernames are
/// case-insensitive, ids are numeric.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum User {
    PilotId(String),
    Username(String),
}

impl User {
    /// Digits only → pilot id, anything else → username.
    pub fn parse(input: &str) -> Option<User> {
        let s = input.trim();
        if s.is_empty() {
            return None;
        }
        Some(if s.chars().all(|c| c.is_ascii_digit()) { User::PilotId(s.into()) } else { User::Username(s.into()) })
    }

    fn query(&self) -> (&'static str, &str) {
        match self {
            User::PilotId(id) => ("userid", id),
            User::Username(name) => ("username", name),
        }
    }
}

/// Fetch the user's most recent OFP.
pub async fn fetch_latest(user: &User) -> Result<Ofp, SimbriefError> {
    let client = reqwest::Client::builder().user_agent(USER_AGENT).timeout(Duration::from_secs(20)).build()?;
    let (key, value) = user.query();
    let resp = client.get(FETCHER_URL).query(&[(key, value), ("json", "v2")]).send().await?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(SimbriefError::Rejected { status: status.as_u16(), body: body.chars().take(300).collect() });
    }
    parse_ofp_json(&body)
}

/// Parse a SimBrief JSON document (v2 preferred; v1 tolerated).
pub fn parse_ofp_json(json: &str) -> Result<Ofp, SimbriefError> {
    let raw: raw::RawOfp = serde_json::from_str(json).map_err(|e| SimbriefError::Parse(e.to_string()))?;
    if let Some(status) = raw.fetch.as_ref().and_then(|f| f.status.as_deref())
        && status != "Success"
    {
        return Err(SimbriefError::Parse(format!("fetch status: {status}")));
    }
    Ok(raw.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_parse() {
        assert_eq!(User::parse(" 123456 "), Some(User::PilotId("123456".into())));
        assert_eq!(User::parse("janedoe"), Some(User::Username("janedoe".into())));
        assert_eq!(User::parse("  "), None);
    }
}
