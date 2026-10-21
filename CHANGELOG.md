# Changelog

Entries are in English from 2026-10-18 on; earlier entries were translated.

## 0.6.2 – 2026-10-22 (Beta)

Assessment profiles: the approach is now rated by aircraft category – Airbus-style, Boeing-style, turboprop, GA piston or the generic FSF/EASA set – with every value traced to a public source, and your own SOP as an importable profile.

### Approach

- Approach assessment profiles: the thresholds of the approach rating now follow the aircraft – generic (FSF/EASA, as before), Airbus-style (gate speed Vapp −5/+10 kt), Boeing-style (same as generic until Boeing publishes values), turboprop (gate speed ±5 kt, no thrust check) and GA piston (tighter speed and sink-rate limits, configuration gate 500 ft, “unstable below 300 ft”), every value taken from a public source. VectaSim picks the profile by ICAO type (else by engine), the debrief and the flight detail name it (“Assessed with: Airbus-style profile”, the tooltip lists what differs), and comparisons and trends only compare approaches assessed with the same profile. In the fleet you can choose another profile per aircraft; *Settings → Approach assessment* lists the profiles with their sources and imports your own (JSON, e.g. your VA’s SOP). Flights already in the logbook are assessed again with their profile in the background.

## 0.6.1 – 2026-10-21 (Beta)

Hotfix for the live map.

### Map

- The live map no longer draws a line across the map when a flight is loaded at another airport, the aircraft is slewed or teleported before or between flights: the own track starts afresh at the new position (same jump rule as the recorder: more than three times the distance the ground speed explains, plus 1 nm, time acceleration included).

## 0.6.0 – 2026-10-21 (Beta)

The logbook learns to read your flying: markers along the flight path, a green approach from the gear extension on, a full-screen flight view, and your take-off and approach numbers compared with your other flights. On the live map a clicked online aircraft shows its filed route through the waypoints and up to two hours of flown track.

### Map

- *Show route* on a VATSIM/IVAO aircraft's flight card now draws its filed route through the waypoints instead of a plain great circle: fixes, navaids and airways are taken from a running MSFS 2020/2024, from the nav data of an X-Plane installed on this PC, or from the navaids now bundled with VectaSim (OurAirports), and coordinates in the route are placed as written. Gaps are bridged with a dashed great circle, waypoint names appear when you zoom in, and a line under the button says how much was found ("14 of 18 waypoints resolved · MSFS, X-Plane"); without any navigation data it stays the dashed great circle.
- The altitude curtain of a clicked VATSIM/IVAO aircraft now shows up to two hours of its flown track even right after you switch the traffic on: an enabled network is polled from app start on – every 15 s while its traffic is shown, every 60 s in the background while it is hidden on the map or the window is minimised – and hiding the traffic no longer drops the recorded tracks. The map's *Traffic* toggle now only shows or hides the traffic; whether a network is downloaded at all is the switch in *Settings → Display → Online traffic* (turning it off stops the downloads and drops the tracks). The status line there and the diagnostics say whether each network is shown on the map or running in the background.

### Logbook

- Markers along the flight path on the track map: gear down/up, every flap change (“Flaps 1 → 2”), the take-off rotation, touchdowns and the stable-approach findings – the 1000 ft and 500 ft gates (stable or not), “stable from”, go-around and every exceedance as a coloured stretch with criterion and peak. Hovering shows time, height above ground and IAS; a click moves the replay cursor there; the profile chart shows the same markers as ticks. The new *Markers* menu in the map toolbar filters them and remembers the choice.
- From the landing gear extension on, the flight path is drawn green instead of altitude-coloured (2D line and 3D curtain), so the final approach stands out at a glance. Fixed-gear aircraft and flights without a retraction keep the altitude colours.
- Rotation rate at lift-off: mean pitch rate from the start of the rotation to lift-off, plus the peak. The normal band is 1.5–4 °/s (airliners typically 2–3 °/s); slower is marked “slow”, faster “fast”.
- Full-screen view of a logbook flight (⛶ in the map toolbar, or F): the track map with the altitude/speed profile and the replay bar fills the window; Esc or F closes it.
- Your flying compared with your other flights, like the landing rate: the landing debrief and the flight detail now also rank the take-off rotation rate, the height and distance to the threshold at which the gear went down, the height at which the landing flaps were set, the exceedances on final and the 1000/500 ft gates against the same runway, the same type or all flights (“Rotation 2.3 °/s – your median in the A20N is 2.6 °/s (12 flights)”). The flight detail shows the values in a compact row under the track, and *Landings → Trends* has curves for rotation rate, gear-down height and exceedances with the same filters. Flights already in the logbook are worked out in the background the first time the comparison is opened.

## 0.5.3 – 2026-10-21 (Beta)

A test button for the in-sim text: find out in a second whether your MSFS shows SimConnect text before relying on the landing line.

### Simulator

- *Settings → Simulator → Send test message to the sim* sends a test line into MSFS via SimConnect and reports what happened – sent, refused by the DLL, rejected by the sim (with the exception name), or no connected session – so you can check whether your MSFS version shows SimConnect text before relying on the landing line.

## 0.5.2 – 2026-10-21 (Beta)

Second audit round: flight detection corrected again (reconnect gaps, short hops), a faster start, the overlay server hardened further, every dialog on one focus module, and the map lighter on the GPU while following.

### Recording

- After a sim restart at the gate or a reconnect gap longer than a minute, the flight ends as interrupted with the resume offer instead of being saved as completed with a landing at the reconnect time; a long ESC menu on short final (sim clock frozen, aircraft in place) still keeps the landing.
- Short helicopter and STOL hops (at least 5 s above 50 ft, or 10 s airborne out of the take-off roll) are recorded as flights with a landing instead of being discarded as ground sessions; a hop that touches down before the usual airborne qualification no longer leaves the flight stuck in “Climb” on the ground.
- The Windows notification, the in-sim landing text, the KML export and a resumed flight’s summary say “landing rate not rated” instead of “0 fpm (smooth)” for an unrated touchdown; a landing right after a short stream hole is rated with the vertical speed from just before the hole.
- An aborted pushback (parked again, brake set, engines off) ends the recording; time acceleration no longer sets the teleport flag; a reconnect during the initial climb keeps the take-off time; a taxi-only recording left open by a crash is discarded on the next start; a flight whose end is still being saved cannot be deleted; a flight loaded low on the approach gets that airport as arrival, not departure; a flight started in the air and interrupted before landing counts in the statistics; merging a bundle no longer double-counts runway landings of duplicate flights.
- The live map track no longer freezes after the system clock is set back; long flights use less CPU while recording (incremental track encoding); if a backup restore could not be applied, VectaSim says so after the start (the previous logbook stays open).

### Map

- After the window returns from the tray, the map draws the skipped frame right away instead of freezing until the next sample; following near a pole or across the date line no longer throws or jumps; clicking a traffic aircraft hidden under the card while “Follow” is on brings it into view; 3D traffic models are hidden behind the globe’s horizon; radar and cloud tiles are recoloured off the main thread; the follow loops sleep between frames and reuse their buffers.

### Interface

- Faster start: the landing debrief and the maps load on first use, cutting the start bundle from 2.30 MB to 1.07 MB (gzip 673 kB to 335 kB).
- Collapsible sections no longer reference a body that is not rendered and are not landmarks; the folded “Events” section shows the newest event; the debrief’s landing pager and the logbook tag filter keep keyboard focus; closing nested dialogs together returns focus to the opener; the runway editor cannot be closed with Esc while saving; installing an update twice at once is ignored; a focused toast keeps its countdown; the “connection lost” notice goes away when the flight ends; telemetry throttling no longer stays at 1 Hz after a quick minimise and restore.
- When a ground session is discarded, VectaSim no longer flashes the taskbar or re-saves an older flight’s landing card, whatever order the events arrive in; failed exports, a failed pre-update backup, a failed resume and a port that could not be saved show a plain next step with the reason behind “Details”.
- “Show in folder” goes through a checked backend command that opens only existing local items.

### Privacy and security

- The overlay start page shows the OBS copy links with the token even when opened from a bookmark through the cookie; the token cookie is bound to the port and outdated cookies are deleted by the next answer.
- Idle local connections can no longer block the overlay server (a new local request takes an idle slot, waits at most 2 s, then gets 503); other devices’ WebSockets have a quota of their own (16, at most 4 per device), so the local OBS overlays keep their connections; every refused request closes its connection.
- The streamer-mode redaction finds registrations written without a dash, in lower case or with a space, and no longer hangs on long lines of dashes; the “no airport near” position message is logged at debug level only.
- An X-Plane host name is resolved on every connection and refused when it points only to public addresses; network paths (`\\server\share`) are refused for exports, imports, the landing card folder and the SimConnect.dll choice; saving a landing card accepts only PNG images up to 32 MB; SimConnect.dll is no longer searched in the SDK’s drive-root folders on its own; links opened from the app are limited to the sites it links to; the VATSIM data address is only accepted on vatsim.net; diagnostics start `reg.exe` by its full path.
- Dependencies: the TLS certificate libraries were updated past published advisories (RUSTSEC-2026-0381/0382/0383).

### Recording

