//! The filed route of an online (VATSIM/IVAO) aircraft as points on the map.
//!
//! VectaSim ships no waypoint or airway data of its own, so the route string is resolved from
//! whatever is on this PC, in this order (the first source that has a usable candidate wins):
//!
//! 1. the running MSFS through SimConnect facility data ([`msfs`]),
//! 2. an installed X-Plane's nav data files ([`xplane`]),
//! 3. the embedded OurAirports navaids (`vectasim_data::navaids`) and airport index, plus
//!    coordinates written in the route itself.
//!
//! Grammar: [`token`]. Candidate rules: an ident known several times worldwide takes the
//! candidate nearest to the previous resolved point (the departure airport for the first one);
//! candidates further than [`MAX_LEG_NM`] from it are rejected. An airway between two resolved
//! points is expanded through the fixes in between when a source knows it (MSFS first, then
//! X-Plane), else the two points are joined directly. An unresolved point right after the
//! departure or right before the arrival is taken for a SID/STAR name and skipped silently;
//! any other unresolved point is listed and leaves a gap (the next point carries `gap_before`).
//! Departure and arrival come from the airport index.

pub mod msfs;
pub mod token;
pub mod xplane;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use token::{Token, tokenize};
use vectasim_data::AirportIndex;

/// A candidate further than this from the previous point is not the one meant.
pub const MAX_LEG_NM: f64 = 1500.0;
/// How long a lookup waits for the X-Plane files to be parsed on first use.
pub const XPLANE_WAIT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    Msfs,
    Xplane,
    Navaids,
    Airport,
    Coord,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub ident: String,
    pub lat: f64,
    pub lon: f64,
    /// ICAO region ("ED", "K2") where the source has one.
    pub region: String,
    pub source: SourceId,
}

pub(crate) fn dist_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    vectasim_data::haversine_nm(lat1, lon1, lat2, lon2)
}

/// Something that knows positions of idents (and maybe airways).
pub trait NavSource {
    fn id(&self) -> SourceId;
    /// Every candidate per ident this source knows; idents it does not know are absent.
    fn candidates(&mut self, idents: &[String]) -> HashMap<String, Vec<Candidate>>;
    /// The fixes strictly between `from` and `to` along `airway`; None when unknown here.
    fn airway(&mut self, _airway: &str, _from: &Candidate, _to: &Candidate) -> Option<Vec<Candidate>> {
        None
    }
}

/// X-Plane nav data as a source.
pub struct XPlaneSource(pub Arc<xplane::XpIndex>);

impl NavSource for XPlaneSource {
    fn id(&self) -> SourceId {
        SourceId::Xplane
    }

    fn candidates(&mut self, idents: &[String]) -> HashMap<String, Vec<Candidate>> {
        idents.iter().map(|i| (i.clone(), self.0.candidates(i))).filter(|(_, c)| !c.is_empty()).collect()
    }

    fn airway(&mut self, airway: &str, from: &Candidate, to: &Candidate) -> Option<Vec<Candidate>> {
        self.0.airway(airway, from, to)
    }
}

/// The data VectaSim ships: OurAirports navaids, and the airport index for 4-letter idents.
pub struct BundledSource<'a> {
    pub airports: &'a AirportIndex,
}

