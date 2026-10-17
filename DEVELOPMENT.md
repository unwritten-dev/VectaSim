# VectaSim – Entwicklung

Technische Doku für alle, die am Code arbeiten. Die Nutzersicht steht in der [README](README.md), Installation in [docs/installation.md](docs/installation.md), Releases in [docs/releasing.md](docs/releasing.md).

## Stack

- **Desktop-Shell:** Tauri v2 (Rust-Backend, WebView2-Frontend), Windows zuerst.
- **Frontend:** React 19 + TypeScript, Vite, MapLibre GL JS 5, Vitest. Keine UI-Bibliothek – eigene Komponenten in `app/src/ui/`, Design-Tokens als CSS-Variablen, sechs umschaltbare Themes in `app/src/themes.ts`.
- **Backend:** Rust-Workspace, SQLite (rusqlite, bundled), reqwest (rustls).

## Struktur

```
Cargo.toml                  Rust-Workspace
crates/vectasim-core        Telemetry-Modell, SimProvider-Trait, MockProvider/MockFlight,
                            PhaseEngine, TouchdownDetector, FlightSession, Landing-Analyse
crates/vectasim-simconnect  SimConnect-Provider (SimConnect.dll per libloading, keine SDK-Importlib)
crates/vectasim-store       SQLite-Logbuch: Schema/Migrationen, FlightRecorder, Track-Codec,
                            Airframes, Exporte (CSV/GPX/KML/JSON)
crates/vectasim-data        Eingebettete OurAirports-Daten (Flughäfen, Runways) mit Bbox-/Nearest-Suche
crates/vectasim-simbrief    SimBrief-OFP-Fetcher (JSON v2) und reduziertes OFP-Modell
crates/vectasim-online      VATSIM-Feed (15-s-Poller mit Backoff), METAR-Client und -Decoder
crates/vectasim-photos      Planespotters-Fotoclient mit Cache
app/src-tauri               Tauri-Backend: Commands, ProviderManager/Forwarder, Updater, Landing-Command
app/src                     Frontend (live/, landing/, map/, airframes/, ui/)
scripts/update-airports.py  Aktualisiert die eingebetteten OurAirports-CSVs
.github/workflows           ci.yml (Tests, Clippy, tsc, Vitest), release.yml (Tag v* → signierter Installer)
```

## Voraussetzungen

- Rust stable (`rustup`, Toolchain `stable-x86_64-pc-windows-msvc`), Visual Studio Build Tools 2022 mit C++-Workload, WebView2 (in Windows 10/11 enthalten)
- Node.js 22
- Für echte Sim-Daten eine `SimConnect.dll` (Suchreihenfolge siehe `docs/installation.md`); ohne Sim läuft alles gegen den Mock.

## Entwickeln

```bash
cd app && npm ci
```

Mock-Flug (ohne Simulator, fliegt eine Platzrunde EDDF 25C mit sauberem 3°-Anflug; `VECTASIM_MOCK=bounce` für eine Bounce-Landung):

cmd:

```bat
cd app && set "VECTASIM_PROVIDER=mock" && npm run tauri dev
```

PowerShell:

```powershell
cd app; $env:VECTASIM_PROVIDER="mock"; npm run tauri dev
```

Mit Simulator: `npm run tauri dev` ohne Variable. Dev-Logs mit `RUST_LOG=info`.