- Runway matching, derived runways and the landing debrief work for runways across the antimeridian (Fiji, Tonga, Chukotka) instead of seeing them as pointing the wrong way; the nearest-airport lookup is exact at high latitudes (Scandinavia, Svalbard, Alaska, Antarctica) and across the date line.
- A flight you delete permanently no longer keeps counting as a landing on a runway VectaSim learnt from your tracks; leftovers of flights deleted earlier are cleaned up once (with the usual backup before the logbook is updated).
- Every round of the demo flight is a flight of its own; the bouncing demo landing no longer shows an unrealistic 3 g spike.

### Map

- The live map leaves more of the graphics card to the simulator: VectaSim’s own map updates (following the aircraft, the 3D model, traffic) are capped at 30 fps, at 15 fps while another window such as the simulator has the focus, and nothing is drawn while VectaSim is minimised, with or without the tray icon (the live data in the background slows down as well). Dragging, zooming and rotating and the map’s own camera animations stay at full rate; camera steps too small to see draw nothing, and labels appear without fading in. Restoring the window draws at once and the camera glides back to the aircraft. Measured in 3D follow mode: about 25 frames per second with VectaSim focused, 14 unfocused and 0 minimised (before: 32, 32 and 10).
- Switching the theme frees the graphics memory of the 3D layers right away; switching 3D on late in a long flight or opening a long logbook track no longer freezes the map while the altitude curtain is built; 3D traffic in busy areas costs less time per update.
- Weather radar: RainViewer’s magenta step (55–64 dBZ) is shown in white; the missing “circle-11” basemap icon is no longer requested.
- Map toolbar and traffic-card buttons expose their explanations to screen readers; “ATC” without traffic and “Route” without a full flight plan stay focusable and say why they are unavailable.

### Interface

- All dialogs (landing debrief, year-review lightbox, CSV import, runway editor) behave the same: Tab and Shift+Tab stay inside the dialog and wrap around, Esc closes only the topmost one, nothing behind it can be clicked or reached with the keyboard, focus returns to where you were and the background keeps its scroll position, the fade-in respects “reduce motion”, and Ctrl+F / Ctrl+. are blocked while a dialog is open, like Ctrl+1…4.
- Saving landing, approach, year-review and country-map images is much faster: “Save all” and the year-review stack no longer stall on large images.
- At 125–150 % in-app zoom in a small window the live side panel lies over the map and the logbook stacks list above detail; totals and filter chips wrap instead of being cut off.
- A failed copy to the clipboard explains what to do instead of showing the raw browser error; simulator settings that fail to load offer “Retry”; exported year-review cards print ranks, legends, page numbers and zero values in the readable muted colour.
- The year review and the countries view load on first use (smaller start bundle); the airports tab looks up each airport only once per session; the logbook result count is announced to screen readers once typing pauses.

### Privacy and security

- Overlay server: a tablet or second PC needs the token in the link only once – the browser then keeps it in a cookie and the overlay pages remove it from the address bar, so it stays out of the browser history and bookmarks; bookmarks without the token keep working until you regenerate the token.
- The diagnostics package always replaces the Windows user name in file paths, not only in streamer mode.
- The VATSIM METAR fallback (metar.vatsim.net) is only used while VATSIM is switched on; with VATSIM off, VectaSim contacts no VATSIM server.
- The X-Plane address setting now checks the host: this PC, an address in your local network (IPv6 included) or a host name; a public IP address is refused, because the X-Plane Web API is unencrypted.
- Photo credit links are now also checked when they come from an imported `.vectasim` file: only links to www.planespotters.net are kept; the app opens only https links and the local overlay server; SimConnect.dll is no longer picked up from the current folder or other folders on the Windows search path, only from the known locations, the app folder and System32.
- Dependencies: the ZIP library was updated past published security advisories, and the updater no longer contains an unpacking feature it never used.

### Release

- Releases are only built from a commit that passes every CI check: the release workflow runs the full CI first; CI checks Rust dependencies with cargo deny (licences, bans, sources, advisories) and that the English and German READMEs have the same structure and valid links.
- New SECURITY.md: security problems can be reported privately through GitHub; README lists RainViewer’s terms under Known limitations; the sim-PC checklist covers the take-off rule, discarded ground sessions, scenery switches, the ESC menu on short final and the in-sim line for unrated touchdowns.

## 0.5.1 – 2026-10-19 (Beta)

Fixes from a full audit of 0.5.0: flight detection (false take-offs, ground sessions, scenery switches, landings lost on reconnect), SimBrief v2, map robustness, privacy, security and release hygiene; plus the altitude curtain and smooth motion for selected online traffic.

### Recording

- A single flickering “not on ground” sample while taxiing in or parked no longer fires a take-off: take-off now needs a take-off roll or more than 50 ft AGL for 1 s, a flight that taxied out and shut down again can still close, and a fast taxi after landing returns to taxi-in.
- A recording that never left the ground (taxi and shut down, or a flight loaded at one airport and then another one somewhere else) now ends as a discarded ground session instead of a flight – it goes to the trash with a notification and does not count in any statistics, so a scenery test at airport A followed by a flight at B is no longer stitched into one flight A→B. Old taxi-only recordings drop out of the counters, airports and countries (a recorded flight needs a take-off or a touchdown to count; imports always count).
- A reconnect, aircraft reload or sim stop/start on short final no longer ends the flight as interrupted and loses the landing: if the position continues plausibly across the gap, the flight goes on and the touchdown is recorded.
- A touchdown reached by slewing or time acceleration without a sim touchdown value is recorded as “unrated” and no longer becomes the flight’s landing rate (previously a perfect-looking 0 fpm); unrated landings stay out of averages, rankings and trends, and the overlay API reports `band: null` for them.
- An aircraft that reports “not on ground” at 1 ft and 0 kt while settling at the gate is no longer taken for a start in the air; after a go-around or touch-and-go the circuit is no longer shown as cruise; a pause within the first 45 s after lift-off no longer shifts the take-off time; a spurious “on ground” frame at altitude no longer removes a real g-load peak; a g-load glitch in the contact frame no longer shows up as a 5 g landing; the approach assessment no longer breaks when the system clock steps back.
- Discarded ground sessions show as “discarded (ground session)” in the logbook and trash (muted strip, tooltip); the app says “Ground session discarded · no take-off, no flight – it is in the trash” instead of “Flight saved”, and the live view and event log reset accordingly. Logbook counters, the year in review and the airports tab count only real flights, matching the backend rule; unrated touchdowns show “unrated” instead of “0 fpm” in the detail, debrief, landing card, PIREP and live view and stay out of bands, best/median values and the landing index. The delete button is disabled for the flight being recorded.
- The flight being recorded can no longer be moved to the trash or deleted; setting the system clock back during a flight no longer stops track recording; saving the track no longer blocks the live map while a long flight is being encoded.

### Map

- Altitude curtain for a selected online aircraft: click a VATSIM or IVAO aircraft and the 3D view shows its flown path of the last up to two hours (480 fixes per aircraft, kept by the feed cache from the moment VectaSim sees it) as a curtain in the accent colour, growing with every feed update; below the own curtain, 3D only, gone when the card closes.
- Smooth traffic: the selected aircraft and its callsign are redrawn every frame instead of 5× and 1× per second, feed corrections blend in over 1.5 s instead of snapping, and the camera that follows it stays on the aircraft at its height instead of drifting for 15 s and jumping back. Following (own or traffic) no longer interrupts map gestures: while you drag, rotate, tilt or zoom, the camera is yours and glides back onto the aircraft afterwards.
- The maps recover from a WebGL context loss (GPU reset): the 3D curtain, the own aircraft model and the traffic models come back instead of leaving the own aircraft invisible; without WebGL2 the map areas show a short explanation instead of staying blank.
- Pacific flights no longer draw a line around the whole world: the track splits cleanly at the date line, the logbook map fits the flight, and airports on both sides of 180° are shown.
- Switching the theme right at start-up or several times in quick succession no longer breaks the live map; 3D traffic models far up a tilted globe no longer spike towards the pole; the own 3D aircraft no longer shows through the globe behind the horizon; a slow airport lookup can no longer replace the dots of a newer view; the planned route line of a selected aircraft works for exactly opposite airports.

### Planning

- SimBrief flight plans load again: SimBrief’s JSON v2 delivers the navlog as a bare list of fixes, which the parser took for the old `{ "fix": [...] }` shape and rejected with “could not parse OFP: trailing characters”; both shapes are accepted now.

### Interface

- The live side panel’s information blocks (flight, times, plan vs. actual, weather, last landing, systems, events, SimBrief plan, traffic nearby, ATC) can each be collapsed with a one-line summary and remember their state; the same applies to the logbook flight-detail sections and the traffic card’s photo, route and remarks.
- Zooming while following an aircraft (mouse wheel, +/− buttons, double-click, pinch, keyboard) no longer pulls the view towards the pointer and snaps it back: the followed aircraft stays centred, in 3D at its height, and Follow stays on (only a drag ends it).
- The streamer-mode toast, the debrief text for a flight without a landing, the raw-data units and the landing card’s fallback file name follow the UI language; the plan-vs-actual table switches language immediately.
- Logbook: moving quickly through the list with ↑/↓ no longer loads the full track of every flight passed; overlapping reloads can no longer show stale data in the logbook, airports tab or year review; *Logbook → Airports* counts the airports as corrected by the pilot.
- Sample size (n = …), chart axis units and unselected rating stars use the muted text colour and meet the contrast minimum in every theme.
- Stacked dialogs keep the background inert until the last one closes and Ctrl+1…4 no longer switches views behind the lightbox or the CSV import; the CSV import dialog cannot be closed while an import runs; the “connection lost” notice disappears when the simulator reconnects after the flight has ended.
- Keyboard and screen readers: logbook tabs no longer reference non-existent panels, the tag-filter and export menus support arrow keys and return focus on Esc, segmented choices (language, time base, units, replay speed, approach range) are single tab stops operated with the arrow keys, the review lightbox keeps focus at the first and last card.
- Error toasts in fleet, notes and settings show a plain explanation with the technical text behind “Details”; a failed setting save no longer reverts other settings changed at the same time; *Settings → About* names EOX, RainViewer, EUMETSAT and Natural Earth.

