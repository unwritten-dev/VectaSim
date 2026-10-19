# VectaSim – Development

Technical documentation for everyone working on the code. The user’s view is in the [README](README.md) (German: [README.de.md](README.de.md)) and in [docs/installation.md](docs/installation.md); both deliberately stay free of development details. Releases: [docs/releasing.md](docs/releasing.md); first test against real MSFS/X-Plane: [docs/sim-pc-checklist.md](docs/sim-pc-checklist.md).

## Stack

- **Desktop shell:** Tauri v2 (Rust backend, WebView2 frontend), Windows first.
- **Frontend:** React 19 + TypeScript, Vite, MapLibre GL JS 6, Vitest. No UI library – own components in `app/src/ui/`, design tokens as CSS variables, six switchable themes in `app/src/themes.ts`.
- **Backend:** Rust workspace, SQLite 3.53.2 (rusqlite 0.40, bundled; the test `bundled_sqlite_is_new_enough` requires ≥ 3.50.2), reqwest (rustls).

## Structure

```
Cargo.toml                  Rust workspace
crates/vectasim-core        telemetry model, SimProvider trait, MockProvider/MockFlight,
                            PhaseEngine, TouchdownDetector, FlightSession, landing analysis
crates/vectasim-simconnect  SimConnect provider (SimConnect.dll via libloading, no SDK import lib),
                            shared decoder, replay provider, probe tool (src/bin/vectasim-probe.rs)
crates/vectasim-xplane      X-Plane 12 provider via the Web API (REST + WebSocket, localhost:8086):
                            dataref list/slots, decoder, replay player for `source: "xplane"`, fake-server tests
crates/vectasim-dump        raw telemetry dump (.vsdump): format, recorder (file + RAM ring), reader
crates/vectasim-store       SQLite logbook: schema/migrations, FlightRecorder, track codec,
                            airframes, exports (CSV/GPX/KML/JSON)
crates/vectasim-data        embedded OurAirports data (airports, runways) with bbox/nearest search; country list + Natural Earth borders (`countries`)
crates/vectasim-simbrief    SimBrief OFP fetcher (JSON v2) and reduced OFP model
crates/vectasim-online      VATSIM feed (15 s poller with backoff), IVAO Whazzup, METAR client and decoder
crates/vectasim-photos      Planespotters photo client with cache
crates/vectasim-server      local HTTP/WebSocket server (axum): JSON API v1, OBS overlays (overlay/),
                            access rules (auth.rs), events from snapshots (watch.rs), demo example
app/src-tauri               Tauri backend: commands, ProviderManager/forwarder, updater, landing command
app/src-tauri/windows/hooks.nsi  NSIS installer hooks (offer the SimConnect download after installation)
app/src                     frontend (live/, landing/, map/, airframes/, ui/, i18n/)
scripts/update-airports.py  updates the embedded OurAirports CSVs
scripts/update-countries.py updates the country list and country borders (Natural Earth, CLDR names)
.github/workflows           ci.yml (Clippy, tests, cargo audit, ESLint, tsc, Vitest), release.yml (tag v* → signed installer)
```

## Prerequisites

- Rust via `rustup` (MSVC target), Visual Studio Build Tools 2022 with the C++ workload, WebView2 (included in Windows 10/11). The compiler version is pinned in `rust-toolchain.toml` (currently 1.99.1); `rustup` installs it by itself on the first `cargo` call in the repo. To bump it: change the file + run Clippy.
- Node.js 22
- For real sim data, a `SimConnect.dll` (search order see `docs/installation.md`, origin see “SimConnect.dll” below); without a sim, everything runs against the mock – which never loads the DLL.

## Developing

```bash
cd app && npm ci
```

Mock flight (no simulator; flies a circuit at EDDF 25C with a clean 3° approach; `VECTASIM_MOCK=bounce` for a bounced landing, `VECTASIM_MOCK=goaround` for a go-around at 300 ft with a second circuit):

cmd:

```bat
cd app && set "VECTASIM_PROVIDER=mock" && npm run tauri dev
```

PowerShell:

```powershell
cd app; $env:VECTASIM_PROVIDER="mock"; npm run tauri dev
```

With a simulator: `npm run tauri dev` without the variable. Dev logs with `RUST_LOG=info`.

Simulator selection: without a variable, *Settings → Simulator* applies (default `auto`: SimConnect first, X-Plane if no MSFS is there for 10 s or the DLL is missing and an X-Plane Web API responds; logic in `app/src-tauri/src/simselect.rs`). `VECTASIM_PROVIDER=simconnect|xplane|auto|sim|mock|replay` fixes it for the run; X-Plane endpoint `VECTASIM_XPLANE_HOST` / `VECTASIM_XPLANE_PORT` (default `localhost:8086`).

**X-Plane provider** (`crates/vectasim-xplane`): `GET /api/capabilities` (version, API v2 preferred) → `GET /api/v2/datarefs?filter[name]=…` (IDs) → WebSocket `/api/v2`, one `dataref_subscribe_values` per dataref (otherwise one failed subscription would take down all datarefs of its request) → `dataref_update_values` at 10 Hz, changed values only. Numeric datarefs are kept as a fixed slot list (arrays: element 0…n−1); that is also the raw format in the `.vsdump` (`source: "xplane"`, `data` with `req` 1, `null` = not in this message; strings `req` 3). Tests run against a fake Web API server (`src/tests.rs`, fixture `tests/fixtures/webapi-session.json`); the replay (`vectasim_simconnect::replay::AnyPlayer`) picks the decoder by `source`.

### Building from source

Your own installer without a signing key (the updater artifact must then be turned off):

```bat
cd app
npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"
```

