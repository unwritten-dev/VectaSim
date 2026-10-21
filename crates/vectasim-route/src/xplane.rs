//! Navigation data of an X-Plane installed on this PC (X-Plane 11 or 12), read in place:
//! `earth_fix.dat` (waypoints), `earth_nav.dat` (VOR/NDB) and `earth_awy.dat` (airway
//! segments). Nothing is copied or sent anywhere.
//!
//! Install folders come from `%LOCALAPPDATA%\x-plane_install_12.txt` and
//! `x-plane_install_11.txt` (written by the X-Plane installer, one path per line; X-Plane 12
//! first). Per file, `Custom Data\` (a Navigraph or other AIRAC update) wins over
//! `Resources\default data\`. The first install that has an `earth_fix.dat` or `earth_nav.dat`
//! is used.
//!
//! The files are tens of MB, so they are parsed once, lazily, on a background thread
//! ([`XPlaneNav::index`]); callers wait for it with a timeout. Memory is bounded by
//! [`MAX_LINES`] per file and [`MAX_FILE_BYTES`]; the index keeps idents, regions and positions
//! only (≈ 30–50 MB for a full AIRAC).
//!
//! Formats (X-Plane DSF/nav data specs): fix 1101/1200 `lat lon ident terminal region …`
//! (600: `lat lon ident`); nav 1150/1200 `code lat lon elev freq range magvar ident terminal
//! region name…` with code 2 = NDB, 3 = VOR (810 without terminal/region); airway 1100
//! `id1 reg1 type1 id2 reg2 type2 dir level base top names` (names joined by `-`; types 11 =
//! fix, 2 = NDB, 3 = VOR), 640 `id1 lat1 lon1 id2 lat2 lon2 level base top names`.

use crate::Candidate;
use crate::SourceId;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Lines read per file at most (a full AIRAC has ≈ 300 000 fixes, 150 000 airway segments).
pub const MAX_LINES: usize = 3_000_000;
/// Files larger than this are not read.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

const FIX: u8 = 11;
const NDB: u8 = 2;
const VOR: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq)]
struct XpFix {
    lat: f64,
    lon: f64,
    region: [u8; 2],
    kind: u8,
}

#[derive(Debug, Clone, PartialEq)]
struct Node {
    ident: Box<str>,
    region: [u8; 2],
    lat: f64,
    lon: f64,
}

/// The parsed nav data.
#[derive(Debug, Default)]
pub struct XpIndex {
    fixes: HashMap<Box<str>, Vec<XpFix>>,
    nodes: Vec<Node>,
    /// Airway name → segments (node indices).
    airways: HashMap<Box<str>, Vec<(u32, u32)>>,
    /// Where it came from (log, diagnostics).
    pub folder: PathBuf,
}

fn region2(s: &str) -> [u8; 2] {
    let b = s.as_bytes();
    [b.first().copied().unwrap_or(b' '), b.get(1).copied().unwrap_or(b' ')]
}

fn region_str(r: [u8; 2]) -> String {
    String::from_utf8_lossy(&r).trim().to_string()
}

fn coord(lat: &str, lon: &str) -> Option<(f64, f64)> {
    let (lat, lon) = (lat.parse::<f64>().ok()?, lon.parse::<f64>().ok()?);
    (lat.abs() <= 90.0 && lon.abs() <= 180.0).then_some((lat, lon))
}

/// Data lines of an X-Plane `.dat` file: header ("I"/"A" + version line) and the "99" end skipped.
fn data_lines(text: impl BufRead) -> impl Iterator<Item = String> {
    text.lines().map_while(Result::ok).skip(2).take(MAX_LINES).take_while(|l| l.trim() != "99")
}

impl XpIndex {
    pub fn fix_count(&self) -> usize {
        self.fixes.values().map(Vec::len).sum()
    }

    pub fn airway_count(&self) -> usize {
        self.airways.len()
    }

