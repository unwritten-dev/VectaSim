//! Precompiled airport index ("VSAD"), written by `build.rs` from the CSVs and embedded with
//! `include_bytes!`. Little-endian, fixed-size records (random access without an offset table),
//! no alignment requirements. Records are decoded lazily: loading only validates the header and
//! the index arrays, so startup cost does not grow with the number of strings.
//!
//! Layout:
//! ```text
//! header   "VSAD" | version u8 | 3 × reserved u8
//!          n_airports u32 | n_runways u32 | n_groups u32 | n_grid_items u32 | strings_len u32
//! strings  UTF-8 bytes, deduplicated; a string ref is (offset u32, len u16)
//! airports AIR_REC bytes each: ident, kind, name: ref | lat f64 | lon f64 | elev i32
//!          | country, municipality, iata: ref | flags u8 (bit 0: elevation known)
//! runways  RWY_REC bytes each: airport: ref | length i32 | width i32 | surface, le_ident: ref
//!          | le lat/lon/hdg f64 | he_ident: ref | he lat/lon/hdg f64 | le_disp i32 | he_disp i32
//!          | presence u16 (bits 0-1 length/width, 2-7 le/he lat/lon/hdg, 8-9 le/he displaced)
//! groups   (start u32, len u32) per airport with runways, sorted by ident
//! order    u32 × n_airports          (airport indices sorted by ident)
//! grid     u32 × (GRID_CELLS + 1)    (prefix offsets, dense 181×361 1° cells) | u32 × n_grid_items
//! ```

use super::source::{Airport, GRID_CELLS, IndexParts, Runway};

pub const MAGIC: &[u8; 4] = b"VSAD";
/// Bump on any layout change.
pub const VERSION: u8 = 1;
const HEADER: usize = 8 + 5 * 4;
const STR_REF: usize = 6;
const AIR_REC: usize = 3 * STR_REF + 8 + 8 + 4 + 3 * STR_REF + 1;
const RWY_REC: usize = STR_REF + 4 + 4 + 2 * STR_REF + 3 * 8 + STR_REF + 3 * 8 + 4 + 4 + 2;
// field offsets inside an airport record
const A_LAT: usize = 3 * STR_REF;
const A_LON: usize = A_LAT + 8;
const A_ELEV: usize = A_LON + 8;
const A_COUNTRY: usize = A_ELEV + 4;
// field offsets inside a runway record
const R_LENGTH: usize = STR_REF;
const R_SURFACE: usize = R_LENGTH + 8;
const R_LE_IDENT: usize = R_SURFACE + STR_REF;
const R_LE_POS: usize = R_LE_IDENT + STR_REF;
const R_HE_IDENT: usize = R_LE_POS + 24;
const R_HE_POS: usize = R_HE_IDENT + STR_REF;
const R_DISP: usize = R_HE_POS + 24;

// ---------------------------------------------------------------- encode (build.rs, CSV fallback)

pub fn encode(p: &IndexParts) -> Vec<u8> {
    let mut strings = StringTable::default();
    let mut body: Vec<u8> = Vec::with_capacity(p.airports.len() * AIR_REC + p.runways.len() * RWY_REC + 4 * (GRID_CELLS + 1));

    for a in &p.airports {
        strings.put(&mut body, &a.ident);
        strings.put(&mut body, &a.kind);
        strings.put(&mut body, &a.name);
        body.extend_from_slice(&a.latitude.to_le_bytes());
        body.extend_from_slice(&a.longitude.to_le_bytes());
        body.extend_from_slice(&a.elevation_ft.unwrap_or(0).to_le_bytes());
        strings.put(&mut body, &a.country);
        strings.put(&mut body, &a.municipality);
        strings.put(&mut body, &a.iata);
        body.push(u8::from(a.elevation_ft.is_some()));
    }
    for r in &p.runways {
        let floats = [r.le_latitude, r.le_longitude, r.le_heading_deg, r.he_latitude, r.he_longitude, r.he_heading_deg];
        let bits = [r.length_ft.is_some(), r.width_ft.is_some()]
            .into_iter()
            .chain(floats.map(|v| v.is_some()))
            .chain([r.le_displaced_threshold_ft.is_some(), r.he_displaced_threshold_ft.is_some()]);
        let presence = bits.enumerate().fold(0u16, |acc, (i, set)| acc | (u16::from(set) << i));
        let i32_bytes = |v: Option<i32>| v.unwrap_or(0).to_le_bytes();
        let f64_bytes = |v: &Option<f64>| v.unwrap_or(0.0).to_le_bytes();
        strings.put(&mut body, &r.airport);
        body.extend_from_slice(&i32_bytes(r.length_ft));
        body.extend_from_slice(&i32_bytes(r.width_ft));
        strings.put(&mut body, &r.surface);
        strings.put(&mut body, &r.le_ident);
        floats[..3].iter().for_each(|v| body.extend_from_slice(&f64_bytes(v)));
        strings.put(&mut body, &r.he_ident);
        floats[3..].iter().for_each(|v| body.extend_from_slice(&f64_bytes(v)));
        body.extend_from_slice(&i32_bytes(r.le_displaced_threshold_ft));
        body.extend_from_slice(&i32_bytes(r.he_displaced_threshold_ft));
        body.extend_from_slice(&presence.to_le_bytes());
    }
    for (s, l) in &p.runway_groups {
        body.extend_from_slice(&s.to_le_bytes());
        body.extend_from_slice(&l.to_le_bytes());
    }
    for v in p.ident_order.iter().chain(&p.grid_offsets).chain(&p.grid_items) {
        body.extend_from_slice(&v.to_le_bytes());
    }

    let mut out = Vec::with_capacity(HEADER + strings.bytes.len() + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&[VERSION, 0, 0, 0]);
    for n in [p.airports.len(), p.runways.len(), p.runway_groups.len(), p.grid_items.len(), strings.bytes.len()] {
        out.extend_from_slice(&u32::try_from(n).expect("index too large").to_le_bytes());
    }
    out.extend_from_slice(&strings.bytes);
    out.extend_from_slice(&body);
    out
}