### Privacy and security

- With streamer mode on, the diagnostics package hides registrations, callsigns, aircraft titles and airlines and leaves out the raw dumps; logs no longer contain registrations or callsigns at info level.
- Importing a `.vectasim` file can no longer write or delete picture files outside the picture folder through a crafted registration; such aircraft are skipped with a warning.
- In LAN mode, devices without a token (or with many idle connections) can no longer block the overlay server for local OBS overlays.
- Photo credit links only open Planespotters.net photo pages; the SimConnect.dll setting only accepts an existing file named SimConnect.dll, and VectaSim warns in the log when the DLL would be loaded from a folder other Windows accounts can write to.
- If the configured backup folder is unavailable, the copy before a database upgrade goes to the default folder; a staged backup restore that cannot be applied no longer blocks every start.

### Release

- The installer ships VectaSim’s licence (`LICENSE.txt`) and the third-party notices next to `vectasim.exe`; notices regenerated and in English.
- Release workflow: every action pinned to a commit SHA, no persisted checkout token, write access only for the release job, and a check that the tag matches all version fields; the update notes under *Settings → Updates* are in English.
- README and installation guide: the privacy list names the VATSIM METAR fallback and the local Discord client; the notification-area behaviour and the X-Plane address setting are described.

## 0.5.0 – 2026-10-19 (Beta)

Second beta: your aircraft as a 3D model at its height above the ground, online traffic in 3D, satellite imagery and live weather (METAR with legend, radar, clouds), the landing rate inside MSFS, replay up to 64× with a follow camera, g-load over the whole flight, close-to-tray by default.

### Simulator

- Landing rate inside MSFS: a few seconds after each touchdown (once its outcome – full stop or touch-and-go – is decided) VectaSim sends a one-line summary to the sim via SimConnect, shown at the top of the screen for 20 s – rate with its band, peak g, bounces and, when a runway was matched, runway, touchdown point from the threshold and centreline offset (in the app language, no registration or callsign). On by default, *Settings → Simulator → Show the landing rate in the simulator*; MSFS only. Whether MSFS displays SimConnect text depends on the sim version – a rejected call is only logged, the recording is never affected; messages older than 30 s (no sim connected) are dropped.

### Map

- After a cold start with the 3D view remembered, the live map shows online traffic, controllers and METAR rings again at once, and they stay current while the 3D camera follows the aircraft in flight (their refresh waited for the camera to stop moving, which it never does while airborne); airport dots are re-queried at most twice a second while following.
- Satellite imagery and live weather: a new “Satellite” switch (also under *Settings → Display*) puts cloud-free Sentinel-2 imagery (EOxCloudless 2017, CC BY 4.0) under the live and track map, with place names, borders and all our layers on top; “Weather” becomes a split button like “Traffic” with METAR rings, precipitation radar (RainViewer) and clouds from the infrared satellite image (EUMETSAT), each on or off, refreshed every 10 minutes with the image time in a small legend – real weather that may differ from the sim’s. Nothing is fetched while satellite, radar and clouds are off.

### Interface

- Closing keeps VectaSim in the notification area: the tray icon is now on by default, and the window’s close button (also Alt+F4) hides VectaSim there instead of quitting – recording, overlays and Discord carry on; the first time a Windows notification says where it went. Double-click the icon to open it again; *Quit* in the tray menu ends the app and still asks during a recorded flight. Both are switchable under *Settings → Integrations → Notification area*; with the icon off, closing quits as before.
- Legend for the METAR rings: while “Weather” and the METAR rings are on, the small weather legend on the live map shows the ring colours VFR, MVFR, IFR, LIFR and “?” (no ceiling or visibility in the METAR) in the theme’s own colours; hovering one explains its ceiling and visibility limits (FAA, statute miles with km). Zoomed out below the rings’ zoom it says “from zoom 7” instead.
- Update messages in the app language: the toasts for an available update, “Install now”, a blocked install during a recording, the backup warning, success and failures were German only and now follow *Settings → Display → Language*; the “available” toast no longer claims a background download – it says that “Install now” downloads the update, backs up the logbook and restarts. The check still runs once, shortly after start.
- Replay a whole flight faster and with the camera: the playback bar in the flight detail now offers 1×, 4×, 16× and 64× (a 3 h flight plays in under 3 min; the landing debrief keeps 1–8×), and the track map has a “Follow” switch that keeps the replay aircraft centred – in 3D looking at it at its height – zooms in to at least zoom 11 when switched on, starts at the beginning of the flight without a cursor and ends when you drag the map.
- Year in review previews fill the window: Logbook → Year measures the free area and picks the column count for the largest cards (portrait 240–420 px, landscape 360–680 px in 2–3 columns, one card always fits the visible height, a row less wins within 85 % of the size) instead of a row of thumbnails, without horizontal scrolling; a click on a card opens it large, fitted to the window (arrow keys, Home/End to browse, Esc or a click beside it closes, Save/Copy also there).
- Smooth 3D track curtain: in the tilted 3D view the wall under the flown track and the altitude-coloured band along its top are now drawn as one WebGL layer instead of stepped extrusion boxes – the top edge rises and falls without stairs or saw teeth, turns and the rotation/flare are rounded by a spline between the 1 Hz samples (ends and ground contact unchanged), the band keeps about 3 px at every zoom, the wall fades towards the ground; long flights are thinned (Douglas-Peucker, a 10 h flight stays a few thousand vertices) and the live map only appends new points. The own aircraft model still sits exactly on the edge; globe and flat map both supported.
- Scrollbars match the theme: thin (10 px, no arrow buttons) with a rounded thumb in the theme’s muted text colour on a transparent track – subtle at rest, stronger on hover and while dragging, dark in the light themes; the settings, logbook list, flight detail and side panel keep their width when a scrollbar appears.
- Own aircraft easier to spot: about 30 % larger than the traffic with a bold dark edge, a soft yellow halo with a ring (gently pulsing while “Follow” is off, never with reduced motion), always drawn above traffic, labels and weather; traffic fades slightly below zoom 9. In the 3D view a simple, rounded low-poly model matching the aircraft class (single prop, turboprop, narrow-body, wide-body, A380, helicopter; smooth-shaded with a subtle darkened rim, at most 800 triangles) now flies at the curtain’s height, oriented by heading, pitch and bank, with a plumb line and ground shadow – also at the replay cursor of the logbook/debrief track map. Curtain and model now use the height above ground (AGL near the ground, MSL minus the field elevation in cruise), so a landed aircraft no longer floats at the airport’s elevation, and the 3D follow camera looks at the aircraft in the air. The airport readout sits below the map toolbar instead of covering it, and dragging the map no longer selects overlay text.
- Online traffic in 3D: in the tilted 3D view from zoom 8, VATSIM and IVAO aircraft are drawn as low-poly models in the traffic blue-grey (the same six shapes as the own aircraft, one instanced draw call per shape, at most 200 – the ones nearest the map centre; the rest keeps its symbol), at their height above the nearest airport within 15 nm, moved on between the 15-s feed updates by ground speed and heading; the selected aircraft turns accent-coloured, callsigns and clicks work at the model, from zoom 11 low aircraft get a ground shadow and plumb line, and the own model always stays on top; models no longer flicker at low zoom (their parts z-fought in the depth buffer) and callsigns no longer flicker while the map follows the aircraft.
- 3D models complete again in every view: in the globe view (up to zoom 12) traffic lost wings and tails – the part nearer the camera sank behind the ground the globe writes into the depth buffer – and the own aircraft on the ground (after landing, in the live and the logbook track map) broke up into jagged pieces, because the globe resolves heights only in steps of about 0.8 m and the parked model was flattened to a few decimetres. Grounded models now keep at least 40 m per model unit vertically (lifted so they sit on the ground, like the traffic), traffic takes its depth from each fragment, and the own model’s contour can no longer cover its body.

### Demo

- The demo flight starts in the air on the left-hand downwind of Frankfurt 25C (2,500 ft, 220 kt, flaps 1) and lands after about 3 min 50 s – no start-up, taxi or take-off; after the landing it vacates, parks and shuts down, and about 20 s later the next round starts on the downwind as a new flight (loop 5 min). Base turn, final and all deliberate small mistakes are unchanged; the 10 nm gate is not reached (the start is closer). Recording: a flight that starts in the air (connected mid-flight, or a flight loaded in the air) goes straight into the phase the aircraft is in (Cruise/Climb/Descent/Approach/Final) and is recorded from there – block time from the start of the recording, no take-off time, departure airport only if within 3 nm, no teleport flag; `VECTASIM_MOCK=circuit` keeps the full circuit from the stand.

### Recording

- G-load over the whole flight: highest and lowest load in the air (0.3 s average, without pauses, slew and the 3 s around each touchdown) with phase and altitude, plus moments above 1.5 g / below 0.5 g – in the flight detail, as a debrief hint when it stands out (above 1.6 g / below 0.4 g, warning above 2.0 g / below 0 g), in the measurement log, the live panel, the overlay API (`maxG`/`minG`), the PIREP and the CSV/JSON exports; older flights get it from their 1 Hz track when opened (logbook schema 16).

