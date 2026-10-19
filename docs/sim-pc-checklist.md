# First test on the sim PC – guide

The goal of this test is not “everything works” but to bring back **a raw dump, the log and a note for every scenario**. Errors are then reproduced and fixed on the development machine via replay. Keep to the order – each step builds on the previous one. Write down the time for every step; that makes it easier to find things in the log.

Everything below has so far only been verified against the mock provider and by unit tests, and has to be confirmed once live against MSFS.

UI labels are given as they appear in the English UI (*Settings → Display → Language → English*). For testers running the German UI, the German label follows once in parentheses where it is not obvious.

## Preparation

- Set up a log table: time · sim (2020/2024) · aircraft · scenario · expected · observed · dump file.
- Under *Settings → Diagnostics*, turn on **Record raw dump** (one file per flight) and set the log level to *Verbose* (`debug`).
- Paths: logs `%LOCALAPPDATA%\io.vectasim.app\logs\`, dumps `%LOCALAPPDATA%\io.vectasim.app\dumps\` (buttons *Open log folder* / *Open dump folder* in Diagnostics). Regardless of the switch, VectaSim keeps the last 30 min in memory – after an unexpected error, click *Save dump now* immediately.

## Step 0 – Environment (10 min)

- [ ] Note the Windows version, MSFS version(s), Store/Steam, and tools running in parallel (FSUIPC, GSX, Navigraph, FBW installer, MobiFlight). Is MSFS running as administrator? Do **not** run VectaSim as admin unless the sim runs elevated.
- [ ] SDK installed? In a new console: `echo %MSFS_SDK%` or `echo %MSFS2024_SDK%`. Otherwise install the SDK via Developer Mode, download it via *Settings → Simulator → Download SimConnect*, or pick the DLL under *Settings → Simulator → SimConnect.dll*.
- [ ] Start VectaSim **without** the sim → Diagnostics: note the DLL found and the paths searched. Status “Waiting for simulator”. The log file must exist and contain the failed connection attempt.

## Step 1 – Connection (15 min)

- [ ] Start MSFS while VectaSim is already running → “connected” within ≤ 10 s after the main menu. Note the sim name/version from Diagnostics.
- [ ] Search the log for `exception`; note every exception with its code and variable. Check that telemetry arrives (data rate in Diagnostics > 0).
- [ ] Leave it **in the main menu** for 2 min: does telemetry arrive? With which values (position, on ground, AGL, IAS)? Does a flight start by mistake? → **dump “menu”**.
- [ ] Note the events on connecting (pause, sim running/stopped).

## Step 2 – Load a flight, raw values at the stand (20 min; default GA aircraft, e.g. C172 at a small airfield)

- [ ] Load a flight at a parking spot. Do *Flight loaded*, *Aircraft loaded*, *Simulation running* appear? Does a ghost landing or a phase appear while loading?
- [ ] Diagnostics → *Live raw data*: AGL on the ground (≈ 3–5 ft for the C172), on ground = yes, gear 100 %, flaps 0, fuel/weight in kg plausible, transponder matches the sim panel, Zulu time, sim rate 1, slew off.
- [ ] Static data: note title, ATC model (token?), ATC type, registration, airline, flight number.
- [ ] Note the **data rate** (expected 30–60 Hz) and the sim FPS at the same time.
- [ ] Parking brake on/off, lights, engine on/off: do the values change?

## Step 3 – GA circuit with touch-and-go (30 min) → dump “ga-pattern”

- [ ] Taxi → phase *Taxi out*. Takeoff → *Takeoff* → *Climb*.
- [ ] Circuit at ~1000 ft AGL, **touch-and-go**: landing report with touch-and-go, phase *Landing* → *Climb*.
- [ ] Second circuit: **pause (P) in the middle of the base leg** for 60 s → resume. Is the phase stable? Pause count/duration in the flight? Do frames keep arriving during the pause (watch the counter)? Also test **Active Pause** once and the **ESC menu** once, and note which events arrive.
- [ ] Full-stop landing. Compare the app’s landing rate with a second tool (Landing Inspector, FLARE, Volanta) and with the sim’s raw value; note sign and magnitude.
- [ ] Vacate, park, engine off → *Taxi in* → *Shutdown* → flight in the logbook, distance plausible. Open the debrief and the approach section.

## Step 4 – Airliner ILS (45–60 min; first a default airliner, then an add-on) → dump “airliner-ils”

- [ ] Gate → pushback (default or GSX) → taxi → takeoff → short climb → ILS. A “start on a 15 nm final” is not the main test.
- [ ] Pushback detected as pushback? With the parking brake released? Engine start during pushback?
- [ ] Phases: *Climb* → *Cruise* (60 s level) → *Descent* → *Approach* → *Final* → *Landing* → *Taxi in* → *Shutdown*.
- [ ] Landing report: landing rate, g, bounces, runway assignment, touchdown distance. Approach: gates, “stable from”, note the flap settings for each lever position.
- [ ] Add-on (Fenix/PMDG/FBW): note registration, parking brake, lights, flap index, fuel, engines, touchdown value.

## Step 4b – Check approach data (track v2) (during step 4, per aircraft) → dump “approach-v2”

New since track v2: a separate 1 Hz definition `APPROACH` (wind, NAV 1/ILS, AP bits, N1, spoilers, alpha, flap positions) and a one-off `DESIGN` (VS0/VS1/VC). Visible under *Settings → Diagnostics → Live raw data* (tables `APPROACH`/`DESIGN` with raw value and value, above them the converted *Approach data*). A value the sim doesn’t know may only cost itself – FAST/SLOW must keep running.

- [ ] `APPROACH` and `DESIGN` registered without `NAME_UNRECOGNIZED` (event list). Candidates for rejection: indices in `NAV …:1`, `AUTOPILOT MANAGED THROTTLE ACTIVE`, `AUTOPILOT THROTTLE ARM`, `INCIDENCE ALPHA`. Note rejected rows (✗); the FAST/SLOW rate stays unchanged.
- [ ] ILS approach with the default A320/C172, PMDG 737, Fenix, FBW: `NAV HAS LOCALIZER`/`NAV HAS GLIDE SLOPE` = yes as soon as the ILS is tuned on NAV 1 (for add-ons: do they tune the sim’s NAV 1 at all?). `NAV RAW GLIDE SLOPE` = published angle (usually 3.00°).
- [ ] **Glide path sign:** fly high → is `NAV GLIDE SLOPE ERROR` positive or negative? Magnitude plausible (1 dot ≈ 0.35°)? Note it; VectaSim assumes “positive = above the path”.
- [ ] **Localizer sign:** right of the extended centreline → are `NAV CDI` (±127) and `NAV RADIAL ERROR` (°) positive or negative? Full deflection 127 at how many degrees?
- [ ] `NAV GS FLAG`: yes = glide slope received/valid, or the other way round (flag visible)? Compare far outside the sector and on final.
- [ ] `NAV LOCALIZER` (course): magnetic or true? Compare with the runway heading and the approach chart.
- [ ] `AUTOPILOT MASTER`/`APPROACH HOLD`/`GLIDESLOPE HOLD` and `MANAGED THROTTLE ACTIVE`/`THROTTLE ARM` per add-on: populated yes/no (does the value change when switching on/off?).
- [ ] `FLAPS HANDLE INDEX` vs. `FLAPS NUM HANDLE POSITIONS` per add-on: is the last position = landing flaps (A320: 5 positions, FULL = index 4)?
- [ ] **Spoiler scale:** `SPOILERS HANDLE POSITION` in % (0–100) or 0–1/16K? Armed → `SPOILERS ARMED` yes? After touchdown, `SPOILERS LEFT POSITION` (surface) ~100 %, even if the lever doesn’t move with it on add-ons?
- [ ] **N1 vs. thrust lever:** note `TURB ENG N1:1/2` at idle, in the climb, on approach and in reverse; `GENERAL ENG THROTTLE LEVER POSITION:1` at the Airbus detents (CL/FLX/TOGA) – which value corresponds to which detent?
- [ ] Compare `AMBIENT WIND` (direction true, kt) on final with METAR/ATIS (direction ±10°, speed ±3 kt plausible?).
- [ ] `INCIDENCE ALPHA` on final plausible (airliner ~3–7°)?
- [ ] Note `DESIGN SPEED VS0/VS1/VC` per aircraft (VS0 × 1.23 ≈ Vref?). VC is requested in ft/s and converted – is the value in kt plausible?
- [ ] After landing, in the debrief → *Measurement log* (German: „Messprotokoll“): the row *Sim recording* („Sim-Aufzeichnung“) with TAS, wind and ILS is present.
- [ ] Data rate: `APPROACH` ~1 Hz, no noticeable load; note the dump size per hour compared with before.

**Approach rating stage 2 (evaluation of the v2 data), after the ILS approach in the debrief → *Approach* / *Measurement log*:**

- [ ] Reference “3.0° (ILS)” with the chip “SIM” for glide path and *Lateral* (German: „Kurs“, the offset from the extended centreline); row *ILS / geometry* in the measurement log: median difference of glide path and localizer < 0.5 dot on a database runway (otherwise check the sign/scale of `NAV GLIDE SLOPE ERROR`/`NAV CDI` – VectaSim assumes GS + = above the path, CDI + = aircraft left, ±127 = ±2 dots).
- [ ] Deliberately fly 1 dot high or right: the sim and geometry values point the same way and are of similar size.
- [ ] RNAV approach with the ILS of a **different** runway (or a parallel runway) tuned: notice “The simulator's ILS does not match RWY … – another ILS tuned? Assessed geometrically”; the rating is geometric (“3° assumption, geometric”).
- [ ] Visual approach without ILS: everything as before (geometry, 3° assumption), no ILS notice.
- [ ] *Sim wind on final* („Sim-Wind im Endanflug“) below the METAR wind: direction/speed plausible against METAR/ATIS, head-/crosswind matching the runway; with live weather and gusts, the “spread” is visible.
- [ ] Gate table 1000/500 ft: rows *Landing flaps*, *Thrust (N1)*, *Spoilers retracted* with sensible values per add-on (A320 CONF 3: enter 3 in the fleet field *Landing flaps (setting)* → ✓). Note N1 in a stable approach per type (Airbus/Boeing ~45–60 %?) – is the 40 % threshold right?
- [ ] Idle on short final (throttle idle > 5 s below 1000 ft) → exceedance *Thrust*; speedbrake extended on final → *Spoilers*; piston engine (C172): no thrust row.
- [ ] Measurement log row *Automation*: “Autopilot down to … ft, then manual” matches the disconnect; autoland → “Autopilot until touchdown (autoland)”.
- [ ] *Save approach card* and *Copy approach card* work; with *Save the landing card as PNG automatically after every landing*, `VectaSim_Approach_…png` (German UI: `VectaSim_Anflug_…png`) is additionally in the card folder after landing; streamer mode masks the registration on the card.

## Step 5 – Edge cases and abuse (30 min) → one dump each

- [ ] **Slew** (Y) in flight and across the airfield, also close to the ground: no touchdown, flag “Slew”.
- [ ] **Time acceleration** 4× in cruise: flag for time acceleration, no phase changes.
- [ ] **End the flight in mid-air → main menu → load a new flight at a different airport at the gate.** Observe closely and dump – the most important reproduction case.
- [ ] MSFS 2024: teleport via the world map, fast travel, start “in the air”.
- [ ] Rejected takeoff up to ~60 kt.

## Step 6 – Sim restart and crash (15 min)

- [ ] Quit the sim normally → “Simulator closed” → start the sim → automatic reconnect. What happens to the open flight?
- [ ] **Kill the sim via Task Manager** (simulates a crash): does the app detect the disconnect? How long does it take?
- [ ] Restart the app while the sim is in flight: does the connection come back, is the flight resumed (or not)?
- [ ] Optional: standby and wake-up.

## Step 7 – Resources and MSFS 2024

- [ ] RAM/CPU of the app in flight (Task Manager, all processes). Noticeable stutters in the sim?
- [ ] If both sims are available: repeat steps 1–3 in the other version. In particular: the loaded DLL, whether *Simulation stopped (menu)* appears when switching to the menu, title vs. livery.

## Step 8 – X-Plane 12 (Web API, 45 min; first the default C172, then an airliner) → dump “xplane”

Beforehand: X-Plane 12.1.1 or newer, *Settings → Network* without “Disable Incoming Traffic”. In VectaSim, test *Settings → Simulator* once with “X-Plane 12” and once with “Automatic”; raw dump on.

- [ ] Connection: VectaSim running before X-Plane → status “Waiting for simulator”, the log shows `sim not reachable (X-Plane Web API localhost:8086 …)` every 5 s. Start X-Plane → “connected” after loading, Diagnostics: source `X-Plane Web API localhost:8086`, version (e.g. `12.1.4`), `Web API v2`, data rate ≈ 10/s. Search the log for `dataref … not found` / `rejected the subscription` and note every message.
- [ ] Automatic: with “Automatic” and X-Plane running (without MSFS), VectaSim switches to X-Plane within ≤ 15 s; the log names the reason (`simulator (automatic): … → switching from simconnect to xplane`).
- [ ] At the stand (Diagnostics → *Live raw data*): **AGL on the ground** (C172 ≈ 3–5 ft – X-Plane measures `y_agl` at the centre of gravity, note the value), on ground = yes, gear 100 %, parking brake on/off as in the cockpit, fuel/weight in kg as in the weight menu, transponder as on the panel, Zulu time, sim rate 1.
- [ ] **Signs**: in the climb, pitch positive and V/S positive; right turn → bank positive (X-Plane `phi`); heading magnetic/true against the cockpit; wind (direction from, kt) against the weather display.
- [ ] **Flap detents**: set each position individually and note the index + flap positions (C172: 0/10/20/30° → index 0–3, 4 positions?). If `acf_flap_detents` doesn’t match the detents, note the values for the report.
- [ ] Engines: count and “running” at start/shutdown (airliner: both individually); N1 and thrust lever on approach; speedbrake armed = spoilers armed.
- [ ] **Pause**: press P → status “paused”, no flight segment keeps running; after 1 min of pause the connection stays up (no “not responding”). Time acceleration (sim rate 2×/4×, also the “ground speed” multiplier) is flagged as accelerated.
- [ ] Circuit with landing: compare the landing rate (source “measured”) with X-Plane’s display/data output; a touch-and-go is detected as such.
- [ ] **Aircraft change** on the ground (default C172 → A330): the new aircraft (title, ICAO, registration) appears, no false flight/landing is created. Note an add-on’s registration/ICAO field if it is empty.
- [ ] Quit X-Plane during a flight → “interrupted”, after restarting and loading the same spot “Resume flight?”. Kill X-Plane hard (Task Manager) → connection gone within ≤ 15 s.
- [ ] Play back the dump at the end (*Diagnostics → Replay*): flight and landing as live.

## Afterwards

- [ ] Zip the `logs\` and `dumps\` folders completely, together with the log table. Every error noted is reproduced on the development machine via the replay provider (`VECTASIM_PROVIDER=replay`, with the file) and checked in as a regression test.