```powershell
cd app
npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Result: `target\release\bundle\nsis\VectaSim_<version>_x64-setup.exe` (relative to the repo root, not to `app/`). An installer built this way works normally; only the auto-update signature is missing.

The installer includes `app/src-tauri/windows/hooks.nsi` (`bundle.windows.nsis.installerHooks`; macros `NSIS_HOOK_POSTINSTALL` etc. from Tauri’s `installer.nsi`; the generated version is under `target\release\nsis\x64\` after the build). The file must stay UTF-8 **with BOM**, otherwise `makensis` reads the umlauts as ANSI. Silent test: `VectaSim_<version>_x64-setup.exe /S` (installs per user to `%LOCALAPPDATA%\VectaSim\`, asks nothing and downloads no DLL); passive like the updater: `/P`. The SimConnect question only appears in the normal, interactive installation.

### Raw dump, replay and probe tool (reproducing errors from the sim PC)

**Recording (sim PC):** *Settings → Diagnostics → Record raw dump* writes one `%LOCALAPPDATA%\io.vectasim.app\dumps\<YYYYMMDD-hhmmssZ>.vsdump` per SimConnect session (next to `logs\`). Regardless of the switch, the app keeps the last 30 min in RAM (≤ 64 MB, in practice ≈ 4 MB); *Save dump now* writes them as `dumps\ring-<time>.vsdump`. Recording happens in the SimConnect session dispatch **before** any interpretation – so decoder errors (units, indices, BCD) stay reproducible.

**Format `.vsdump`** (version 1; details in `crates/vectasim-dump/src/lib.rs`): zstd-compressed NDJSON (also several concatenated zstd frames; uncompressed NDJSON is read as well).

- Line 1 `{"type":"header","format":1,"app",…,"source":"simconnect","sim","simVersion","simconnect","dll","defs":{"fast":[[name,unit]…],"slow":[…],"static":[…],"approach":[…],"design":[…]},"reqs":{"approach":4,"design":5,"fast":1,"slow":2,"static":3},"inactive":{…},"startedWallMs"}`
- Definitions: `fast` (SIM_FRAME), `slow` (1 Hz), `static` (strings, once per aircraft), `approach` (1 Hz, track v2: `AMBIENT WIND VELOCITY/DIRECTION`, `NAV HAS LOCALIZER/HAS GLIDE SLOPE/GS FLAG/GLIDE SLOPE ERROR/CDI/RADIAL ERROR/RAW GLIDE SLOPE/LOCALIZER:1`, `AUTOPILOT MASTER/APPROACH HOLD/GLIDESLOPE HOLD/MANAGED THROTTLE ACTIVE/THROTTLE ARM`, `TURB ENG N1:1..2`, `GENERAL ENG THROTTLE LEVER POSITION:1`, `SPOILERS HANDLE POSITION/ARMED/LEFT POSITION`, `INCIDENCE ALPHA`, `FLAPS NUM HANDLE POSITIONS`) and `design` (once per aircraft, again after `AircraftLoaded`: `DESIGN SPEED VS0/VS1` in kt, `VC` requested in ft/s and converted). `approach`/`design` are additive (still format 1): older dumps don’t have them and play back unchanged (fields `None`), older builds ignore them. A rejected variable only drops out of its own definition; in `approach` it then reads `None` (not “last value”). ILS deviations only count while the station has the component (`NAV HAS LOCALIZER/GLIDE SLOPE`).
- After that, one `{"t":<ms monotonic>,"w":<wall clock ms>,"k":…}` per message with `k` = `data` (`req` + `v` raw f64 or `s` strings; NaN → `null`), `event` (`id` = name, `data`), `filename` (`id`, `path`), `exception` (`code`, `sendId`, `index`, mapped `call`/`def`/`var`, `dropped`), `open` (sim and SimConnect version), `quit`, `hr` (`fn`, `hr`), `systemState` (`req`, `int`), `end` (`reason` of the session).
- Compaction: between keyframes, a `dv` replaces `v` – the difference of the IEEE 754 bit patterns to the previous `data` of the same `req` (lossless). A keyframe at the start of every file/ring chunk and at least once per second. The reader always returns `v`. Result: 60 Hz × 17 FAST values ≈ 7–8 MB/h (test `sixty_hz_fast_stays_below_10_mb_per_hour`).
- A truncated file (app closed) is readable up to the last second (flush once per second).

**Playback (dev PC):** copy the dump file from the sim PC, then

```powershell
cd app; $env:VECTASIM_PROVIDER="replay"; $env:VECTASIM_REPLAY="C:\path\20261017-140322Z.vsdump"; $env:VECTASIM_REPLAY_SPEED="10"; npm run tauri dev
```

```bat
cd app && set "VECTASIM_PROVIDER=replay" && set "VECTASIM_REPLAY=C:\path\20261017-140322Z.vsdump" && set "VECTASIM_REPLAY_SPEED=10" && npm run tauri dev
```

`VECTASIM_REPLAY_SPEED`: default `1`, `0` = as fast as possible; `VECTASIM_REPLAY_LOOP=1` repeats. Short form `VECTASIM_PROVIDER=replay:<file>`. Alternatively, in the running app *Settings → Diagnostics → Replay*: choose a file, speed, *Start replay*/*Stop replay* (back to SimConnect). The replay provider sends `Connected { sim_name: "Replay <file>" }` and feeds the lines through **the same decoder** as the live session (`crates/vectasim-simconnect/src/decoder.rs`); if the dump’s definitions no longer match the build, values are mapped by SimVar name. Time: `Telemetry.timestamp_ms = start + (t − t₀)` in *recorded* milliseconds, playback pace `(t − t₀)/speed` – so the engine sees exactly the recorded timeline (dwells behave as live, they just run ten times faster at factor 10). Start = wall clock at replay start; with `0`, the recorded wall clock (deterministic, for tests). Replay flights land in the logbook with provider `replay`.

**Creating a dump without a sim:** `cargo run -p vectasim-simconnect --example mock-to-vsdump -- out.vsdump [--variant bounce] [--from 0] [--to 600] [--hz 60]` (mock flight → raw values, inverting the decoder conversions). Without options, this produces the fixture `crates/vectasim-core/tests/fixtures/mock-circuit.vsdump` (60 s of final approach + landing + 20 s of rollout, full 60 Hz); the test `the_fixture_is_what_the_generator_produces` reports when it needs to be regenerated. Trimmed dumps from the sim day go into the same folder, with a golden test next to them (`replay::replay_file` returns the `ProviderEvent`s with a simulated clock).

**Live raw data:** *Settings → Diagnostics → Live raw data* (collapsed) shows every definition (FAST/SLOW/STATIC) with SimVar, unit, raw value, converted value, age and rate per request, the last 100 events/exceptions with name and mapped SimVar, the engine internals (`FlightSession::debug_state`) and connection info. Data path: command `diagnostics_snapshot` + event `diag:raw` (2 Hz, only while the view is open: `set_diag_stream`). Mock: no raw definitions (“–”).

**Probe tool** (Windows only, not bundled): connects with the same definitions and the same session code as the app, writes raw values once per second plus every event, every exception and every log line to the console and to `probe.log`, optionally a dump:

```powershell
cargo build -p vectasim-simconnect --bin vectasim-probe --release
target\release\vectasim-probe.exe --dump probe.vsdump --log probe.log [--index 0] [--seconds 600]
```

If the app breaks on the sim PC, the probe shows whether the problem is in SimConnect or in the app logic; its dump can be played back like any other.

### Tests and checks

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cd app && npm run lint && npx tsc --noEmit && npm test
```

