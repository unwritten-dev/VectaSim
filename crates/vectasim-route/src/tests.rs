use super::*;
use std::sync::OnceLock;
use std::time::Instant;
use vectasim_simconnect::facility::{FacKind, FacilityAnswer, FacilityBroker, FacilityQuery, LinkFix, MinimalFacility, RouteLink};

fn airports() -> &'static AirportIndex {
    static IDX: OnceLock<AirportIndex> = OnceLock::new();
    IDX.get_or_init(AirportIndex::load)
}

/// (airway, from, to, fixes in between)
type FakeAirway = (&'static str, &'static str, &'static str, Vec<(&'static str, f64, f64)>);

/// A scripted source.
struct Fake {
    id: SourceId,
    fixes: Vec<(&'static str, f64, f64)>,
    airways: Vec<FakeAirway>,
    asked: Vec<String>,
}

impl Fake {
    fn new(id: SourceId, fixes: Vec<(&'static str, f64, f64)>) -> Self {
        Self { id, fixes, airways: Vec::new(), asked: Vec::new() }
    }
}

impl NavSource for Fake {
    fn id(&self) -> SourceId {
        self.id
    }
    fn candidates(&mut self, idents: &[String]) -> HashMap<String, Vec<Candidate>> {
        self.asked.extend(idents.iter().cloned());
        let mut out: HashMap<String, Vec<Candidate>> = HashMap::new();
        for (i, lat, lon) in &self.fixes {
            if idents.iter().any(|x| x == i) {
                out.entry((*i).to_string()).or_default().push(Candidate {
                    ident: (*i).into(),
                    lat: *lat,
                    lon: *lon,
                    region: String::new(),
                    source: self.id,
                });
            }
        }
        out
    }
    fn airway(&mut self, airway: &str, from: &Candidate, to: &Candidate) -> Option<Vec<Candidate>> {
        self.airways.iter().find(|(a, f, t, _)| *a == airway && *f == from.ident && *t == to.ident).map(|(_, _, _, via)| {
            via.iter()
                .map(|(i, lat, lon)| Candidate { ident: (*i).into(), lat: *lat, lon: *lon, region: String::new(), source: self.id })
                .collect()
        })
    }
}

fn idents(r: &RouteResolution) -> Vec<String> {
    r.points.iter().map(|p| p.ident.clone()).collect()
}

#[test]
fn nearest_candidate_wins_and_far_ones_are_rejected() {
    // ROLIS exists near Frankfurt and in Australia; FARAW only in Australia
    let mut src =
        Fake::new(SourceId::Xplane, vec![("ROLIS", -33.0, 151.0), ("ROLIS", 49.0, 9.0), ("FARAW", -30.0, 150.0), ("KOPOR", 49.8, 8.9)]);
    let r = resolve("EDDF", "EDDM", "ANEKI1L KOPOR FARAW ROLIS STAR1A", airports(), &mut [&mut src]);
    assert_eq!(idents(&r), ["EDDF", "KOPOR", "ROLIS", "EDDM"]);
    assert_eq!(r.points[2].lat, 49.0);
    // FARAW unresolved and counted, the SID/STAR names silently skipped
    assert_eq!(r.unresolved, ["FARAW"]);
    assert_eq!((r.total, r.resolved_count, r.enroute), (5, 4, 2));
    assert!(r.points[2].gap_before && !r.points[1].gap_before && !r.points[3].gap_before);
    assert_eq!(r.sources, [SourceId::Xplane, SourceId::Airport]);
}

#[test]
fn source_priority_falls_through_to_the_next_source() {
    let mut msfs = Fake::new(SourceId::Msfs, vec![("KOPOR", 49.8, 8.9)]);
    let mut xp = Fake::new(SourceId::Xplane, vec![("KOPOR", 49.81, 8.91), ("DIBIR", 49.2, 9.9)]);
    let r = resolve("EDDF", "EDDM", "KOPOR DIBIR", airports(), &mut [&mut msfs, &mut xp]);
    assert_eq!(r.points[1].source, SourceId::Msfs);
    assert_eq!(r.points[2].source, SourceId::Xplane);
    assert_eq!(r.sources, [SourceId::Msfs, SourceId::Xplane, SourceId::Airport]);
    // every source was asked for every name once
    assert_eq!(msfs.asked, ["KOPOR", "DIBIR"]);
}

#[test]
fn airways_are_expanded_or_joined_directly() {
    let mut xp = Fake::new(SourceId::Xplane, vec![("ANEKI", 49.72, 8.47), ("DIBIR", 49.2, 9.9), ("NATOR", 48.6, 11.0)]);
    xp.airways.push(("UZ650", "ANEKI", "DIBIR", vec![("KOPOR", 49.8, 8.9), ("FFM", 49.5, 9.3)]));
    let r = resolve("EDDF", "EDDM", "ANEKI UZ650 DIBIR T180 NATOR", airports(), &mut [&mut xp]);
    assert_eq!(idents(&r), ["EDDF", "ANEKI", "KOPOR", "FFM", "DIBIR", "NATOR", "EDDM"]);
    assert_eq!(r.points[2].airway.as_deref(), Some("UZ650"));
    assert_eq!(r.points[4].airway, None);
    assert_eq!(r.airways_expanded, 1);
    // airway fixes are drawn but not counted as filed waypoints
    assert_eq!((r.total, r.resolved_count, r.enroute), (5, 5, 5));
}

#[test]
fn airway_shaped_fix_is_used_when_it_lies_between_its_neighbours() {
    let mut xp =
        Fake::new(SourceId::Xplane, vec![("ANEKI", 49.72, 8.47), ("DF432", 49.6, 8.9), ("DIBIR", 49.2, 9.9), ("L603", 10.0, 10.0)]);
    let r = resolve("EDDF", "EDDM", "ANEKI DF432 DIBIR L603 NATOR", airports(), &mut [&mut xp]);
    // DF432 sits after a point, so it is read as an airway – unknown there, but a fix on the way;
    // L603 is a fix far off the line: not taken (and NATOR is unknown → skipped as a STAR name)
    assert_eq!(idents(&r), ["EDDF", "ANEKI", "DF432", "DIBIR", "EDDM"]);
    assert!(r.unresolved.is_empty());
}

#[test]
fn nothing_beyond_the_airports_and_coordinates() {
    let mut empty = Fake::new(SourceId::Xplane, vec![]);
    let r = resolve("EDDF", "EDDM", "DCT", airports(), &mut [&mut empty]);
    assert_eq!(idents(&r), ["EDDF", "EDDM"]);
    assert_eq!((r.total, r.resolved_count, r.enroute), (2, 2, 0));
    assert!(empty.asked.is_empty(), "nothing to ask");
    let r = resolve("EDDF", "KJFK", "5020N00830E 55N020W 62N040W", airports(), &mut [&mut empty]);
    assert_eq!(r.enroute, 3);
    assert_eq!(r.sources, [SourceId::Airport, SourceId::Coord]);
    // unknown airports are listed as unresolved, the route still resolves around them
    let r = resolve("ZZZZ", "YYYY", "50N008E", airports(), &mut [&mut empty]);
    assert_eq!(r.unresolved, ["ZZZZ", "YYYY"]);
    assert_eq!((r.total, r.resolved_count), (3, 1));
    assert!(r.points[0].gap_before, "nothing before the first point");
}

#[test]
fn bundled_navaids_place_real_vors_near_the_route() {
    let mut bundled = BundledSource { airports: airports() };
    // Frankfurt VOR-DME and Kempten NDB (OurAirports); KPT exists elsewhere too
    let r = resolve("EDDF", "LOWI", "FFM KPT", airports(), &mut [&mut bundled]);
    assert_eq!(idents(&r), ["EDDF", "FFM", "KPT", "LOWI"], "{r:?}");
    assert!((r.points[1].lat - 50.05).abs() < 0.2 && (r.points[1].lon - 8.64).abs() < 0.2);
    assert!(r.points[2].lat > 47.0 && r.points[2].lat < 48.5, "the Kempten one: {:?}", r.points[2]);
    assert_eq!(r.points[1].source, SourceId::Navaids);
}

#[test]
fn json_shape() {
    let mut xp = Fake::new(SourceId::Xplane, vec![("KOPOR", 49.8, 8.9)]);
    let r = resolve("EDDF", "EDDM", "KOPOR", airports(), &mut [&mut xp]);
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["points"][1]["source"], "xplane");
    assert_eq!(v["points"][1]["resolved"], true);
    assert_eq!(v["points"][1]["gapBefore"], false);
    assert!(v["points"][1].get("airway").is_none());
    for k in ["unresolved", "total", "resolvedCount", "enroute", "airwaysExpanded", "sources"] {
        assert!(v.get(k).is_some(), "{k}");
    }
}

#[test]
fn xplane_fixture_as_source() {
    let mut idx = xplane::XpIndex::default();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("xplane");
    let rd = |n: &str| std::io::BufReader::new(std::fs::File::open(dir.join(n)).unwrap());
    idx.add_fixes(rd("earth_fix.dat"));
    idx.add_navaids(rd("earth_nav.dat"));
    idx.add_airways(rd("earth_awy.dat"));
    let mut xp = XPlaneSource(Arc::new(idx));
    let r = resolve("EDDF", "EDDM", "N0450F350 ANEKI/N0450F350 UZ650 DIBIR DCT ROLIS", airports(), &mut [&mut xp]);
    assert_eq!(idents(&r), ["EDDF", "ANEKI", "KOPOR", "FFM", "DIBIR", "ROLIS", "EDDM"]);
    assert_eq!(r.points[5].lat, 49.0, "the ROLIS near the route");
    assert_eq!(r.airways_expanded, 1);
}

// ---- MSFS through a stand-in session ----

/// Serves the broker like a SimConnect session would, from a fixed table, until dropped.
struct FakeSim {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<Vec<FacilityQuery>>>,
}

impl FakeSim {
    fn start(broker: &FacilityBroker, answer: impl Fn(&FacilityQuery) -> FacilityAnswer + Send + 'static) -> Self {
        broker.attach();
        let b = broker.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut seen = Vec::new();
            while !s.load(std::sync::atomic::Ordering::Relaxed) {
                for (t, q) in b.take(64) {
                    b.complete(t, answer(&q));
                    seen.push(q);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            b.detach();
            seen
        });
        Self { stop, thread: Some(thread) }
    }

