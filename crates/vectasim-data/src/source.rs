//! Data model, CSV parsing and the precomputed index layout. Shared verbatim with `build.rs`
//! (`#[path]` include), so the build-time encoder and the runtime decoder can never disagree on
//! what an index looks like. Keep this module free of crate-internal dependencies.

use serde::{Deserialize, Serialize};

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
    /// Displaced threshold of each end, ft along the runway from that end's coordinates
    /// (OurAirports `le/he_displaced_threshold_ft`); None = none known.
    #[serde(default)]
    pub le_displaced_threshold_ft: Option<i32>,
    #[serde(default)]
    pub he_displaced_threshold_ft: Option<i32>,
}

/// Grid covers lat cells -90..=90 and lon cells -180..=180 (a coordinate of exactly 90° / 180°
/// floors onto the last row / column).
pub const GRID_LAT_CELLS: usize = 181;
pub const GRID_LON_CELLS: usize = 361;
pub const GRID_CELLS: usize = GRID_LAT_CELLS * GRID_LON_CELLS;

/// 1°×1° cell of a coordinate.
pub fn cell(lat: f64, lon: f64) -> (i16, i16) {
    (lat.floor() as i16, lon.floor() as i16)
}

/// Dense slot of a cell, None outside the grid.
pub fn cell_slot(lat_cell: i16, lon_cell: i16) -> Option<usize> {
    let r = usize::try_from(i32::from(lat_cell) + 90).ok()?;
    let c = usize::try_from(i32::from(lon_cell) + 180).ok()?;
    (r < GRID_LAT_CELLS && c < GRID_LON_CELLS).then_some(r * GRID_LON_CELLS + c)
}

/// Everything the index holds, in the exact shape both the CSV path and the binary blob produce.
#[derive(Debug, PartialEq)]
pub struct IndexParts {
    /// Source order (CSV order).
    pub airports: Vec<Airport>,
    /// Indices into `airports`, sorted by ident (binary search for `get`).
    pub ident_order: Vec<u32>,
    /// Grouped by airport ident (sorted); source order within a group.
    pub runways: Vec<Runway>,
    /// (start, len) into `runways`, one per airport ident, sorted by ident.
    pub runway_groups: Vec<(u32, u32)>,
    /// Prefix offsets into `grid_items`, `GRID_CELLS + 1` entries.
    pub grid_offsets: Vec<u32>,
    /// Airport indices per cell, ascending within a cell.
    pub grid_items: Vec<u32>,
}

impl IndexParts {
    pub fn build(airports: Vec<Airport>, mut runways: Vec<Runway>) -> Self {
        let mut ident_order: Vec<u32> = (0..airports.len() as u32).collect();
        ident_order.sort_by(|&a, &b| airports[a as usize].ident.cmp(&airports[b as usize].ident));
        // duplicate idents: keep the last one (what a HashMap insert loop did before)
        ident_order.dedup_by(|later, earlier| {
            let same = airports[*later as usize].ident == airports[*earlier as usize].ident;
            if same {
                *earlier = (*earlier).max(*later);
            }
            same
        });

        runways.sort_by(|a, b| a.airport.cmp(&b.airport)); // stable: keeps source order per airport
        let mut runway_groups: Vec<(u32, u32)> = Vec::new();
        for (i, r) in runways.iter().enumerate() {
            match runway_groups.last_mut() {
                Some((start, len)) if runways[*start as usize].airport == r.airport => *len += 1,
                _ => runway_groups.push((i as u32, 1)),
            }
        }

        let mut counts = vec![0u32; GRID_CELLS];
        let slots: Vec<Option<usize>> = airports
            .iter()
            .map(|a| {
                let (r, c) = cell(a.latitude, a.longitude);
                cell_slot(r, c)
            })
            .collect();
        for s in slots.iter().flatten() {
            counts[*s] += 1;
        }
        let mut grid_offsets = Vec::with_capacity(GRID_CELLS + 1);
        let mut acc = 0u32;
        grid_offsets.push(0);
        for c in &counts {
            acc += c;
            grid_offsets.push(acc);
        }
        let mut fill: Vec<u32> = grid_offsets[..GRID_CELLS].to_vec();
        let mut grid_items = vec![0u32; acc as usize];
        for (i, s) in slots.iter().enumerate() {
            if let Some(s) = *s {
                grid_items[fill[s] as usize] = i as u32;
                fill[s] += 1;
            }
        }
        Self { airports, ident_order, runways, runway_groups, grid_offsets, grid_items }
    }
}

pub fn parse_airports(text: &str) -> Vec<Airport> {
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

pub fn parse_runways(text: &str) -> Vec<Runway> {
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
                le_displaced_threshold_ft: opt(r.get(12)),
                he_displaced_threshold_ft: opt(r.get(13)),
            })
        })
        .collect()
}
