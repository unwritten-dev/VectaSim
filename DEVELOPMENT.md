# VectaSim – Entwicklung

Technische Doku für alle, die am Code arbeiten. Die Nutzersicht steht in der [README](README.md) und in [docs/installation.md](docs/installation.md); beides bleibt bewusst frei von Entwicklungsdetails. Releases: [docs/releasing.md](docs/releasing.md), erster Test gegen echtes MSFS: [docs/sim-pc-checklist.md](docs/sim-pc-checklist.md).

## Stack

- **Desktop-Shell:** Tauri v2 (Rust-Backend, WebView2-Frontend), Windows zuerst.
- **Frontend:** React 19 + TypeScript, Vite, MapLibre GL JS 6, Vitest. Keine UI-Bibliothek – eigene Komponenten in `app/src/ui/`, Design-Tokens als CSS-Variablen, sechs umschaltbare Themes in `app/src/themes.ts`.
- **Backend:** Rust-Workspace, SQLite 3.53.2 (rusqlite 0.40, bundled; Test `bundled_sqlite_is_new_enough` verlangt ≥ 3.50.2), reqwest (rustls).

## Struktur

```
Cargo.toml                  Rust-Workspace
crates/vectasim-core        Telemetry-Modell, SimProvider-Trait, MockProvider/MockFlight,
                            PhaseEngine, TouchdownDetector, FlightSession, Landing-Analyse
crates/vectasim-simconnect  SimConnect-Provider (SimConnect.dll per libloading, keine SDK-Importlib),
                            gemeinsamer Decoder, Replay-Provider, Probe-Tool (src/bin/vectasim-probe.rs)
crates/vectasim-dump        Roh-Telemetrie-Dump (.vsdump): Format, Recorder (Datei + RAM-Ring), Reader
crates/vectasim-store       SQLite-Logbuch: Schema/Migrationen, FlightRecorder, Track-Codec,
                            Airframes, Exporte (CSV/GPX/KML/JSON)
crates/vectasim-data        Eingebettete OurAirports-Daten (Flughäfen, Runways) mit Bbox-/Nearest-Suche; Länderliste + Natural-Earth-Grenzen (`countries`)
crates/vectasim-simbrief    SimBrief-OFP-Fetcher (JSON v2) und reduziertes OFP-Modell
crates/vectasim-online      VATSIM-Feed (15-s-Poller mit Backoff), METAR-Client und -Decoder
crates/vectasim-photos      Planespotters-Fotoclient mit Cache
app/src-tauri               Tauri-Backend: Commands, ProviderManager/Forwarder, Updater, Landing-Command
app/src                     Frontend (live/, landing/, map/, airframes/, ui/)
scripts/update-airports.py  Aktualisiert die eingebetteten OurAirports-CSVs
scripts/update-countries.py Aktualisiert Länderliste und Ländergrenzen (Natural Earth, CLDR-Namen)
.github/workflows           ci.yml (Clippy, Tests, cargo audit, ESLint, tsc, Vitest), release.yml (Tag v* → signierter Installer)
```

## Voraussetzungen

- Rust über `rustup` (MSVC-Target), Visual Studio Build Tools 2022 mit C++-Workload, WebView2 (in Windows 10/11 enthalten). Die Compiler-Version ist in `rust-toolchain.toml` festgelegt (derzeit 1.99.1); `rustup` installiert sie beim ersten `cargo`-Aufruf im Repo selbst. Anheben = Datei ändern + Clippy laufen lassen.
- Node.js 22
- Für echte Sim-Daten eine `SimConnect.dll` (Suchreihenfolge siehe `docs/installation.md`, Herkunft siehe „SimConnect.dll“ unten); ohne Sim läuft alles gegen den Mock – der lädt die DLL nie.

## Entwickeln

```bash
cd app && npm ci
```

Mock-Flug (ohne Simulator, fliegt eine Platzrunde EDDF 25C mit sauberem 3°-Anflug; `VECTASIM_MOCK=bounce` für eine Bounce-Landung, `VECTASIM_MOCK=goaround` für ein Durchstarten bei 300 ft mit zweiter Platzrunde):

cmd:

```bat
cd app && set "VECTASIM_PROVIDER=mock" && npm run tauri dev
```

PowerShell:

```powershell
cd app; $env:VECTASIM_PROVIDER="mock"; npm run tauri dev
```

Mit Simulator: `npm run tauri dev` ohne Variable. Dev-Logs mit `RUST_LOG=info`.

### Aus dem Quellcode bauen

Eigener Installer ohne Signaturschlüssel (das Updater-Artefakt muss dann abgeschaltet sein):

```bat
cd app
npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"
```