CI (`.github/workflows/ci.yml`) runs these steps, Cargo with `--locked` (an outdated `Cargo.lock` fails the run, as does `npm ci` with an outdated `package-lock.json`), plus `cargo audit` against the RustSec database (vulnerabilities fail the job, “unmaintained” notices are only printed). All actions are pinned to commit SHAs.

Tools:

- **ESLint** (`app/eslint.config.js`, flat config): typescript-eslint “recommended” without type information plus the two classic hooks rules (`rules-of-hooks`, `exhaustive-deps`, both as errors). Unused `eslint-disable` comments are errors – so a disable needs a real hit and should be justified. The React Compiler rules of `eslint-plugin-react-hooks` ≥ 6 are deliberately not enabled.
- **rustfmt** (`rustfmt.toml`: `max_width = 140`, `use_small_heuristics = "Max"`) describes the existing style. The tree is not fully formatted with it yet (≈ 130 places differ); please format new files with it (`rustfmt --edition 2024 <file>`). Once `cargo fmt --all` has been run over the whole workspace, `cargo fmt --all --check` goes into CI.
- **Golden files** of the exports are in `crates/vectasim-store/tests/golden/`. An intended format change regenerates them: `UPDATE_GOLDEN=1 cargo test -p vectasim-store --test export_golden_tests`; then review the file diff like code.

## Architecture in brief

