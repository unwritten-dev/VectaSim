//! Airports and runways from OurAirports (public domain), embedded at build
//! time and indexed in memory. ~49k airports / ~35k runways. Radio navaids (`navaids`) for
//! placing filed online routes.
//!
//! The CSVs in `data/` are the source of truth; `build.rs` precompiles them into a compact binary
//! index (`binfmt.rs`, strings in one table, grid precomputed) that `load()` opens in a few ms;
//! records are decoded lazily on first access.
//! If that blob is missing or does not fit this build, the CSVs are parsed instead (slower, same
//! result).
//!
//! Lookups: by ident, by bounding box (for the map viewport) and nearest
//! airport (to name departure/arrival of a flight). A dense 1°×1° grid keeps both
//! spatial queries cheap without pulling in an R-tree crate.

mod binfmt;
pub mod countries;
pub mod navaids;
mod source;

use binfmt::Layout;
use serde::Serialize;
use source::{IndexParts, cell, cell_slot};
use std::borrow::Cow;
use std::cmp::Ordering;
use std::sync::OnceLock;
pub use source::{Airport, Runway};

const AIRPORTS_CSV: &str = include_str!("../data/airports.csv");
const RUNWAYS_CSV: &str = include_str!("../data/runways.csv");
/// Written by build.rs; empty when precompiling failed.
const AIRPORTS_BIN: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/airports.vsad"));

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearestAirport {
    pub airport: Airport,
    pub distance_nm: f64,
}

pub struct AirportIndex {
    /// VSAD blob (see `binfmt.rs`): the embedded one, or one encoded from the CSVs as fallback.
    blob: Cow<'static, [u8]>,
    layout: Layout,
    /// Records are materialised on first access; `&Airport`/`&[Runway]` borrow from here.
    airports: Box<[OnceLock<Airport>]>,
    runway_groups: Box<[OnceLock<Box<[Runway]>>]>,
}

impl AirportIndex {
    /// Open the precompiled index, falling back to parsing the embedded CSVs.
    pub fn load() -> Self {
        let idx = Self::from_binary(AIRPORTS_BIN).unwrap_or_else(|| {
            log::warn!("airport index: precompiled blob unusable ({} bytes), parsing CSV", AIRPORTS_BIN.len());
            Self::from_csv()
        });
        log::info!("airport index: {} airports, {} airports with runways", idx.len(), idx.layout.n_groups);
        idx
    }

    /// Open a precompiled blob; None if it does not fit this build (magic, version, size, indices).
    fn from_binary(blob: &'static [u8]) -> Option<Self> {
        Self::from_blob(Cow::Borrowed(blob))
    }

    /// Parse the embedded CSVs and encode them in memory. Panics only on a malformed embedded
    /// file, which is a build error.
    fn from_csv() -> Self {
        let parts = IndexParts::build(source::parse_airports(AIRPORTS_CSV), source::parse_runways(RUNWAYS_CSV));
        Self::from_blob(Cow::Owned(binfmt::encode(&parts))).expect("freshly encoded index is valid")
    }

    fn from_blob(blob: Cow<'static, [u8]>) -> Option<Self> {
        let layout = Layout::parse(&blob)?;
        let airports = std::iter::repeat_with(OnceLock::new).take(layout.n_airports).collect();
        let runway_groups = std::iter::repeat_with(OnceLock::new).take(layout.n_groups).collect();
        Some(Self { blob, layout, airports, runway_groups })
    }

    fn airport_at(&self, i: usize) -> &Airport {
        self.airports[i].get_or_init(|| self.layout.airport(&self.blob, i))
    }