```powershell
cd app
npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Ergebnis: `target\release\bundle\nsis\VectaSim_<version>_x64-setup.exe` (relativ zum Repo-Root, nicht zu `app/`). Ein so gebauter Installer funktioniert normal; nur die Auto-Update-Signatur fehlt.

### Roh-Dump, Replay und Probe-Tool (Fehler vom Sim-PC nachstellen)

**Aufnahme (Sim-PC):** *Einstellungen → Diagnose → „Roh-Dump aufzeichnen“* schreibt pro SimConnect-Sitzung `%LOCALAPPDATA%\io.vectasim.app\dumps\<JJJJMMTT-hhmmssZ>.vsdump` (neben `logs\`). Unabhängig vom Schalter hält die App die letzten 30 min im RAM (≤ 64 MB, real ≈ 4 MB); „Dump jetzt speichern“ schreibt sie als `dumps\ring-<zeit>.vsdump`. Aufgezeichnet wird im SimConnect-Session-Dispatch **vor** jeder Interpretation – Decoder-Fehler (Einheiten, Indizes, BCD) bleiben so reproduzierbar.

**Format `.vsdump`** (Version 1; Details in `crates/vectasim-dump/src/lib.rs`): zstd-komprimiertes NDJSON (auch mehrere aneinandergehängte zstd-Frames; unkomprimiertes NDJSON wird ebenfalls gelesen).

- Zeile 1 `{"type":"header","format":1,"app",…,"source":"simconnect","sim","simVersion","simconnect","dll","defs":{"fast":[[name,unit]…],"slow":[…],"static":[…]},"reqs":{"fast":1,"slow":2,"static":3},"inactive":{…},"startedWallMs"}`
- danach je Nachricht `{"t":<ms monoton>,"w":<Wanduhr ms>,"k":…}` mit `k` = `data` (`req` + `v` rohe f64 bzw. `s` Strings; NaN → `null`), `event` (`id` = Name, `data`), `filename` (`id`, `path`), `exception` (`code`, `sendId`, `index`, zugeordneter `call`/`def`/`var`, `dropped`), `open` (Sim- und SimConnect-Version), `quit`, `hr` (`fn`, `hr`), `systemState` (`req`, `int`), `end` (`reason` der Sitzung).
- Kompaktierung: zwischen Keyframes steht statt `v` ein `dv` – die Differenz der IEEE-754-Bitmuster zum vorigen `data` desselben `req` (verlustfrei). Keyframe am Anfang jeder Datei/jedes Ring-Chunks und mindestens jede Sekunde. Der Reader liefert immer `v`. Ergebnis: 60 Hz × 17 FAST-Werte ≈ 7–8 MB/h (Test `sixty_hz_fast_stays_below_10_mb_per_hour`).
- Eine abgeschnittene Datei (App beendet) ist bis zur letzten Sekunde lesbar (Flush 1×/s).

**Abspielen (Dev-PC):** Die Dump-Datei vom Sim-PC kopieren, dann

```powershell
cd app; $env:VECTASIM_PROVIDER="replay"; $env:VECTASIM_REPLAY="C:\pfad\20261017-140322Z.vsdump"; $env:VECTASIM_REPLAY_SPEED="10"; npm run tauri dev
```

```bat
cd app && set "VECTASIM_PROVIDER=replay" && set "VECTASIM_REPLAY=C:\pfad\20261017-140322Z.vsdump" && set "VECTASIM_REPLAY_SPEED=10" && npm run tauri dev
```

`VECTASIM_REPLAY_SPEED`: Default `1`, `0` = so schnell wie möglich; `VECTASIM_REPLAY_LOOP=1` wiederholt. Kurzform `VECTASIM_PROVIDER=replay:<datei>`. Alternativ in der laufenden App *Einstellungen → Diagnose → Replay*: Datei wählen, Geschwindigkeit, „Replay starten“/„Replay beenden“ (zurück zu SimConnect). Der Replay-Provider schickt `Connected { sim_name: "Replay <datei>" }` und speist die Zeilen durch **denselben Decoder** wie die Live-Sitzung (`crates/vectasim-simconnect/src/decoder.rs`); stimmen die Definitionen des Dumps nicht mehr mit dem Build überein, werden die Werte per SimVar-Name zugeordnet. Zeit: `Telemetry.timestamp_ms = Start + (t − t₀)` in *aufgezeichneten* Millisekunden, das Abspieltempo `(t − t₀)/speed` – die Engine sieht also exakt die aufgezeichnete Zeitachse (Dwells verhalten sich wie live, laufen bei Faktor 10 nur zehnmal schneller ab). Start = Wanduhr beim Replay-Start; bei `0` die aufgezeichnete Wanduhr (deterministisch, für Tests). Replay-Flüge landen mit Provider `replay` im Logbuch.

**Ohne Sim einen Dump erzeugen:** `cargo run -p vectasim-simconnect --example mock-to-vsdump -- out.vsdump [--variant bounce] [--from 0] [--to 600] [--hz 60]` (Mock-Flug → Rohwerte, Umkehrung der Decoder-Umrechnungen). Ohne Optionen entsteht die Fixture `crates/vectasim-core/tests/fixtures/mock-circuit.vsdump` (60 s Endanflug + Landung + 20 s Ausrollen, volle 60 Hz); der Test `the_fixture_is_what_the_generator_produces` meldet, wenn sie neu erzeugt werden muss. Gekürzte Dumps vom Sim-Tag gehören in denselben Ordner, mit einem Golden-Test daneben (`replay::replay_file` liefert die `ProviderEvent`s mit simulierter Uhr).

**Live-Rohdaten:** *Einstellungen → Diagnose → Live-Rohdaten* (eingeklappt) zeigt jede Definition (FAST/SLOW/STATIC) mit SimVar, Unit, Rohwert, umgerechnetem Wert, Alter und Rate je Request, die letzten 100 Ereignisse/Exceptions mit Namen und zugeordnetem SimVar, Engine-Innenleben (`FlightSession::debug_state`) und Verbindungsinfo. Datenweg: Command `diagnostics_snapshot` + Event `diag:raw` (2 Hz, nur solange die Ansicht offen ist: `set_diag_stream`). Mock: keine Rohdefinitionen („–“).

**Probe-Tool** (nur Windows, wird nicht gebündelt): verbindet mit denselben Definitionen und demselben Session-Code wie die App, schreibt Rohwerte 1×/s sowie jedes Ereignis, jede Exception und jede Log-Zeile auf die Konsole und nach `probe.log`, optional einen Dump:

```powershell
cargo build -p vectasim-simconnect --bin vectasim-probe --release
target\release\vectasim-probe.exe --dump probe.vsdump --log probe.log [--index 0] [--seconds 600]
```

Bricht die App am Sim-PC, zeigt die Probe, ob das Problem in SimConnect oder in der App-Logik liegt; ihr Dump lässt sich wie jeder andere abspielen.

### Tests und Checks

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd app && npm run lint && npx tsc --noEmit && npm test
```