#[derive(Default)]
struct StringTable {
    bytes: Vec<u8>,
    seen: std::collections::HashMap<String, u32>,
}

impl StringTable {
    fn put(&mut self, body: &mut Vec<u8>, s: &str) {
        let len = u16::try_from(s.len()).expect("string longer than 64 KiB");
        let off = match self.seen.get(s) {
            Some(&o) => o,
            None => {
                let o = u32::try_from(self.bytes.len()).expect("string table too large");
                self.bytes.extend_from_slice(s.as_bytes());
                self.seen.insert(s.to_owned(), o);
                o
            }
        };
        body.extend_from_slice(&off.to_le_bytes());
        body.extend_from_slice(&len.to_le_bytes());
    }
}

// ---------------------------------------------------------------- view (runtime)

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn f64_at(b: &[u8], at: usize) -> f64 {
    b.get(at..at + 8).and_then(|s| s.try_into().ok()).map_or(0.0, f64::from_le_bytes)
}

fn i32_at(b: &[u8], at: usize) -> i32 {
    b.get(at..at + 4).and_then(|s| s.try_into().ok()).map_or(0, i32::from_le_bytes)
}

/// Section offsets of a validated blob. Accessors take the blob again (it may be `'static` or
/// owned by the index) and are total: they never panic, whatever the bytes.
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub n_airports: usize,
    pub n_groups: usize,
    strings: usize,
    strings_end: usize,
    airports: usize,
    runways: usize,
    groups: usize,
    order: usize,
    grid: usize,
    items: usize,
}

impl Layout {
    /// Validate magic, version, exact size and every index array (grid, ident order, runway
    /// groups) so queries stay in bounds. String refs inside records are not pre-checked (that
    /// would cost as much as decoding them); a bad ref decodes as "".
    pub fn parse(b: &[u8]) -> Option<Self> {
        if b.get(..4)? != MAGIC || *b.get(4)? != VERSION {
            return None;
        }
        let n = |i: usize| u32_at(b, 8 + 4 * i).map(|v| v as usize);
        let (n_airports, n_runways, n_groups, n_items, strings_len) = (n(0)?, n(1)?, n(2)?, n(3)?, n(4)?);
        let strings = HEADER;
        let airports = strings.checked_add(strings_len)?;
        let runways = airports.checked_add(n_airports.checked_mul(AIR_REC)?)?;
        let groups = runways.checked_add(n_runways.checked_mul(RWY_REC)?)?;
        let order = groups.checked_add(n_groups.checked_mul(8)?)?;
        let grid = order.checked_add(n_airports.checked_mul(4)?)?;
        let items = grid.checked_add((GRID_CELLS + 1) * 4)?;
        let end = items.checked_add(n_items.checked_mul(4)?)?;
        if end != b.len() {
            return None;
        }
        let l = Self { n_airports, n_groups, strings, strings_end: airports, airports, runways, groups, order, grid, items };

        let words = |from: usize, count: usize| b[from..from + 4 * count].as_chunks::<4>().0.iter().map(|c| u32::from_le_bytes(*c));
        let in_air = |i: u32| (i as usize) < n_airports;
        let groups_ok = (0..n_groups).all(|g| {
            let (s, len) = l.group(b, g);
            len > 0 && s + len <= n_runways
        });
        let mut prev = 0u32;
        let offsets_ok = words(grid, GRID_CELLS + 1).enumerate().all(|(i, v)| {
            let ok = (i > 0 || v == 0) && v >= prev;
            prev = v;
            ok
        }) && prev as usize == n_items;
        if !(groups_ok && offsets_ok && words(order, n_airports).all(in_air) && words(items, n_items).all(in_air)) {
            return None;
        }
        Some(l)
    }