### Tests und Checks

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd app && npx tsc --noEmit && npm test
```

CI führt genau diese vier Schritte aus.

## Architektur in Kürze

- **Provider → Channel → Forwarder.** Jeder Sim-Provider läuft auf einem eigenen Thread und pusht `ProviderEvent`s (Telemetry mit nativer Rate, Aircraft, Sim-Events, Status). Der `ProviderManager` (`app/src-tauri/src/manager.rs`) führt pro Verbindung eine `FlightSession` und einen `FlightRecorder`, drosselt Telemetrie fürs Webview auf 10 Hz und emittiert `sim:*`-Events.
- **Flugphasen** (`crates/vectasim-core/src/phase.rs`): 12 Phasen, zeitbasierte Hysterese, Samples bei Pause/Slew/Zeitraffer werden ignoriert; „am Boden" nur, wenn AGL ≤ 50 ft (bzw. GS ≤ 200 kt ohne AGL) – die Schwellwerte stehen im Dateikopf.
- **Touchdown** (`touchdown.rs`): Ringpuffer auf dem vollen Stream; Landerate = Sim-Wert (`PLANE TOUCHDOWN NORMAL VELOCITY` × 60) mit Rückfall auf die letzte Vertical Speed in der Luft, Worst-of-Bounces innerhalb eines Ereignisses, Debounce über mehrere Bodensamples, Erstkontakt als Zeit/Ort. Touch-and-gos werden gespeichert, zählen aber nie als Landung des Flugs.
- **Landeauswertung** (`landing.rs`): reine Funktionen über Track + Touchdown + Runway (OurAirports-Schwellen) + METAR-Wind: Aufsetzpunkt relativ zur Schwelle, Mittellinien-Versatz, Touchdown-Zone, Gleitpfad gegen 3°, Flare, Rollout, Stabilized-Approach-Gates bei 1000/500 ft. Der „VectaSim-Index" (0–100) wird im Frontend aus Bändern gebildet (`app/src/landing/facts.ts`, Formel sichtbar unter „Methodik").
- **Store** (`crates/vectasim-store`): SQLite im WAL-Modus unter `%APPDATA%\io.vectasim.app\vectasim.db`, Migrationen in `store.rs` (`schema_version`), Tracks als spaltenweise Delta/Varint + zstd (~10 Bytes/Sample), Flush jede Minute; ein beim Absturz offener Flug wird beim nächsten Start als unvollständig markiert.
- **Karte** (`app/src/map/`): OpenFreeMap-Style wird einmal geladen, pro Theme gepatcht (`basemap.ts`) und gecacht; eigene Layer: Flughäfen, Airport-Diagramm (OSM `aeroway`), Track, geplante Route, VATSIM-Traffic/ATC, METAR-Badges, eigenes Flugzeug (Silhouette nach Wirbelschleppen-Klasse). Nach einem Theme-Wechsel wird der Style neu gesetzt und die Layer werden neu angelegt.
- **Themes** (`app/src/themes.ts`): Token-Sets werden als CSS-Variablen auf `:root` geschrieben; `theme.ts` liefert die Kartenfarben live. Regel: kein Violett/Magenta (Tests prüfen das), eigenes Flugzeug immer `#ffd54a`, Kontrast Text/Fläche ≥ 4,5:1.
- **Events ans Frontend:** `sim:status`, `sim:telemetry`, `sim:flight`, `sim:flight-event`, `sim:aircraft`, `sim:event`, `sim:stats`, `online:summary`, `logbook:changed`, `dispatch:ofp`, `theme:changed`.

## Daten und Lizenzen

| Quelle | Nutzung | Lizenz |
|---|---|---|
| OurAirports | Flughäfen/Runways eingebettet (`crates/vectasim-data/data`) | Public Domain |
| OpenFreeMap / OpenMapTiles / OpenStreetMap | Basemap-Vektortiles | ODbL – Attribution bleibt sichtbar |
| aviationweather.gov (NOAA) | METAR | Public Domain; eigener User-Agent, ≤ 60 req/min, 10-min-Cache |
| VATSIM data feed v3 | Traffic/ATC | nur bei eingeschaltetem Verkehr, nie schneller als 15 s |
| SimBrief (Navigraph) | OFP-Abruf auf Knopfdruck | Navigraph Developer Terms |
| Planespotters.net | Flugzeugfotos zur Registrierung | Credit + Link Pflicht, ≤ 1 req/s, Cache 7 Tage |
| SimConnect.dll | wird **nicht** mitgeliefert, zur Laufzeit geladen | MSFS SDK EULA |

Bewusst nicht verwendet: Navigraph-Charts/FMS-Daten (keine Einbettung erlaubt), RainViewer (ab 2026 nur privat), OpenAIP (CC BY-NC).

## Konventionen

- Rust: Doc-Kommentare erklären das *Warum*; `unsafe` nur in der SimConnect-FFI mit `SAFETY`-Kommentar; Clippy ohne Warnungen.
- Frontend: serde-Felder camelCase, Typen gespiegelt in `app/src/types.ts`; UI-Texte Deutsch, Flugphasen Englisch; Zahlen über `format.ts` (UTC mit „z", Tausendertrennung, echtes Minus).
- Keine neuen Abhängigkeiten ohne Grund; Charts sind handgeschriebenes SVG.

## Noch offen (Auszug)

- Erste Verifikation gegen echtes MSFS (siehe `docs/sim-pc-checklist.md`): Touchdown-Vorzeichen, `SIM_FRAME`-Rate, `TT:`-Tokens im ATC-Model, Pushback-Erkennung.
- X-Plane-Provider (Web-API 12.1+, später eigenes Plugin), P3D best effort.
- Weitere UI-Schritte: Bereit-Karte beim Start, Demo ohne Logbuch-Spuren, SimBrief automatisch laden, Sidebar auf drei Einträge, Landekarte als PNG, Streubild der letzten Landungen.