CI (`.github/workflows/ci.yml`) führt diese Schritte aus, Cargo mit `--locked` (ein veraltetes `Cargo.lock` lässt den Lauf scheitern, ebenso `npm ci` bei einem veralteten `package-lock.json`), und zusätzlich `cargo audit` gegen die RustSec-Datenbank (Sicherheitslücken brechen ab, „unmaintained"-Hinweise werden nur ausgegeben). Alle Actions sind auf Commit-SHAs gepinnt.

Werkzeuge:

- **ESLint** (`app/eslint.config.js`, Flat Config): typescript-eslint „recommended" ohne Typinformation plus die zwei klassischen Hooks-Regeln (`rules-of-hooks`, `exhaustive-deps`, beide als Fehler). Ungenutzte `eslint-disable`-Kommentare sind Fehler – ein Disable braucht also einen echten Treffer und sollte begründet sein. Die React-Compiler-Regeln von `eslint-plugin-react-hooks` ≥ 6 sind bewusst nicht aktiv.
- **rustfmt** (`rustfmt.toml`: `max_width = 140`, `use_small_heuristics = "Max"`) beschreibt den vorhandenen Stil. Der Baum ist damit noch nicht durchformatiert (≈ 130 Stellen weichen ab); neue Dateien bitte damit formatieren (`rustfmt --edition 2024 <datei>`). Sobald einmal `cargo fmt --all` über den ganzen Workspace gelaufen ist, kommt `cargo fmt --all --check` in die CI.
- **Golden-Files** der Exporte liegen in `crates/vectasim-store/tests/golden/`. Eine gewollte Formatänderung erzeugt sie neu: `UPDATE_GOLDEN=1 cargo test -p vectasim-store --test export_golden_tests`; den Diff der Dateien dann wie Code prüfen.

## Architektur in Kürze

- **Provider → Channel → Forwarder.** Jeder Sim-Provider läuft auf einem eigenen Thread und pusht `ProviderEvent`s (Telemetry mit nativer Rate, Aircraft, Sim-Events, Status). Der `ProviderManager` (`app/src-tauri/src/manager.rs`) führt pro Verbindung eine `FlightSession` und einen `FlightRecorder`, drosselt Telemetrie fürs Webview auf 10 Hz (verdecktes Fenster: 1 Hz, siehe „Performance“) und emittiert `sim:*`-Events.
- **Flugphasen** (`crates/vectasim-core/src/phase.rs`): 12 Phasen, zeitbasierte Hysterese, Samples bei Pause/Slew/Zeitraffer werden ignoriert; „am Boden" nur, wenn AGL ≤ 50 ft (bzw. GS ≤ 200 kt ohne AGL) – die Schwellwerte stehen im Dateikopf.
- **Zeitbasis** (`crates/vectasim-core/src/clock.rs`): `Telemetry.timestamp_ms` bleibt Wall-Clock (Anzeige, Logbuch, Track). Phasen-Dwells, Touchdown-Fenster, Pausen und die Distanz-Integration laufen über eine monotone Uhr (`MonoClock`): springt die Systemuhr zurück, zählt das als Δt = 0 (`clock_jump` im Log, `clockJumps` im Debug-Zustand), statt die Phasenerkennung anzuhalten, bis die Uhr den alten Stand wieder erreicht. Zeitraffer (Sim-Rate ≠ 1) wird in Phasen-Engine und Touchdown-Detektor gleich behandelt: beide überspringen diese Samples; eine im Zeitraffer gemachte Landung erscheint in beiden beim ersten Echtzeit-Sample am Boden (Rate dann aus dem Sim-Wert), der Flug trägt `time_acceleration_detected`.
- **Touchdown** (`touchdown.rs`): Ringpuffer auf dem vollen Stream; Landerate = Sim-Wert (`PLANE TOUCHDOWN NORMAL VELOCITY` × 60) mit Rückfall auf die letzte Vertical Speed in der Luft, Worst-of-Bounces innerhalb eines Ereignisses, Debounce über mehrere Bodensamples, Erstkontakt als Zeit/Ort. Touch-and-gos werden gespeichert, zählen aber nie als Landung des Flugs.
- **Anflugbewertung** (`crates/vectasim-core/src/approach.rs`): reine Funktionen über Track (1 Hz) + Phasen + Touchdowns + Runway-Kandidaten; findet Anflugversuche inkl. Go-around, ordnet die Runway auch ohne Touchdown zu, bewertet Gates (10 nm, FAF-Proxy, 1000, 500, 50 ft) und durchgehende Kriterien (EASA-Zwei-Stufen mit Mindestdauer, Ausreißer < 3 s zählen nicht) und liefert „stabil ab“, Bänder, Stabilitätsmaße, Energie-Proxy. Ergebnisse je Anflug in `approach_facts` (Schema 8, versioniert, lazy + beim Flugende).
- **Landeauswertung** (`landing.rs`): reine Funktionen über Track + Touchdown + Runway (OurAirports-Schwellen) + METAR-Wind: Aufsetzpunkt relativ zur Schwelle, Mittellinien-Versatz, Touchdown-Zone, Gleitpfad gegen 3°, Flare, Rollout, Stabilized-Approach-Gates bei 1000/500 ft. Der „VectaSim-Index" (0–100) wird im Frontend aus Bändern gebildet (`app/src/landing/facts.ts`, Formel sichtbar unter „Methodik").
- **Store** (`crates/vectasim-store`): SQLite im WAL-Modus unter `%APPDATA%\io.vectasim.app\vectasim.db`, Migrationen in `store.rs` (`schema_version`), Tracks als spaltenweise Delta/Varint + zstd (~10 Bytes/Sample), Flush alle 15 s (`FLUSH_INTERVAL_MS` in `recorder.rs`); ein beim Absturz offener Flug wird beim nächsten Start als unvollständig markiert.
- **Karte** (`app/src/map/`): OpenFreeMap-Style wird einmal geladen, pro Theme gepatcht (`basemap.ts`) und gecacht; eigene Layer: Flughäfen, Airport-Diagramm (OSM `aeroway`), Track, geplante Route, VATSIM-Traffic/ATC, METAR-Badges, eigenes Flugzeug (Silhouette nach Wirbelschleppen-Klasse). Nach einem Theme-Wechsel wird der Style neu gesetzt und die Layer werden neu angelegt.
- **Themes** (`app/src/themes.ts`): Token-Sets werden als CSS-Variablen auf `:root` geschrieben; `theme.ts` liefert die Kartenfarben live. Regel: kein Violett/Magenta (Tests prüfen das), eigenes Flugzeug immer `#ffd54a`, Kontrast Text/Fläche ≥ 4,5:1.
- **Events ans Frontend:** `sim:status`, `sim:telemetry`, `sim:flight`, `sim:flight-event`, `sim:aircraft`, `sim:event`, `sim:stats`, `diag:raw`, `online:summary`, `logbook:changed`, `dispatch:ofp`, `theme:changed`.
- **Decoder / Replay** (`crates/vectasim-simconnect/src/decoder.rs`, `replay.rs`): Die Interpretation der SimConnect-Rohwerte (Umrechnungen, Events → `ProviderEvent`, Exception-Texte) ist ein `Decoder` ohne FFI und ohne Uhr; Live-`Session` und `ReplayProvider` nutzen ihn gemeinsam. Rohaufnahme: `vectasim-dump::DumpRecorder` (siehe oben).