    /// Airport indices of one 1-degree cell (empty outside the grid).
    fn cell_indices(&self, lat_cell: i16, lon_cell: i16) -> impl Iterator<Item = usize> + '_ {
        cell_slot(lat_cell, lon_cell).into_iter().flat_map(|s| self.layout.cell(&self.blob, s))
    }

    pub fn len(&self) -> usize {
        self.layout.n_airports
    }

    pub fn is_empty(&self) -> bool {
        self.layout.n_airports == 0
    }

    pub fn get(&self, ident: &str) -> Option<&Airport> {
        let key = ident.to_ascii_uppercase();
        let (l, b) = (&self.layout, &*self.blob);
        let pos = binary_search(l.n_airports, |k| l.airport_ident(b, l.ordered(b, k)).cmp(key.as_str()))?;
        Some(self.airport_at(l.ordered(b, pos)))
    }

    pub fn runways(&self, ident: &str) -> &[Runway] {
        let key = ident.to_ascii_uppercase();
        let (l, b) = (&self.layout, &*self.blob);
        let Some(g) = binary_search(l.n_groups, |k| l.group_ident(b, k).cmp(key.as_str())) else { return &[] };
        self.runway_groups[g].get_or_init(|| {
            let (start, len) = l.group(b, g);
            (start..start + len).map(|j| l.runway(b, j)).collect()
        })
    }

    /// Airports inside the box, largest first, at most `limit`. Handles boxes crossing the antimeridian.
    pub fn in_bbox(&self, min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64, limit: usize) -> Vec<&Airport> {
        let (min_lat, max_lat) = (min_lat.clamp(-90.0, 90.0), max_lat.clamp(-90.0, 90.0));
        let lon_ranges: Vec<(f64, f64)> =
            if min_lon <= max_lon { vec![(min_lon, max_lon)] } else { vec![(min_lon, 180.0), (-180.0, max_lon)] };
        let (l, b) = (&self.layout, &*self.blob);
        let mut found: Vec<usize> = Vec::new();
        for (lo, hi) in lon_ranges {
            for lat_cell in (min_lat.floor() as i16)..=(max_lat.floor() as i16) {
                for lon_cell in (lo.floor() as i16)..=(hi.floor() as i16) {
                    for i in self.cell_indices(lat_cell, lon_cell) {
                        let (alat, alon) = l.airport_pos(b, i);
                        if alat >= min_lat && alat <= max_lat && alon >= lo && alon <= hi {
                            found.push(i);
                        }
                    }
                }
            }
        }
        // rank from the raw record, so only the `limit` survivors get decoded
        found.sort_by_key(|&i| size_rank(l.airport_kind(b, i)));
        found.truncate(limit);
        found.into_iter().map(|i| self.airport_at(i)).collect()
    }

    /// Nearest airport within `max_nm`, searching outward ring by ring on the grid.
    ///
    /// A cell is 60 nm high but only 60·cos(lat) nm wide, so towards the poles a ring reaches
    /// `k` cells east and west for every cell north and south (`k` from the most poleward
    /// latitude within `max_nm`): every ring then covers at least `r`·60 nm in each direction,
    /// and the search stops once the best hit is closer than that. Up to 0.5.0 a ring was one
    /// cell wide in longitude, which at high latitudes could miss or misrank airports a few
    /// cells east or west. Longitude cells wrap across the antimeridian.
    pub fn nearest(&self, lat: f64, lon: f64, max_nm: f64) -> Option<NearestAirport> {
        if !(lat.is_finite() && lon.is_finite() && max_nm >= 0.0) {
            return None;
        }
        let (clat, clon) = cell(lat, lon);
        // one grid cell is 60 nm in latitude, so a ring radius of ceil(max_nm/60)+1 covers the box
        let rings = (max_nm / 60.0).ceil().min(180.0) as i16 + 1;
        // longitude cells per latitude cell; +1° for the great circle bulging poleward
        let lat_far = (lat.abs() + max_nm / 60.0 + 1.0).min(90.0);
        let k = (1.0 / lat_far.to_radians().cos().max(1e-6)).ceil().min(180.0) as i16;
        let mut best: Option<(f64, usize)> = None;
        for r in 0..=rings {
            // offsets -span..=span cover each longitude cell once (−180 == 180)
            let span = (k * r).min(180);
            let from = if span == 180 { -179 } else { -span };
            for dlat in -r..=r {
                for dlon in from..=span {
                    let ring = dlat.abs().max((dlon.abs() + k - 1) / k);
                    if ring != r {
                        continue; // only the ring's border cells; inner ones were visited already
                    }
                    for i in self.cell_indices(clat + dlat, wrap_lon_cell(clon + dlon)) {
                        let (alat, alon) = self.layout.airport_pos(&self.blob, i);
                        let d = haversine_nm(lat, lon, alat, alon);
                        if d <= max_nm && best.is_none_or(|(bd, _)| d < bd) {
                            best = Some((d, i));
                        }
                    }
                }
            }
            // anything in a farther ring is at least r · 60 nm away; stop once best is closer
            if let Some((bd, _)) = best
                && bd < (r as f64) * 60.0
            {
                break;
            }
        }
        best.map(|(distance_nm, i)| NearestAirport { airport: self.airport_at(i).clone(), distance_nm })
    }
}