    pub fn add_fixes(&mut self, text: impl BufRead) {
        for line in data_lines(text) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 3 {
                continue;
            }
            let Some((lat, lon)) = coord(f[0], f[1]) else { continue };
            let region = f.get(4).map_or([b' '; 2], |r| region2(r));
            self.fixes.entry(f[2].to_ascii_uppercase().into()).or_default().push(XpFix { lat, lon, region, kind: FIX });
        }
    }

    pub fn add_navaids(&mut self, text: impl BufRead) {
        for line in data_lines(text) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 8 {
                continue;
            }
            let kind = match f[0] {
                "2" => NDB,
                "3" => VOR,
                _ => continue,
            };
            let Some((lat, lon)) = coord(f[1], f[2]) else { continue };
            // 1150/1200: terminal + region after the ident; 810: the name follows directly
            let region = match f.get(9) {
                Some(r) if r.len() == 2 && f.len() >= 10 => region2(r),
                _ => [b' '; 2],
            };
            self.fixes.entry(f[7].to_ascii_uppercase().into()).or_default().push(XpFix { lat, lon, region, kind });
        }
    }

    fn node(&mut self, keys: &mut HashMap<(Box<str>, [u8; 2], u8), u32>, ident: &str, region: [u8; 2], kind: u8) -> Option<u32> {
        let key: (Box<str>, [u8; 2], u8) = (ident.into(), region, kind);
        if let Some(&n) = keys.get(&key) {
            return Some(n);
        }
        let cands = self.fixes.get(ident)?;
        let f = cands.iter().find(|c| c.region == region && c.kind == kind).or_else(|| cands.iter().find(|c| c.region == region))?;
        let n = self.nodes.len() as u32;
        self.nodes.push(Node { ident: ident.into(), region, lat: f.lat, lon: f.lon });
        keys.insert(key, n);
        Some(n)
    }

    /// Airway segments; call after the fixes and navaids are in (1100 refers to them by ident/region).
    pub fn add_airways(&mut self, text: impl BufRead) {
        let mut keys: HashMap<(Box<str>, [u8; 2], u8), u32> = HashMap::new();
        // 640 format: nodes by ident + rounded position
        let mut pos_keys: HashMap<(Box<str>, i64, i64), u32> = HashMap::new();
        for line in data_lines(text) {
            let f: Vec<&str> = line.split_whitespace().collect();
            let (a, b, names) = if f.len() >= 11 && f[1].len() <= 2 && f[2].parse::<u8>().is_ok() {
                let (t1, t2) = (f[2].parse::<u8>().unwrap_or(FIX), f[5].parse::<u8>().unwrap_or(FIX));
                let a = self.node(&mut keys, &f[0].to_ascii_uppercase(), region2(f[1]), t1);
                let b = self.node(&mut keys, &f[3].to_ascii_uppercase(), region2(f[4]), t2);
                (a, b, f[10])
            } else if f.len() >= 10 && f[1].contains('.') {
                let mut by_pos = |ident: &str, lat: &str, lon: &str| -> Option<u32> {
                    let (lat, lon) = coord(lat, lon)?;
                    let key: (Box<str>, i64, i64) =
                        (ident.to_ascii_uppercase().into(), (lat * 1e4).round() as i64, (lon * 1e4).round() as i64);
                    Some(*pos_keys.entry(key).or_insert_with(|| {
                        self.nodes.push(Node { ident: ident.to_ascii_uppercase().into(), region: [b' '; 2], lat, lon });
                        (self.nodes.len() - 1) as u32
                    }))
                };
                (by_pos(f[0], f[1], f[2]), by_pos(f[3], f[4], f[5]), f[9])
            } else {
                continue;
            };
            let (Some(a), Some(b)) = (a, b) else { continue };
            for name in names.split('-').filter(|n| !n.is_empty()) {
                self.airways.entry(name.to_ascii_uppercase().into()).or_default().push((a, b));
            }
        }
    }

    /// Every fix/navaid with this ident.
    pub fn candidates(&self, ident: &str) -> Vec<Candidate> {
        self.fixes
            .get(ident)
            .map(|v| {
                v.iter()
                    .map(|f| Candidate {
                        ident: ident.to_owned(),
                        lat: f.lat,
                        lon: f.lon,
                        region: region_str(f.region),
                        source: SourceId::Xplane,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The fixes strictly between `from` and `to` along `airway` (fewest segments, either
    /// direction). The end nodes are the ones with the right ident nearest to the resolved
    /// points (within 30 nm). None when the airway is unknown or does not connect them.
    pub fn airway(&self, airway: &str, from: &Candidate, to: &Candidate) -> Option<Vec<Candidate>> {
        let segs = self.airways.get(airway)?;
        let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
        for &(a, b) in segs {
            adj.entry(a).or_default().push(b);
            adj.entry(b).or_default().push(a);
        }
        let pick = |c: &Candidate| -> Option<u32> {
            adj.keys()
                .copied()
                .filter(|&n| *self.nodes[n as usize].ident == *c.ident)
                .map(|n| (n, crate::dist_nm(self.nodes[n as usize].lat, self.nodes[n as usize].lon, c.lat, c.lon)))
                .filter(|(_, d)| *d <= 30.0)
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(n, _)| n)
        };
        let (start, goal) = (pick(from)?, pick(to)?);
        let mut prev: HashMap<u32, u32> = HashMap::new();
        let mut seen: HashSet<u32> = HashSet::from([start]);
        let mut queue = VecDeque::from([start]);
        while let Some(n) = queue.pop_front() {
            if n == goal {
                break;
            }
            for &m in adj.get(&n).map(Vec::as_slice).unwrap_or_default() {
                if seen.insert(m) {
                    prev.insert(m, n);
                    queue.push_back(m);
                }
            }
        }
        if start != goal && !prev.contains_key(&goal) {
            return None;
        }
        let mut path = Vec::new();
        let mut n = goal;
        while let Some(&p) = prev.get(&n) {
            if p == start {
                break;
            }
            path.push(p);
            n = p;
        }
        path.reverse();
        Some(
            path.into_iter()
                .map(|n| {
                    let node = &self.nodes[n as usize];
                    Candidate {
                        ident: node.ident.to_string(),
                        lat: node.lat,
                        lon: node.lon,
                        region: region_str(node.region),
                        source: SourceId::Xplane,
                    }
                })
                .collect(),
        )
    }
}

/// X-Plane install folders named in `%LOCALAPPDATA%\x-plane_install_{12,11}.txt`, existing ones only.
pub fn install_dirs(local_app_data: Option<&Path>) -> Vec<PathBuf> {
    let Some(base) = local_app_data else { return Vec::new() };
    let mut out: Vec<PathBuf> = Vec::new();
    for name in ["x-plane_install_12.txt", "x-plane_install_11.txt"] {
        let Ok(text) = std::fs::read_to_string(base.join(name)) else { continue };
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let p = PathBuf::from(line.trim_end_matches(['/', '\\']));
            if p.is_dir() && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// The three files of one install: Custom Data first, else the default data.
pub fn nav_files(install: &Path) -> [Option<PathBuf>; 3] {
    let pick = |name: &str| {
        [install.join("Custom Data").join(name), install.join("Resources").join("default data").join(name)]
            .into_iter()
            .find(|p| p.is_file())
    };
    [pick("earth_fix.dat"), pick("earth_nav.dat"), pick("earth_awy.dat")]
}

fn open(p: &Option<PathBuf>) -> Option<BufReader<std::fs::File>> {
    let p = p.as_ref()?;
    let f = std::fs::File::open(p).ok()?;
    if f.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > MAX_FILE_BYTES {
        log::warn!("X-Plane nav file too large, skipped: {}", p.display());
        return None;
    }
    Some(BufReader::with_capacity(1 << 16, f))
}

/// Parse the nav data of the first usable install. None: no X-Plane or no nav files.
pub fn load(installs: &[PathBuf]) -> Option<XpIndex> {
    for dir in installs {
        let files = nav_files(dir);
        if files[0].is_none() && files[1].is_none() {
            continue;
        }
        let started = Instant::now();
        let mut idx = XpIndex { folder: dir.clone(), ..XpIndex::default() };
        if let Some(r) = open(&files[0]) {
            idx.add_fixes(r);
        }
        if let Some(r) = open(&files[1]) {
            idx.add_navaids(r);
        }
        if let Some(r) = open(&files[2]) {
            idx.add_airways(r);
        }
        log::info!(
            "X-Plane nav data from {}: {} fixes/navaids, {} airways in {} ms",
            dir.display(),
            idx.fix_count(),
            idx.airway_count(),
            started.elapsed().as_millis()
        );
        return Some(idx);
    }
    None
}

#[derive(Default)]
enum LoadState {
    #[default]
    Idle,
    Loading,
    Done(Option<Arc<XpIndex>>),
}

/// The background parse has not finished within the wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StillLoading;

/// Lazily loaded X-Plane nav data, shared by every lookup of the process.
#[derive(Default)]
pub struct XPlaneNav {
    state: Mutex<LoadState>,
    cv: Condvar,
}

impl XPlaneNav {
    pub fn shared() -> &'static XPlaneNav {
        static NAV: OnceLock<XPlaneNav> = OnceLock::new();
        NAV.get_or_init(XPlaneNav::default)
    }

    /// The index, starting the background parse on the first call and waiting at most `wait`
    /// for it. `Err(StillLoading)` after `wait`; `Ok(None)` = no X-Plane nav data here.
    pub fn index(&'static self, wait: Duration) -> Result<Option<Arc<XpIndex>>, StillLoading> {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        self.index_from(wait, move || load(&install_dirs(local.as_deref())))
    }

    pub fn index_from(
        &'static self,
        wait: Duration,
        loader: impl FnOnce() -> Option<XpIndex> + Send + 'static,
    ) -> Result<Option<Arc<XpIndex>>, StillLoading> {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*g, LoadState::Idle) {
            *g = LoadState::Loading;
            let spawned = std::thread::Builder::new().name("xplane-navdata".into()).spawn(move || {
                let idx = loader().map(Arc::new);
                *self.state.lock().unwrap_or_else(|e| e.into_inner()) = LoadState::Done(idx);
                self.cv.notify_all();
            });
            if spawned.is_err() {
                *g = LoadState::Done(None);
            }
        }
        let deadline = Instant::now() + wait;
        loop {
            if let LoadState::Done(idx) = &*g {
                return Ok(idx.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(StillLoading);
            }
            g = self.cv.wait_timeout(g, deadline - now).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("xplane").join(name)
    }

    pub(crate) fn fixture_index() -> XpIndex {
        let rd = |n: &str| BufReader::new(std::fs::File::open(fixture(n)).unwrap());
        let mut idx = XpIndex::default();
        idx.add_fixes(rd("earth_fix.dat"));
        idx.add_navaids(rd("earth_nav.dat"));
        idx.add_airways(rd("earth_awy.dat"));
        idx
    }

    fn cand(ident: &str, lat: f64, lon: f64) -> Candidate {
        Candidate { ident: ident.into(), lat, lon, region: String::new(), source: SourceId::Xplane }
    }

    #[test]
    fn parses_fixes_navaids_and_airways() {
        let idx = fixture_index();
        // two ROLIS worldwide, one VOR FFM, NDB KPT; DME rows and the header are skipped
        assert_eq!(idx.candidates("ROLIS").len(), 2);
        let ffm = idx.candidates("FFM");
        assert_eq!(ffm.len(), 1);
        assert_eq!(ffm[0].region, "ED");
        assert_eq!(idx.candidates("KPT").len(), 1);
        assert!(idx.candidates("99").is_empty());
        assert_eq!(idx.airway_count(), 3);
    }

    #[test]
    fn walks_an_airway_in_either_direction() {
        let idx = fixture_index();
        let a = cand("ANEKI", 49.72, 8.47);
        let d = cand("DIBIR", 49.20, 9.90);
        let ids = |v: Vec<Candidate>| v.into_iter().map(|c| c.ident).collect::<Vec<_>>();
        assert_eq!(ids(idx.airway("UZ650", &a, &d).unwrap()), ["KOPOR", "FFM"]);
        assert_eq!(ids(idx.airway("UZ650", &d, &a).unwrap()), ["FFM", "KOPOR"]);
        // the shared segment of a second airway (names joined by '-')
        assert_eq!(ids(idx.airway("T180", &a, &cand("KOPOR", 49.80, 8.90)).unwrap()), Vec::<String>::new());
        // unknown airway, unknown fix, fix far from the resolved point
        assert!(idx.airway("Q999", &a, &d).is_none());
        assert!(idx.airway("UZ650", &a, &cand("NOPE", 49.0, 9.0)).is_none());
        assert!(idx.airway("UZ650", &cand("ANEKI", 10.0, 10.0), &d).is_none());
        // the 640 format (with coordinates) is read too
        assert_eq!(ids(idx.airway("A1", &cand("OLDAA", 10.0, 10.0), &cand("OLDCC", 10.2, 10.2)).unwrap()), ["OLDBB"]);
    }

    #[test]
    fn install_lookup_reads_the_installer_files_and_prefers_custom_data() {
        let tmp = tempfile::tempdir().unwrap();
        let xp12 = tmp.path().join("X-Plane 12");
        std::fs::create_dir_all(xp12.join("Custom Data")).unwrap();
        std::fs::create_dir_all(xp12.join("Resources").join("default data")).unwrap();
        std::fs::copy(fixture("earth_fix.dat"), xp12.join("Custom Data").join("earth_fix.dat")).unwrap();
        std::fs::copy(fixture("earth_nav.dat"), xp12.join("Resources").join("default data").join("earth_nav.dat")).unwrap();
        let missing = tmp.path().join("gone");
        std::fs::write(tmp.path().join("x-plane_install_12.txt"), format!("{}\r\n\r\n{}\\\n", missing.display(), xp12.display())).unwrap();
        let dirs = install_dirs(Some(tmp.path()));
        assert_eq!(dirs, vec![xp12.clone()]);
        let [fix, nav, awy] = nav_files(&xp12);
        assert!(fix.unwrap().starts_with(xp12.join("Custom Data")));
        assert!(nav.unwrap().starts_with(xp12.join("Resources")));
        assert!(awy.is_none());
        let idx = load(&dirs).unwrap();
        assert_eq!(idx.folder, xp12);
        assert_eq!(idx.candidates("FFM").len(), 1);
        assert_eq!(idx.airway_count(), 0);
        assert!(install_dirs(None).is_empty());
        assert!(load(&[missing]).is_none());
    }

    #[test]
    fn background_load_is_waited_for_with_a_timeout() {
        let nav: &'static XPlaneNav = Box::leak(Box::default());
        let slow = || {
            std::thread::sleep(Duration::from_millis(150));
            Some(fixture_index())
        };
        assert_eq!(nav.index_from(Duration::from_millis(10), slow).map(|_| ()), Err(StillLoading));
        // the second call does not start a second parse and gets the result
        let idx = nav.index_from(Duration::from_secs(5), || panic!("parsed twice")).unwrap().unwrap();
        assert_eq!(idx.candidates("FFM").len(), 1);
    }
}