## 0.4.0 – 2026-10-19 (Beta)

First beta: X-Plane 12, approach assessment stage 2 with the simulator ILS, lateral tracking, overlay and API server, IVAO and a traffic card with photos, year in review, globe map, English and German UI, installer SimConnect download.

### Integrations

- Discord status works without any setup: the VectaSim Discord application is built in (public Application ID, not a secret); the field for a custom app ID is now only visible under “Custom Discord application (experts)”

### Overlay & API

- New local server for OBS, a second screen and your own tools, *Settings → Overlay & API*: off by default, then only on this PC (`http://127.0.0.1:8095`, port configurable). Status with “running since” and connected overlays; a port in use is reported.
- OBS overlays with a transparent background: `/overlay/hud` (phase, altitude, speed, V/S, heading, remaining, ETA), `/overlay/landing` (20 s after touchdown: landing rate, g, bounces, band, runway) and `/overlay/route` (route, block time, aircraft, phase bar); `?scale=`, `?preview=1`, `?local=1`. Copy the URLs in the panel or open them in the browser; the start page `/` explains everything, including OBS instructions.
- JSON API v1, read-only: `GET /api/v1/status`, `/flight`, `/telemetry`, `/landing`, `/logbook?limit=` and the WebSocket `/api/v1/ws` (telemetry at 2 Hz, events `phase`, `landing`, `flightSaved`, `status`). Docs with examples: `docs/overlay-api.md`.
- “Reachable on the network” opens the server to tablets and phones on your Wi-Fi – only with a random token (show, copy, regenerate); on this PC it still works without. Other websites get no data (CORS localhost only, protection against DNS rebinding), and streamer mode masks registration, callsign and airline here too.

### Map

- World view as a globe instead of a flat Mercator map – on the live map, the track map in logbook/debrief and the countries world map; no more duplicated Canada at the edge, no more inflated Greenland. Zooming in turns the globe into the flat map by itself; follow, 3D altitude profile, airport diagrams and VATSIM layers stay unchanged. New “Globe” switch next to “3D” (Countries view: “Globe” checkbox); the choice applies to all maps and is on by default.

### Installer

- At the end, the installer offers to fetch `SimConnect.dll` from Microsoft right away (official MSFS SDK 0.24.6.0, about 108 MB, SHA-256-verified, only the DLL is kept) – VectaSim then connects to MSFS on its very first start. The question only appears if no suitable DLL or MSFS SDK is present yet; silent and passive installations (including automatic updates) never ask and download nothing. A failed download does not abort the installation; *Settings → Simulator* keeps offering it.
- New headless mode `vectasim.exe --install-simconnect [--check]` (no window; exit codes 0/1/2/3, log `%LOCALAPPDATA%\io.vectasim.app\logs\simconnect-install.log`), which the installer calls for this.

### Online networks

- IVAO alongside VATSIM on the live map: next to “Traffic” in the map bar you choose VATSIM, IVAO or both. IVAO aircraft have an outline in the accent colour, controller dots staffed on IVAO a ring; popups and the online list in the “Dispatch” side panel name the network. The data source is IVAO’s public Whazzup file (no login, fetched at most every 15 s as IVAO requires). Existing installations stay on VATSIM; IVAO is off until you choose it.
- The diagnostics package contains source, age of the last fetch and the last error for both networks.
- Flight card for other traffic: clicking a VATSIM/IVAO aircraft (or its entry in the online list in the “Dispatch” panel) opens a card at the right edge of the map in the style of “Ready”/“After the flight” instead of the previous popup – with callsign, network, airline (from the callsign prefix), type as ICAO code and in plain text, route with airport names, flight rules, planned cruise altitude, current altitude with climb/descent trend, GS, heading, squawk, distance and bearing from your own aircraft, “online for”, expandable route and remarks, and the pilot’s name (VATSIM only, not in streamer mode). The selected aircraft gets an accent ring, stays selected across feed updates and reports “no longer online” before the card closes after 30 s. “Follow” moves the camera with it (cancels following your own aircraft), “Show route” draws the great circle departure → destination as a dashed line; Esc closes.
- Photo in the flight card: if the registration is in the remarks (`REG/DAIZB`) or the callsign itself is one (GA), the card shows a Planespotters photo with the photographer (click opens the page in the browser), otherwise the type silhouette with “no photo (registration unknown)”. Requests go through the same queue as the fleet photos (at most 1 per second), are cached for the session only, never written to the logbook, and are skipped when aircraft photos are off in the settings.
- Settings → Display: the status line names each network separately (“Online traffic: VATSIM on (2,176 pilots, 211 controllers) · IVAO off”) instead of the sum of both networks under “VATSIM”; two checkboxes VATSIM/IVAO switch the networks right there, equivalent to “Traffic” on the map. Settings → Diagnostics shows one row per network with source (host), age of the last fetch (“12 s ago”), counts and status or last error; “Copy diagnostics” includes them. Errors of an IVAO fetch are now also called “IVAO is not reachable” where VATSIM used to be assumed. Footer: “Online traffic VATSIM · IVAO”; the simulator card names X-Plane 12 alongside MSFS 2020/2024.

### Interface
- German UI: the lateral metric is now called „Kurs“ (as in the ILS pair Gleitpfad/Kurs) instead of „Grundlinie“ – hero „Kurs (RMS)“ with the caption „Ablage zur verlängerten Mittellinie in Dots“, bands „auf dem Kurs“ · „leichte Ablage“ · „deutliche Ablage“, key sentence, hints, facts row, trends, dispersion tile and approach card; English texts unchanged.
- README (English/German) reviewed for end users: corrected status, theme names, update signing, Fleet/Discord/overlay wording; new sections System requirements, Your data & privacy, Uninstall, Known limitations; screenshots per language (`docs/screenshots/en|de/`). The countries and landing hints about demo flights now point to the “Demo flights” filter in the logbook instead of a non-existent setting.
- Map and settings polish: other traffic in a muted blue-grey in every theme (own aircraft stays yellow with a ring), traffic split button with keyboard-navigable network menu, follow mode restored after closing the traffic card, base-map labels in the UI language, globe option under Display and dimmed below the flat-map zoom, diagnostics across both columns, X-Plane address folded while automatic detection runs, shorter installer dialog

- The event list of the live view (“Flight” side panel, badge on the tab) now stays complete for the current flight: it used to live in the state of the app root and was empty after every rebuild of the interface (reloading the window, in development every hot reload), while off-block and block time came back from the backend – after a go-around the badge then showed 1. Now it has its own store outside the component tree with a copy in the window session, bound to the provider; up to 200 instead of 40 rows.
- Settings: two evenly filled columns – Simulator, Flight planning and Updates on the left, Integrations on the right; Keyboard and Diagnostics share the last row. Below 1100 px a single column; “Display” and “Data” still full width.
- Logbook → Landings → Trends: the fifth chart (touchdown zone) takes the whole row in the two-column grid instead of standing alone on the left; the number of columns follows the measured width so grid and chart width match.
- Live map and traffic card polish: the traffic flight card no longer covers the selected aircraft or its route (camera fits into the free area beside the card and above the HUD), Follow / Show route sit right under the title, the card takes at most ~45 % of the map and a smaller photo on short windows; the route line is drawn above the traffic; the Dispatch traffic list keeps its order while the pointer is over it (two fixed lines per entry with a chevron); light themes get darker traffic symbols and callsigns (≥ 4.5:1) and a dark ring around the own aircraft; checkboxes in settings rows stay next to their label; Simulator and overlay port save on leaving the field or Enter with a short “✓ saved”, both 1024–65535; the countries map refits the world when switching globe/flat; the installer shows the real data folder instead of `%LOCALAPPDATA%` and tells X-Plane users they can answer “No”.
- Year in review and trends polish: Logbook → Year labels its switches („Zeitraum“, „Format“) with a visible active segment in light themes, hides the year chip in „Letzte 12 Monate“ and shows a single year as text, disables Save/Copy on cards without data (with tooltip and per-card screen-reader labels), renames the exports to „Alle einzeln speichern“ / „Alle als ein langes Bild“, and explains imports, the first recorded flight and the 200-facts window as hint lines; new optional eighth card „Mit Sternchen“ (recorded flights with pause, time acceleration, slew or a position jump; only when there are such flights). Trends: y axis up to the next tick above the data with its unit, no lone „Alle“ chip, legend for the dashed band limits, the „Kurs“ tooltip explained, UTC/local note following the setting, no empty month comparison, sticky first table column, and an empty state with a demo hint and a link to the last debrief.

### Recording

- Future flights record the data for the extended approach rating (track v2): true airspeed (TAS), wind at the aircraft according to the simulator, ILS on NAV 1 (localizer/glide slope present and received, deviations, published glide path angle and course), autopilot/autothrust state, N1, spoilers (surface, lever, armed), angle of attack, number of flap positions and the aircraft’s design speeds VS0/VS1. Older flights stay readable unchanged; these values are simply missing for them.
- SimConnect: a separate 1 Hz definition for this and a one-off one for the design speeds. If the simulator or an add-on doesn’t know one of these variables, only that one drops out – position, speeds and landing detection carry on unchanged. ILS deviations only count when the tuned station has a localizer or glide slope. Raw dumps record the new definitions as well, and the replay plays them back.
- Exports: CSV, GPX, KML and JSON contain TAS and sim wind where recorded (CSV: three new columns at the end, empty for older flights).
- Settings → Diagnostics → Live raw data shows the new values (raw and converted, also in the demo flight); the debrief’s measurement log names TAS, sim wind and ILS of the final approach. The rating itself does not change yet.
- Demo flight: provides wind (250°/8 kt), ILS 25C, autopilot, N1, spoilers and angle of attack, so everything can be checked without a simulator.