fn size_rank(kind: &str) -> u8 {
    match kind {
        "large" => 0,
        "medium" => 1,
        "small" => 2,
        _ => 3,
    }
}

/// Index `k` in `0..n` where `cmp(k)` is Equal, for a sequence sorted ascending.
fn binary_search(n: usize, cmp: impl Fn(usize) -> Ordering) -> Option<usize> {
    let (mut lo, mut hi) = (0, n);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match cmp(mid) {
            Ordering::Less => lo = mid + 1,
            Ordering::Greater => hi = mid,
            Ordering::Equal => return Some(mid),
        }
    }
    None
}

fn wrap_lon_cell(c: i16) -> i16 {
    (c + 180).rem_euclid(360) - 180
}

pub fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R_NM: f64 = 3_440.065;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dlat = p2 - p1;
    let dlon = (lon2 - lon1).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R_NM * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn index() -> &'static AirportIndex {
        static IDX: OnceLock<AirportIndex> = OnceLock::new();
        IDX.get_or_init(AirportIndex::load)
    }

    #[test]
    fn loads_a_sane_number_of_airports() {
        let idx = index();
        assert!(idx.len() > 40_000, "{}", idx.len());
        let eddf = idx.get("eddf").expect("EDDF present");
        assert_eq!(eddf.kind, "large");
        assert_eq!(eddf.iata, "FRA");
        assert!((eddf.latitude - 50.0267).abs() < 0.01);
    }

    #[test]
    fn displaced_thresholds_per_end() {
        // KLAX 06R/24L: 530 ft / 800 ft displaced (OurAirports); EDDF 07C/25C: none
        let r = index().runways("KLAX").iter().find(|r| r.le_ident == "6R").expect("KLAX 6R");
        assert_eq!((r.le_displaced_threshold_ft, r.he_displaced_threshold_ft), (Some(530), Some(800)));
        let r = index().runways("EDDF").iter().find(|r| r.le_ident == "07C").expect("EDDF 07C");
        assert_eq!((r.le_displaced_threshold_ft, r.he_displaced_threshold_ft), (None, None));
    }

    #[test]
    fn runways_are_attached() {
        let rw = index().runways("EDDF");
        assert_eq!(rw.len(), 4, "{rw:?}");
        assert!(rw.iter().any(|r| r.le_ident == "07C" || r.he_ident == "25C"));
        assert!(rw.iter().all(|r| r.length_ft.unwrap_or(0) > 2_000));
    }

    #[test]
    fn bbox_returns_large_first_and_respects_limit() {
        let idx = index();
        let all = idx.in_bbox(8.0, 49.5, 9.0, 50.5, 1000);
        assert!(all.iter().any(|a| a.ident == "EDDF"));
        assert_eq!(all[0].kind, "large");
        assert_eq!(idx.in_bbox(8.0, 49.5, 9.0, 50.5, 3).len(), 3);
        assert!(idx.in_bbox(0.0, 0.0, 0.0, 0.0, 10).is_empty());
    }

    #[test]
    fn bbox_across_antimeridian() {
        // Fiji (east, ~178°) and the Samoa side (west, ~-172°) in one box
        let hits = index().in_bbox(170.0, -20.0, -168.0, -12.0, 500);
        assert!(hits.iter().any(|a| a.ident == "NFFN"), "Nadi missing");
        assert!(hits.iter().any(|a| a.ident == "NSTU"), "Pago Pago missing");
    }

    #[test]
    fn nearest_finds_frankfurt_and_respects_radius() {
        let idx = index();
        // on the EDDF apron (the mock flight's start position)
        let n = idx.nearest(50.033, 8.570, 5.0).unwrap();
        assert_eq!(n.airport.ident, "EDDF");
        assert!(n.distance_nm < 1.0, "{}", n.distance_nm);
        // middle of the North Atlantic
        assert!(idx.nearest(45.0, -35.0, 50.0).is_none());
        // far ring search still works with a large radius
        assert!(idx.nearest(45.0, -35.0, 600.0).is_some());
    }

    /// Brute force over every airport: the reference for `nearest`.
    fn nearest_brute_force(lat: f64, lon: f64, max_nm: f64) -> Option<(String, f64)> {
        index()
            .in_bbox(-180.0, -90.0, 180.0, 90.0, usize::MAX)
            .into_iter()
            .map(|a| (a.ident.clone(), haversine_nm(lat, lon, a.latitude, a.longitude)))
            .filter(|(_, d)| *d <= max_nm)
            .min_by(|a, b| a.1.total_cmp(&b.1))
    }

    #[test]
    fn nearest_at_high_latitudes_and_across_the_antimeridian_matches_brute_force() {
        // rings assumed 60 nm per cell east-west, it is 60·cos(lat)
        let idx = index();
        let svalbard = idx.get("ENSB").expect("Longyearbyen");
        let points = [
            (69.9, 23.0),                                  // 70°N, northern Norway
            (70.0, -150.0),                                // North Slope, Alaska
            (svalbard.latitude, svalbard.longitude - 3.0), // ENSB ~32 nm east of the point
            (78.25, 10.0),
            (82.5, -62.3), // Alert
            (89.9, 0.0),
            (-16.5, 179.99), // Fiji, east of the date line
            (-16.5, -179.99),
            (65.0, 179.9), // Chukotka / Bering Sea
            (65.0, -179.9),
            (50.033, 8.570),
            (-77.85, 166.7), // McMurdo
        ];
        for (lat, lon) in points {
            for max_nm in [3.0, 10.0, 50.0, 120.0, 400.0] {
                let got = idx.nearest(lat, lon, max_nm).map(|n| (n.airport.ident, n.distance_nm));
                let want = nearest_brute_force(lat, lon, max_nm);
                match (&got, &want) {
                    (Some(g), Some(w)) => assert!((g.1 - w.1).abs() < 1e-9, "({lat}, {lon}) {max_nm} nm: {got:?} vs {want:?}"),
                    _ => assert_eq!(got, want, "({lat}, {lon}) {max_nm} nm"),
                }
            }
        }
        // Longyearbyen from 32 nm west: three cells east at 78°N, found with a 50 nm radius
        let n = idx.nearest(svalbard.latitude, svalbard.longitude - 3.0, 50.0).expect("found");
        assert!(n.distance_nm > 30.0 && n.distance_nm < 40.0, "{n:?}");
        assert!(idx.nearest(f64::NAN, 0.0, 10.0).is_none());
        assert_eq!((wrap_lon_cell(180), wrap_lon_cell(-181), wrap_lon_cell(-180), wrap_lon_cell(179)), (-180, 179, -180, 179));
    }

    #[test]
    fn precompiled_index_matches_csv() {
        // the blob build.rs embedded is byte-identical to encoding the CSVs now
        let parts = IndexParts::build(source::parse_airports(AIRPORTS_CSV), source::parse_runways(RUNWAYS_CSV));
        assert!(binfmt::encode(&parts) == AIRPORTS_BIN, "embedded blob is stale or the encoder is not deterministic");

        let bin = AirportIndex::from_binary(AIRPORTS_BIN).expect("build.rs blob opens");
        assert!(matches!(bin.blob, Cow::Borrowed(_)));
        assert_eq!(bin.len(), parts.airports.len());
        assert_eq!(bin.layout.n_groups, parts.runway_groups.len());
        // every record, field by field, against the CSV parse
        for (i, a) in parts.airports.iter().enumerate() {
            assert_eq!(bin.airport_at(i), a);
            assert_eq!(bin.get(&a.ident), Some(a), "{}", a.ident);
        }
        let mut runways = 0;
        for &(start, len) in &parts.runway_groups {
            let ident = &parts.runways[start as usize].airport;
            assert_eq!(bin.runways(ident), &parts.runways[start as usize..(start + len) as usize], "{ident}");
            runways += bin.runways(ident).len();
        }
        assert_eq!(runways, parts.runways.len());
        // queries agree with the CSV-backed fallback index
        let csv = AirportIndex::from_csv();
        assert!(matches!(csv.blob, Cow::Owned(_)));
        assert_eq!(bin.in_bbox(-180.0, -90.0, 180.0, 90.0, 100_000).len(), csv.len());
        assert_eq!(bin.in_bbox(8.0, 49.5, 9.0, 50.5, 1000), csv.in_bbox(8.0, 49.5, 9.0, 50.5, 1000));
        assert_eq!(bin.nearest(45.0, -35.0, 600.0), csv.nearest(45.0, -35.0, 600.0));
        assert_eq!(bin.get("zzzz"), None);
        assert!(bin.runways("ZZZZ").is_empty());
    }

    #[test]
    fn rejects_foreign_or_damaged_blobs() {
        let leak = |v: Vec<u8>| -> &'static [u8] { Box::leak(v.into_boxed_slice()) };
        assert!(AirportIndex::from_binary(&[]).is_none());
        let mut wrong_version = AIRPORTS_BIN.to_vec();
        wrong_version[4] = binfmt::VERSION.wrapping_add(1);
        assert!(AirportIndex::from_binary(leak(wrong_version)).is_none());
        assert!(AirportIndex::from_binary(&AIRPORTS_BIN[..AIRPORTS_BIN.len() - 1]).is_none());
        let mut bad_index = AIRPORTS_BIN.to_vec();
        let n = bad_index.len();
        bad_index[n - 4..].copy_from_slice(&u32::MAX.to_le_bytes()); // last grid item out of range
        assert!(AirportIndex::from_binary(leak(bad_index)).is_none());
    }

    /// `cargo test -p vectasim-data --release -- --ignored --nocapture load_benchmark`
    #[test]
    #[ignore]
    fn load_benchmark() {
        let time = |f: &dyn Fn() -> AirportIndex| {
            (0..5)
                .map(|_| {
                    let t = std::time::Instant::now();
                    assert!(!f().is_empty());
                    t.elapsed()
                })
                .min()
                .unwrap()
        };
        let bin = time(&|| AirportIndex::from_binary(AIRPORTS_BIN).unwrap());
        let first_query = {
            let idx = AirportIndex::load();
            let t = std::time::Instant::now();
            assert!(!idx.in_bbox(-180.0, -90.0, 180.0, 90.0, 500).is_empty()); // world view: ranks 49k raw records, decodes 500
            t.elapsed()
        };
        let csv = time(&AirportIndex::from_csv);
        eprintln!(
            "airport index load (best of 5): binary {bin:?}, csv fallback {csv:?}; first world-bbox query {first_query:?}; blob {} KiB",
            AIRPORTS_BIN.len() / 1024
        );
    }
}
