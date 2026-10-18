# Embedded reference data

`airports.csv` and `runways.csv` are derived from [OurAirports](https://ourairports.com/data/)
(David Megginson et al.), which is released into the **public domain** – no attribution required,
though we credit it in the app's about screen.

Filtered to `large_airport`, `medium_airport`, `small_airport` and `seaplane_base` (no heliports,
closed or balloon ports), closed runways dropped, unused columns stripped. The `ident` column is the
ICAO code where OurAirports has one, else the GPS code, else OurAirports' own identifier.

Refresh with `scripts/update-airports.py` (downloads the nightly CSVs and rewrites these two files).
Last refresh: 2026-10-17.

## Countries

`countries.csv` lists the 249 ISO 3166-1 alpha-2 codes plus Kosovo (`XK`, as used by OurAirports)
with continent (OurAirports `countries.csv`, public domain; AX/BV/SJ by hand) and the German and
English short name (Unicode CLDR, Unicode License v3). `countries.geojson.zst` holds the country
outlines of [Natural Earth](https://www.naturalearthdata.com/) 1:110m Admin-0 Countries (**public
domain**), every property dropped except `iso2`, coordinates rounded to 0.01°, zstd-compressed.

Refresh with `python -I scripts/update-countries.py` (Python 3.14+, stdlib only).
Last refresh: 2026-10-18.
