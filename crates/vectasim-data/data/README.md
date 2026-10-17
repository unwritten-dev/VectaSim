# Embedded reference data

`airports.csv` and `runways.csv` are derived from [OurAirports](https://ourairports.com/data/)
(David Megginson et al.), which is released into the **public domain** – no attribution required,
though we credit it in the app's about screen.

Filtered to `large_airport`, `medium_airport`, `small_airport` and `seaplane_base` (no heliports,
closed or balloon ports), closed runways dropped, unused columns stripped. The `ident` column is the
ICAO code where OurAirports has one, else the GPS code, else OurAirports' own identifier.

Refresh with `scripts/update-airports.py` (downloads the nightly CSVs and rewrites these two files).
Last refresh: 2026-10-17.
