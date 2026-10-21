//! METAR fetching (aviationweather.gov, VATSIM fallback) and a small decoder.
//!
//! The VATSIM fallback (`metar.vatsim.net`) is only asked while the app has the VATSIM network
//! switched on ([`MetarClient::set_vatsim_fallback`], off by default): with VATSIM off, VectaSim
//! contacts no VATSIM server at all, and a failing aviationweather.gov leaves stale or no reports.
//!
//! aviationweather.gov asks clients to stay below 100 requests per minute and
//! to send a descriptive User-Agent. METARs are issued every 30–60 min, so a
//! 10-minute cache per ICAO loses nothing and lets the map re-ask for the same
//! airports on every pan without touching the network.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::OnlineError;

const NOAA_URL: &str = "https://aviationweather.gov/api/data/metar";
const VATSIM_METAR_URL: &str = "https://metar.vatsim.net/metar.php";
/// Fresh-cache lifetime per station.
pub const CACHE_TTL: Duration = Duration::from_secs(600);
/// How old a cached report may be when it is served because upstream failed.
const STALE_TTL: Duration = Duration::from_secs(3600);
/// Stations per upstream request; also the map's per-view cap.
pub const MAX_BATCH: usize = 40;
/// Our own ceiling, comfortably under aviationweather.gov's 100/min.
const MAX_REQUESTS_PER_MINUTE: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum FlightCategory {
    Vfr,
    Mvfr,
    Ifr,
    Lifr,
    Unknown,
}