- **Provider → channel → forwarder.** Every sim provider runs on its own thread and pushes `ProviderEvent`s (telemetry at native rate, aircraft, sim events, status). The `ProviderManager` (`app/src-tauri/src/manager.rs`) keeps one `FlightSession` and one `FlightRecorder` per connection, throttles telemetry for the webview to 10 Hz (hidden window: 1 Hz, see “Performance”) and emits `sim:*` events.
- **Flight phases** (`crates/vectasim-core/src/phase.rs`): 12 phases, time-based hysteresis, samples during pause/slew/time acceleration are ignored; “on the ground” only if AGL ≤ 50 ft (or GS ≤ 200 kt without AGL) – the thresholds are in the file header.
- **Time base** (`crates/vectasim-core/src/clock.rs`): `Telemetry.timestamp_ms` stays wall clock (display, logbook, track). Phase dwells, touchdown windows, pauses and distance integration run on a monotonic clock (`MonoClock`): if the system clock jumps back, that counts as Δt = 0 (`clock_jump` in the log, `clockJumps` in the debug state) instead of stalling phase detection until the clock reaches the old value again. Time acceleration (sim rate ≠ 1) is treated the same way in the phase engine and the touchdown detector: both skip those samples; a landing made under time acceleration appears in both at the first real-time sample on the ground (rate then from the sim value), and the flight carries `time_acceleration_detected`.
- **Touchdown** (`touchdown.rs`): ring buffer on the full stream; landing rate = sim value (`PLANE TOUCHDOWN NORMAL VELOCITY` × 60) with a fallback to the last airborne vertical speed, worst of bounces within one event, debounce over several ground samples, first contact as time/position. Touch-and-gos are stored but never count as the flight’s landing.
- **Approach rating** (`crates/vectasim-core/src/approach.rs`): pure functions over track (1 Hz) + phases + touchdowns + runway candidates; finds approach attempts including go-arounds, assigns the runway even without a touchdown, rates gates (10 nm, FAF proxy, 1000, 500, 50 ft) and continuous criteria (EASA two-stage with minimum duration, outliers < 3 s don’t count) and returns “stable from”, bands, stability measures, lateral tracking (`lateral`: its own band by VectaSim convention; not rated with a derived runway via `apply_runway_geometry`), energy proxy. Results per approach in `approach_facts` (schema 8, versioned, lazy + at flight end). **Stage 2 (track v2, everything `Option`):** the simulator’s ILS becomes the reference if the glide slope was valid for ≥ `ils_min_share` (60 %) of the samples 1000 → 200 ft (`HAS_GLIDE_SLOPE` + `GLIDE_SLOPE_VALID`) and the median deviation from the geometry is ≤ `ils_reject_gs_deg` (otherwise “foreign ILS”, geometric); angle from `gs_angle_deg`, dots from `gs_error_deg / gs_dot_deg` or `−loc_cdi / 127 × loc_full_scale_dots`. Geometry and sim are always both computed (`ApproachProfilePoint::gs_dots_sim/geo`, `loc_dots_sim/geo`, metrics in `IlsStats`); `ApproachReference::glidepath_source`/`localizer_source` says what the criteria use. In addition `WindStats` (sim wind 1000 → 50 ft), the criteria `LandingFlaps` (gate; `AircraftRef::landing_flaps_index` from the airframe → `flap_positions − 1` → setting at touchdown), `Thrust` (N1, only if anywhere > `n1_valid_min_pct`) and `Spoilers` (both also as continuous specs with minimum duration), `EnergyBand` 10 nm → 1000 ft on final, `AutomationStats` (informational only) and the Vapp cascade user → flown → `Design` (VS0 × 1.3). VS0 and flap positions come from the track via `app/src-tauri/src/approach.rs`, Vapp/landing flaps from the airframe (`Store::flight_airframe_refs`). v1 tracks (`nav_recorded` false, no N1/wind values) fall back exactly to stage 1. Tests: `crates/vectasim-core/tests/approach_tests.rs` (v2 mock standard/go-around, synthetic approaches with/without ILS, foreign ILS, wind, thrust, spoilers, cascade), frontend `app/src/landing/approachStage2.test.tsx`; approach card `ApproachCard.tsx` + `exportApproachCard.ts` (autosave in `autoSaveCard`).
- **Landing analysis** (`landing.rs`): pure functions over track + touchdown + runway (OurAirports thresholds) + METAR wind: touchdown point relative to the threshold, centreline offset, touchdown zone, glide path against 3°, flare, rollout, stabilised approach gates at 1000/500 ft. The “VectaSim index” (0–100) is formed in the frontend from bands (`app/src/landing/facts.ts`, formula visible under “Methodik”, methodology).
- **Store** (`crates/vectasim-store`): SQLite in WAL mode at `%APPDATA%\io.vectasim.app\vectasim.db`, migrations in `store.rs` (`schema_version`), tracks as column-wise delta/varint + zstd (~10 bytes/sample; format in `track.rs`: **track v2** = the 16 base columns, a presence bitmask per sample and 17 optional columns – TAS, magnetic heading, sim wind, ILS deviations/angle/course, `nav_flags` (bits from `approach::nav_flags`: LOC, GS, GS valid, AP, APPR, G/S, A/THR, spoilers armed), N1, spoiler surface/lever, alpha, flap positions, VS0/VS1; the encoder always writes v2, the decoder reads v1 and v2, missing values are `None`; mock circuit ≈ 8.5 bytes/sample), flush every 15 s (`FLUSH_INTERVAL_MS` in `recorder.rs`); a flight left open by a crash is marked incomplete at the next start.
- **Map** (`app/src/map/`): the OpenFreeMap style is loaded once, patched per theme (`basemap.ts`) and cached; own layers: airports, airport diagram (OSM `aeroway`), track, planned route, VATSIM/IVAO traffic/ATC, METAR badges, own aircraft (silhouette by wake turbulence category). After a theme change, the style is set again and the layers are recreated.
- **Themes** (`app/src/themes.ts`): token sets are written as CSS variables on `:root`; `theme.ts` provides the map colours live. Rule: no violet/magenta (tests check this), own aircraft always `#ffd54a`, text/surface contrast ≥ 4.5:1.
- **Events to the frontend:** `sim:status`, `sim:telemetry`, `sim:flight`, `sim:flight-event`, `sim:aircraft`, `sim:event`, `sim:stats`, `diag:raw`, `online:summary`, `logbook:changed`, `dispatch:ofp`, `theme:changed`.
- **Overlay & API** (`crates/vectasim-server`, app integration `app/src-tauri/src/server.rs`, docs [`docs/overlay-api.md`](docs/overlay-api.md)): off by default; its own thread with a single-threaded Tokio runtime, reads via the `Source` trait (manager snapshot, store, settings) in the blocking pool and polls at 2 Hz only while WebSocket clients are connected – nothing hangs in the live path. Events (`phase`, `landing`, `flightSaved`, `status`) are derived from consecutive snapshots (`watch.rs`). Settings `server_enabled`, `server_port`, `server_lan`, `server_token` in `settings`. Without the app: `cargo run -p vectasim-server --example demo [port] [--lan] [--privacy]`.
- **Security of the local server** (`auth.rs`): without the LAN switch only `127.0.0.1`; with LAN `0.0.0.0` and a mandatory token (24 characters from OS randomness, constant-time comparison) for all non-loopback peers; token-free only with a loopback peer **and** a loopback `Host` (against DNS rebinding); `Origin` only own/loopback origin or OBS (`http://absolute`), otherwise 403 – also during the WebSocket handshake; only GET/HEAD/OPTIONS; strict CSP on the pages; streamer mode masks all responses like the UI. Tests: `crates/vectasim-server/src/{auth,api,routes,watch}.rs`, `tests/server.rs` (routing, token, masking, JSON golden, WS handshake, port in use).
- **Decoder / replay** (`crates/vectasim-simconnect/src/decoder.rs`, `replay.rs`): the interpretation of the SimConnect raw values (conversions, events → `ProviderEvent`, exception texts) is a `Decoder` without FFI and without a clock; the live `Session` and the `ReplayProvider` share it. Raw recording: `vectasim-dump::DumpRecorder` (see above).

### Export format `.vectasim` (full export, `crates/vectasim-store/src/bundle.rs`)