### Exportformat `.vectasim` (Gesamtexport, `crates/vectasim-store/src/bundle.rs`)

- ZIP; `manifest.json`: `format` (1), `app`, `appVersion`, `schemaVersion`, `createdMs`/`createdUtc`, Zähler (`flights`, `flightsDeleted`, `tracks`, `airframes`, `images`), `trackEncoding` (`vstk1`). Ein Leser lehnt ein höheres `format` ab; ein neueres Schema ist nur ein Hinweis.
- `flights.jsonl`: eine Zeile je Flug – `flight` (alle Spalten von `flights` unter ihrem SQL-Namen, inkl. `deleted_ms`, Plan-, METAR- und Airframe-Feldern), `touchdowns` und `phaseEvents` (Zeilen ohne lokale `id`/`flight_id`), `track` (`file`, `previewFile`, `sampleCount`, `encoding`, `updatedMs`).
- `tracks/<flight_id>.bin` und `tracks/<flight_id>.preview.bin`: die Blobs roh wie in der DB (zstd, Codec laut `encoding`), unkomprimiert im ZIP abgelegt.
- `airframes.jsonl`: `airframe` (alle Spalten von `airframes`) und `imageFile` für eigene Bilder; `images/<Registrierung>.<ext>` (jpg/jpeg/png/webp/gif, ≤ 15 MB).
- Nicht enthalten: `landing_facts`, `approach_facts` (Cache, wird neu berechnet), Einstellungen; Demo-/Replay-Flüge exportiert die App nicht.
- Import: unbekannte Spalten werden übergangen, fehlende bekommen ihre Defaults; gelesen werden nur die genannten Einträge mit Größenlimit (kein Entpacken nach Eintragsnamen). Ein Flug im Zustand `active` kommt als `interrupted` an.
- Zusammenführen: gleiche `id` oder gleiche `dep_icao`/`arr_icao` mit |Δ `off_block_ms`| < 15 min (Papierkorb eingeschlossen) = Duplikat; Airframes füllen nur leere Felder, ein Bild nur, wenn keins da ist; Transaktion je 100 Flüge.
- Ersetzen: erst `create_backup(PreImport)` (`vectasim-pre-import-…`), dann Löschen und Einfügen in **einer** Transaktion; ohne Sicherung kein Ersetzen.