impl FlightCategory {
    /// FAA categories from ceiling (lowest BKN/OVC/VV, ft AGL) and visibility (SM).
    /// Missing values count as unlimited, but with neither known we can't say anything.
    pub fn from_conditions(ceiling_ft: Option<u32>, visibility_sm: Option<f64>) -> FlightCategory {
        if ceiling_ft.is_none() && visibility_sm.is_none() {
            return FlightCategory::Unknown;
        }
        let c = ceiling_ft.unwrap_or(u32::MAX);
        let v = visibility_sm.unwrap_or(f64::INFINITY);
        if c < 500 || v < 1.0 {
            FlightCategory::Lifr
        } else if c < 1000 || v < 3.0 {
            FlightCategory::Ifr
        } else if c <= 3000 || v <= 5.0 {
            FlightCategory::Mvfr
        } else {
            FlightCategory::Vfr
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wind {
    /// None for variable (VRB) wind.
    pub direction_deg: Option<u16>,
    pub speed_kt: u16,
    pub gust_kt: Option<u16>,
    /// "dddVddd" variability range.
    pub variable_from_deg: Option<u16>,
    pub variable_to_deg: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metar {
    pub station: String,
    pub raw: String,
    /// Report time group as written ("171250Z").
    pub time: Option<String>,
    pub wind: Option<Wind>,
    /// Prevailing visibility in metres (9999 → 10000; SM converted).
    pub visibility_m: Option<u32>,
    pub cavok: bool,
    /// Lowest broken/overcast layer or vertical visibility, ft AGL.
    pub ceiling_ft: Option<u32>,
    pub qnh_hpa: Option<u16>,
    pub altimeter_inhg: Option<f64>,
    pub temperature_c: Option<i32>,
    pub dewpoint_c: Option<i32>,
    pub category: FlightCategory,
    /// "aviationweather" or "vatsim".
    pub source: String,
}

// ---- decoder ------------------------------------------------------------------------

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn parse_wind(tok: &str) -> Option<Wind> {
    let (body, factor) = [("KT", 1.0), ("MPS", 1.943_84), ("KMH", 0.539_957)]
        .iter()
        .find_map(|&(unit, f)| tok.strip_suffix(unit).map(|b| (b, f)))?;
    if body.len() < 5 {
        return None;
    }
    // checked: byte 3 may fall inside a multi-byte character
    let (dir, rest) = body.split_at_checked(3)?;
    let direction_deg = match dir {
        "VRB" => None,
        d if all_digits(d) => Some(d.parse::<u16>().ok()?),
        _ => return None,
    };
    let (speed, gust) = match rest.split_once('G') {
        Some((s, g)) => (s, Some(g)),
        None => (rest, None),
    };
    if !all_digits(speed) || gust.is_some_and(|g| !all_digits(g)) {
        return None;
    }
    let conv = |s: &str| s.parse::<f64>().ok().map(|v| (v * factor).round() as u16);
    Some(Wind {
        direction_deg,
        speed_kt: conv(speed)?,
        gust_kt: gust.and_then(conv),
        variable_from_deg: None,
        variable_to_deg: None,
    })
}

/// "1/2" → 0.5, "10" → 10, "M1/4" → 0.25, "P6" → 6.
fn parse_sm(s: &str) -> Option<f64> {
    let s = s.trim_start_matches(['M', 'P']);
    match s.split_once('/') {
        Some((n, d)) => {
            let (n, d) = (n.parse::<f64>().ok()?, d.parse::<f64>().ok()?);
            (d > 0.0).then(|| n / d)
        }
        None => s.parse().ok(),
    }
}

fn parse_temp(s: &str) -> Option<i32> {
    let (neg, digits) = match s.strip_prefix('M') {
        Some(d) => (true, d),
        None => (false, s),
    };
    if digits.len() != 2 || !all_digits(digits) {
        return None;
    }
    let v: i32 = digits.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// Decode the parts of a METAR we display. Unknown groups are skipped, and
/// trend/remark sections are ignored because they describe forecasts or
/// local detail, not the current conditions the category is based on.
pub fn decode(raw: &str) -> Metar {
    let raw = raw.trim().trim_end_matches('=');
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut m = Metar {
        station: String::new(),
        raw: raw.to_string(),
        time: None,
        wind: None,
        visibility_m: None,
        cavok: false,
        ceiling_ft: None,
        qnh_hpa: None,
        altimeter_inhg: None,
        temperature_c: None,
        dewpoint_c: None,
        category: FlightCategory::Unknown,
        source: String::new(),
    };
    let mut vis_sm: Option<f64> = None;
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if matches!(tok, "RMK" | "TEMPO" | "BECMG" | "NOSIG") || tok.starts_with("PROB") {
            break;
        }
        if matches!(tok, "METAR" | "SPECI" | "COR" | "AUTO") {
            continue;
        }
        if m.station.is_empty() {
            if tok.len() == 4 && tok.bytes().all(|b| b.is_ascii_alphanumeric()) {
                m.station = tok.to_string();
            }
            continue;
        }
        if m.time.is_none() && tok.len() == 7 && tok.ends_with('Z') && all_digits(&tok[..6]) {
            m.time = Some(tok.to_string());
            continue;
        }
        if m.wind.is_none()
            && let Some(w) = parse_wind(tok)
        {
            m.wind = Some(w);
            continue;
        }
        if tok.len() == 7 && tok.as_bytes()[3] == b'V' && all_digits(&tok[..3]) && all_digits(&tok[4..]) {
            if let Some(w) = m.wind.as_mut() {
                w.variable_from_deg = tok[..3].parse().ok();
                w.variable_to_deg = tok[4..].parse().ok();
            }
            continue;
        }
        if tok == "CAVOK" {
            m.cavok = true;
            m.visibility_m = Some(10_000);
            continue;
        }
        if let Some(sm) = tok.strip_suffix("SM") {
            // "1 1/2SM": the whole-number part is the previous token
            let whole = if i >= 2 && sm.contains('/') && tokens[i - 2].len() <= 2 && all_digits(tokens[i - 2]) {
                tokens[i - 2].parse::<f64>().unwrap_or(0.0)
            } else {
                0.0
            };
            if let Some(v) = parse_sm(sm) {
                vis_sm = Some(whole + v);
                m.visibility_m = Some(((whole + v) * 1609.344).round() as u32);
            }
            continue;
        }
        // `get`: a non-ASCII token ("abcÄ") has no char boundary at byte 4 – no slice panic
        if let Some(head) = tok.get(..4)
            && m.visibility_m.is_none()
            && all_digits(head)
            && tok[4..].bytes().all(|b| b.is_ascii_uppercase())
        {
            // "9999" means 10 km or more; a direction suffix ("4000NE") is the minimum visibility
            let v: u32 = head.parse().unwrap_or(0);
            m.visibility_m = Some(if v == 9999 { 10_000 } else { v });
            continue;
        }
        let layer = ["BKN", "OVC", "VV"].iter().find_map(|p| tok.strip_prefix(p));
        if let Some(height) = layer.and_then(|rest| rest.get(..3))
            && all_digits(height)
        {
            let base = height.parse::<u32>().unwrap_or(0) * 100;
            m.ceiling_ft = Some(m.ceiling_ft.map_or(base, |c| c.min(base)));
            continue;
        }
        if let Some(q) = tok.strip_prefix('Q')
            && q.len() == 4
            && all_digits(q)
        {
            m.qnh_hpa = q.parse().ok();
            continue;
        }
        if let Some(a) = tok.strip_prefix('A')
            && a.len() == 4
            && all_digits(a)
        {
            let inhg = a.parse::<f64>().unwrap_or(0.0) / 100.0;
            m.altimeter_inhg = Some(inhg);
            if m.qnh_hpa.is_none() {
                m.qnh_hpa = Some((inhg * 33.8639).round() as u16);
            }
            continue;
        }
        if let Some((t, d)) = tok.split_once('/')
            && m.temperature_c.is_none()
            && let Some(t) = parse_temp(t)
        {
            m.temperature_c = Some(t);
            m.dewpoint_c = parse_temp(d);
            continue;
        }
    }
    let vis_sm = vis_sm.or(m.visibility_m.map(|v| v as f64 / 1609.344));
    m.category = if m.cavok { FlightCategory::Vfr } else { FlightCategory::from_conditions(m.ceiling_ft, vis_sm) };
    m
}

// ---- observation time ---------------------------------------------------------------

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m)
}

/// Observation time of a report group "DDHHMMZ" as Unix ms. The group has no month or
/// year, so the date with that day of the month nearest to `near_ms` (the landing) is
/// taken: same, previous or next month. None for an unparsable group or an impossible date.
pub fn observation_ms(time: &str, near_ms: u64) -> Option<u64> {
    let t = time.strip_suffix('Z').unwrap_or(time);
    if t.len() != 6 || !all_digits(t) {
        return None;
    }
    let (dd, hh, mm): (u32, i64, i64) = (t[..2].parse().ok()?, t[2..4].parse().ok()?, t[4..].parse().ok()?);
    if !(1..=31).contains(&dd) || hh > 23 || mm > 59 {
        return None;
    }
    let (y, m) = civil_from_days((near_ms / 86_400_000) as i64);
    let near = near_ms as i64;
    let mut best: Option<i64> = None;
    for dm in [-1i64, 0, 1] {
        let idx = y * 12 + (m as i64 - 1) + dm;
        let (cy, cm) = (idx.div_euclid(12), (idx.rem_euclid(12) + 1) as u32);
        let days = days_from_civil(cy, cm, dd);
        // day 31 in a 30-day month rolls over into the next month: not this month's date
        if civil_from_days(days).1 != cm {
            continue;
        }
        let ms = (days * 86_400 + hh * 3600 + mm * 60) * 1000;
        if best.is_none_or(|b| (ms - near).abs() < (b - near).abs()) {
            best = Some(ms);
        }
    }
    best.and_then(|b| u64::try_from(b).ok())
}

// ---- client -------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoaaMetar {
    #[serde(default)]
    icao_id: String,
    #[serde(default)]
    raw_ob: String,
}

/// Parse aviationweather.gov's JSON (an array; an empty body means no matches).
pub fn parse_noaa_json(body: &str) -> Result<Vec<Metar>, OnlineError> {
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<NoaaMetar> = serde_json::from_str(body).map_err(|e| OnlineError::Parse(e.to_string()))?;
    Ok(list
        .into_iter()
        .filter(|r| !r.raw_ob.is_empty())
        .map(|r| {
            let mut m = decode(&r.raw_ob);
            if !r.icao_id.is_empty() {
                m.station = r.icao_id;
            }
            m.source = "aviationweather".into();
            m
        })
        .collect())
}

/// Parse VATSIM's plain-text METAR response: one report per line.
pub fn parse_vatsim_text(body: &str) -> Vec<Metar> {
    body.lines()
        .map(str::trim)
        .filter(|l| l.len() > 8 && !l.starts_with('<'))
        .map(|l| {
            let mut m = decode(l);
            m.source = "vatsim".into();
            m
        })
        .filter(|m| !m.station.is_empty())
        .collect()
}

struct CacheEntry {
    at: Instant,
    /// None = upstream had no report; cached too so we don't keep asking.
    metar: Option<Metar>,
}

pub struct MetarClient {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, CacheEntry>>,
    requests: Mutex<VecDeque<Instant>>,
    /// Ask `metar.vatsim.net` when aviationweather.gov fails (follows the VATSIM switch).
    vatsim_fallback: AtomicBool,
}

impl Default for MetarClient {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize(icao: &str) -> Option<String> {
    let s = icao.trim().to_ascii_uppercase();
    (s.len() >= 3 && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(s)
}

impl MetarClient {
    pub fn new() -> Self {
        let client = crate::client(Duration::from_secs(15));
        Self { client, cache: Mutex::new(HashMap::new()), requests: Mutex::new(VecDeque::new()), vatsim_fallback: AtomicBool::new(false) }
    }