### Year in review

- New logbook section “Year”: “Your year 2026” as seven story cards – Overview (flights, block hours, distance in nm and “x times around the Earth”, countries, airports), Your routes (top 5 routes, longest flight, great circles on a Natural Earth world map), Your fleet (types and registrations by hours), Your landings (count, median landing rate, smoothest and hardest landing with runway and date, bands, yearly dispersion plot on the normalised runway with touchdown zone rate), Your approaches (share stable, Ø “stable from”, go-arounds as a decision), Your months (flights and block hours per month, most active month and day) and Your countries (world map, countries visited for the first time highlighted).
- Year selection (years with flights) and a switch calendar year / last 12 months; portrait 1080 × 1920 or landscape 1200 × 675 (PNG 2400 × 1350). Save each card individually (the dialog starts in the card folder, default Pictures\VectaSim) or copy it, “Save all” into a folder, “Save stack” puts all portrait cards one below the other into a single image. Cards without data are skipped in the bulk export.
- Calculated in the frontend from the existing data: imported flights count for hours, routes, fleet, months and countries, not for landings and approaches; demo flights only with “Include demo flights”. The dispersion plot uses the last 200 landings with a known runway (with a note if the year goes further back). Registrations are masked by streamer mode or “Landing card without registration”.

### X-Plane

- **X-Plane 12 as a second simulator** (from 12.1.1, via the built-in Web API – no plugin, no SimConnect.dll): position, altitudes, speeds, V/S, attitude, g, ground, gear, flaps (index from lever and detents), parking brake, fuel and weight in kg, engines, transponder, Zulu time, pause, time acceleration, lights, wind, angle of attack, N1, thrust lever, speedbrake and aircraft (title, ICAO, registration). 10 values per second (the Web API’s maximum); datarefs that an X-Plane version or aircraft doesn’t know stay empty without disturbing the connection.
- Connection: waits for X-Plane (attempt every 5 s), reconnects by itself after a restart, detects an aircraft change; a silent sim (pause) is checked via the REST API instead of being disconnected.
- Landing rate: X-Plane reports no touchdown value – VectaSim takes the last vertical speed measured in the air (source “measured”).
- *Settings → Simulator*: choice of “Automatic (MSFS first, then X-Plane)” (default), “MSFS 2020/2024” or “X-Plane 12”, and host/port of the Web API (default `localhost:8086`; also `VECTASIM_XPLANE_HOST`/`VECTASIM_XPLANE_PORT`, `VECTASIM_PROVIDER=xplane`). Automatic only switches if no MSFS is there for 10 s (or SimConnect.dll is missing) and an X-Plane Web API responds; every switch is logged.
- Diagnostics: source `X-Plane Web API localhost:8086`, X-Plane and API version, data rate and all datarefs raw and converted; raw dumps record X-Plane sessions as well (`source: "xplane"`), and the replay plays them back. The connection rows of the live raw data are labelled per source (DLL, RECV_OPEN, SimConnect version and HRESULTs only for SimConnect).
- Texts: “Waiting for simulator” instead of “Waiting for MSFS” in the status bar and on the ready card.

### Demo

- The demo flight now always lands normally, but with a few small, deliberate mistakes so the debrief has something to show: ≈ 12 kt fast at the FAF (reduced to ≈ +4 kt by 500 ft), ≈ 0.5 dots above the glide path at 1,000 ft (captured by 500 ft, briefly 0.3 dots low below 300 ft), ≈ 90 m (0.6 dots) overshoot of the extended centreline on the intercept followed by a gentle S (2 side changes), landing flaps only at ≈ 1,100 ft, a short float (flare from ≈ 25 ft, ≈ 6 s) and touchdown ≈ 520 m past the threshold (in the touchdown zone, beyond the aiming point), ≈ 9 m right, ≈ −230 fpm, ≈ 1.3 g. The approach stays “stable”, the landing “normal”. Wind, ILS deviations, N1 and angle of attack match the deviations. The go-around, bounce, teleport and reconnect variants are unchanged.

### Languages

- Backend bilingual (DE/EN) according to the setting `language` (`system` = Windows display language): Windows notifications, tray menu and tooltip (flight phases now in English as in the app), Discord status, the startup dialog “logbook not opened”, diagnostics package (`README.txt`, `HINWEISE.txt`/`NOTES.txt`) and the commands’ error messages; logbook errors have stable codes with parameters (`store.flight_not_found`, `store.merge_gap` …); overlays with `?lang=de|en` (default: app language), start page bilingual, `/api/v1/status` with `lang`, `bandLabel` in the app language.
- Countries and year in review bilingual (DE/EN): list, filters, continents, map tooltip and countries PNG, all seven story cards (“Your year 2026”, “Your landings”, “1.8 times around the Earth”), month names via `Intl.DateTimeFormat`, file names per language (`VectaSim_Year_2026_1-Overview_portrait.png`, `VectaSim_Countries_…`); country names and sorting follow the language (German/English name from the country list).
- Live view and map bilingual (DE/EN): HUD (Remaining, ETA, Heading), the “Ready”/“After the flight” cards, side panel Flight/Systems/Events, map bar (Follow, Globe, Traffic, Weather), network choice, the flight card for other traffic including compass points (NO/NE) and photo notes, airfield display and *Settings → Diagnostics → Live raw data*; numbers and limits in texts follow the language’s number format (`4 000 fpm` / `4,000 fpm`), flight phases stay in English.
- Logbook and flight bilingual (DE/EN): flight list with search, filters, tags, trash and merge, flight strips including screen reader text, flight detail (landings, circuits, plan vs. actual, phases, integrity, export menu), notes & tags with rating and corrections, fleet and aircraft selection, activities, landings tab and altitude profile; the PIREP text follows the language (`Flight no.`, `Date 16 Oct 2026 (UTC)`, `Punctuality on time`), the PIREP JSON stays language-neutral (`pirep/v1`, only the integrity findings are text); technical terms such as block time, air time, off-block/on-block, touch-and-go and go-around.
- Language choice in *Settings → Display → Language*: System / Deutsch / English, applies immediately (System = Windows display language). Interface and settings bilingual (DE/EN): sidebar, logbook tabs, title bar, recording status (status button, map pill), toasts and prompts (landing, flight saved, sim gone, resume, quitting during a recording), error messages with the next step, all settings panels (Simulator, SimConnect download, Flight planning, Updates, Integrations, Overlay & API, Display, Data, Keyboard with “Ctrl” shortcuts, Diagnostics), CSV import and SimBrief dispatch; the confirmation word for “Delete all data” per language (LÖSCHEN / DELETE).
- Landing and approach debrief bilingual (DE/EN): key sentence, notes, provenance chips (SIM/MEAS./DERIV. with plain-language tooltips), methodology and measurement log, history, scatter plots, runway editor, replay bar, landing and approach card PNG in the UI language, theme names; import warnings, replay status and download/PIREP errors from the backend in the backend language. Debrief wording: “centreline” for the runway, “extended centreline” for the approach (the key figure *Lateral* – German „Kurs“ – gets a tooltip), German UI “Localizer” instead of “Lokalizer”, an explaining line for RMS/MAD under the approach heroes, a new note for speed above the reference at the FAF/1000 ft (info from +10 kt, warning from +15 kt), S-turns from 2 side changes and landing flaps below 1,200 ft now warnings.

### Security

- Hardening after the security audit: the X-Plane client no longer crashes on a broken chunk size (limit of 4 MiB per response and WebSocket message, overall deadline per request), and auto-detection no longer mistakes another service on port 8086 (e.g. InfluxDB) for X-Plane. The METAR decoder copes with non-ASCII characters. All web requests (VATSIM, IVAO, METAR, Planespotters, SimBrief) now only go over HTTPS, also on redirects, and with a size limit; SimBrief error messages no longer contain the pilot ID. The overlay server has a header timeout (10 s), at most 64 simultaneous connections, a tight 16-client limit for WebSockets and `frame-ancestors 'none'`; in streamer mode the callsign is also masked in the aircraft title of the landing. The SimConnect download aborts a stalled connection (below 1 KiB/s for 60 s, at most 30 min).

### Approach