- ZIP; `manifest.json`: `format` (1), `app`, `appVersion`, `schemaVersion`, `createdMs`/`createdUtc`, counters (`flights`, `flightsDeleted`, `tracks`, `airframes`, `images`), `trackEncoding` (`vstk1`). A reader rejects a higher `format`; a newer schema is only a hint.
- `flights.jsonl`: one line per flight – `flight` (all columns of `flights` under their SQL name, including `deleted_ms`, plan, METAR and airframe fields), `touchdowns` and `phaseEvents` (rows without the local `id`/`flight_id`), `track` (`file`, `previewFile`, `sampleCount`, `encoding`, `updatedMs`).
- `tracks/<flight_id>.bin` and `tracks/<flight_id>.preview.bin`: the blobs raw as in the DB (zstd, codec as per `encoding`), stored uncompressed in the ZIP.
- `airframes.jsonl`: `airframe` (all columns of `airframes`) and `imageFile` for your own images; `images/<registration>.<ext>` (jpg/jpeg/png/webp/gif, ≤ 15 MB).
- Not included: `landing_facts`, `approach_facts` (cache, recalculated), settings; the app does not export demo/replay flights.
- Import: unknown columns are skipped, missing ones get their defaults; only the listed entries are read, with a size limit (no extraction by entry name). A flight in state `active` arrives as `interrupted`.
- Merge: same `id`, or same `dep_icao`/`arr_icao` with |Δ `off_block_ms`| < 15 min (trash included) = duplicate; airframes only fill empty fields, an image only if there is none; one transaction per 100 flights.
- Replace: first `create_backup(PreImport)` (`vectasim-pre-import-…`), then delete and insert in **one** transaction; no replace without a backup.

## Data and licenses

| Source | Use | License |
|---|---|---|
| OurAirports | airports/runways embedded (`crates/vectasim-data/data`), continent per country | public domain |
| Natural Earth 1:110m Admin-0 | country borders for the *Countries* view (`countries.geojson.zst`) | public domain |
| Unicode CLDR | country names German/English (`countries.csv`) | Unicode License v3 |
| OpenFreeMap / OpenMapTiles / OpenStreetMap | basemap vector tiles | ODbL – attribution stays visible |
| aviationweather.gov (NOAA) | METAR | public domain; own user agent, ≤ 60 req/min, 10 min cache |
| VATSIM data feed v3 | traffic/ATC | only with traffic on, never more often than every 15 s |
| IVAO Whazzup v2 | traffic/ATC | only with IVAO traffic on, at most one request every 15 s |
| SimBrief (Navigraph) | OFP fetch on request | Navigraph Developer Terms |
| Planespotters.net | aircraft photos by registration | credit + link required, ≤ 1 req/s, 7-day cache |
| SimConnect.dll | **not** bundled, loaded at runtime; fetched on click from Microsoft’s SDK download (see below) | MSFS SDK EULA |

Deliberately not used: Navigraph charts/FMS data (embedding not allowed), RainViewer (private use only from 2026), OpenAIP (CC BY-NC).

### SimConnect.dll (origin, updating)

The DLL is **not** in the repo and not in the installer (the installer only downloads it from Microsoft’s server on request, see below): the MSFS SDK EULA only allows redistribution of “distributable code” without naming SimConnect.dll as such; enquiries to Microsoft have gone unanswered. There is no Microsoft NuGet package.

Instead, `app/src-tauri/src/simconnect_dl.rs` (commands `simconnect_download_info`, `download_simconnect`, event `simconnect-download` with `{phase, received, total}`): on click, downloads the pinned ZIP of the MSFS 2020 SDK Core from `sdk.flightsimulator.com` via `%SystemRoot%\System32\curl.exe` (HTTPS only), checks size + SHA-256, takes out `cab1.cab`, extracts only the DLL with `expand.exe -F:<MSI file key>`, checks its SHA-256 and stores it as `%LOCALAPPDATA%\io.vectasim.app\simconnect\SimConnect.dll` (+ `SOURCE.txt`). The MSI is never run. According to Microsoft/Asobo, the 2020 DLL also works with MSFS 2024; the 2024 SDK ZIP would be ~620 MB.

The same download also runs without a window (for the installer, `app/src-tauri/windows/hooks.nsi`): `vectasim.exe --install-simconnect` is intercepted in `run()` **before** the Tauri builder (no single-instance handover, a running app is left alone). Exit codes: `0` DLL downloaded and verified or already present, `2` download failed/no network, `3` checksum mismatch, `1` otherwise. `--install-simconnect --check` downloads nothing: `0` if the loader would find a DLL (search order from `ffi::candidate_paths`; the downloaded one only counts with a matching SHA-256), otherwise `1` – the file chosen in *Settings → Simulator* is stored in the database and is not read here. Every call appends a line with a UTC timestamp (source, SHA-256, duration or error) to `%LOCALAPPDATA%\io.vectasim.app\logs\simconnect-install.log` and writes it to stderr (in the release build only visible when redirected: `vectasim.exe --install-simconnect 2> out.txt`). The installer only asks interactively (not with `/S` or `/P`, so also not during auto-update) and does not abort on an error.

Current: SDK Core **0.24.6.0**, ZIP 113 306 986 B, SHA-256 `6daaa1fa45598d890d17b1c8347cd736e529c83bfc00630fcefe8822500eaf3f`; DLL 67 072 B, SHA-256 `cffb74b62b596a897b0ff101bac3d66ea10236c540c75864658b451ffd1e6513`, MSI file key `filtEQeYbpLedi0MhYth1bxHyr8SqE` in `cab1.cab`.

Pinning a new SDK version:

1. Take the newest entry in `https://sdk.flightsimulator.com/files/sdk.json` (`game_versions[0].downloads_menu["SDK Installer (Core)"]`), download the ZIP into an empty folder, note the size and `sha256sum`.
2. Take the `.msi` out of the ZIP and read the `File`/`Media` tables (PowerShell, COM `WindowsInstaller.Installer`, `SELECT File, FileName, Sequence FROM File` and `SELECT DiskId, LastSequence, Cabinet FROM Media`): the key of the row `…|SimConnect.dll` with the 64-bit size in the `lib` folder (not `Microsoft.FlightSimulator.SimConnect.dll`), the cabinet from the sequence.
3. `expand.exe -F:<key> <cab> <out>` → DLL size and SHA-256; the PE machine must be `0x8664`.
4. Replace the constants at the top of `simconnect_dl.rs`, then `VECTASIM_TEST_SDK_ZIP=<zip> cargo test -p vectasim --lib simconnect_dl -- --ignored` (end-to-end extraction), and connect on the sim PC with 2020 and 2024.