## Daten und Lizenzen

| Quelle | Nutzung | Lizenz |
|---|---|---|
| OurAirports | Flughäfen/Runways eingebettet (`crates/vectasim-data/data`), Kontinent je Land | Public Domain |
| Natural Earth 1:110m Admin-0 | Ländergrenzen der Ansicht *Länder* (`countries.geojson.zst`) | Public Domain |
| Unicode CLDR | Ländernamen Deutsch/Englisch (`countries.csv`) | Unicode License v3 |
| OpenFreeMap / OpenMapTiles / OpenStreetMap | Basemap-Vektortiles | ODbL – Attribution bleibt sichtbar |
| aviationweather.gov (NOAA) | METAR | Public Domain; eigener User-Agent, ≤ 60 req/min, 10-min-Cache |
| VATSIM data feed v3 | Traffic/ATC | nur bei eingeschaltetem Verkehr, nie schneller als 15 s |
| SimBrief (Navigraph) | OFP-Abruf auf Knopfdruck | Navigraph Developer Terms |
| Planespotters.net | Flugzeugfotos zur Registrierung | Credit + Link Pflicht, ≤ 1 req/s, Cache 7 Tage |
| SimConnect.dll | wird **nicht** mitgeliefert, zur Laufzeit geladen; auf Klick aus dem Microsoft-SDK-Download geholt (siehe unten) | MSFS SDK EULA |

Bewusst nicht verwendet: Navigraph-Charts/FMS-Daten (keine Einbettung erlaubt), RainViewer (ab 2026 nur privat), OpenAIP (CC BY-NC).

### SimConnect.dll (Herkunft, Aktualisieren)

Die DLL liegt **nicht** im Repo und nicht im Installer: Die MSFS-SDK-EULA erlaubt Weitergabe nur für „distributable code“, ohne SimConnect.dll als solchen zu nennen; Anfragen bei Microsoft sind unbeantwortet. Ein Microsoft-NuGet-Paket gibt es nicht.