    /// Whether `metar.vatsim.net` may be asked when aviationweather.gov fails; the app ties it to
    /// the VATSIM switch (module doc). Off by default.
    pub fn set_vatsim_fallback(&self, on: bool) {
        self.vatsim_fallback.store(on, Ordering::Relaxed);
    }

    pub fn vatsim_fallback(&self) -> bool {
        self.vatsim_fallback.load(Ordering::Relaxed)
    }

    /// Insert a report as if fetched now (tests, or callers that already have one).
    pub fn insert(&self, metar: Metar) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(metar.station.clone(), CacheEntry { at: Instant::now(), metar: Some(metar) });
    }

    fn take_request_slot(&self) -> bool {
        let mut q = self.requests.lock().unwrap_or_else(|e| e.into_inner());
        while q.front().is_some_and(|t| t.elapsed() > Duration::from_secs(60)) {
            q.pop_front();
        }
        if q.len() >= MAX_REQUESTS_PER_MINUTE {
            return false;
        }
        q.push_back(Instant::now());
        true
    }

    fn cached(&self, icao: &str, max_age: Duration) -> Option<Option<Metar>> {
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.get(icao).filter(|e| e.at.elapsed() < max_age).map(|e| e.metar.clone())
    }

    pub async fn get(&self, icao: &str) -> Result<Option<Metar>, OnlineError> {
        Ok(self.get_many(&[icao.to_string()]).await?.into_iter().next())
    }