    fn finish(mut self) -> Vec<FacilityQuery> {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap()
    }
}

fn link(ident: &str, lat: f64, lon: f64) -> Option<LinkFix> {
    Some(LinkFix { ident: ident.into(), region: "ED".into(), lat, lon })
}

/// A little airway UZ650: ANEKI – KOPOR – FFM – DIBIR, plus an ambiguous NDB.
fn sim_answer(q: &FacilityQuery) -> FacilityAnswer {
    let found = |lat, lon, routes| FacilityAnswer::Found { lat, lon, region: "ED".into(), routes };
    let uz = |prev: Option<LinkFix>, next: Option<LinkFix>| vec![RouteLink { airway: "UZ650".into(), prev, next }];
    match (q.kind, q.ident.as_str()) {
        (FacKind::Waypoint, "ANEKI") => found(49.72, 8.47, uz(None, link("KOPOR", 49.8, 8.9))),
        (FacKind::Waypoint, "KOPOR") => found(49.8, 8.9, uz(link("ANEKI", 49.72, 8.47), link("FFM", 49.5, 9.3))),
        (FacKind::Waypoint, "FFM") => found(49.5, 9.3, uz(link("KOPOR", 49.8, 8.9), link("DIBIR", 49.2, 9.9))),
        (FacKind::Waypoint, "DIBIR") => found(49.2, 9.9, uz(link("FFM", 49.5, 9.3), None)),
        (FacKind::Ndb, "KPT") => FacilityAnswer::Ambiguous(vec![
            MinimalFacility { kind: Some(FacKind::Ndb), ident: "KPT".into(), region: "UU".into(), lat: 55.0, lon: 37.0 },
            MinimalFacility { kind: Some(FacKind::Ndb), ident: "KPT".into(), region: "ED".into(), lat: 47.7, lon: 10.3 },
        ]),
        _ => FacilityAnswer::NotFound,
    }
}

#[test]
fn msfs_resolves_walks_airways_in_both_directions_and_picks_among_candidates() {
    let broker = FacilityBroker::default();
    let sim = FakeSim::start(&broker, sim_answer);
    let mut msfs = msfs::MsfsSource::new(&broker);
    let r = resolve("EDDF", "LOWI", "ANEKI UZ650 DIBIR KPT", airports(), &mut [&mut msfs]);
    assert_eq!(idents(&r), ["EDDF", "ANEKI", "KOPOR", "FFM", "DIBIR", "KPT", "LOWI"]);
    assert_eq!(r.points[5].lat, 47.7, "the Kempten KPT");
    assert_eq!(r.sources, [SourceId::Msfs, SourceId::Airport]);
    // the other way round along the same airway
    let mut msfs = msfs::MsfsSource::new(&broker);
    let r = resolve("EDDM", "EDDF", "DIBIR UZ650 ANEKI", airports(), &mut [&mut msfs]);
    assert_eq!(idents(&r), ["EDDM", "DIBIR", "FFM", "KOPOR", "ANEKI", "EDDF"]);
    let asked = sim.finish();
    // unknown idents went on to VOR and NDB; KPT stopped at NDB, nothing asked as AIRPORT twice
    assert!(asked.iter().any(|q| q.kind == FacKind::Vor && q.ident == "KPT"));
    assert!(!asked.iter().any(|q| q.kind == FacKind::Airport && q.ident == "KPT"));
}

#[test]
fn msfs_is_skipped_without_session_or_answer() {
    // no session: not even asked
    let broker = FacilityBroker::default();
    let mut msfs = msfs::MsfsSource::new(&broker);
    assert!(!msfs.alive());
    let mut bundled = BundledSource { airports: airports() };
    let t = Instant::now();
    let r = resolve("EDDF", "LOWI", "FFM", airports(), &mut [&mut msfs, &mut bundled]);
    assert_eq!(r.points[1].source, SourceId::Navaids);
    assert!(t.elapsed() < Duration::from_secs(1));
    // a session that never answers: one timeout, then the rest goes on without it
    broker.attach();
    let mut msfs = msfs::MsfsSource::with_timing(&broker, Duration::from_millis(100), Duration::from_secs(5));
    let mut bundled = BundledSource { airports: airports() };
    let t = Instant::now();
    let r = resolve("EDDF", "LOWI", "FFM UZ650 KPT", airports(), &mut [&mut msfs, &mut bundled]);
    assert!(!msfs.alive());
    assert_eq!(idents(&r), ["EDDF", "FFM", "KPT", "LOWI"]);
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    broker.detach();
}

#[test]
fn cache_key_normalises_the_route_text() {
    let c = RouteCache::default();
    let k = RouteCache::key(" eddf", "EDDM ", "ANEKI  UZ650\tDIBIR", true);
    assert_eq!(k, ("EDDF".into(), "EDDM".into(), "ANEKI UZ650 DIBIR".into(), true));
    assert!(c.get(&k).is_none());
    c.put(k.clone(), Arc::new(RouteResolution::default()));
    assert!(c.get(&k).is_some());
    assert!(c.get(&RouteCache::key("EDDF", "EDDM", "ANEKI UZ650 DIBIR", false)).is_none());
}
