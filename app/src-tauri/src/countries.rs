//! "Länder" view: country list, outlines and the countries the pilot has landed in.
//!
//! A country counts only through an arrival: `arr_icao` of a completed flight (not in the
//! trash; demo/replay flights only with `include_demo`) → `iso_country` of that airport in the
//! index (vectasim-data). The UI reloads on `logbook:changed`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;
use vectasim_data::AirportIndex;
use vectasim_data::countries::{self, Arrival, Country, CountryVisit};
use vectasim_store::{FlightRow, Store};

/// Providers whose flights are session-only (demo / replayed dump), see `Store::delete_demo_flights`.
const DEMO_PROVIDERS: [&str; 2] = ["mock", "replay"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitedAirport {
    pub ident: String,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub iso2: String,
    pub landings: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitedCountries {
    pub countries: Vec<CountryVisit>,
    /// Arrival airports with position (pins on the map; small countries have no 1:110m outline).
    pub airports: Vec<VisitedAirport>,
    /// Size of the country list (249 ISO codes + Kosovo).
    pub total: usize,
}

/// Outlines as raw GeoJSON bytes (no JSON-string escaping over IPC); the UI loads them once.
#[tauri::command]
pub fn countries_geojson() -> tauri::ipc::Response {
    tauri::ipc::Response::new(countries::outlines_geojson().as_bytes().to_vec())
}

#[tauri::command]
pub fn countries_list() -> Vec<Country> {
    countries::countries().to_vec()
}

fn is_demo(f: &FlightRow) -> bool {
    f.provider.as_deref().is_some_and(|p| DEMO_PROVIDERS.contains(&p))
}

/// Arrivals that count: completed, with an arrival airport, demo only on request.
/// (`list_flights` already leaves out the trash.)
fn arrivals(flights: &[FlightRow], include_demo: bool) -> Vec<Arrival<'_>> {
    flights
        .iter()
        .filter(|f| f.state == "completed" && (include_demo || !is_demo(f)))
        .filter_map(|f| {
            let icao = f.arr_icao.as_deref().filter(|s| !s.trim().is_empty())?;
            let ms = f.landing_ms.or(f.on_block_ms).unwrap_or(f.updated_ms);
            Some(Arrival { flight_id: &f.id, arr_icao: icao, ms })
        })
        .collect()
}

pub fn compute(flights: &[FlightRow], include_demo: bool, index: &AirportIndex) -> VisitedCountries {
    let arr = arrivals(flights, include_demo);
    let visits = countries::visited_countries(arr.iter().copied(), index);
    let mut per_airport: HashMap<String, u32> = HashMap::new();
    for a in &arr {
        *per_airport.entry(a.arr_icao.trim().to_ascii_uppercase()).or_default() += 1;
    }
    let mut airports: Vec<VisitedAirport> = visits
        .iter()
        .flat_map(|v| v.airports.iter().map(move |icao| (v.iso2.as_str(), icao)))
        .filter_map(|(iso2, icao)| {
            let a = index.get(icao)?;
            Some(VisitedAirport {
                ident: a.ident.clone(),
                name: a.name.clone(),
                latitude: a.latitude,
                longitude: a.longitude,
                iso2: iso2.to_string(),
                landings: per_airport.get(icao).copied().unwrap_or(0),
            })
        })
        .collect();
    airports.sort_by(|a, b| a.ident.cmp(&b.ident));
    VisitedCountries { countries: visits, airports, total: countries::countries().len() }
}

#[tauri::command]
pub async fn visited_countries(
    include_demo: Option<bool>,
    store: State<'_, Store>,
    airports: State<'_, Arc<AirportIndex>>,
) -> Result<VisitedCountries, String> {
    let store = store.inner().clone();
    let index = airports.inner().clone();
    let include_demo = include_demo.unwrap_or(false);
    crate::blocking(move || {
        let flights = store.list_flights(u32::MAX, 0).map_err(|e| e.to_string())?;
        Ok(compute(&flights, include_demo, &index))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flight(id: &str, state: &str, provider: &str, arr: Option<&str>, landing_ms: u64) -> FlightRow {
        FlightRow {
            id: id.into(),
            state: state.into(),
            provider: Some(provider.into()),
            arr_icao: arr.map(Into::into),
            dep_icao: Some("EDDF".into()),
            landing_ms: Some(landing_ms),
            ..Default::default()
        }
    }

    #[test]
    fn only_completed_arrivals_count_and_demo_on_request() {
        let index = AirportIndex::load();
        let flights = vec![
            flight("a", "completed", "simconnect", Some("EGLL"), 10),
            flight("b", "completed", "simconnect", Some("egll"), 20),
            flight("c", "active", "simconnect", Some("LFPG"), 30),
            flight("d", "completed", "mock", Some("KJFK"), 40),
            flight("e", "completed", "replay", Some("LEMD"), 50),
            flight("f", "completed", "simconnect", None, 60),
        ];
        // departure EDDF never counts: only arrivals
        let v = compute(&flights, false, &index);
        assert_eq!(v.total, 250);
        assert_eq!(v.countries.len(), 1);
        assert_eq!((v.countries[0].iso2.as_str(), v.countries[0].landings), ("GB", 2));
        assert_eq!(v.countries[0].flight_ids, ["b", "a"]);
        assert_eq!(v.airports.len(), 1);
        assert_eq!((v.airports[0].ident.as_str(), v.airports[0].landings), ("EGLL", 2));

        let with_demo = compute(&flights, true, &index);
        let codes: Vec<&str> = with_demo.countries.iter().map(|c| c.iso2.as_str()).collect();
        assert_eq!(codes, ["ES", "GB", "US"]);
    }
}