### Airport index (precompiled)

The source remains `crates/vectasim-data/data/{airports,runways}.csv` (update with `python scripts/update-airports.py`). The crate’s `build.rs` translates them on every `cargo build` into `OUT_DIR/airports.vsad` (build artifact, not in the repo); `include_bytes!` embeds it. Format (`src/binfmt.rs`, little-endian):

1. Header: `VSAD`, version byte (`binfmt::VERSION`, bump on every layout change), counters (airports, runways, groups, grid entries, string table).
2. String table: all texts deduplicated back to back (UTF-8); fields refer to them with (offset u32, length u16).
3. Airports and runways as fixed-size records (57 / 90 bytes; coordinates as f64, missing values via bitmask) – random access without an offset table.
4. Runway groups per airport (start, count), sorted by ident; plus the airport permutation sorted by ident (binary search instead of a HashMap).
5. Dense 1° grid (181 × 361 cells) as prefix offsets + airport indices – bbox/nearest without setup work.
6. `load()` only checks the header, size and index arrays and decodes records on access (`OnceLock`); if the blob doesn’t fit (version, size, indices), the embedded CSVs are parsed (same result, ~230 ms). The test `precompiled_index_matches_csv` compares every record.

Load time (`cargo test -p vectasim-data --release -- --ignored --nocapture load_benchmark`): previously CSV parsing ~125 ms (release) / ~600 ms (debug), now ~2 ms / ~25 ms; the first world view query (`in_bbox` over everything, 500 hits) ~16 ms.

### Countries (embedded)

`crates/vectasim-data/data/countries.csv` (iso2, continent, German/English name; 249 ISO 3166 codes + `XK`) and `countries.geojson.zst` (Natural Earth 1:110m Admin-0, only the property `iso2`, coordinates rounded to 0.01°, zstd level 19: ≈ 165 KiB GeoJSON → ≈ 42 KiB) are generated by `python -I scripts/update-countries.py [download-dir]` (Python 3.14+, standard library only). Special cases in the script: `ISO_A2` “-99”/“CN-TW” → `ISO_A2_EH` (France, Norway, Kosovo, Taiwan), Northern Cyprus → CY, Somaliland → SO (this is how OurAirports assigns their airports), French Guiana (GF) split out of France and Svalbard (SJ) out of Norway. Microstates without an outline at 1:110m (e.g. Singapore, Malta) appear on the map only via the airport dots, in the list as normal.

Counting (`vectasim_data::countries::visited_countries`, command `visited_countries` in `app/src-tauri/src/countries.rs`): `list_flights` (without trash) → `state = completed`, `arr_icao` set, provider `mock`/`replay` only with `include_demo` → `country` (OurAirports `iso_country`) of the arrival airport; date = `landing_ms`, otherwise `on_block_ms`. Unknown airports and codes outside the list (`ZZ`, `XP`) don’t count. The view loads the list and borders once (`countries_list`, `countries_geojson` as raw bytes) and the count again on `logbook:changed`.

### Performance (background, SimConnect)

- **Hidden window:** the frontend reports `invoke("set_ui_visible", { visible })` on `visibilitychange`/minimise/tray. While hidden: `sim:telemetry` (and the periodic `sim:flight`) at 1 Hz, `sim:stats` at 0.2 Hz, `diag:raw` off; event-driven events (`sim:status`, `sim:flight-event`, `sim:aircraft`, `logbook:changed`) and `FlightSession`/recorder keep running unchanged on the full stream.
- **Incremental live track:** `invoke("get_live_track_since", { tsMs })` returns only samples with `t_ms > tsMs`; after `flightStarted` or a provider change, start again with `get_live_track` (the buffer is then replaced or cleared).
- **SimConnect pump:** `SimConnect_Open` gets an auto-reset event (`CreateEventW`); with an empty queue the thread waits with `WaitForSingleObject` for at most 100 ms (stop flag and watchdog stay effective) instead of polling every 2 ms. Without an event (creation failed), the old polling remains.

## Security

**Content Security Policy** (`app/src-tauri/tauri.conf.json` → `app.security.csp`). It applies to the built webview; `tauri dev` loads the Vite server directly and runs without CSP on the desktop – CSP problems therefore only show up in `npm run tauri build` (or the installer). Network requests from Rust (reqwest: METAR, VATSIM, IVAO, SimBrief, Planespotters API, updater) are not subject to the CSP and are therefore deliberately **not** listed in it. Sources:

| Directive | Source | What for |
|---|---|---|
| `default-src` | `'self'` | everything not listed only from the app bundle |
| `script-src` | `'self'` | bundled JS; Tauri adds hashes for its own inline scripts itself. No `'unsafe-eval'`: MapLibre GL 6 doesn’t need it |
| `style-src` | `'self' 'unsafe-inline'` | Vite CSS bundle. `'unsafe-inline'` is a safeguard for `style` attributes in HTML strings (MapLibre popups via `setHTML`, libraries that use `setAttribute("style")`); React and MapLibre styles via the CSSOM are allowed anyway. `dangerousDisableAssetCspModification: ["style-src"]` prevents Tauri from appending nonces – with a nonce, the browser would ignore `'unsafe-inline'` |
| `img-src` | `'self' asset: http://asset.localhost` | your own aircraft images via the asset protocol (`convertFileSrc`, scope restricted at runtime to the app’s image folder, `airframes.rs`) |
| | `data: blob:` | SVG icons on the map (`aircraftIcons.ts`), landing card as PNG (`exportCard.ts`), MapLibre rasters from blobs |
| | `https://tiles.openfreemap.org` | Natural Earth raster tiles of the basemap style |
| | `https://*.plnspttrs.net https://*.planespotters.net` | Planespotters photos (hotlink, thumbnails on `t.plnspttrs.net`) |
| `font-src` | `'self' data:` | bundled `@fontsource` fonts |
| `connect-src` | `'self' ipc: http://ipc.localhost` | Tauri IPC (commands, events) |
| | `https://tiles.openfreemap.org` | style JSON (`basemap.ts`), vector tiles, glyphs, sprites – all on this host (checked against the style `styles/dark`) |
| `worker-src` | `'self' blob:` | MapLibre worker. Since MapLibre 6 it is a separate file bundled by Vite (`app/src/map/maplibreWorker.ts`: `?worker&url` + `setWorkerUrl`, same origin) – `blob:` is no longer needed for it and can be dropped after a test in the installer |
| `object-src` / `base-uri` / `form-action` | `'none'` / `'self'` / `'none'` | hardening, none of these is needed |

