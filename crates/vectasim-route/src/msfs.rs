//! The running MSFS as a waypoint source: facility lookups through the SimConnect session
//! ([`vectasim_simconnect::facility`]).
//!
//! Every ident is asked as a WAYPOINT first (the waypoint record also carries the airways
//! through it), the ones the sim does not know then as VOR, then NDB, and 4-letter ones last as
//! AIRPORT – one batch per kind, all requests of a batch in flight together. An ident the sim
//! has in several regions comes back as a candidate list with positions; the resolver picks the
//! nearest. Airways are walked fix by fix along the ROUTE children (airway name, previous and
//! next fix), in the direction that gets closer to the exit fix.
//!
//! Degrading: no SimConnect session, a DLL without the facility calls or no answer within
//! [`TIMEOUT`] switch the source off for the rest of this resolution; the whole resolution
//! spends at most [`BUDGET`] on the simulator.

use crate::{Candidate, NavSource, SourceId, dist_nm};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use vectasim_simconnect::facility::{FacKind, FacilityAnswer, FacilityBroker, FacilityQuery, LinkFix, RouteLink};

/// One batch of lookups without any answer for this long: the sim is skipped.
pub const TIMEOUT: Duration = Duration::from_secs(3);
/// Time spent on the simulator per resolution at most.
pub const BUDGET: Duration = Duration::from_secs(12);
/// Fixes walked along one airway at most.
pub const MAX_WALK: usize = 150;

pub struct MsfsSource<'a> {
    broker: &'a FacilityBroker,
    timeout: Duration,
    deadline: Instant,
    alive: bool,
    /// Airways through each waypoint the sim returned, by (ident, region).
    routes: HashMap<(String, String), Vec<RouteLink>>,
}

impl<'a> MsfsSource<'a> {
    pub fn new(broker: &'a FacilityBroker) -> Self {
        Self::with_timing(broker, TIMEOUT, BUDGET)
    }

    pub fn with_timing(broker: &'a FacilityBroker, timeout: Duration, budget: Duration) -> Self {
        Self { broker, timeout, deadline: Instant::now() + budget, alive: broker.available(), routes: HashMap::new() }
    }

    /// The simulator answered (or still may answer) in this resolution.
    pub fn alive(&self) -> bool {
        self.alive
    }

    fn lookup(&mut self, queries: &[FacilityQuery]) -> Option<Vec<FacilityAnswer>> {
        if !self.alive || Instant::now() >= self.deadline {
            return None;
        }
        let answers = self.broker.lookup(queries, self.timeout);
        if answers.is_none() {
            log::info!("MSFS facility lookup unanswered; this route lookup continues without the simulator");
            self.alive = false;
        }
        answers
    }

    /// The airways through a waypoint (asked with its region when not known yet).
    fn routes_of(&mut self, ident: &str, region: &str) -> Option<Vec<RouteLink>> {
        let key = (ident.to_owned(), region.to_owned());
        if let Some(r) = self.routes.get(&key) {
            return Some(r.clone());
        }
        let answers = self.lookup(&[FacilityQuery::new(FacKind::Waypoint, ident, region)])?;
        match answers.into_iter().next()? {
            FacilityAnswer::Found { routes, .. } => {
                self.routes.insert(key, routes.clone());
                Some(routes)
            }
            _ => None,
        }
    }
}

fn link_candidate(l: &LinkFix) -> Candidate {
    Candidate { ident: l.ident.clone(), lat: l.lat, lon: l.lon, region: l.region.clone(), source: SourceId::Msfs }
}

impl NavSource for MsfsSource<'_> {
    fn id(&self) -> SourceId {
        SourceId::Msfs
    }

    fn candidates(&mut self, idents: &[String]) -> HashMap<String, Vec<Candidate>> {
        let mut out: HashMap<String, Vec<Candidate>> = HashMap::new();
        let mut rest: Vec<&String> = idents.iter().filter(|i| i.len() <= 8).collect();
        for kind in [FacKind::Waypoint, FacKind::Vor, FacKind::Ndb, FacKind::Airport] {
            let ask: Vec<&String> = rest
                .iter()
                .copied()
                .filter(|i| kind != FacKind::Airport || (i.len() == 4 && i.bytes().all(|b| b.is_ascii_uppercase())))
                .collect();
            if ask.is_empty() {
                continue;
            }
            let queries: Vec<FacilityQuery> = ask.iter().map(|i| FacilityQuery::new(kind, i, "")).collect();
            let Some(answers) = self.lookup(&queries) else { break };
            for (ident, answer) in ask.iter().zip(answers) {
                let found = match answer {
                    FacilityAnswer::Found { lat, lon, region, routes } => {
                        if kind == FacKind::Waypoint {
                            self.routes.insert(((*ident).clone(), region.clone()), routes);
                        }
                        vec![Candidate { ident: (*ident).clone(), lat, lon, region, source: SourceId::Msfs }]
                    }
                    FacilityAnswer::Ambiguous(list) => list
                        .into_iter()
                        .map(|m| Candidate { ident: (*ident).clone(), lat: m.lat, lon: m.lon, region: m.region, source: SourceId::Msfs })
                        .collect(),
                    FacilityAnswer::NotFound | FacilityAnswer::Unavailable => continue,
                };
                if !found.is_empty() {
                    out.insert((*ident).clone(), found);
                }
            }
            rest.retain(|i| !out.contains_key(*i));
            if rest.is_empty() {
                break;
            }
        }
        out
    }

    fn airway(&mut self, airway: &str, from: &Candidate, to: &Candidate) -> Option<Vec<Candidate>> {
        if !self.alive || from.source == SourceId::Coord {
            return None;
        }
        let links_on = |routes: &[RouteLink]| -> Vec<LinkFix> {
            routes
                .iter()
                .filter(|r| r.airway.eq_ignore_ascii_case(airway))
                .flat_map(|r| [r.next.clone(), r.prev.clone()])
                .flatten()
                .collect()
        };
        let start = links_on(&self.routes_of(&from.ident, &from.region)?);
        let d0 = dist_nm(from.lat, from.lon, to.lat, to.lon);
        // the direction that gets closer to the exit fix
        let mut step =
            start.into_iter().min_by(|a, b| dist_nm(a.lat, a.lon, to.lat, to.lon).total_cmp(&dist_nm(b.lat, b.lon, to.lat, to.lon)))?;
        if dist_nm(step.lat, step.lon, to.lat, to.lon) >= d0 + 1.0 {
            return None;
        }
        let mut path: Vec<Candidate> = Vec::new();
        let mut came_from = from.ident.clone();
        let mut seen: HashSet<(String, String)> = HashSet::from([(from.ident.clone(), from.region.clone())]);
        for _ in 0..MAX_WALK {
            if step.ident == to.ident && dist_nm(step.lat, step.lon, to.lat, to.lon) <= 30.0 {
                return Some(path);
            }
            if !seen.insert((step.ident.clone(), step.region.clone())) || dist_nm(step.lat, step.lon, to.lat, to.lon) > d0 + 300.0 {
                return None;
            }
            path.push(link_candidate(&step));
            let next = links_on(&self.routes_of(&step.ident, &step.region)?).into_iter().find(|l| l.ident != came_from)?;
            came_from = std::mem::replace(&mut step, next).ident;
        }
        None
    }
}