Stattdessen `app/src-tauri/src/simconnect_dl.rs` (Commands `simconnect_download_info`, `download_simconnect`, Event `simconnect-download` mit `{phase, received, total}`): lädt auf Klick die gepinnte ZIP des MSFS 2020 SDK Core von `sdk.flightsimulator.com` per `%SystemRoot%\System32\curl.exe` (nur HTTPS), prüft Größe + SHA-256, holt `cab1.cab` heraus, extrahiert mit `expand.exe -F:<MSI-File-Key>` nur die DLL, prüft deren SHA-256 und legt sie als `%LOCALAPPDATA%\io.vectasim.app\simconnect\SimConnect.dll` (+ `SOURCE.txt`) ab. Der MSI wird nie ausgeführt. Die 2020-DLL läuft laut Microsoft/Asobo auch mit MSFS 2024; die 2024-SDK-ZIP wäre ~620 MB.

Aktuell: SDK Core **0.24.6.0**, ZIP 113 306 986 B, SHA-256 `6daaa1fa45598d890d17b1c8347cd736e529c83bfc00630fcefe8822500eaf3f`; DLL 67 072 B, SHA-256 `cffb74b62b596a897b0ff101bac3d66ea10236c540c75864658b451ffd1e6513`, MSI-File-Key `filtEQeYbpLedi0MhYth1bxHyr8SqE` in `cab1.cab`.

Neue SDK-Version pinnen:

1. Neuesten Eintrag in `https://sdk.flightsimulator.com/files/sdk.json` (`game_versions[0].downloads_menu["SDK Installer (Core)"]`) nehmen, ZIP in einen leeren Ordner laden, Größe und `sha256sum` notieren.
2. Den `.msi` aus der ZIP holen und die `File`-/`Media`-Tabellen lesen (PowerShell, COM `WindowsInstaller.Installer`, `SELECT File, FileName, Sequence FROM File` und `SELECT DiskId, LastSequence, Cabinet FROM Media`): Key der Zeile `…|SimConnect.dll` mit 64-bit-Größe im `lib`-Ordner (nicht `Microsoft.FlightSimulator.SimConnect.dll`), Cabinet aus der Sequenz.
3. `expand.exe -F:<key> <cab> <out>` → DLL-Größe und SHA-256; PE-Machine muss `0x8664` sein.
4. Konstanten oben in `simconnect_dl.rs` ersetzen, dann `VECTASIM_TEST_SDK_ZIP=<zip> cargo test -p vectasim --lib simconnect_dl -- --ignored` (End-to-End-Extraktion), am Sim-PC mit 2020 und 2024 verbinden.

### Flughafen-Index (vorkompiliert)

Quelle bleiben `crates/vectasim-data/data/{airports,runways}.csv` (aktualisieren mit `python scripts/update-airports.py`). `build.rs` des Crates übersetzt sie bei jedem `cargo build` nach `OUT_DIR/airports.vsad` (Build-Artefakt, nicht im Repo); `include_bytes!` bettet es ein. Format (`src/binfmt.rs`, little-endian):

1. Kopf: `VSAD`, Versionsbyte (`binfmt::VERSION`, bei jeder Layoutänderung erhöhen), Zähler (Flughäfen, Runways, Gruppen, Grid-Einträge, Stringtabelle).
2. Stringtabelle: alle Texte dedupliziert hintereinander (UTF-8); Felder verweisen mit (Offset u32, Länge u16).
3. Flughäfen und Runways als Records fester Größe (57 / 90 Byte; Koordinaten als f64, fehlende Werte über Bitmaske) – wahlfreier Zugriff ohne Offset-Tabelle.
4. Runway-Gruppen je Flughafen (Start, Anzahl), nach Ident sortiert; dazu die nach Ident sortierte Flughafen-Permutation (Binärsuche statt HashMap).
5. Dichtes 1°-Grid (181 × 361 Zellen) als Präfix-Offsets + Flughafen-Indizes – Bbox/Nearest ohne Aufbauarbeit.
6. `load()` prüft nur Kopf, Größe und Index-Arrays und dekodiert Records erst beim Zugriff (`OnceLock`); passt der Blob nicht (Version, Größe, Indizes), werden die eingebetteten CSVs geparst (gleiches Ergebnis, ~230 ms). Test `precompiled_index_matches_csv` vergleicht jeden Datensatz.

Ladezeit (`cargo test -p vectasim-data --release -- --ignored --nocapture load_benchmark`): vorher CSV-Parsen ~125 ms (Release) / ~600 ms (Debug), jetzt ~2 ms / ~25 ms; die erste Weltansicht-Abfrage (`in_bbox` über alles, 500 Treffer) ~16 ms.

### Länder (eingebettet)

