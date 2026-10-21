//! Radio navaids (VOR, VOR-DME, VORTAC, TACAN, NDB, NDB-DME, DME) from OurAirports
//! (`navaids.csv`, public domain), embedded zstd-compressed (≈ 200 KiB, ≈ 500 KiB as CSV).
//!
//! Used to place the navaid tokens of a filed online route on the map when neither the running
//! MSFS nor an installed X-Plane knows them. Only ident, name, type, position, frequency and
//! country are kept (`scripts/update-navaids.py`); the file is sorted by ident, so a lookup is a
//! binary search over the parsed list. Parsed once on first use.

use serde::Serialize;
use std::sync::OnceLock;

const NAVAIDS_ZST: &[u8] = include_bytes!("../data/navaids.csv.zst");

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Navaid {
    pub ident: String,
    pub name: String,
    /// OurAirports type: VOR, VOR-DME, VORTAC, TACAN, NDB, NDB-DME, DME.
    pub kind: String,
    pub latitude: f64,
    pub longitude: f64,
    /// kHz as OurAirports gives it (VOR 114 200, NDB 373); None when empty.
    pub frequency_khz: Option<u32>,
    /// ISO 3166-1 alpha-2.
    pub country: String,
}

/// All navaids sorted by ident.
pub fn navaids() -> &'static [Navaid] {
    static LIST: OnceLock<Vec<Navaid>> = OnceLock::new();
    LIST.get_or_init(|| match zstd::decode_all(NAVAIDS_ZST).map(String::from_utf8) {
        Ok(Ok(s)) => parse_navaids(&s),
        e => {
            log::error!("navaids unreadable: {e:?}");
            Vec::new()
        }
    })
}

/// Every navaid with this ident (case-insensitive), e.g. the several "FFM"/"KPT" worldwide.
pub fn by_ident(ident: &str) -> &'static [Navaid] {
    lookup(navaids(), ident)
}

fn lookup<'a>(list: &'a [Navaid], ident: &str) -> &'a [Navaid] {
    let key = ident.trim().to_ascii_uppercase();
    let start = list.partition_point(|n| n.ident.as_str() < key.as_str());
    let end = start + list[start..].partition_point(|n| n.ident == key);
    &list[start..end]
}

pub(crate) fn parse_navaids(text: &str) -> Vec<Navaid> {
    let mut rdr = csv::ReaderBuilder::new().has_headers(true).from_reader(text.as_bytes());
    let mut list: Vec<Navaid> = rdr
        .records()
        .filter_map(|r| r.ok())
        .filter(|r| r.len() >= 7)
        .filter_map(|r| {
            let latitude: f64 = r[3].parse().ok()?;
            let longitude: f64 = r[4].parse().ok()?;
            let ident = r[0].trim().to_ascii_uppercase();
            (!ident.is_empty() && latitude.abs() <= 90.0 && longitude.abs() <= 180.0).then(|| Navaid {
                ident,
                name: r[1].to_string(),
                kind: r[2].to_string(),
                latitude,
                longitude,
                frequency_khz: r[5].parse().ok(),
                country: r[6].to_string(),
            })
        })
        .collect();
    // the script sorts already; a hand-edited file must not break the binary search
    list.sort_by(|a, b| a.ident.cmp(&b.ident));
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_list_is_sorted_and_finds_known_navaids() {
        let all = navaids();
        assert!(all.len() > 5_000, "{}", all.len());
        assert!(all.windows(2).all(|w| w[0].ident <= w[1].ident));
        // Frankfurt VOR-DME
        let ffm = by_ident("ffm");
        assert!(ffm.iter().any(|n| n.country == "DE" && (n.latitude - 50.05).abs() < 0.1 && (n.longitude - 8.64).abs() < 0.1), "{ffm:?}");
        assert!(by_ident("ZZZZZZZZ").is_empty());
    }

    #[test]
    fn parses_and_skips_broken_rows() {
        let csv = "ident,name,type,latitude_deg,longitude_deg,frequency_khz,iso_country\n\
                   KPT,Kempten,NDB,47.7,10.3,373,DE\n\
                   BAD,No position,VOR,,,114200,DE\n\
                   ABC,Alpha,VOR-DME,10.5,-20.25,,XX\n";
        let list = parse_navaids(csv);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].ident, "ABC");
        assert_eq!(list[0].frequency_khz, None);
        assert_eq!(lookup(&list, "kpt")[0].frequency_khz, Some(373));
    }
}