    /// Reports for every station that has one, in no particular order. Served
    /// from cache where fresh; misses go upstream in batches of [`MAX_BATCH`].
    /// If upstream fails, stale entries (≤ 1 h) are returned instead; the call
    /// only errors when it has nothing at all to give back.
    pub async fn get_many(&self, icaos: &[String]) -> Result<Vec<Metar>, OnlineError> {
        let mut wanted: Vec<String> = icaos.iter().filter_map(|s| normalize(s)).collect();
        wanted.sort();
        wanted.dedup();

        let mut out = Vec::new();
        let mut misses = Vec::new();
        for icao in wanted {
            match self.cached(&icao, CACHE_TTL) {
                Some(hit) => out.extend(hit),
                None => misses.push(icao),
            }
        }

        let mut last_err = None;
        for chunk in misses.chunks(MAX_BATCH) {
            match self.fetch_chunk(chunk).await {
                Ok(found) => {
                    let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
                    let now = Instant::now();
                    for icao in chunk {
                        let metar = found.iter().find(|m| &m.station == icao).cloned();
                        out.extend(metar.clone());
                        cache.insert(icao.clone(), CacheEntry { at: now, metar });
                    }
                }
                Err(e) => {
                    log::warn!("METAR fetch failed for {}: {e}", chunk.join(","));
                    out.extend(chunk.iter().filter_map(|icao| self.cached(icao, STALE_TTL).flatten()));
                    last_err = Some(e);
                }
            }
        }
        match last_err {
            Some(e) if out.is_empty() => Err(e),
            _ => Ok(out),
        }
    }

    async fn fetch_chunk(&self, chunk: &[String]) -> Result<Vec<Metar>, OnlineError> {
        let ids = chunk.join(",");
        match self.fetch_noaa(&ids).await {
            Ok(list) => Ok(list),
            Err(e) if self.vatsim_fallback() => {
                log::info!("aviationweather.gov unavailable ({e}), trying VATSIM METAR");
                self.fetch_vatsim(&ids).await
            }
            Err(e) => Err(e),
        }
    }

    async fn fetch_noaa(&self, ids: &str) -> Result<Vec<Metar>, OnlineError> {
        if !self.take_request_slot() {
            return Err(OnlineError::RateLimited);
        }
        let resp = self.client.get(NOAA_URL).query(&[("ids", ids), ("format", "json")]).send().await?;
        if !resp.status().is_success() {
            return Err(OnlineError::Http { status: resp.status().as_u16(), url: NOAA_URL.into() });
        }
        parse_noaa_json(&String::from_utf8_lossy(&crate::read_limited(resp, crate::MAX_SMALL_BYTES).await?))
    }

    async fn fetch_vatsim(&self, ids: &str) -> Result<Vec<Metar>, OnlineError> {
        if !self.take_request_slot() {
            return Err(OnlineError::RateLimited);
        }
        let resp = self.client.get(VATSIM_METAR_URL).query(&[("id", ids)]).send().await?;
        if !resp.status().is_success() {
            return Err(OnlineError::Http { status: resp.status().as_u16(), url: VATSIM_METAR_URL.into() });
        }
        Ok(parse_vatsim_text(&String::from_utf8_lossy(&crate::read_limited(resp, crate::MAX_SMALL_BYTES).await?)))
    }
}