`crates/vectasim-data/data/countries.csv` (iso2, Kontinent, Name Deutsch/Englisch; 249 ISO-3166-Codes + `XK`) und `countries.geojson.zst` (Natural Earth 1:110m Admin-0, nur Property `iso2`, Koordinaten auf 0,01° gerundet, zstd Level 19: ≈ 165 KiB GeoJSON → ≈ 42 KiB) erzeugt `python -I scripts/update-countries.py [download-dir]` (Python 3.14+, nur Standardbibliothek). Sonderfälle im Skript: `ISO_A2` „-99“/„CN-TW“ → `ISO_A2_EH` (Frankreich, Norwegen, Kosovo, Taiwan), Nordzypern → CY, Somaliland → SO (so ordnet OurAirports deren Flughäfen zu), Französisch-Guayana (GF) aus Frankreich und Spitzbergen (SJ) aus Norwegen herausgelöst. Kleinstaaten ohne Umriss in 1:110m (z. B. Singapur, Malta) erscheinen auf der Karte nur über die Flughafen-Punkte, in der Liste normal.

Zählung (`vectasim_data::countries::visited_countries`, Command `visited_countries` in `app/src-tauri/src/countries.rs`): `list_flights` (ohne Papierkorb) → `state = completed`, `arr_icao` gesetzt, Provider `mock`/`replay` nur mit `include_demo` → `country` (OurAirports `iso_country`) des Ankunftsflughafens; Datum = `landing_ms`, sonst `on_block_ms`. Unbekannte Flughäfen und Codes außerhalb der Liste (`ZZ`, `XP`) zählen nicht. Die Ansicht lädt Liste und Grenzen einmal (`countries_list`, `countries_geojson` als rohe Bytes) und die Zählung neu bei `logbook:changed`.

### Performance (Hintergrund, SimConnect)

- **Verdecktes Fenster:** Das Frontend meldet `invoke("set_ui_visible", { visible })` bei `visibilitychange`/Minimieren/Tray. Unsichtbar: `sim:telemetry` (und das periodische `sim:flight`) 1 Hz, `sim:stats` 0,2 Hz, `diag:raw` aus; ereignisgetriebene Events (`sim:status`, `sim:flight-event`, `sim:aircraft`, `logbook:changed`) und `FlightSession`/Recorder laufen unverändert auf dem vollen Stream.
- **Live-Track inkrementell:** `invoke("get_live_track_since", { tsMs })` liefert nur Samples mit `t_ms > tsMs`; nach `flightStarted` oder Providerwechsel neu mit `get_live_track` beginnen (der Puffer wird dann ersetzt bzw. geleert).
- **SimConnect-Pump:** `SimConnect_Open` bekommt ein Auto-Reset-Event (`CreateEventW`); bei leerer Queue wartet der Thread mit `WaitForSingleObject` höchstens 100 ms (Stop-Flag und Watchdog bleiben wirksam) statt alle 2 ms zu pollen. Ohne Event (Erzeugen fehlgeschlagen) bleibt das alte Polling.

## Sicherheit

**Content Security Policy** (`app/src-tauri/tauri.conf.json` → `app.security.csp`). Sie gilt für den gebauten Webview; `tauri dev` lädt den Vite-Server direkt und läuft auf dem Desktop ohne CSP – CSP-Probleme zeigen sich daher erst in `npm run tauri build` (bzw. dem Installer). Netzabrufe aus Rust (reqwest: METAR, VATSIM, SimBrief, Planespotters-API, Updater) unterliegen der CSP nicht und stehen deshalb bewusst **nicht** darin. Quellen:

