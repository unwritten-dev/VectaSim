# Third-Party Notices

VectaSim selbst steht unter der [MIT-Lizenz](LICENSE). Dieses Dokument listet die Bibliotheken, Schriften, Daten und Dienste Dritter, die die App zur Laufzeit verwendet, mit ihren Lizenzen. Die Lizenztexte der Pakete liegen jeweils im Paket selbst (npm: `node_modules/<paket>/LICENSE`, Rust: crates.io-Quelle).

Erzeugt aus `npx license-checker-rseidelsohn --production` (in `app/`) und `cargo tree --workspace -e normal --target x86_64-pc-windows-msvc` (Stand: Version 0.3.0). Bei einer Lizenzangabe mit „OR“ wählt VectaSim die MIT-Variante, sofern vorhanden.

## Daten und Dienste

| Quelle | Nutzung in VectaSim | Lizenz / Bedingungen |
|---|---|---|
| © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende | Kartendaten der Basemap | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); Attribution bleibt auf der Karte sichtbar |
| [OpenMapTiles](https://openmaptiles.org) | Vektortile-Schema der Basemap | Schema [CC-BY 4.0](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md); © OpenMapTiles |
| [OpenFreeMap](https://openfreemap.org) | Tile-Hosting und Kartenstil (`dark`), in der App je Theme umgefärbt | Dienst kostenlos ohne Schlüssel; Stil aus [openfreemap-styles](https://github.com/hyperknot/openfreemap-styles), abgeleitet von den OpenMapTiles-Styles (Code BSD-3-Clause, Design CC-BY 4.0); Daten ODbL |
| [OurAirports](https://ourairports.com/data/) | Flughäfen und Runways, eingebettet in `crates/vectasim-data/data`; Kontinent je Land (`countries.csv`) | Public Domain |
| [Natural Earth](https://www.naturalearthdata.com/) | Ländergrenzen 1:110m (Admin-0 Countries) für die Ansicht *Länder*, vereinfacht eingebettet in `crates/vectasim-data/data/countries.geojson.zst` (`scripts/update-countries.py`) | Public Domain ([Nutzungsbedingungen](https://www.naturalearthdata.com/about/terms-of-use/)); Quelle wird auf der Karte genannt |
| [Unicode CLDR](https://cldr.unicode.org/) | Deutsche und englische Ländernamen in `crates/vectasim-data/data/countries.csv` | [Unicode License v3](https://www.unicode.org/license.txt) – © 1991–2026 Unicode, Inc. |
| NOAA / [aviationweather.gov](https://aviationweather.gov) | METAR-Wetter | US-Regierungswerk, Public Domain |
| [VATSIM](https://vatsim.net) data feed v3 | Online-Verkehr und ATC (nur wenn „Verkehr“ eingeschaltet) | VATSIM-Datennutzungsbedingungen; Abruf höchstens alle 15 s |
| [SimBrief](https://www.simbrief.com) (Navigraph) | OFP-Abruf auf Knopfdruck | Navigraph/SimBrief-Nutzungsbedingungen |
| [Planespotters.net](https://www.planespotters.net) | Flugzeugfotos zur Registrierung | Foto © jeweiliger Fotograf; Credit und Link zur Fotoseite werden bei jedem Foto angezeigt |
| Microsoft Flight Simulator SDK | `SimConnect.dll`, zur Laufzeit geladen, **nicht** mitgeliefert; auf Klick des Nutzers aus dem offiziellen SDK-Download (`sdk.flightsimulator.com`, MSFS 2020 SDK Core 0.24.6.0) nach `%LOCALAPPDATA%\io.vectasim.app\simconnect\` geladen | [MSFS SDK EULA](https://docs.flightsimulator.com/html/Introduction/SDK_EULA.htm), siehe unten |

### Microsoft Flight Simulator SDK – SimConnect.dll

Die `SimConnect.dll` ist Eigentum der Microsoft Corporation und wird **nicht** mit VectaSim verteilt (weder im Repository noch im Installer). Die Schaltfläche *SimConnect herunterladen* lädt das offizielle SDK-Archiv von Microsofts Server, prüft es per SHA-256 und behält davon nur die DLL. Für diese Datei gelten allein die „Microsoft Software License Terms“ des Microsoft Flight Simulator SDK (Microsoft Corporation): https://docs.flightsimulator.com/html/Introduction/SDK_EULA.htm (MSFS 2024: https://docs.flightsimulator.com/msfs2024/html/1_Introduction/SDK_EULA.htm). Die MIT-Lizenz von VectaSim gilt für sie nicht.

## Schriften

Alle Schriften sind über [Fontsource](https://fontsource.org) gebündelt und stehen unter der **SIL Open Font License 1.1** (https://openfontlicense.org).

| Schrift | Urheber |
|---|---|
| Inter, Inter Tight | © The Inter Project Authors |
| Geist, Geist Mono | © Vercel |
| IBM Plex Sans Condensed, IBM Plex Mono | © IBM Corp. |
| Atkinson Hyperlegible Next, Atkinson Hyperlegible Mono | © Braille Institute of America |
| B612, B612 Mono | © Airbus / Intactile Design / ENAC |

Die Wortmarke im Logo verwendet Inter (© The Inter Project Authors, SIL OFL 1.1) als Konturen.

## npm-Pakete (Frontend, Produktion)

| Paket | Version | Lizenz |
|---|---|---|
| `@fontsource-variable/atkinson-hyperlegible-mono` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/atkinson-hyperlegible-next` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/geist-mono` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/geist` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/inter-tight` | 5.3.0 | OFL-1.1 |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 |
| `@fontsource/b612-mono` | 5.3.0 | OFL-1.1 |
| `@fontsource/b612` | 5.3.0 | OFL-1.1 |
| `@fontsource/ibm-plex-mono` | 5.3.0 | OFL-1.1 |
| `@fontsource/ibm-plex-sans-condensed` | 5.3.0 | OFL-1.1 |
| `@mapbox/jsonlint-lines-primitives` | 2.0.3 | MIT |
| `@mapbox/point-geometry` | 1.1.0 | ISC |
| `@mapbox/tiny-sdf` | 2.3.0 | BSD-2-Clause |
| `@mapbox/unitbezier` | 1.0.0 | BSD-2-Clause |
| `@mapbox/vector-tile` | 3.0.0 | BSD-3-Clause |
| `@maplibre/geojson-vt` | 6.3.0 | ISC |
| `@maplibre/maplibre-gl-style-spec` | 26.4.4 | ISC |
| `@maplibre/mlt` | 1.3.0 | (MIT OR Apache-2.0) |
| `@maplibre/vt-pbf` | 4.3.2 | MIT |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | 2.8.3 | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-opener` | 2.7.2 | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-process` | 2.4.0 | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-updater` | 2.14.0 | MIT OR Apache-2.0 |
| `@types/geojson` | 7946.0.16 | MIT |
| `bidi-js` | 1.1.0 | MIT |
| `earcut` | 3.2.4 | ISC |
| `gl-matrix` | 3.4.4 | MIT |
| `json-stringify-pretty-compact` | 4.0.0 | MIT |
| `kdbush` | 4.1.0 | ISC |
| `maplibre-gl` | 6.12.0 | BSD-3-Clause |
| `minimist` | 1.2.8 | MIT |
| `murmurhash-js` | 1.0.0 | MIT |
| `pbf` | 5.1.2 | BSD-3-Clause |
| `potpack` | 2.1.0 | ISC |
| `protocol-buffers-schema` | 3.6.1 | MIT |
| `quickselect` | 3.0.0 | ISC |
| `react-dom` | 19.3.1 | MIT |
| `react` | 19.3.1 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `resolve-protobuf-schema` | 2.1.0 | MIT |
| `scheduler` | 0.28.0 | MIT |
| `tinyqueue` | 3.0.0 | ISC |

Zusammenfassung: 20× MIT, 13× ISC, 10× OFL-1.1, 5× BSD-3-Clause, 4× MIT OR Apache-2.0, 2× BSD-2-Clause, 1× Apache-2.0 OR MIT, 1× BlueOak-1.0.0.

## Rust-Crates (Backend, Windows-Build)

Die mitgelieferte SQLite-Bibliothek (3.53.2, über `libsqlite3-sys`, Feature `bundled`) ist Public Domain.

| Crate | Version | Lizenz |
|---|---|---|
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| `aho-corasick` | 1.1.5 | Unlicense OR MIT |
| `alloc-no-stdlib` | 3.0.0 | BSD-3-Clause |
| `alloc-stdlib` | 0.3.0 | BSD-3-Clause |
| `anstream` | 1.0.0 | MIT OR Apache-2.0 |
| `anstyle` | 1.0.14 | MIT OR Apache-2.0 |
| `anstyle-parse` | 1.0.0 | MIT OR Apache-2.0 |
| `anstyle-query` | 1.1.5 | MIT OR Apache-2.0 |
| `anstyle-wincon` | 3.0.11 | MIT OR Apache-2.0 |
| `anyhow` | 1.0.104 | MIT OR Apache-2.0 |
| `async-compression` | 0.4.51 | MIT OR Apache-2.0 |
| `atomic-waker` | 1.1.2 | Apache-2.0 OR MIT |
| `base64` | 0.22.1 | MIT OR Apache-2.0 |
| `base64` | 0.23.1 | MIT OR Apache-2.0 |
| `bit-set` | 0.8.0 | Apache-2.0 OR MIT |
| `bit-vec` | 0.8.0 | Apache-2.0 OR MIT |
| `bitflags` | 1.3.2 | MIT/Apache-2.0 |
| `bitflags` | 2.13.2 | MIT OR Apache-2.0 |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 |
| `brotli` | 9.0.0 | BSD-3-Clause AND MIT |
| `brotli-decompressor` | 6.0.1 | BSD-3-Clause/MIT |
| `byteorder` | 1.5.0 | Unlicense OR MIT |
| `bytes` | 1.12.1 | MIT |
| `camino` | 1.2.6 | MIT OR Apache-2.0 |
| `cargo-platform` | 0.1.9 | MIT OR Apache-2.0 |
| `cargo_metadata` | 0.19.2 | MIT |
| `cfb` | 0.14.0 | MIT |
| `cfg-if` | 1.0.5 | MIT OR Apache-2.0 |
| `colorchoice` | 1.0.5 | MIT OR Apache-2.0 |
| `compression-codecs` | 0.4.46 | MIT OR Apache-2.0 |
| `compression-core` | 0.4.34 | MIT OR Apache-2.0 |
| `cookie` | 0.18.2 | MIT OR Apache-2.0 |
| `cpufeatures` | 0.2.17 | MIT OR Apache-2.0 |
| `crc32fast` | 1.5.2 | MIT OR Apache-2.0 |
| `crossbeam-channel` | 0.5.17 | MIT OR Apache-2.0 |
| `crossbeam-utils` | 0.8.23 | MIT OR Apache-2.0 |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 |
| `cssparser` | 0.37.0 | MPL-2.0 |
| `cssparser-macros` | 0.7.1 | MPL-2.0 |
| `csv` | 1.4.0 | Unlicense/MIT |
| `csv-core` | 0.1.13 | Unlicense/MIT |
| `ctor` | 1.0.13 | Apache-2.0 OR MIT |
| `darling` | 0.24.1 | MIT |
| `darling_core` | 0.24.1 | MIT |
| `darling_macro` | 0.24.1 | MIT |
| `deranged` | 0.5.9 | MIT OR Apache-2.0 |
| `derive_more` | 2.1.1 | MIT |
| `derive_more-impl` | 2.1.1 | MIT |
| `digest` | 0.10.7 | MIT OR Apache-2.0 |
| `dirs` | 7.0.0 | MIT OR Apache-2.0 |
| `dirs-sys` | 0.5.0 | MIT OR Apache-2.0 |
| `discord-rich-presence` | 1.1.0 | MIT |
| `displaydoc` | 0.2.7 | MIT OR Apache-2.0 |
| `dom_query` | 0.28.0 | MIT |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT |
| `dtoa` | 1.0.11 | MIT OR Apache-2.0 |
| `dtoa-short` | 0.3.5 | MPL-2.0 |
| `dunce` | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| `dyn-clone` | 1.0.20 | MIT OR Apache-2.0 |
| `env_filter` | 2.0.0 | MIT OR Apache-2.0 |
| `env_logger` | 0.11.11 | MIT OR Apache-2.0 |
| `equivalent` | 1.0.3 | Apache-2.0 OR MIT |
| `erased-serde` | 0.4.10 | MIT OR Apache-2.0 |
| `fallible-iterator` | 0.3.0 | MIT/Apache-2.0 |
| `fallible-streaming-iterator` | 0.1.9 | MIT/Apache-2.0 |
| `fastrand` | 2.5.0 | Apache-2.0 OR MIT |
| `fdeflate` | 0.3.7 | MIT OR Apache-2.0 |
| `flate2` | 1.1.10 | MIT OR Apache-2.0 |
| `fnv` | 1.0.7 | Apache-2.0 / MIT |
| `foldhash` | 0.2.0 | Zlib |
| `form_urlencoded` | 1.2.2 | MIT OR Apache-2.0 |
| `futures-channel` | 0.3.34 | MIT OR Apache-2.0 |
| `futures-core` | 0.3.34 | MIT OR Apache-2.0 |
| `futures-macro` | 0.3.34 | MIT OR Apache-2.0 |
| `futures-sink` | 0.3.34 | MIT OR Apache-2.0 |
| `futures-task` | 0.3.34 | MIT OR Apache-2.0 |
| `futures-util` | 0.3.34 | MIT OR Apache-2.0 |
| `generic-array` | 0.14.7 | MIT |
| `getrandom` | 0.2.17 | MIT OR Apache-2.0 |
| `getrandom` | 0.3.4 | MIT OR Apache-2.0 |
| `getrandom` | 0.4.3 | MIT OR Apache-2.0 |
| `glob` | 0.3.4 | MIT OR Apache-2.0 |
| `hashbrown` | 0.12.3 | MIT OR Apache-2.0 |
| `hashbrown` | 0.17.1 | MIT OR Apache-2.0 |
| `hashlink` | 0.12.2 | MIT OR Apache-2.0 |
| `heck` | 0.5.0 | MIT OR Apache-2.0 |
| `html5ever` | 0.39.0 | MIT OR Apache-2.0 |
| `http` | 1.5.0 | MIT OR Apache-2.0 |
| `http-body` | 1.1.0 | MIT |
| `http-body-util` | 0.1.5 | MIT |
| `http-range` | 0.1.5 | MIT |
| `httparse` | 1.10.1 | MIT OR Apache-2.0 |
| `hyper` | 1.12.0 | MIT |
| `hyper-rustls` | 0.27.10 | Apache-2.0 OR ISC OR MIT |
| `hyper-util` | 0.1.21 | MIT |
| `ico` | 0.5.0 | MIT |
| `icu_collections` | 2.3.0 | Unicode-3.0 |
| `icu_locale_core` | 2.3.0 | Unicode-3.0 |
| `icu_normalizer` | 2.3.0 | Unicode-3.0 |
| `icu_normalizer_data` | 2.3.0 | Unicode-3.0 |
| `icu_properties` | 2.3.0 | Unicode-3.0 |
| `icu_properties_data` | 2.3.0 | Unicode-3.0 |
| `icu_provider` | 2.3.1 | Unicode-3.0 |
| `ident_case` | 1.0.1 | MIT/Apache-2.0 |
| `idna` | 1.1.0 | MIT OR Apache-2.0 |
| `idna_adapter` | 1.2.2 | Apache-2.0 OR MIT |
| `indexmap` | 1.9.3 | Apache-2.0 OR MIT |
| `indexmap` | 2.14.2 | Apache-2.0 OR MIT |
| `infer` | 0.22.0 | MIT |
| `ipnet` | 2.12.2 | MIT OR Apache-2.0 |
| `is_terminal_polyfill` | 1.70.2 | MIT OR Apache-2.0 |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 |
| `jiff` | 0.2.38 | Unlicense OR MIT |
| `jiff-core` | 0.1.1 | Unlicense OR MIT |
| `json-patch` | 4.2.0 | MIT/Apache-2.0 |
| `jsonptr` | 0.7.1 | MIT OR Apache-2.0 |
| `keyboard-types` | 0.8.3 | MIT OR Apache-2.0 |
| `libc` | 0.2.190 | MIT OR Apache-2.0 |
| `libloading` | 0.8.9 | ISC |
| `libsqlite3-sys` | 0.38.2 | MIT |
| `litemap` | 0.8.3 | Unicode-3.0 |
| `lock_api` | 0.4.14 | MIT OR Apache-2.0 |
| `log` | 0.4.34 | MIT OR Apache-2.0 |
| `markup5ever` | 0.39.0 | MIT OR Apache-2.0 |
| `memchr` | 2.8.3 | Unlicense OR MIT |
| `mime` | 0.3.17 | MIT OR Apache-2.0 |
| `minisign-verify` | 0.3.0 | MIT |
| `miniz_oxide` | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| `miniz_oxide` | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| `mio` | 1.2.4 | MIT |
| `muda` | 0.20.0 | Apache-2.0 OR MIT |
| `new_debug_unreachable` | 1.0.6 | MIT |
| `notify-rust` | 4.18.2 | MIT OR Apache-2.0 |
| `num-conv` | 0.2.2 | MIT OR Apache-2.0 |
| `once_cell` | 1.21.4 | MIT OR Apache-2.0 |
| `once_cell_polyfill` | 1.70.2 | MIT OR Apache-2.0 |
| `open` | 5.4.4 | MIT |
| `option-ext` | 0.2.0 | MPL-2.0 |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 |
| `parking_lot_core` | 0.9.12 | MIT OR Apache-2.0 |
| `percent-encoding` | 2.3.2 | MIT OR Apache-2.0 |
| `phf` | 0.13.1 | MIT |
| `phf_generator` | 0.13.1 | MIT |
| `phf_macros` | 0.13.1 | MIT |
| `phf_shared` | 0.13.1 | MIT |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT |
| `plist` | 1.10.1 | MIT |
| `png` | 0.17.16 | MIT OR Apache-2.0 |
| `png` | 0.18.1 | MIT OR Apache-2.0 |
| `potential_utf` | 0.1.6 | Unicode-3.0 |
| `powerfmt` | 0.2.1 | MIT OR Apache-2.0 |
| `ppv-lite86` | 0.2.21 | MIT OR Apache-2.0 |
| `precomputed-hash` | 0.1.1 | MIT |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 |
| `quick-xml` | 0.42.0 | MIT |
| `quote` | 1.0.47 | MIT OR Apache-2.0 |
| `rand` | 0.9.5 | MIT OR Apache-2.0 |
| `rand_chacha` | 0.9.0 | MIT OR Apache-2.0 |
| `rand_core` | 0.9.5 | MIT OR Apache-2.0 |
| `raw-window-handle` | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| `regex` | 1.13.1 | MIT OR Apache-2.0 |
| `regex-automata` | 0.4.18 | MIT OR Apache-2.0 |
| `regex-syntax` | 0.8.11 | MIT OR Apache-2.0 |
| `reqwest` | 0.12.28 | MIT OR Apache-2.0 |
| `reqwest` | 0.13.5 | MIT OR Apache-2.0 |
| `rfd` | 0.16.0 | MIT |
| `ring` | 0.17.14 | Apache-2.0 AND ISC |
| `rusqlite` | 0.40.2 | MIT |
| `rustc-hash` | 2.1.3 | Apache-2.0 OR MIT |
| `rustls` | 0.23.46 | Apache-2.0 OR ISC OR MIT |
| `rustls-pki-types` | 1.15.1 | MIT OR Apache-2.0 |
| `rustls-platform-verifier` | 0.7.1 | MIT OR Apache-2.0 |
| `rustls-webpki` | 0.103.15 | ISC |
| `ryu` | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| `same-file` | 1.0.6 | Unlicense/MIT |
| `schemars` | 0.8.22 | MIT |
| `schemars_derive` | 0.8.22 | MIT |
| `scopeguard` | 1.2.0 | MIT OR Apache-2.0 |
| `selectors` | 0.38.0 | MPL-2.0 |
| `semver` | 1.0.28 | MIT OR Apache-2.0 |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `serde-untagged` | 0.1.9 | MIT OR Apache-2.0 |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_derive` | 1.0.229 | MIT OR Apache-2.0 |
| `serde_derive_internals` | 0.29.1 | MIT OR Apache-2.0 |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 |
| `serde_repr` | 0.1.21 | MIT OR Apache-2.0 |
| `serde_spanned` | 1.1.2 | MIT OR Apache-2.0 |
| `serde_urlencoded` | 0.7.1 | MIT/Apache-2.0 |
| `serde_with` | 3.24.0 | MIT OR Apache-2.0 |
| `serde_with_macros` | 3.24.0 | MIT OR Apache-2.0 |
| `serialize-to-javascript` | 0.1.2 | MIT OR Apache-2.0 |
| `serialize-to-javascript-impl` | 0.1.2 | MIT OR Apache-2.0 |
| `servo_arc` | 0.4.3 | MIT OR Apache-2.0 |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 |
| `simd-adler32` | 0.3.10 | MIT |
| `siphasher` | 1.0.4 | MIT OR Apache-2.0 |
| `slab` | 0.4.12 | MIT |
| `smallvec` | 1.16.3 | MIT OR Apache-2.0 |
| `socket2` | 0.6.5 | MIT OR Apache-2.0 |
| `softbuffer` | 0.4.8 | MIT OR Apache-2.0 |
| `stable_deref_trait` | 1.2.1 | MIT OR Apache-2.0 |
| `string_cache` | 0.9.0 | MIT OR Apache-2.0 |
| `strsim` | 0.11.1 | MIT |
| `subtle` | 2.6.1 | BSD-3-Clause |
| `syn` | 2.0.119 | MIT OR Apache-2.0 |
| `syn` | 3.0.9 | MIT OR Apache-2.0 |
| `sync_wrapper` | 1.0.2 | Apache-2.0 |
| `synstructure` | 0.14.0 | MIT |
| `tao` | 0.37.1 | Apache-2.0 |
| `tauri` | 2.12.4 | Apache-2.0 OR MIT |
| `tauri-codegen` | 2.7.3 | Apache-2.0 OR MIT |
| `tauri-macros` | 2.7.3 | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | 2.8.3 | Apache-2.0 OR MIT |
| `tauri-plugin-fs` | 2.7.1 | Apache-2.0 OR MIT |
| `tauri-plugin-notification` | 2.7.0 | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | 2.7.2 | Apache-2.0 OR MIT |
| `tauri-plugin-process` | 2.4.0 | Apache-2.0 OR MIT |
| `tauri-plugin-updater` | 2.14.0 | Apache-2.0 OR MIT |
| `tauri-runtime` | 2.12.2 | Apache-2.0 OR MIT |
| `tauri-runtime-wry` | 2.12.2 | Apache-2.0 OR MIT |
| `tauri-utils` | 2.10.2 | Apache-2.0 OR MIT |
| `tauri-winrt-notification` | 0.8.1 | MIT OR Apache-2.0 |
| `tempfile` | 3.27.0 | MIT OR Apache-2.0 |
| `tendril` | 0.5.1 | MIT OR Apache-2.0 |
| `thiserror` | 2.0.21 | MIT OR Apache-2.0 |
| `thiserror-impl` | 2.0.21 | MIT OR Apache-2.0 |
| `time` | 0.3.55 | MIT OR Apache-2.0 |
| `time-core` | 0.1.9 | MIT OR Apache-2.0 |
| `time-macros` | 0.2.32 | MIT OR Apache-2.0 |
| `tinystr` | 0.8.4 | Unicode-3.0 |
| `tokio` | 1.53.3 | MIT |
| `tokio-macros` | 2.7.2 | MIT |
| `tokio-rustls` | 0.26.6 | MIT OR Apache-2.0 |
| `tokio-util` | 0.7.20 | MIT |
| `toml` | 1.1.8+spec-1.1.0 | MIT OR Apache-2.0 |
| `toml_datetime` | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| `toml_parser` | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 |
| `toml_writer` | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| `tower` | 0.5.3 | MIT |
| `tower-http` | 0.6.11 | MIT |
| `tower-layer` | 0.3.3 | MIT |
| `tower-service` | 0.3.3 | MIT |
| `tracing` | 0.1.44 | MIT |
| `tracing-core` | 0.1.36 | MIT |
| `tray-icon` | 0.25.1 | MIT OR Apache-2.0 |
| `try-lock` | 0.2.5 | MIT |
| `typeid` | 1.0.3 | MIT OR Apache-2.0 |
| `typenum` | 1.20.1 | MIT OR Apache-2.0 |
| `unicode-ident` | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| `unicode-segmentation` | 1.13.3 | MIT OR Apache-2.0 |
| `untrusted` | 0.9.0 | ISC |
| `url` | 2.5.8 | MIT OR Apache-2.0 |
| `urlpattern` | 0.6.0 | MIT |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT |
| `utf8parse` | 0.2.2 | Apache-2.0 OR MIT |
| `uuid` | 1.28.0 | Apache-2.0 OR MIT |
| `uuid` | 0.8.2 | Apache-2.0 OR MIT |
| `walkdir` | 2.5.0 | Unlicense/MIT |
| `want` | 0.3.2 | MIT |
| `web-time` | 1.1.0 | MIT OR Apache-2.0 |
| `web_atoms` | 0.2.6 | MIT OR Apache-2.0 |
| `webpki-roots` | 1.0.9 | CDLA-Permissive-2.0 |
| `webview2-com` | 0.39.1 | MIT |
| `webview2-com-macros` | 0.8.1 | MIT |
| `webview2-com-sys` | 0.39.1 | MIT |
| `winapi-util` | 0.1.11 | Unlicense OR MIT |
| `window-vibrancy` | 0.8.1 | Apache-2.0 OR MIT |
| `windows` | 0.62.2 | MIT OR Apache-2.0 |
| `windows-collections` | 0.3.2 | MIT OR Apache-2.0 |
| `windows-core` | 0.62.2 | MIT OR Apache-2.0 |
| `windows-future` | 0.3.2 | MIT OR Apache-2.0 |
| `windows-implement` | 0.60.2 | MIT OR Apache-2.0 |
| `windows-interface` | 0.59.3 | MIT OR Apache-2.0 |
| `windows-link` | 0.2.1 | MIT OR Apache-2.0 |
| `windows-numerics` | 0.3.1 | MIT OR Apache-2.0 |
| `windows-registry` | 0.6.1 | MIT OR Apache-2.0 |
| `windows-result` | 0.4.1 | MIT OR Apache-2.0 |
| `windows-strings` | 0.5.1 | MIT OR Apache-2.0 |
| `windows-sys` | 0.60.2 | MIT OR Apache-2.0 |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 |
| `windows-targets` | 0.53.5 | MIT OR Apache-2.0 |
| `windows-threading` | 0.2.1 | MIT OR Apache-2.0 |
| `windows-version` | 0.1.7 | MIT OR Apache-2.0 |
| `windows_x86_64_msvc` | 0.53.1 | MIT OR Apache-2.0 |
| `winnow` | 1.0.4 | MIT |
| `writeable` | 0.6.4 | Unicode-3.0 |
| `wry` | 0.57.0 | Apache-2.0 OR MIT |
| `yoke` | 0.8.3 | Unicode-3.0 |
| `yoke-derive` | 0.8.4 | Unicode-3.0 |
| `zerocopy` | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| `zerofrom` | 0.1.8 | Unicode-3.0 |
| `zerofrom-derive` | 0.1.8 | Unicode-3.0 |
| `zeroize` | 1.9.1 | Apache-2.0 OR MIT |
| `zerotrie` | 0.2.5 | Unicode-3.0 |
| `zerovec` | 0.11.8 | Unicode-3.0 |
| `zerovec-derive` | 0.11.6 | Unicode-3.0 |
| `zip` | 4.6.1 | MIT |
| `zmij` | 1.0.23 | MIT |
| `zstd` | 0.13.3 | MIT |
| `zstd-safe` | 7.3.0 | BSD-3-Clause |
| `zstd-sys` | 2.1.2+zstd.1.5.7 | BSD-3-Clause |

Zusammenfassung: 141× MIT OR Apache-2.0, 56× MIT, 29× Apache-2.0 OR MIT, 18× Unicode-3.0, 6× Unlicense OR MIT, 6× MIT/Apache-2.0, 5× BSD-3-Clause, 5× MPL-2.0, 4× Unlicense/MIT, 3× ISC, 2× Apache-2.0 OR ISC OR MIT, 2× MIT OR Zlib OR Apache-2.0, 2× Apache-2.0, 1× 0BSD OR MIT OR Apache-2.0, 1× BSD-3-Clause AND MIT, 1× BSD-3-Clause/MIT, 1× Apache-2.0 AND MIT, 1× CC0-1.0 OR MIT-0 OR Apache-2.0, 1× Apache-2.0 / MIT, 1× Zlib, 1× MIT OR Apache-2.0 OR Zlib, 1× Apache-2.0 AND ISC, 1× Apache-2.0 OR BSL-1.0, 1× (MIT OR Apache-2.0) AND Unicode-3.0, 1× CDLA-Permissive-2.0, 1× BSD-2-Clause OR Apache-2.0 OR MIT.

## MapLibre GL JS – Lizenztext

MapLibre GL JS 6.12.0 (BSD-3-Clause) verlangt die Weitergabe des folgenden Hinweises mit jeder Binärverteilung (Text aus `node_modules/maplibre-gl/LICENSE.txt`):

```text
Copyright (c) 2023, MapLibre contributors

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of MapLibre GL JS nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


-------------------------------------------------------------------------------

Contains code from mapbox-gl-js v1.13 and earlier

Version v1.13 of mapbox-gl-js and earlier are licensed under a BSD-3-Clause license

Copyright (c) 2020, Mapbox
Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of Mapbox GL JS nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


-------------------------------------------------------------------------------

Contains code from glfx.js

Copyright (C) 2011 by Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

--------------------------------------------------------------------------------

Contains a portion of d3-color https://github.com/d3/d3-color

Copyright 2010-2016 Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