New remote content in the webview (e.g. another map provider) needs an entry here and in the table.

**MapLibre GL JS** is on 6.x (from 6.12.0): 5.x had [GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579) (XSS bypass in `DOM.sanitize`). The popups (`app/src/map/online.ts`) still escape all values themselves (`esc`) before they go through `setHTML` – never put feed data (VATSIM, IVAO, METAR) unescaped into HTML strings. CI checks the production dependencies with `npm audit --omit=dev --audit-level=high` (high/critical fail the job). MapLibre 6 is ESM-only (`import * as maplibregl`), loads the worker via `setWorkerUrl` (see above) and no longer ships the global `GeoJSON` namespace (`app/src/map/geojson.d.ts`).

**Paths from the webview** (`data::check_path`): `save_export`, `export_logbook_csv`, `save_image`, `export_bundle` and `create_diag_package` only write to paths that are absolute, contain no `..`, have the matching extension (format extension `.csv/.gpx/.kml/.json`, `.png`, `.vectasim`, `.zip`) and are not under `%WINDIR%`, the program folders (`ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`) or the app’s installation folder – otherwise the error “path not allowed”. `import_bundle`/`read_bundle_manifest` check absolute, no `..`, extension `.vectasim`.

**Exports:** free-text cells in the logbook CSV (aircraft title, callsign, ICAO, provider …) that start with `=`, `+`, `-`, `@`, tab or CR get a `'` prefix (CSV/formula injection); number cells stay unchanged (`export.rs`). **Track blobs** are treated as untrusted: at most 200 000 samples, the sample count in the header must match the blob length, and decompression is bounded – a broken entry returns an error instead of running out of memory (`track.rs`).

## Conventions

- Rust: doc comments explain the *why*; `unsafe` only in the SimConnect FFI with a `SAFETY` comment; Clippy without warnings.
- Frontend: serde fields camelCase, types mirrored in `app/src/types.ts`; UI texts through i18n (German reference, English second – see “Languages” below), flight phases in English; numbers via `format.ts` / `i18n/number.ts` (UTC with “z”, thousands separators, a real minus sign).
- No new dependencies without a reason; charts are hand-written SVG.
- **Languages of the project:** the app is bilingual German/English; the public documentation (README, `docs/installation.md`, `docs/overlay-api.md`, `docs/releasing.md`, `docs/sim-pc-checklist.md`, this file, `CHANGELOG.md`) is written in English.
- **README pairs:** [README.md](README.md) (English) and [README.de.md](README.de.md) (German) list the same features and are updated together on every feature change – same sections, same feature list.
- **CHANGELOG:** new entries in English under `## Unreleased`, one line per change.

## Still open (excerpt)

- First verification against real MSFS and X-Plane (see `docs/sim-pc-checklist.md`): touchdown sign, `SIM_FRAME` rate, `TT:` tokens in the ATC model, pushback detection.
- X-Plane: own plugin later (higher data rate, touchdown value); P3D best effort.
- Further UI steps: final countdown with live runway assignment.

## Languages (i18n)

German is the reference language, English the second one. An own lean solution without dependencies in `app/src/i18n/` (bundled JSON resources; keys typed from `de/*.json` – one file per area, merged in `de/index.ts`; plurals via `Intl.PluralRules`, number format as in `format.ts`). The language follows the setting `language` and switches live (no reload). All views are migrated; `npm run i18n:extract` lists the few remaining literals (mostly German fallbacks behind getters, e.g. theme moods in `themes.ts`).