| Direktive | Quelle | Wofür |
|---|---|---|
| `default-src` | `'self'` | alles Nicht-Genannte nur aus dem App-Bundle |
| `script-src` | `'self'` | gebündeltes JS; Tauri ergänzt Hashes für eigene Inline-Skripte selbst. Kein `'unsafe-eval'`: MapLibre GL 6 braucht keins |
| `style-src` | `'self' 'unsafe-inline'` | Vite-CSS-Bundle. `'unsafe-inline'` ist Absicherung für `style`-Attribute in HTML-Strings (MapLibre-Popups über `setHTML`, Bibliotheken, die `setAttribute("style")` nutzen); React- und MapLibre-Styles über das CSSOM sind ohnehin erlaubt. `dangerousDisableAssetCspModification: ["style-src"]` verhindert, dass Tauri Nonces anhängt – mit Nonce würde der Browser `'unsafe-inline'` ignorieren |
| `img-src` | `'self' asset: http://asset.localhost` | eigene Flugzeugbilder über das Asset-Protokoll (`convertFileSrc`, Scope zur Laufzeit nur auf den App-Bildordner, `airframes.rs`) |
| | `data: blob:` | SVG-Icons der Karte (`aircraftIcons.ts`), Landekarte als PNG (`exportCard.ts`), MapLibre-Raster aus Blobs |
| | `https://tiles.openfreemap.org` | Natural-Earth-Rasterkacheln des Basemap-Styles |
| | `https://*.plnspttrs.net https://*.planespotters.net` | Planespotters-Fotos (Hotlink, Thumbnails auf `t.plnspttrs.net`) |
| `font-src` | `'self' data:` | gebündelte `@fontsource`-Schriften |
| `connect-src` | `'self' ipc: http://ipc.localhost` | Tauri-IPC (Commands, Events) |
| | `https://tiles.openfreemap.org` | Style-JSON (`basemap.ts`), Vektorkacheln, Glyphen, Sprites – alles auf diesem Host (geprüft am Style `styles/dark`) |
| `worker-src` | `'self' blob:` | MapLibre-Worker. Seit MapLibre 6 ist er eine eigene, von Vite gebündelte Datei (`app/src/map/maplibreWorker.ts`: `?worker&url` + `setWorkerUrl`, gleicher Ursprung) – `blob:` wird dafür nicht mehr gebraucht und kann nach einem Test im Installer entfallen |
| `object-src` / `base-uri` / `form-action` | `'none'` / `'self'` / `'none'` | Härtung, nichts davon wird gebraucht |

Neue Remote-Inhalte im Webview (z. B. ein weiterer Kartenanbieter) brauchen einen Eintrag hier und in der Tabelle.

**MapLibre GL JS** steht auf 6.x (ab 6.12.0): 5.x hatte [GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579) (XSS-Umgehung in `DOM.sanitize`). Die Popups (`app/src/map/online.ts`) escapen alle Werte trotzdem selbst (`esc`), bevor sie über `setHTML` gehen – Feed-Daten (VATSIM, METAR) nie ungeescapt in HTML-Strings. Die CI prüft die Produktions-Abhängigkeiten mit `npm audit --omit=dev --audit-level=high` (high/critical brechen ab). MapLibre 6 ist ESM-only (`import * as maplibregl`), lädt den Worker über `setWorkerUrl` (siehe oben) und bringt den globalen `GeoJSON`-Namespace nicht mehr mit (`app/src/map/geojson.d.ts`).

**Pfade aus dem Webview** (`data::check_path`): `save_export`, `export_logbook_csv`, `save_image`, `export_bundle` und `create_diag_package` schreiben nur auf Pfade, die absolut sind, kein `..` enthalten, die passende Endung haben (Format-Endung `.csv/.gpx/.kml/.json`, `.png`, `.vectasim`, `.zip`) und nicht unter `%WINDIR%`, den Programmordnern (`ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`) oder dem Installationsordner der App liegen – sonst Fehler „Pfad nicht erlaubt“. `import_bundle`/`read_bundle_manifest` prüfen absolut, ohne `..`, Endung `.vectasim`.

**Exporte:** Freitext-Zellen im Logbuch-CSV (Flugzeugtitel, Callsign, ICAO, Provider …), die mit `=`, `+`, `-`, `@`, Tab oder CR beginnen, bekommen ein `'` vorangestellt (CSV-/Formel-Injection); Zahlenzellen bleiben unverändert (`export.rs`). **Track-Blobs** gelten als nicht vertrauenswürdig: höchstens 200 000 Samples, die Sample-Zahl im Header muss zur Blob-Länge passen, und die Dekompression ist begrenzt – ein kaputter Eintrag liefert einen Fehler statt eines Speicherüberlaufs (`track.rs`).

## Konventionen

- Rust: Doc-Kommentare erklären das *Warum*; `unsafe` nur in der SimConnect-FFI mit `SAFETY`-Kommentar; Clippy ohne Warnungen.
- Frontend: serde-Felder camelCase, Typen gespiegelt in `app/src/types.ts`; UI-Texte Deutsch, Flugphasen Englisch; Zahlen über `format.ts` (UTC mit „z", Tausendertrennung, echtes Minus).
- Keine neuen Abhängigkeiten ohne Grund; Charts sind handgeschriebenes SVG.

## Noch offen (Auszug)

- Erste Verifikation gegen echtes MSFS (siehe `docs/sim-pc-checklist.md`): Touchdown-Vorzeichen, `SIM_FRAME`-Rate, `TT:`-Tokens im ATC-Model, Pushback-Erkennung.
- X-Plane-Provider (Web-API 12.1+, später eigenes Plugin), P3D best effort.
- Weitere UI-Schritte: Jahresrückblick, Final-Countdown mit Live-Runway-Zuordnung.