impl NavSource for BundledSource<'_> {
    fn id(&self) -> SourceId {
        SourceId::Navaids
    }

    fn candidates(&mut self, idents: &[String]) -> HashMap<String, Vec<Candidate>> {
        let mut out = HashMap::new();
        for ident in idents {
            let mut c: Vec<Candidate> = vectasim_data::navaids::by_ident(ident)
                .iter()
                .map(|n| Candidate {
                    ident: ident.clone(),
                    lat: n.latitude,
                    lon: n.longitude,
                    region: String::new(),
                    source: SourceId::Navaids,
                })
                .collect();
            if ident.len() == 4
                && let Some(a) = self.airports.get(ident)
            {
                c.push(Candidate {
                    ident: ident.clone(),
                    lat: a.latitude,
                    lon: a.longitude,
                    region: String::new(),
                    source: SourceId::Airport,
                });
            }
            if !c.is_empty() {
                out.insert(ident.clone(), c);
            }
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePoint {
    pub ident: String,
    pub lat: f64,
    pub lon: f64,
    pub source: SourceId,
    /// Always true: unresolved idents are listed in [`RouteResolution::unresolved`] instead.
    pub resolved: bool,
    /// Something unresolved lies between the previous point and this one (drawn as a bridge).
    pub gap_before: bool,
    /// Set for the fixes an airway expansion inserted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub airway: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteResolution {
    /// Departure, the resolved route points (airway fixes included), arrival.
    pub points: Vec<RoutePoint>,
    /// Idents that could not be placed, in route order.
    pub unresolved: Vec<String>,
    /// Waypoints of the flight plan counted: departure, arrival and every point token that is
    /// not a skipped SID/STAR name (airway fixes not counted).
    pub total: usize,
    pub resolved_count: usize,
    /// Resolved points between departure and arrival (airway fixes included); 0 = nothing to
    /// draw beyond the great circle.
    pub enroute: usize,
    pub airways_expanded: usize,
    /// Sources of the drawn points, in priority order.
    pub sources: Vec<SourceId>,
}

fn point(c: &Candidate, gap_before: bool, airway: Option<&str>) -> RoutePoint {
    RoutePoint {
        ident: c.ident.clone(),
        lat: c.lat,
        lon: c.lon,
        source: c.source,
        resolved: true,
        gap_before,
        airway: airway.map(str::to_owned),
    }
}

/// Nearest candidate to `reference` within [`MAX_LEG_NM`], from the first source that has one.
fn choose(per_source: &[HashMap<String, Vec<Candidate>>], ident: &str, reference: Option<&Candidate>) -> Option<Candidate> {
    for map in per_source {
        let Some(cands) = map.get(ident) else { continue };
        let best = match reference {
            Some(r) => cands
                .iter()
                .map(|c| (c, dist_nm(r.lat, r.lon, c.lat, c.lon)))
                .filter(|(_, d)| *d <= MAX_LEG_NM)
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(c, _)| c),
            None => cands.first(),
        };
        if let Some(c) = best {
            return Some(c.clone());
        }
    }
    None
}

/// Resolve `route` between `dep` and `arr` with `sources` in priority order (see the crate doc).
pub fn resolve(dep: &str, arr: &str, route: &str, airports: &AirportIndex, sources: &mut [&mut dyn NavSource]) -> RouteResolution {
    let tokens = tokenize(route, dep, arr);
    let airport = |icao: &str| {
        airports.get(icao.trim()).map(|a| Candidate {
            ident: a.ident.clone(),
            lat: a.latitude,
            lon: a.longitude,
            region: String::new(),
            source: SourceId::Airport,
        })
    };
    let (dep_pt, arr_pt) = (airport(dep), airport(arr));

    // every name that may be a point: point tokens, and airway tokens as a fallback
    let mut idents: Vec<String> = Vec::new();
    for t in &tokens {
        if let Token::Point(s) | Token::Airway(s) = t
            && !idents.contains(s)
        {
            idents.push(s.clone());
        }
    }
    let per_source: Vec<HashMap<String, Vec<Candidate>>> =
        if idents.is_empty() { Vec::new() } else { sources.iter_mut().map(|s| s.candidates(&idents)).collect() };

    // pass 1: points in route order, each nearest to the one before it
    let mut chosen: Vec<Option<Candidate>> = vec![None; tokens.len()];
    let mut reference = dep_pt.clone().or_else(|| arr_pt.clone());
    for (i, t) in tokens.iter().enumerate() {
        let c = match t {
            Token::Coord(lat, lon, text) => {
                Some(Candidate { ident: text.clone(), lat: *lat, lon: *lon, region: String::new(), source: SourceId::Coord })
            }
            Token::Point(id) => choose(&per_source, id, reference.as_ref()),
            Token::Airway(_) => None,
        };
        if c.is_some() {
            reference.clone_from(&c);
        }
        chosen[i] = c;
    }
    let point_tokens: Vec<usize> = (0..tokens.len()).filter(|&i| !matches!(tokens[i], Token::Airway(_))).collect();
    let (first, last) = (point_tokens.first().copied(), point_tokens.last().copied());

    // pass 2: the list, airways expanded between resolved neighbours
    let mut out = RouteResolution { total: 2, ..RouteResolution::default() };
    let mut last_pt: Option<Candidate> = None;
    match &dep_pt {
        Some(d) => {
            out.points.push(point(d, false, None));
            out.resolved_count += 1;
            last_pt = Some(d.clone());
        }
        None => out.unresolved.push(dep.trim().to_ascii_uppercase()),
    }
    let mut gap = dep_pt.is_none();
    let mut pending_airway: Option<&str> = None;
    for (i, t) in tokens.iter().enumerate() {
        match (t, &chosen[i]) {
            (Token::Airway(name), _) => {
                pending_airway = (i > 0 && chosen[i - 1].is_some()).then_some(name.as_str());
            }
            (Token::Point(_) | Token::Coord(..), Some(c)) => {
                if let (Some(aw), Some(prev)) = (pending_airway.take(), last_pt.as_ref()) {
                    let via = sources.iter_mut().find_map(|s| s.airway(aw, prev, c));
                    match via {
                        Some(fixes) => {
                            out.airways_expanded += 1;
                            for f in &fixes {
                                out.points.push(point(f, false, Some(aw)));
                                out.enroute += 1;
                            }
                        }
                        // an airway-shaped name may be a fix (terminal fixes such as DF432):
                        // taken when it lies roughly between its neighbours
                        None => {
                            let direct = dist_nm(prev.lat, prev.lon, c.lat, c.lon);
                            if let Some(f) = choose(&per_source, aw, Some(prev))
                                && dist_nm(prev.lat, prev.lon, f.lat, f.lon) + dist_nm(f.lat, f.lon, c.lat, c.lon) <= direct * 1.3 + 30.0
                            {
                                out.points.push(point(&f, false, None));
                                out.enroute += 1;
                            }
                        }
                    }
                }
                out.points.push(point(c, gap, None));
                out.total += 1;
                out.resolved_count += 1;
                out.enroute += 1;
                gap = false;
                last_pt = Some(c.clone());
            }
            (Token::Point(id), None) => {
                pending_airway = None;
                // SID/STAR names: unresolved right after the departure / before the arrival
                if Some(i) == first || Some(i) == last {
                    continue;
                }
                out.unresolved.push(id.clone());
                out.total += 1;
                gap = true;
            }
            (Token::Coord(..), None) => {}
        }
    }
    match &arr_pt {
        Some(a) => {
            out.points.push(point(a, gap, None));
            out.resolved_count += 1;
        }
        None => out.unresolved.push(arr.trim().to_ascii_uppercase()),
    }
    let mut srcs: Vec<SourceId> = out.points.iter().map(|p| p.source).collect();
    srcs.sort();
    srcs.dedup();
    out.sources = srcs;
    out
}

/// Resolve with every source available on this PC (blocking: MSFS lookups wait for the sim,
/// the first call parses the X-Plane files). The second value says whether the result may be
/// cached: not while the X-Plane data was still being parsed.
pub fn resolve_here(
    dep: &str,
    arr: &str,
    route: &str,
    airports: &AirportIndex,
    broker: &vectasim_simconnect::facility::FacilityBroker,
) -> (RouteResolution, bool) {
    let mut msfs = msfs::MsfsSource::new(broker);
    let (xp, complete) = match xplane::XPlaneNav::shared().index(XPLANE_WAIT) {
        Ok(idx) => (idx.map(XPlaneSource), true),
        Err(xplane::StillLoading) => (None, false),
    };
    let mut bundled = BundledSource { airports };
    let mut xp = xp;
    let mut sources: Vec<&mut dyn NavSource> = vec![&mut msfs];
    if let Some(x) = xp.as_mut() {
        sources.push(x);
    }
    sources.push(&mut bundled);
    let r = resolve(dep, arr, route, airports, &mut sources);
    (r, complete)
}

/// (departure, arrival, normalised route text, simulator connected).
pub type CacheKey = (String, String, String, bool);

/// Results per [`CacheKey`], for the app session.
#[derive(Debug, Default)]
pub struct RouteCache {
    map: Mutex<HashMap<CacheKey, Arc<RouteResolution>>>,
}

/// Entries kept at most (one per clicked flight plan; cleared when full).
const CACHE_MAX: usize = 256;

impl RouteCache {
    pub fn key(dep: &str, arr: &str, route: &str, sim: bool) -> CacheKey {
        (
            dep.trim().to_ascii_uppercase(),
            arr.trim().to_ascii_uppercase(),
            route.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase(),
            sim,
        )
    }

    pub fn get(&self, key: &CacheKey) -> Option<Arc<RouteResolution>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
    }

    pub fn put(&self, key: CacheKey, value: Arc<RouteResolution>) {
        let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if g.len() >= CACHE_MAX {
            g.clear();
        }
        g.insert(key, value);
    }
}

#[cfg(test)]
mod tests;
