//! Countries for the "Länder" view: the ISO 3166-1 list (249 codes plus Kosovo `XK`) with
//! continent and German/English name, Natural Earth 1:110m outlines (public domain) and the
//! aggregation "which countries has the pilot landed in".
//!
//! A country counts as visited only through an arrival: the `iso_country` of the arrival
//! airport (OurAirports, via the airport index). Both data files are refreshed by
//! `scripts/update-countries.py`; the outlines carry one property, `iso2`, and are embedded
//! zstd-compressed (≈ 40 KiB, ≈ 165 KiB as GeoJSON text).

use crate::AirportIndex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

const COUNTRIES_CSV: &str = include_str!("../data/countries.csv");
const OUTLINES_ZST: &[u8] = include_bytes!("../data/countries.geojson.zst");

/// Continent codes as in OurAirports: AF, AN, AS, EU, NA, OC, SA.
pub const CONTINENTS: [&str; 7] = ["AF", "AN", "AS", "EU", "NA", "OC", "SA"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Country {
    pub iso2: String,
    pub continent: String,
    pub name_de: String,
    pub name_en: String,
}

/// All countries, sorted by ISO code (parsed once from the embedded CSV).
pub fn countries() -> &'static [Country] {
    static LIST: OnceLock<Vec<Country>> = OnceLock::new();
    LIST.get_or_init(|| parse_countries(COUNTRIES_CSV))
}

pub fn country(iso2: &str) -> Option<&'static Country> {
    let list = countries();
    list.binary_search_by(|c| c.iso2.as_str().cmp(iso2)).ok().map(|i| &list[i])
}

fn parse_countries(csv_text: &str) -> Vec<Country> {
    let mut rdr = csv::ReaderBuilder::new().has_headers(true).from_reader(csv_text.as_bytes());
    let mut list: Vec<Country> = rdr
        .records()
        .filter_map(|r| r.ok())
        .filter(|r| r.len() >= 4 && r[0].len() == 2)
        .map(|r| Country { iso2: r[0].to_string(), continent: r[1].to_string(), name_de: r[2].to_string(), name_en: r[3].to_string() })
        .collect();
    list.sort_by(|a, b| a.iso2.cmp(&b.iso2));
    list.dedup_by(|a, b| a.iso2 == b.iso2);
    list
}

/// Country outlines as GeoJSON text (FeatureCollection, property `iso2`), decompressed once.
/// Empty FeatureCollection if the embedded blob cannot be read (a build error, logged).
pub fn outlines_geojson() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| match zstd::decode_all(OUTLINES_ZST).map(String::from_utf8) {
        Ok(Ok(s)) => s,
        e => {
            log::error!("country outlines unreadable: {e:?}");
            r#"{"type":"FeatureCollection","features":[]}"#.to_string()
        }
    })
}

/// One arrival of a completed flight (input to [`visited_countries`]).
#[derive(Clone, Copy, Debug)]
pub struct Arrival<'a> {
    pub flight_id: &'a str,
    pub arr_icao: &'a str,
    /// Time of the arrival (landing, else on-block), ms since the epoch.
    pub ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountryVisit {
    pub iso2: String,
    /// Flights that arrived in this country.
    pub landings: u32,
    pub first_ms: u64,
    pub last_ms: u64,
    /// Arrival airports in this country, sorted.
    pub airports: Vec<String>,
    /// Flights that arrived here, newest first.
    pub flight_ids: Vec<String>,
}

/// Countries landed in, sorted by ISO code. Arrivals at airports the index does not know, or
/// whose country is not in the list (OurAirports `ZZ`, disputed `XP`), are skipped.
pub fn visited_countries<'a>(arrivals: impl IntoIterator<Item = Arrival<'a>>, index: &AirportIndex) -> Vec<CountryVisit> {
    aggregate(arrivals, |icao| index.get(icao).map(|a| a.country.clone()))
}

