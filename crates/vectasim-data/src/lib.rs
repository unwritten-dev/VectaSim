//! Airports and runways from OurAirports (public domain), embedded at build
//! time and indexed in memory. ~49k airports / ~35k runways, a few MB of CSV,
//! loaded once at startup in well under a second.
//!
//! Lookups: by ident, by bounding box (for the map viewport) and nearest
//! airport (to name departure/arrival of a flight). A 1°×1° grid keeps both
//! spatial queries cheap without pulling in an R-tree crate.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const AIRPORTS_CSV: &str = include_str!("../data/airports.csv");
const RUNWAYS_CSV: &str = include_str!("../data/runways.csv");

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Airport {
    pub ident: String,
    /// large | medium | small | seaplane_base
    pub kind: String,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub elevation_ft: Option<i32>,
    pub country: String,
    pub municipality: String,
    pub iata: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runway {
    pub airport: String,
    pub length_ft: Option<i32>,
    pub width_ft: Option<i32>,
    pub surface: String,
    pub le_ident: String,
    pub le_latitude: Option<f64>,
    pub le_longitude: Option<f64>,
    pub le_heading_deg: Option<f64>,
    pub he_ident: String,
    pub he_latitude: Option<f64>,
    pub he_longitude: Option<f64>,
    pub he_heading_deg: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearestAirport {
    pub airport: Airport,
    pub distance_nm: f64,
}

pub struct AirportIndex {
    airports: Vec<Airport>,
    by_ident: HashMap<String, usize>,
    /// (floor(lat), floor(lon)) → indices into `airports`
    grid: HashMap<(i16, i16), Vec<usize>>,
    runways: HashMap<String, Vec<Runway>>,
}

impl AirportIndex {
    /// Parse the embedded CSVs. Panics only on a malformed embedded file, which is a build error.
    pub fn load() -> Self {
        let airports = parse_airports(AIRPORTS_CSV);
        let mut by_ident = HashMap::with_capacity(airports.len());
        let mut grid: HashMap<(i16, i16), Vec<usize>> = HashMap::new();
        for (i, a) in airports.iter().enumerate() {
            by_ident.insert(a.ident.clone(), i);
            grid.entry(cell(a.latitude, a.longitude)).or_default().push(i);
        }
        let mut runways: HashMap<String, Vec<Runway>> = HashMap::new();
        for r in parse_runways(RUNWAYS_CSV) {
            runways.entry(r.airport.clone()).or_default().push(r);
        }
        log::info!("airport index: {} airports, {} airports with runways", airports.len(), runways.len());
        Self { airports, by_ident, grid, runways }
    }

    pub fn len(&self) -> usize {
        self.airports.len()
    }

    pub fn is_empty(&self) -> bool {
        self.airports.is_empty()
    }

    pub fn get(&self, ident: &str) -> Option<&Airport> {
        self.by_ident.get(&ident.to_ascii_uppercase()).map(|&i| &self.airports[i])
    }

    pub fn runways(&self, ident: &str) -> &[Runway] {
        self.runways.get(&ident.to_ascii_uppercase()).map_or(&[], Vec::as_slice)
    }

    /// Airports inside the box, largest first, at most `limit`. Handles boxes crossing the antimeridian.
    pub fn in_bbox(&self, min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64, limit: usize) -> Vec<&Airport> {
        let (min_lat, max_lat) = (min_lat.clamp(-90.0, 90.0), max_lat.clamp(-90.0, 90.0));
        let lon_ranges: Vec<(f64, f64)> =
            if min_lon <= max_lon { vec![(min_lon, max_lon)] } else { vec![(min_lon, 180.0), (-180.0, max_lon)] };
        let mut found: Vec<&Airport> = Vec::new();
        for (lo, hi) in lon_ranges {
            for lat_cell in (min_lat.floor() as i16)..=(max_lat.floor() as i16) {
                for lon_cell in (lo.floor() as i16)..=(hi.floor() as i16) {
                    if let Some(ids) = self.grid.get(&(lat_cell, lon_cell)) {
                        found.extend(ids.iter().map(|&i| &self.airports[i]).filter(|a| {
                            a.latitude >= min_lat && a.latitude <= max_lat && a.longitude >= lo && a.longitude <= hi
                        }));
                    }
                }
            }
        }
        found.sort_by_key(|a| size_rank(&a.kind));
        found.truncate(limit);
        found
    }

    /// Nearest airport within `max_nm`, searching outward ring by ring on the grid.
    pub fn nearest(&self, lat: f64, lon: f64, max_nm: f64) -> Option<NearestAirport> {
        let (clat, clon) = cell(lat, lon);
        // one grid cell is ≥ 60 nm in latitude, so a ring radius of ceil(max_nm/60)+1 covers the box
        let rings = (max_nm / 60.0).ceil() as i16 + 1;
        let mut best: Option<(f64, usize)> = None;
        for r in 0..=rings {
            for dlat in -r..=r {
                for dlon in -r..=r {
                    if dlat.abs() != r && dlon.abs() != r {
                        continue; // only the ring's border cells; inner ones were visited already
                    }
                    let key = (clat + dlat, wrap_lon_cell(clon + dlon));
                    if let Some(ids) = self.grid.get(&key) {
                        for &i in ids {
                            let a = &self.airports[i];
                            let d = haversine_nm(lat, lon, a.latitude, a.longitude);
                            if d <= max_nm && best.is_none_or(|(bd, _)| d < bd) {
                                best = Some((d, i));
                            }
                        }
                    }
                }
            }
            // anything in a farther ring is at least (r) * ~60 nm away in latitude; stop once best is closer
            if let Some((bd, _)) = best
                && bd < (r as f64) * 60.0
            {
                break;
            }
        }
        best.map(|(distance_nm, i)| NearestAirport { airport: self.airports[i].clone(), distance_nm })
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

fn cell(lat: f64, lon: f64) -> (i16, i16) {
    (lat.floor() as i16, lon.floor() as i16)
}

fn wrap_lon_cell(c: i16) -> i16 {
    if c < -180 {
        c + 360
    } else if c >= 180 {
        c - 360
    } else {
        c
    }
}

pub fn haversine_nm(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R_NM: f64 = 3_440.065;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dlat = p2 - p1;
    let dlon = (lon2 - lon1).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R_NM * h.sqrt().asin()
}

fn parse_airports(text: &str) -> Vec<Airport> {
    let mut rdr = csv::Reader::from_reader(text.as_bytes());
    rdr.records()
        .filter_map(|rec| {
            let r = rec.ok()?;
            Some(Airport {
                ident: r.get(0)?.to_string(),
                kind: r.get(1)?.to_string(),
                name: r.get(2)?.to_string(),
                latitude: r.get(3)?.parse().ok()?,
                longitude: r.get(4)?.parse().ok()?,
                elevation_ft: r.get(5).and_then(|v| v.parse().ok()),
                country: r.get(6).unwrap_or("").to_string(),
                municipality: r.get(7).unwrap_or("").to_string(),
                iata: r.get(8).unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn opt<T: std::str::FromStr>(v: Option<&str>) -> Option<T> {
    v.and_then(|s| s.parse().ok())
}

fn parse_runways(text: &str) -> Vec<Runway> {
    let mut rdr = csv::Reader::from_reader(text.as_bytes());
    rdr.records()
        .filter_map(|rec| {
            let r = rec.ok()?;
            Some(Runway {
                airport: r.get(0)?.to_string(),
                length_ft: opt(r.get(1)),
                width_ft: opt(r.get(2)),
                surface: r.get(3).unwrap_or("").to_string(),
                le_ident: r.get(4).unwrap_or("").to_string(),
                le_latitude: opt(r.get(5)),
                le_longitude: opt(r.get(6)),
                le_heading_deg: opt(r.get(7)),
                he_ident: r.get(8).unwrap_or("").to_string(),
                he_latitude: opt(r.get(9)),
                he_longitude: opt(r.get(10)),
                he_heading_deg: opt(r.get(11)),
            })
        })
        .collect()
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
}