    fn str_at<'b>(&self, b: &'b [u8], at: usize) -> &'b str {
        let (Some(off), Some(len)) = (u32_at(b, at), b.get(at + 4..at + 6)) else { return "" };
        let from = self.strings + off as usize;
        let to = from + u16::from_le_bytes([len[0], len[1]]) as usize;
        // validates just this slice, which also rejects a range cut through a character
        (to <= self.strings_end).then(|| b.get(from..to)).flatten().and_then(|s| std::str::from_utf8(s).ok()).unwrap_or("")
    }

    fn air(&self, i: usize) -> usize {
        self.airports + i * AIR_REC
    }

    pub fn airport_ident<'b>(&self, b: &'b [u8], i: usize) -> &'b str {
        self.str_at(b, self.air(i))
    }

    pub fn airport_kind<'b>(&self, b: &'b [u8], i: usize) -> &'b str {
        self.str_at(b, self.air(i) + STR_REF)
    }

    /// (lat, lon) without decoding the record's strings.
    pub fn airport_pos(&self, b: &[u8], i: usize) -> (f64, f64) {
        (f64_at(b, self.air(i) + A_LAT), f64_at(b, self.air(i) + A_LON))
    }

    pub fn airport(&self, b: &[u8], i: usize) -> Airport {
        let at = self.air(i);
        let s = |off: usize| self.str_at(b, at + off).to_owned();
        let flags = b.get(at + AIR_REC - 1).copied().unwrap_or(0);
        Airport {
            ident: s(0),
            kind: s(STR_REF),
            name: s(2 * STR_REF),
            latitude: f64_at(b, at + A_LAT),
            longitude: f64_at(b, at + A_LON),
            elevation_ft: (flags & 1 != 0).then(|| i32_at(b, at + A_ELEV)),
            country: s(A_COUNTRY),
            municipality: s(A_COUNTRY + STR_REF),
            iata: s(A_COUNTRY + 2 * STR_REF),
        }
    }

    pub fn runway(&self, b: &[u8], j: usize) -> Runway {
        let at = self.runways + j * RWY_REC;
        let p = b.get(at + RWY_REC - 2..at + RWY_REC).map_or(0, |s| u16::from_le_bytes([s[0], s[1]]));
        let has = |bit: u16| p & (1 << bit) != 0;
        let s = |off: usize| self.str_at(b, at + off).to_owned();
        let f = |off: usize, bit: u16| has(bit).then(|| f64_at(b, at + off));
        let i = |off: usize, bit: u16| has(bit).then(|| i32_at(b, at + off));
        Runway {
            airport: s(0),
            length_ft: i(R_LENGTH, 0),
            width_ft: i(R_LENGTH + 4, 1),
            surface: s(R_SURFACE),
            le_ident: s(R_LE_IDENT),
            le_latitude: f(R_LE_POS, 2),
            le_longitude: f(R_LE_POS + 8, 3),
            le_heading_deg: f(R_LE_POS + 16, 4),
            he_ident: s(R_HE_IDENT),
            he_latitude: f(R_HE_POS, 5),
            he_longitude: f(R_HE_POS + 8, 6),
            he_heading_deg: f(R_HE_POS + 16, 7),
            le_displaced_threshold_ft: i(R_DISP, 8),
            he_displaced_threshold_ft: i(R_DISP + 4, 9),
        }
    }

    /// (start, len) of runway group `g` (an airport's runways, contiguous).
    pub fn group(&self, b: &[u8], g: usize) -> (usize, usize) {
        let at = self.groups + 8 * g;
        (u32_at(b, at).unwrap_or(0) as usize, u32_at(b, at + 4).unwrap_or(0) as usize)
    }

    /// Ident of the airport a runway group belongs to (its first runway's `airport`).
    pub fn group_ident<'b>(&self, b: &'b [u8], g: usize) -> &'b str {
        self.str_at(b, self.runways + self.group(b, g).0 * RWY_REC)
    }

    /// The `i`-th airport index in ident order.
    pub fn ordered(&self, b: &[u8], i: usize) -> usize {
        u32_at(b, self.order + 4 * i).unwrap_or(0) as usize
    }

    /// Airport indices in a dense grid slot (ascending).
    pub fn cell<'b>(&self, b: &'b [u8], slot: usize) -> impl Iterator<Item = usize> + 'b {
        let from = u32_at(b, self.grid + 4 * slot).unwrap_or(0) as usize;
        let to = u32_at(b, self.grid + 4 * (slot + 1)).unwrap_or(0) as usize;
        let items = self.items;
        (from..to).map(move |k| u32_at(b, items + 4 * k).unwrap_or(0) as usize)
    }
}