/// [`visited_countries`] with the airport → country lookup injected (testable without the index).
pub fn aggregate<'a>(arrivals: impl IntoIterator<Item = Arrival<'a>>, country_of: impl Fn(&str) -> Option<String>) -> Vec<CountryVisit> {
    struct Acc {
        first: u64,
        last: u64,
        airports: BTreeSet<String>,
        flights: Vec<(u64, String)>,
    }
    let mut by: BTreeMap<String, Acc> = BTreeMap::new();
    for a in arrivals {
        let icao = a.arr_icao.trim().to_ascii_uppercase();
        if icao.is_empty() {
            continue;
        }
        let Some(iso) = country_of(&icao).filter(|c| country(c).is_some()) else { continue };
        let acc = by.entry(iso).or_insert_with(|| Acc { first: u64::MAX, last: 0, airports: BTreeSet::new(), flights: Vec::new() });
        acc.first = acc.first.min(a.ms);
        acc.last = acc.last.max(a.ms);
        acc.airports.insert(icao);
        acc.flights.push((a.ms, a.flight_id.to_string()));
    }
    by.into_iter()
        .map(|(iso2, mut acc)| {
            acc.flights.sort_by(|x, y| y.0.cmp(&x.0).then_with(|| x.1.cmp(&y.1)));
            acc.flights.dedup_by(|x, y| x.1 == y.1);
            CountryVisit {
                iso2,
                landings: acc.flights.len() as u32,
                first_ms: acc.first,
                last_ms: acc.last,
                airports: acc.airports.into_iter().collect(),
                flight_ids: acc.flights.into_iter().map(|(_, id)| id).collect(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_has_the_iso_codes_plus_kosovo() {
        let list = countries();
        assert_eq!(list.len(), 250);
        assert!(list.windows(2).all(|w| w[0].iso2 < w[1].iso2));
        assert!(list.iter().all(|c| CONTINENTS.contains(&c.continent.as_str()) && !c.name_de.is_empty() && !c.name_en.is_empty()));
        let de = country("DE").unwrap();
        assert_eq!((de.name_de.as_str(), de.name_en.as_str(), de.continent.as_str()), ("Deutschland", "Germany", "EU"));
        assert_eq!(country("XK").map(|c| c.continent.as_str()), Some("EU"));
        assert_eq!(country("US").map(|c| c.continent.as_str()), Some("NA"));
        assert!(country("ZZ").is_none() && country("EU").is_none());
    }

    #[test]
    fn outlines_decode_and_use_listed_codes() {
        let text = outlines_geojson();
        assert!(text.starts_with(r#"{"type":"FeatureCollection""#), "{}", &text[..text.len().min(60)]);
        // every iso2 property names a listed country; the special cases are present
        let codes: Vec<&str> = text.match_indices(r#""iso2":""#).map(|(i, _)| &text[i + 8..i + 10]).collect();
        assert!(codes.len() > 170, "{}", codes.len());
        assert!(codes.iter().all(|c| country(c).is_some()), "{codes:?}");
        for c in ["FR", "NO", "XK", "TW", "GF", "SJ", "DE", "US"] {
            assert!(codes.contains(&c), "{c} missing");
        }
    }

    #[test]
    fn aggregates_arrivals_per_country() {
        let country_of = |icao: &str| match icao {
            "EDDF" | "EDDM" => Some("DE".to_string()),
            "EGLL" => Some("GB".to_string()),
            "XXXX" => Some("ZZ".to_string()),
            _ => None,
        };
        let arr = |id, icao, ms| Arrival { flight_id: id, arr_icao: icao, ms };
        let visits = aggregate(
            [
                arr("a", "EDDF", 100),
                arr("b", "egll", 200),
                arr("c", "EDDM", 300),
                arr("d", "", 400),
                arr("e", "XXXX", 500),
                arr("f", "KJFK", 600),
                arr("c", "EDDM", 300),
            ],
            country_of,
        );
        assert_eq!(visits.len(), 2);
        let de = &visits[0];
        assert_eq!(de.iso2, "DE");
        assert_eq!((de.landings, de.first_ms, de.last_ms), (2, 100, 300));
        assert_eq!(de.airports, ["EDDF", "EDDM"]);
        assert_eq!(de.flight_ids, ["c", "a"]);
        assert_eq!(visits[1].iso2, "GB");
        assert_eq!(visits[1].airports, ["EGLL"]);
    }

    #[test]
    fn visited_countries_uses_the_airport_index() {
        let idx = AirportIndex::load();
        let v = visited_countries(
            [Arrival { flight_id: "x", arr_icao: "EGLL", ms: 1 }, Arrival { flight_id: "y", arr_icao: "KJFK", ms: 2 }],
            &idx,
        );
        let codes: Vec<&str> = v.iter().map(|c| c.iso2.as_str()).collect();
        assert_eq!(codes, ["GB", "US"]);
    }
}