- Approach rating stage 2 with the track v2 data (future flights; older flights and approaches without ILS stay unchanged with geometry and the 3° assumption): if NAV 1 receives a valid glide slope over at least 60 % of the samples 1000 → 200 ft, the simulator’s ILS is the reference – angle from `NAV RAW GLIDE SLOPE`, deviation from `NAV GLIDE SLOPE ERROR` (“3.0° (ILS)”, chip “SIM”); likewise the localizer from `NAV CDI` instead of the geometry. Both sources appear in the measurement log; if their median differs by more than 0.5 dot, the note “sim ILS and geometry differ (check runway coordinates)” appears, and at more than 1° glide path or 1.5 dots course the ILS counts as foreign (a different ILS tuned) and VectaSim rates geometrically.
- Sim wind on final: head-/crosswind relative to the runway (median 1000 → 50 ft), range as gustiness and change between 1000 ft and the threshold – next to the METAR wind in the debrief, in the approach section and in the measurement log. Notes for tailwind above 5 kt, crosswind above 15 kt and wind shear above 15 kt. The energy uses the simulator’s TAS instead of the ISA approximation.
- New criteria after FSF ALAR BN 7.1 (only with data, otherwise “not measured”): **landing flaps** at 1000/500 ft (the setting entered for the aircraft, otherwise the highest lever position, otherwise the one at touchdown), **thrust** N1 ≥ 40 % below 1000 ft (idle only counts after 5 s and not below 50 ft; piston engines without N1 are excluded), **spoilers** retracted on final (≤ 2 %). They count in the bands like the other criteria. Autopilot and A/THR are shown for information only (“autopilot until 800 ft, then manual”).
- Vapp cascade: the aircraft’s entered Vapp → flown median → 1.3 × the simulator’s VS0 (source “assumption (VS0×1.3)”); the SimBrief OFP contains no approach speed. New field *Fleet → Landing flaps (setting)* per aircraft (e.g. 3 for CONF 3 on the A320).
- Energy 10 nm → 1000 ft as a band (“on profile” / “too high” from +500 ft / “too low” from −300 ft) in the facts block.
- **Approach card** (1200 × 675 PNG) with summary sentence, band, gates FAF/1000/500 with ticks, mini profile (height to the path and speed to the reference), lateral strip, sim wind and wordmark: “save/copy approach card” in the approach section, registration masked in streamer mode; with “save landing card automatically” it is saved next to the landing card after every landing.
- Approach facts in the cache recalculated (version 5), schema 15 (landing flaps per aircraft). The demo flight now delivers the localizer needle at the usual scale (full deflection = 2 dots).

## 0.3.0 – 2026-10-18 (Alpha)

Second alpha: lateral tracking as a dimension of its own in the approach rating, reworked 3D view.

### Map

- 3D view reworked: the band at flight altitude now follows the track sample by sample instead of jumping in 200 ft steps, no more gaps or sawtooth at the segment boundaries; the curtain is more subtle (14 % instead of 22 %) and lies below the labels of airports and places

### Approach
- **Lateral tracking as a metric of its own** next to the glide path: a fourth hero metric *Lateral (RMS)* (“Grundlinie (RMS)”) in the debrief (dots, otherwise metres; source DERIVED) with the largest offset, offset at 500 ft and over the threshold (+ = right); a *lateral* row (“Grundlinie”) with band, overshoot on the intercept and S-turns
- New values in the approach rating (`lateral`): `locMaxDots` (largest offset 1000 → 50 ft), `latAt500M`/`locAt500Dots`, `latAtThresholdM`, `interceptOvershootM`/`-Dots` (opposite side within the first 20 s after “established”), `lateralReversals` (side changes beyond 0.3 dot between 1000 and 100 ft) and `lateralBand` – “on the centreline” (RMS ≤ 0.3 and max. ≤ 0.5 dot), “slight deviation” (RMS ≤ 0.6 and max. ≤ 1 dot = FSF gate), “significant” above that; the finer steps are a VectaSim convention, thresholds in `ApproachConfig`. Not rated without a runway or with a runway derived from the ground track
- The summary sentence names the offset at 500 ft when the approach was not on the centreline; new notes on overshoot (> 0.5 dot), S-turns (from 2/3), offset below 500 ft (> 0.5 dot), offset over the threshold (> 10 m / > ¼ runway width) and on lateral offsets that cannot be rated
- Dispersion plot: tile *Lateral 500 ft* (Ø |offset|); Trends: row *Lateral (RMS)* in dots. The cached approach facts are recalculated once (version 4)

### Interface
- The title bar is part of the surface: same background as sidebar and content, no more dividing line below it; the window buttons only stand out on hover

## 0.2.0 – 2026-10-18 (Alpha)

First public pre-release. Everything below was added since 0.1.0; the interface is German, flight phases English.

### Map

- The flown track is much easier to see: a wider line with a strong outline, and the altitude colours of the dark themes start brighter (Signal now draws the track in cyan instead of grey, Graphit & Amber in amber)
- **3D view** on the live map and on the map in logbook/debrief (switch *3D* in the map bar): the map tilts, and the track stands in space as an altitude profile – a translucent curtain from the ground up to the flown altitude with a coloured band at the altitude itself. Rotating and tilting also works with the right mouse button or Ctrl + drag; the compass shows the tilt