- **Usage:** in components `const t = useT();` → `t("nav.map")`; outside React (toasts, `errors.ts`, stores) `import { t } from "./i18n"`. `I18nProvider` sits in `main.tsx`; `<I18nProvider lang="en">` pins a subtree to one language (preview, tests).
- **Label tables and constant strings (live binding):** module-level lookups must not freeze the language at import time. Tables such as `BAND_LABEL`, `APPROACH_BAND_LABEL`, `LATERAL_BAND_LABEL` (`landing/facts.ts`, helper `labels(keys, k => t(…))`) are plain `Record`s whose properties are getters that call `t()` on every access; theme names/moods in `themes.ts` work the same way. Exported constant sentences (`VS_BANDS`, `G_BANDS`, `LATERAL_REASON` …) are `export let` and rebuilt by a `refreshStrings()` registered with `subscribeLanguage` – importers see the new value through the ES module live binding. Never copy such a value into a module constant.
- **Markup inside sentences:** `rich(text, { name: <code>…</code> })` (`app/src/ui/richText.tsx`) inserts React nodes for the `{name}` placeholders that `t()` left untouched, so a sentence with `<code>`, `<b>` or a link stays one key.
- **Exports in a fixed language:** `tIn(lang, key, vars)` translates in an explicit language (landing/approach card PNG, countries and year-in-review images, file names such as `VectaSim_Approach_…`/`VectaSim_Anflug_…`); render functions take `lang` as a parameter instead of reading the global.
- **Language:** setting `language` = `de` | `en` | `system` (default `system` = Windows display language via `navigator.language`; neither de nor en → de). Stored like all prefs in the `settings` table; `prefs.ts` passes it on to `i18n/lang.ts`.
- **Keys and namespaces:** nested JSON, key = dot path. One namespace per area or file in camelCase (`nav`, `band`, `logbook`, `flightDetail`, `settings.display` …); leaves describe the meaning, not the text (`logbook.deleteConfirm`, not `logbook.endgueltigLoeschen`). Recurring words in `common.*`. `de/*.json` (one file per area, merged in `de/index.ts`) is the reference: new keys always go there first, then into `en/*.json`. Keys are typed from `de.json` (`TKey`) – a typo is a tsc error.
- **Placeholders:** `{name}`; numbers are inserted language-appropriately without decimals (`1 500` / `1,500`); format anything with a unit or decimals beforehand with `i18n/number` and pass it as a string. Whole sentences as one key – don’t glue sentence fragments together, the word order differs.
- **Plurals:** object `{ "one": "{count} Flug", "other": "{count} Flüge" }` (categories of `Intl.PluralRules`, `other` mandatory); call `t("count.flights", { count })` – without `count`, tsc reports an error.
- **Numbers, dates, times:** `app/src/i18n/number.ts` has the same functions as `format.ts` (`fmt`, `fmtNum`, `fmtSigned`, `fmtDuration`, `fmtWeight`, `fmtDate`, …) with an optional `lang` at the end; for German the output is identical (golden tests). de: `1 500 ft`, `−155 fpm`, `1,25`, `17.10.2026`; en: `1,500 ft`, `-155 fpm`, `1.25`, `17 Oct 2026`. Times in 24 h, UTC with `z` or local time as before (`time_local`).
- **English style:** British spelling (centre, colour, normalised, minimise), matching the existing `en/*.json`; aviation terms as pilots use them (landing rate, touchdown zone, go-around, off-block/on-block, block time, air time, stable approach).
- **Not translated:** flight phases stay in English (`format.ts → PHASE_LABEL`), as do ICAO/METAR abbreviations, `FL350`, units (`ft`, `kt`, `fpm`, `g`), product names and the theme names.
- **Fallback:** if a key is missing in `en/*.json`, the German text appears (with a console warning in the dev build); if it is missing there too, the key.
- **Tests:** Vitest runs with `navigator.language` = `en-US`, so `system` resolves to English. Tests that assert German text pin the language with `beforeEach(() => setLanguageSetting("de"))` (or wrap in `<I18nProvider lang="de">`); English assertions pin `"en"` the same way.
- **Checking:** `npm run i18n:check` (in `app/`) reports missing/surplus keys between the languages, wrong plural forms, differing placeholders, empty texts and `t("…")` calls with an unknown key; exit code 1 on errors. `npm run i18n:extract` lists texts not yet migrated per file (`-- --file Fleet --all`, `-- --json`), read-only.
- **Rust texts** (notifications, tray, Discord, dialogs, overlay): read the setting `language` from the store (`system` → Windows UI language) and pick the text with a `match` on the language; no language parameter threaded through every call. Errors that end up in the frontend should preferably be delivered as code + detail and only be turned into user text in `errors.ts` with `t()`. The installer (NSIS) is already bilingual (`app/src-tauri/windows/hooks.nsi`).
- **Rust language (mechanics):** `vectasim_core::Lang` (`De`/`En`, `tr(de, en)`, `decimal`, `parse`, `from_locale`) is the shared type. `app/src-tauri/src/lang.rs` resolves `language` at startup (`lang::init` after opening the logbook) and on every `set_setting("language", …)` (`apply_setting`, then `tray::relabel`) and caches the result in an atomic: `lang::current()`, `lang::tr("…", "…")`, `trf!("… {x}", "… {x}")` (format! per language). `system`/unknown → `GetUserDefaultUILanguage` (kernel32, no crate), neither de nor en → de; before `init` the system language applies, in `cfg(test)` always de. Text functions take the language as a parameter (`notify::landing_text(lang, …)`, `tray::tooltip(lang, …)`, `PresenceInput.lang`) – testable without global state. The overlay server asks `Source::lang()` (page default, `Status.lang`, `bandLabel`, port errors).
- **Error codes (store):** rejections are `StoreError::Invalid(Invalid::…)` (`crates/vectasim-store/src/error.rs`) with a stable code `store.<snake_case>`, typed parameters (`params()`, camelCase keys, nested cause under `cause`) and text in both languages (`message(lang)`); `Display` = German text (reference, log). Technical errors: `store.sqlite|io|json|track` with an English `detail`, plus `store.newer_schema`, `store.migration_failed`, `store.backup_failed` (`step`). `to_json(lang)` returns `{ code, params, message }`. The Tauri commands still return `Err(String)` = `lang::ui_error(e)` (store errors in the backend language, everything else `Display`), because many components display `String(e)`; switching to a structured error object only works together with `errors.ts`/`rawText`. New rejection: variant in `Invalid` + code + both texts + parameters, golden test in `error.rs`.
- **Store texts:** the store has no global language. User-facing texts (import warnings, row errors, generated note lines) use `ltr!(lang, "de …", "en …", args…)` (`crates/vectasim-store/src/lib.rs`, `format!` per language); the language arrives as a field set by the app, not by the frontend: `ImportOptions.lang` (`.vectasim` import, `bundle.rs`) and `CsvImportOptions.lang` (`#[serde(skip)]`, `csvimport.rs`).

**UX conventions from the review fixes (map overlays):** a card on the map (traffic flight card, `.traffic-card`) must not cover what it describes – `measureInsets()` in `map/LiveMap.tsx` measures the free area beside the card and above the HUD, camera moves use it as `offset` (`insetOffset`) or as `padding` for `cameraForBounds`, and `pointFree()` checks whether a point is visible. Colours drawn on the basemap go through `ensureContrast(color, ground, ink, min)` in `map/aircraftIcons.ts` (mixes towards the text colour in 5 % steps until WCAG contrast is reached: 4.5:1 for callsigns, 3:1 for symbols) so light themes stay readable.