### SimConnect
- *Download SimConnect*: on click, VectaSim fetches `SimConnect.dll` from Microsoft’s official MSFS 2020 SDK download (0.24.6.0, ~108 MB, SHA-256-verified, without installation/admin rights) into `%LOCALAPPDATA%\io.vectasim.app\simconnect\` – works with MSFS 2020 and 2024; Diagnostics shows where the DLL came from (commands `simconnect_download_info`, `download_simconnect`)
- *Set up SimConnect* card in *Settings → Simulator* (progress downloading/verifying/extracting, “Try again” on errors, license note); notices now read “SimConnect is still missing – download it with one click under Settings → Simulator”, the status popover jumps there with *Set up SimConnect*, Diagnostics shows the path and origin of the DLL

### Import
- *Settings → Data → Import → Import CSV …*: bring over flights from other logbooks – the **Volanta import CSV** (13 columns `Origin,Destination,DepartureTime,Duration,…`), VectaSim’s **own logbook CSV**, a **SimToolkitPro** export (no guarantee, columns not documented) or any other table (VA/phpVMS …) with free column mapping
- Dialog in three steps: choose the file (detects format, delimiter `,` `;` tab `|` including Excel’s `sep=` line, encoding UTF-8/with BOM/UTF-16/Latin-1 and the header row), map columns (prefilled from the format and German/English column names; date and time together or separate; formats ISO, `DD.MM.YYYY`, `MM/DD/YYYY`, Unix time; times without a zone as UTC or as this PC’s local time with daylight saving; kg/lb; duration as `H:MM` or a number), preview of the first 20 rows with notes and errors, then import with a result notice. VectaSim remembers the mapping per format
- Imported flights are completed flights without a track (`provider = import:<format>`, simulator “Import”, tags `import` + source such as `volanta`/`stkp`/file name): they count for hours, routes, fleet (the registration creates the aircraft), airports and countries, not for landing analysis, dispersion plot and approach rating. If the distance is missing, VectaSim enters the great circle between the airports; if the arrival is missing, it calculates it from the block time
- A **landing rate from the file** goes into the notes as a line (“Landing rate according to the import file: −142 fpm (not measured by VectaSim)”) – it comes from a different measuring method and is deliberately not stored as a touchdown; likewise a fuel burn without start/end values
- **Duplicates** (can be turned off): same route and off-block less than 15 minutes apart – against the logbook including the trash and within the file. Faulty rows (airport or date missing/unreadable) are skipped with their row number
- Commands `csv_sniff`, `csv_preview`, `csv_import` (only `.csv`/`.txt`, at most 50 MB, 100 rows per transaction); module `vectasim_store::csvimport`

### Integrations
- New panel *Settings → Integrations* (between Flight planning and Display) with Discord, notifications and notification area
- **Discord status** (Rich Presence, off by default): “DLH4YA · EDDF → EGLL · A20N” and “Cruise FL360 · 420 nm to go” / “Approach EGLL” / “Ready – waiting for MSFS”, flight time from off-block; after landing, “Landed · −155 fpm” for one minute; demo and replay appear as “Demo”; no callsign in streamer mode. At most one update every 15 s; if Discord isn’t running, VectaSim quietly retries every 30 s. A custom Discord app ID can optionally be entered (setting `discord_app_id`)
- **Windows notifications** while VectaSim is not in the foreground (on by default): landing with landing rate, g-load and bounces, flight saved, connection to the simulator lost/back (during a flight), update available – each can be turned off, with *Send test*; never with registration or callsign; clicking brings the window to the front
- **Notification area (tray)** (off by default): icon with the status as tooltip and a menu with open, recording status, *Debug mode*, quit; minimising hides the window there, double-clicking opens it again; quitting during a recording asks first as usual
- Settings `discord_presence`, `discord_app_id`, `notifications`, `notify_landing`, `notify_saved`, `notify_connection`, `notify_update`, `tray_minimize`; commands `discord_status`, `notify`, `notify_test`, `set_tray_enabled`, `tray_active`; plugin `tauri-plugin-notification`, crate `discord-rich-presence`

### Notes & tags
- In the flight detail, below the header, the new **Notes & tags** section: your own notes (up to 2000 characters, plain text with line breaks, saved when leaving the field or with Ctrl/⌘+S), tags as chips (Enter or comma adds, Backspace removes the last one, suggestions from the logbook’s tags; at most 20 of 30 characters each, “VATSIM” and “vatsim” count as one tag) and a personal **rating** of the flight with 1–5 stars (also with the arrow keys; rates the flight, not the landing)
- *Correct …*: overwrite a wrongly recorded callsign, departure/arrival (ICAO, 4 characters), aircraft name or registration – logbook, flight strip, search and CSV show the correction, the tooltip the recorded value (“Sim: ASXGS”); the original stays saved, and empty fields restore it. A corrected registration moves the flight to that aircraft (fleet)
- Logbook: the search also finds notes, tags and corrections; new chip filter **Tags** with multiple selection (at least one tag matches); flight strips show up to two tags, the stars compactly (“★4”) and a note icon with the first line as tooltip
- Logbook CSV with the new columns `notes`, `tags` (separated by “; ”) and `rating`; the columns departure, arrival, callsign, aircraft and registration contain the corrections. The full export (`.vectasim`) takes everything along; when merging, an existing flight gets notes, tags, rating and corrections from the file if it has none itself; when merging two parts of a flight, the details of both parts are kept
- Data format v14 (columns `notes`, `tags`, `rating`, `user_callsign`, `user_dep_icao`, `user_arr_icao`, `user_aircraft_title`, `user_registration`), commands `update_flight_user` and `list_tags`

### Streamer mode
- New **streamer mode** (*Settings → Display* or Ctrl+Shift+P, with a short notice): hides registrations (“D-••••”, the country prefix stays), callsign and flight number, airline, the SimBrief ID and your Windows user name in paths (`%LOCALAPPDATA%\…` instead of `C:\Users\<name>\…`) across the whole interface – live HUD and side panel, ready card, fleet, landing debrief, settings and diagnostics. Only the display changes, everything is still saved; photo credits stay visible. A subtle eye icon in the status popover shows the mode and turns it off with one click
- Landing card (PNG) without registration in streamer mode; also, without streamer mode, the switch *Landing card without registration*
- **Save landing card automatically**: after every landing, VectaSim saves the landing card as `VectaSim_<ICAO>_<RWY>_<date_time>.png` into a folder (default `Pictures\VectaSim`, change/open/reset), with a short notice and an open-folder button
- Diagnostics package in streamer mode without user names in paths (JSON files, logs, notes); the README in the package says so

### Countries
- New menu item *Countries* in the sidebar (between Logbook and Settings, Ctrl+3; Settings now Ctrl+4): world map with country borders (Natural Earth 1:110m, same basemap and themes as the live map, zoom 1–6), visited countries in the accent colour, tooltip on hover, legend
- A country only counts as visited through a landing: arrival airport of completed flights (not in the trash, demo only with *Include demo flights*), country from the airport database; updates with every change in the logbook
- List of all 250 countries (ISO 3166 + Kosovo) with ✓/–, landings and last date as a table alternative to the map; progress “n / 250” overall and per continent, continent chips, search (German, English, ISO code), filter visited/open
- Click on a country: first/last landing, airports and the flights there, each opens in the logbook; arrival airports as dots (can be turned off) – also for small states without an outline at 1:110m
- *Save as image*: map with progress line as PNG (`VectaSim_Laender_<date>.png`)
- Commands `countries_list`, `countries_geojson` (embedded zstd-compressed, ≈ 40 KiB) and `visited_countries`; data via `scripts/update-countries.py`

### Performance
- The live map stays smooth even on long-haul flights: the flight path is drawn in segments instead of completely anew every second; logbook map and altitude profile open long flights faster, short peaks (sink rate at touchdown) stay visible
- The airport database starts in milliseconds instead of half a second; in the background or minimised, VectaSim sends to the interface only once per second; the SimConnect connection waits for events instead of polling constantly; tracks are saved every 15 s instead of 60 s
- Graphit & Amber: warnings are now red-orange and can no longer be confused with the accent or errors; map switches look consistent, zoom/compass/source note with focus rings and larger click targets

### Debrief
- Profile, runway view, lateral offset and gate table show the same moment – pointing or clicking in one chart moves all of them; new approach playback (play/pause, 1–8×, slider, jumps to 10 nm/FAF/1000/500 ft/threshold/touchdown/standstill) with the measured values at the cursor; in the logbook the map shows the position at the profile cursor
- Runway from the ground track: if you land at an airfield whose runway has no coordinates in the database (many small airfields, grass strips), VectaSim derives the runway from the approach and rollout, marks it as “derived” and remembers it per airport; further landings refine it
  - Below the runway name it now says where the runway comes from: “runway from OurAirports”, “runway derived from your ground track (n landings)” or “runway set by you”
  - Honest values for derived runways: the touchdown point is shown with “± 50 m”, the centreline deviation is “not measurable” (the axis is your own line, after all), without a known length the touchdown zone is “assumed (0–900 m)” and the rest of the runway is no longer shown; the VectaSim index is then “not comparable”
  - In the dispersion plot such landings appear hollow on the centreline and don’t count towards the Ø centreline; for the approaches, the lateral offset at 1000/500 ft is missing for them
  - New: *Correct runway …* („Piste korrigieren …“) in the landing debrief – enter designation, threshold and end (latitude/longitude in decimal degrees), width and elevation yourself, take the values from the current landing with one click, or forget them again with “Zurücksetzen auf Datenbank” (reset to database); plus the list of the airfield’s remembered runways with origin and number of landings. Your own runway takes precedence over OurAirports, and all landings at the airfield are re-evaluated with it
  - Remembered and user-defined runways are included in the full export (`.vectasim`); when merging, a user-defined runway wins, and two derived ones are averaged by number of landings

- Troubleshooting without a simulator: raw dump of the SimConnect data (*Settings → Diagnostics*, about 5–10 MB per hour), replay of a dump as a data source, live raw data view, **debug mode** and **diagnostics package** (ZIP with logs, dumps, settings without secrets, system and database info) to pass on
- Reliability for the first sim use: log file with rotation (*Settings → Diagnostics → Open log folder*, adjustable log level, “Copy diagnostics”), only one app instance, a prompt when closing or updating during a recording
- SimConnect: a simulator crash is detected and reconnected (watchdog), errors in individual variables no longer stall the telemetry, correct error names, slew/time acceleration without delay, transponder correct, a wider search for `SimConnect.dll` with a list of the searched paths and file selection in the settings
- No more ghost landings: reloading a flight, main menu, teleport and reconnect reset the detection; interrupted flights are closed cleanly; pauses without telemetry are detected; takeoff time from liftoff; block-on only with engines shut down; flag “position jump” in the logbook and export
- Approach rating: a new core module rates every approach on the 1 Hz track (approach attempts including go-arounds, runway assignment without touchdown, gates 10 nm/FAF/1000/500/50 ft, glide path and lateral dots, speed against the flown reference, V/S, bank, configuration, energy proxy, stability measures, “stable from”); EASA two-stage criteria with minimum durations; four bands
- Debrief: “Approach” section with summary sentence, band, three metrics with source, configuration events and exceedances; gate table with five gates and “not measurable” with the reason; approach profile with ranges final/10 nm/from TOD and lateral strip; approach selector; a separate go-around debrief; index share “stabilised approach” from “stable from” + gates
- The landing card shows the reference, “stable from” and the gate result; flight strips show “stable from” and go-arounds; Logbook → Landings has the views “Touchdowns” and “Approaches”
- Cache table `approach_facts` (schema 8), commands `approach_analysis` and `approach_facts_recent`, computed at flight end; mock variant `VECTASIM_MOCK=goaround`
- Sidebar reduced to three entries (Map, Logbook, Settings; Ctrl+1/2/3); fleet and activities are now the logbook sections *Aircraft* and *Airports*, plus *Landings*
- Logbook rows as flight strips: callsign/type, route with block times, integrity marks (pause, slew, time acceleration), landing rate with runway glyph and touchdown point
- Landing card as PNG (1200×675) from the debrief and the landing toast: save or copy to the clipboard
- Dispersion plot of the last 20 landings in the logbook section *Landings*: normalised runway, band colours, 1σ ellipse, TDZ rate, sparkline, filter by type/airport; results are cached in the table `landing_facts` (schema 7)
- “Ready” card on the live map before the flight: connection status, loaded flight plan, detected or last flown aircraft, demo start without a simulator
- The SimBrief flight plan is loaded automatically with a stored pilot ID (start and connect, at most every 5 minutes; setting *Flight planning*)
- Side panel of the live map reduced to two tabs: *Flight* (previously Flight, Systems, Events) and *Dispatch* (previously Flight plan, Online)
- Demo flights are now only session guests: when the demo ends and at the next start they are deleted, together with aircraft created only by them

### Ranking & trends

- *Ranking* (“Einordnung”) in the flight detail (below the landing summary): a sentence “Your last 20 landings on EDDF 25C: median −180 fpm · you: −155 fpm (better than 70 %)” and three tiles landing rate, touchdown point and “stable from” – each actual vs. median with distance and percentile; switch *same runway / same type / all* (automatically the narrowest selection with at least three comparison landings); below three landings only the note “not enough landings to compare yet”
- The *After the flight* card shows a line “better than 70 % of your last 20 landings on EDDF 25C”
- New tab *Logbook → Landings → Trends*: landing rate (absolute), touchdown distance, “stable from” and share in the touchdown zone per landing, week or month with a rolling median (window 5 or 10 landings, 3 periods) and quartile band; filter type, airport and period (last 20/50/200); tiles “this month vs. last month” with Δ; all values also as a table
- *Circuits* in the flight detail from two ground contacts: every touch-and-go and the full stop as a row (time, kind, landing rate, g, bounces, touchdown point and “stable from” where evaluated) with a mini trend of the landing rates; a click opens the landing debrief of that contact
- Missing values (centreline, unrated approach) are left out of median and rates; demo landings only count in comparison with demo landings or when demo flights are shown

### Plan vs. actual

- New section *Plan vs. actual* in the flight detail as soon as a SimBrief flight plan is attached to the flight: plan, actual and deviation for off-block, takeoff, landing and on-block, taxi out/in, block and air time, fuel at off-block, trip fuel, block fuel, landing fuel, distance and cruise altitude
- Punctuality by airline definition: up to 15 minutes after plan counts as “on time”, otherwise “delayed” (at on-block; without an arrival, at off-block)
- Trip fuel comes from the track (fuel at liftoff minus at touchdown); without a track it is estimated from the block fuel minus the planned taxi fuel and marked with “≈”
- The live view (*Flight → actual vs. plan*) calculates with the same rules and now also shows the deviation at off-block, takeoff and landing
- *Dispatch* additionally shows planned taxi times, taxi fuel, reserve, alternate and contingency
- PIREP: *Export flight → Copy PIREP as text* puts a report for VA forms on the clipboard (callsign, flight number, route, times in UTC, block/air time, distance, fuel, landing rate, g-load, bounces, “stable from”, punctuality, integrity, sim, aircraft, registration); *Save PIREP as JSON …* writes the same details to a file (schema `pirep/v1`)
- The logbook CSV has six new columns at the end: `sched_out`, `sched_in`, `delay_out_min`, `delay_in_min`, `planned_block_s`, `planned_trip_kg`

### After a crash

- **Resume flight:** if VectaSim or the simulator crashes mid-flight and you are back nearby afterwards (last recording at most 30 minutes old, at most 5 nm and ±3000 ft away, in the air or not yet shut down), VectaSim asks “Resume flight?” on connecting, with route and off-block time. *Resume* appends the rest to the interrupted flight – off-block and takeoff time, route, fuel and landings keep counting, and the break appears as a recording gap in the flight; *New flight* or no answer within 60 seconds leaves the rest as a flight of its own. Demo and replay don’t ask
- **Merging afterwards:** if an interrupted flight is followed within 60 minutes and at most 5 nm away by another one, the logbook shows “… is probably the continuation of …” above the list with *Merge*: times, track, landings, distance, fuel and integrity marks become one flight, flight plan, weather and aircraft come from the first part (missing items from the second); the second part goes to the trash in full. *Ignore* hides the notice
- Flight strips show “interrupted” with an explanation and the distance to the next flight in the tooltip; resumed or merged flights carry the mark “⋯” with the length of the gap
- Technical: schema 13 (column `flights.gap_ms`, `integrity.gapMs`), events `flight:resumable` / `flight:resumed`, commands `resume_flight`, `list_merge_candidates`, `merge_flights`

### Data safety
- SQLite updated to 3.53.2 (rusqlite 0.40.2 / libsqlite3-sys 0.38.2, previously 3.46.0) – fixes CVE-2025-6965
- Map library MapLibre GL JS updated to 6.12 (fixes the XSS vulnerability GHSA-jrc7-96c5-q579 from 5.x); CI now checks the frontend dependencies with `npm audit`
- More security: the app now only loads content from known sources, and when the CSV logbook is opened in Excel, aircraft names or callsigns are no longer executed as formulas
- A changed system clock (DST change, synchronisation) no longer confuses phase and landing detection; time acceleration is treated consistently for phases and landings

- Data format migrations run step by step, each in a transaction; beforehand VectaSim copies the logbook to `vectasim-pre-v<old>-<date>.db` in the backup folder. If a step fails, the file stays unchanged
- A logbook from a newer VectaSim version is no longer opened (instead of continuing to write to it with the old version); errors on opening show a dialog with the paths of the database and the backup instead of the window disappearing
- Trash: deleted flights stay restorable for 30 days (toast with undo, logbook filter *Trash*); totals, fleet, landings, approaches and airports no longer count them (schema 10, column `deleted_ms`); confirming a delete with the focus on *Cancel*
- *Settings → Data*: database location, freely selectable backup folder (e.g. OneDrive/Dropbox/NAS, with a note), daily automatic backup and before every update, 7-day rotation, *Back up now*, *Restore* with restart, *Empty trash*, *Delete all data* (two-stage, with a backup beforehand); a warning if the database is in a sync folder
- Full export/import: *Settings → Data → Export everything …* writes the whole logbook (flights with tracks, fleet, your own aircraft images; trash on request) into a `.vectasim` file; *Import from file …* merges it (duplicates – the same flight or the same route with less than 15 min difference at off-block – are skipped, existing aircraft data is kept) or replaces the logbook after a backup (`vectasim-pre-import-…`). For moving to another PC or merging two PCs
- Writing commands (flight export, logbook CSV, landing card, full export, diagnostics package) only accept complete paths without `..` with a matching file extension, and never in Windows, program or installation folders (“path not allowed”)
- Track loading, exports, logbook list and landing dispersion plot run outside the UI thread; the logbook only checks a count every 30 s (`flight_summary_counts`) and reloads the list only on changes
- The diagnostics package counts flights in the trash separately (`flightsDeleted`)

### Domain corrections

- The speed at the gate is checked against a real reference (your own Vapp, otherwise the flown mean 500 → 100 ft, otherwise 1.3 × VS0) instead of against itself; the source is shown in the debrief
- Glide path tolerance at the gate now ±0.35° (1 dot) instead of ±0.7°; more than 2 dots is named as level S2
- The touchdown zone starts at the threshold (up to 900 m or the first third of the runway); the aiming point (150–400 m depending on runway length) is only a marker now – a landing at 200 m is now “in the touchdown zone”
- Displaced thresholds from OurAirports are taken into account; an unknown runway width is shown as “width unknown” instead of “0 m”; centreline distance rounded to whole metres (runway data accurate to about ±5 m)
- METAR: a note if the report was observed more than 1 h before or after the landing; with VRB or a direction range, additionally the most unfavourable crosswind; gusts in the wind line
- Wake turbulence categories per ICAO: TBM, PC-12, Caravan, Twin Otter, Beaver, King Air, Phenom 100, Citation CJ/M2, Premier as Light; C-130 and UH-60 as Medium; Concorde as Heavy
- VectaSim index: “normal” counts as much as “smooth”, touchdown point rated by the new zone; without runway, runway width or gate it is “not comparable” instead of showing a partial value
- g-band “hard” only from 2.0 g (previously 1.75 g) – reasoning in the methodology
- Terms (German UI): “Aufsetzzone” (touchdown zone), “Mittellinie” (centreline), “Piste” (runway), unit “g”, “Luftzeit” (air time) instead of “Flugzeit” (flight time) (also the export column `air_time`); altitudes above 5000 ft as flight level; no more “20 Hz” statements
- A bounce only from 0.3 s without ground contact – a short flicker on grass or on one gear leg is no longer a bounce

### Interface

- Before the flight the ready card leads: the status pill on the map then only says “Waiting for MSFS”, the phase tile no longer shows a second “Ready”; without the ready card the pill reads “Waiting for MSFS – recording starts when you taxi”
- The demo is called “demo flight” everywhere (*Start demo flight* / *Stop demo flight*); *Stop demo flight* is now always available, and afterwards the demo’s aircraft, events and the counter on the “Flight” tab disappear from the map
- Logbook filter “completed” instead of “saved” (all flights are saved), also in the totals bar and on the flight
- After landing: the debrief has a button at the top to open the flight in the logbook next to *Close*; the *After the flight* card has *Landing card* to save it as an image; the image action is called “save landing card” / “copy landing card” everywhere
- Logbook at around 1100 px window width: the callsign column adapts (truncated only from 110 px), route on one line, badges after date and block time, times and “stable from” only when there is room (always in the tooltip); aircraft list without a horizontal scrollbar; toolbar without wrapping (narrower search, short *Export* below 1200 px)
- Setting *Display → Weights*: fuel and weights in kg or lb
- Vapp per aircraft (*Logbook → Aircraft → details*): the approach and landing analysis uses it as the reference speed (“Vapp 138 kt (entered)”), otherwise the flown value as before (schema 11)
- Error states: if loading the logbook fails, there is *Try again* instead of an endless “loading”; flight detail and landing debrief also offer *Try again*; if the map doesn’t load (offline), a pill says “Map offline – tracking continues”; if the *Traffic* switch fails, a notice explains why
- Installation guide: no fixed Hz figure any more, SimBrief autoload described correctly
- Keyboard and screen reader: the landing debrief is a real window within the window – Tab stays inside, Esc first closes an open source note, shortcuts no longer act behind it; notices (toasts) are read out reliably and reachable with Alt+T; dispersion plots can be stepped through with the arrow keys and expanded as a table; all shortcuts are listed under *Settings → Keyboard*
- Window: can be dragged smaller (from 1024 × 640), VectaSim remembers size, position, monitor and maximised state; the interface can be enlarged with Ctrl+Plus/Minus (Ctrl+0 to reset, also under *Settings → Display → Size*)
- When switching between map, logbook and settings everything stays as it was: map view, search, filters, selection and scroll position in the logbook, position in the settings; a dismissed ready card stays hidden until the next flight

## 0.1.0 – 2026-10-17

First version – phase 1 (MVP).

- Live map (MapLibre/OpenFreeMap) with aircraft, altitude-coloured track, airports (OurAirports), airport diagram when zooming in, VATSIM traffic/ATC, METAR badges
- Flight phase detection, touchdown detector by fixed, documented rules (sim value, V/S fallback, worst of bounces, AGL corroboration), flight summary with integrity flags
- Local SQLite logbook with compressed tracks, profile chart, export (CSV/GPX/KML/JSON), fleet, visited airports
- SimBrief dispatch with planned route and OFP vs. actual
- Landing debrief: runway top view with touchdown point, approach profile, stabilised approach checklist, stored METAR
- Interface with icon sidebar, full-screen map, side panel, logbook (list/detail), demo mode
- Automatic updates via signed GitHub releases
