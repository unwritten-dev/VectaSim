# Installing VectaSim (Windows, sim PC)

The ready-made installer from GitHub Releases gets automatic updates and is the normal way to install. If you want to build from source yourself, see [DEVELOPMENT.md](../DEVELOPMENT.md).

The app runs in English or German. By default it follows your Windows display language; you can change it under *Settings → Display → Language* (System / Deutsch / English, applies immediately). The installer dialogs are bilingual as well.

## Requirements on the sim PC

- Windows 10/11 64-bit, WebView2 (included in Windows).
- MSFS 2020 or 2024 (Store or Steam) **or X-Plane 12.1.1+** (via its built-in Web API, see [X-Plane 12](#x-plane-12)).
- **SimConnect.dll** (MSFS only) – the connection to the sim. It is part of Microsoft’s **MSFS SDK** and may not simply be redistributed with VectaSim; the installer or VectaSim therefore fetches it from Microsoft’s server on request (see below). If the SDK is already installed, VectaSim finds the file on its own.

### Providing SimConnect.dll

**During installation:** If the DLL is missing, the installer asks at the end: “VectaSim needs Microsoft’s SimConnect library. Download it now?” With *Yes* it downloads the same official SDK as the button in VectaSim (see below), verifies it and keeps only `SimConnect.dll`; VectaSim then connects on its very first start. If a suitable DLL is already present (earlier download, installed MSFS SDK), it doesn’t ask. A silent (`/S`) or passive installation (`/P`, also used by automatic updates) never asks and never downloads anything without consent. If the download fails (no network, checksum mismatch), the installation still completes – VectaSim then offers the download again under *Settings → Simulator*. Log: `%LOCALAPPDATA%\io.vectasim.app\logs\simconnect-install.log`.

**Later in VectaSim:** When VectaSim reports “SimConnect is still missing”, *Settings → Simulator* shows the *Set up SimConnect* card (the status icon in the sidebar takes you straight there via *Set up SimConnect*). One click on *Download SimConnect* is enough; a progress bar shows the steps (downloading, verifying, extracting), after which VectaSim reports “SimConnect set up”. VectaSim downloads the official MSFS 2020 SDK (Core, version 0.24.6.0, about 108 MB) from `sdk.flightsimulator.com`, verifies it, takes out only `SimConnect.dll` and stores it under `%LOCALAPPDATA%\io.vectasim.app\simconnect\` – without admin rights and without installing anything. The download is subject to the [MSFS SDK license terms](https://docs.flightsimulator.com/html/Introduction/SDK_EULA.htm). The file works with MSFS 2020 **and** 2024; VectaSim then connects on its own.

Without the button, you can also go through the SDK in the sim:

1. In the sim, turn on **Developer Mode** under *Options → General → Developers*.
2. In the new menu bar at the top, choose *Help → SDK Installer* and install the SDK.
3. VectaSim keeps searching automatically and connects as soon as the file is there.

If the file is already somewhere else (e.g. from an older SDK installation): *Settings → Simulator → SimConnect.dll → Choose file …* and select `SimConnect.dll`. VectaSim retries the connection immediately. *Reset* switches back to automatic search.

*Settings → Diagnostics* shows which DLL was found and where it came from (downloaded, MSFS SDK, chosen manually …) – and, if none was found, which locations were searched. The search order is: chosen file or `VECTASIM_SIMCONNECT_DLL` → downloaded DLL → next to `vectasim.exe` → `%MSFS2024_SDK%`/`%MSFS_SDK%` → by name in the app folder and System32 (not the current folder or `PATH`; the SDK’s default folders in the drive root are only used through those variables). A DLL on a network share (`\\server\share`) is refused; mapped drives work.

## X-Plane 12

VectaSim reads X-Plane 12 through its **built-in Web API** (REST + WebSocket, X-Plane 12.1.1 and later) – no plugin, no SimConnect.dll.

1. **Leave the Web API on.** From 12.1.1 it is on by default and listens on port **8086**; X-Plane offers it to programs on the same PC. According to the X-Plane documentation, only one setting turns it off: in *Settings → Network*, **“Disable Incoming Traffic”** must *not* be selected (otherwise X-Plane answers “403 Forbidden”, and VectaSim reports this in Diagnostics). The command-line option `--no_web_server` also turns it off.
2. **Different port** (only if 8086 is taken): start X-Plane with `--web_server_port=8088` and enter the same port in VectaSim under *Settings → Simulator → Adjust X-Plane address …* (or `VECTASIM_XPLANE_PORT=8088`).
   **Host:** the default `localhost` (this PC) is what you normally want. VectaSim also accepts an address in your local network (192.168.x.x, 10.x.x.x, 172.16–31.x.x, link-local, 100.64.x.x as used by Tailscale, IPv6 local addresses) or a host name such as `simpc`; it refuses a public IP address, because the X-Plane Web API is unencrypted and has no password. Another PC only works if X-Plane’s Web API on that PC can be reached from the network – X-Plane itself serves it to the same PC. With `VECTASIM_XPLANE_HOST`, a public or invalid host is ignored: VectaSim writes a warning to the log and connects to `localhost`.
3. *Settings → Simulator → Simulator*: **“Automatic (MSFS first, then X-Plane)”** (default) finds X-Plane by itself: if no MSFS shows up within 10 s (or SimConnect.dll is missing) and an X-Plane Web API responds, VectaSim connects to X-Plane. If you only fly X-Plane, choose **“X-Plane 12”** – then SimConnect is not even tried.
4. Start X-Plane and load a flight. The map shows “Ready”; *Settings → Diagnostics* names `X-Plane Web API localhost:8086` as the source and shows the data rate (≈ 10/s).

Limitations: the Web API delivers values at most **10 times per second** (MSFS: every sim frame) and has no “touchdown value” – the landing rate is therefore the last vertical speed measured in the air (source “measured”), accurate to about ±50–100 fpm. **This PC or your local network only**: VectaSim normally runs on the same PC as X-Plane; public addresses are refused (see step 2).

## Installer from GitHub Releases

1. Open the latest version under https://github.com/unwritten-dev/VectaSim/releases and download `VectaSim_<version>_x64-setup.exe`.
2. Run the installer. Windows SmartScreen reports an “unknown publisher” (no code-signing certificate yet) → *More info → Run anyway*. The installer needs no admin rights (per-user installation).
3. At the end, the installer asks whether to fetch SimConnect.dll from Microsoft – one click, about 108 MB (see above; if the MSFS SDK is already installed, the question is skipped). You can also do this later in VectaSim under *Settings → Simulator → Download SimConnect*.
4. Start VectaSim, start MSFS – as soon as the sim is in the main menu, the ready card on the map shows “Ready”; recording starts when you taxi. Without a simulator: *Start demo flight* on the ready card – an approach into Frankfurt that starts in the air on the downwind (EDDF 25C, landing after ≈ 4 min, then a new round every 5 min). It is recorded from the start in the air: block time from there, no take-off time and no departure airport (the downwind is more than 3 nm from the airport). The demo flight lands normally, but with a few small, deliberate mistakes (a little fast at the FAF, slightly high at 1,000 ft, overshooting the extended centreline on the intercept followed by a gentle S, touchdown ≈ 520 m past the threshold and ≈ 9 m right of the centreline at ≈ −230 fpm), so the debrief shows what it assesses.

VectaSim only ever runs once: starting it a second time brings the open window to the front.

The installation folder (`%LOCALAPPDATA%\VectaSim\` by default) also contains `LICENSE.txt` (VectaSim’s MIT license) and `THIRD-PARTY-NOTICES.md` (licenses of the libraries, fonts, data and services VectaSim uses).

**Notification area (tray):** by default VectaSim puts an icon in the notification area, and both minimising and closing the window (X) keep it running there – recording included. Double-click the icon to open the window again; its menu shows the recording state, switches debug mode and quits the app with *Quit* (during a flight VectaSim asks first). Under *Settings → Integrations → Notification area (tray)* you can turn off the icon, or let the X button quit VectaSim instead.

**Window:** the window can be made as small as 1024 × 640 and reopens at the size and position you last used (also on a second monitor); Ctrl+Plus/Minus makes the whole interface larger or smaller, Ctrl+0 resets it to 100 %.

**Countries:** *Countries* in the sidebar (Ctrl+3) colours every country you have landed in – only the arrival airport of completed flights counts, demo flights only while the *Demo flights* filter chip in the logbook is on. Clicking a country lists the flights there; *Save as image* saves the map as a PNG.

**Updates:** installed apps announce a new release at the next start (toast “Update available”) or via *Settings → Updates*, and install it after you confirm. Installing restarts VectaSim – so during a recorded flight, an update can only be installed after the flight.

**Quitting during a flight:** VectaSim asks first. If you quit anyway, the flight is saved in the logbook as “interrupted”.

## First flight – in brief

1. VectaSim is running, MSFS is in the main menu → the “Ready” card on the map shows simulator, flight plan and aircraft; recording starts when you taxi.
2. Optional SimBrief: enter your pilot ID under *Settings → Flight planning* – from then on your latest flight plan is loaded automatically at start and when connecting (side panel → *Dispatch* to reload). The route appears dashed, and plan vs. actual is compared.
3. Fly. After touchdown: landing toast → “Landing debrief”. After on-block: the *After the flight* card with *Landing debrief*, *Landing card* (PNG to share) and a button to open the flight in the logbook.
   Under *Settings → Display* you can have the landing card saved automatically after every landing (default folder `Pictures\VectaSim`). If you stream, turn on **streamer mode** there or with Ctrl+Shift+P: registrations, callsigns, airline and SimBrief ID are then hidden everywhere. Everything is still saved in full – only the display, the landing card and the diagnostics package are masked. (Your Windows user name in file paths is always left out of the diagnostics package, with or without streamer mode.)

   **Correcting a runway:** if a runway is wrong (many small airfields have no coordinates in OurAirports; VectaSim then derives them from your ground track), click *Correct runway …* (German UI: „Piste korrigieren …“) under the runway name in the landing debrief and enter the threshold and end in decimal degrees – or take them from the current landing with one click. Your runway takes precedence over the database and applies to all landings at that airfield; *Reset to database* undoes it.
   **Notes & tags:** in the logbook, below the header of every flight, the *Notes & tags* section holds your own notes, tags and a rating of 1–5 stars; with *Correct …* you overwrite a wrongly recorded callsign, airport, aircraft name or registration – the original value stays saved and appears in the tooltip. The logbook search also finds notes and tags, and the *Tags* filter shows only flights with the selected tags.
   **Integrations:** under *Settings → Integrations*, VectaSim can show your flight as your Discord status (route, type, phase, flight time; without callsign in streamer mode), report landings, saved flights, connection losses and updates as Windows notifications while the window is in the background, and keep running in the notification area (tray, see above) when the window is minimised or closed. The Discord status needs no setup: VectaSim registers with the local Discord client as the application “VectaSim”; in Discord, activity sharing must be allowed under *Settings → Activity Privacy*. If you want to use your own Discord application, enter its Application ID under *Custom Discord application (experts)*. Notifications only carry the app’s name and icon in the installed VectaSim, and clicking one brings the window to the front only while it is still on screen (not from the Action Center).
4. If something isn’t detected: *Settings → Diagnostics* shows the data rate (if it doesn’t count up, no data is coming from the sim) and the DLL that was found.

**After a crash** (VectaSim or the simulator): restart both and load the flight at the same spot – if you are back within 30 minutes and 5 nm, VectaSim asks “Resume flight?”, and *Resume* turns it into a single flight again. If you missed that, the logbook offers *Merge* for the two parts above the list; the second part then goes to the trash.

## If something goes wrong

Open *Settings → Diagnostics*:

- **Copy diagnostics** puts all lines (version, status, DLL, paths, message) on the clipboard – for pasting into a GitHub issue.
- **Open log folder** shows `vectasim.log` in Explorer (`%LOCALAPPDATA%\io.vectasim.app\logs\`). The file is rotated at 5 MB, and at most 5 files are kept. Please attach the file to a bug report.
- Set the **log level** to *Verbose* if support asks for it, reproduce the problem, then set it back to *Normal*.
- Turn on **Debug mode**, reproduce the problem and then click **Create diagnostics package**: VectaSim saves a ZIP file (suggested location: the desktop) with logs, settings and simulator recordings that you send to the developer. Passwords and keys are not included, the SimBrief ID is masked, and your Windows user name in file paths is always replaced (`%USERPROFILE%`, `%APPDATA%` …); streamer mode additionally hides registrations and callsigns and leaves out the raw recordings. After troubleshooting you simply turn debug mode off again.

## Data

Everything is stored locally under `%APPDATA%\io.vectasim.app\` (`vectasim.db` = logbook, `airframes\` = your own aircraft images), the logs under `%LOCALAPPDATA%\io.vectasim.app\logs\`. No account, no cloud. Network access: OpenFreeMap (map), EOX `tiles.maps.eox.at` (satellite imagery, only while “Satellite” is on), RainViewer `api.rainviewer.com`/`tilecache.rainviewer.com` (precipitation radar) and EUMETSAT `view.eumetsat.int` (clouds) – both only while that weather layer is on, every 10 minutes – aviationweather.gov (METAR, only airports in view; if it fails and VATSIM is switched on, `metar.vatsim.net` – with VATSIM off, no VATSIM server is contacted), VATSIM feed and IVAO Whazzup (only when “Traffic” is on for that network), SimBrief (at start and when connecting to the sim, if a pilot ID is set; can be turned off under *Settings → Flight planning*), Planespotters.net (aircraft photos, can be turned off), GitHub (update check), Microsoft `sdk.flightsimulator.com` (only for the SimConnect download), and the local Discord client (only with the Discord status on).

### Backups, restore, trash (*Settings → Data*)

- **Backups** go to `%LOCALAPPDATA%\io.vectasim.app\backups\` by default, as plain SQLite files (`vectasim-<date>-<time>.db`, time in UTC). With **Change …** you pick a different folder – a folder in OneDrive, Dropbox, Google Drive or on a NAS is ideal, because then a copy exists outside this PC. The database itself stays local: sync services can damage an open SQLite database (WAL), and VectaSim warns you if it is in such a folder anyway.
- **Automatic**: once a day (shortly after start, checked hourly, never during a recording), before every update (`vectasim-pre-update-…`) and before every data format migration (`vectasim-pre-v<old>-…`). Kept are the last 7 days (one backup per day), the last 5 backups made before update/restore/delete, and all backups made before data format migrations. VectaSim does not touch other files in the folder.
- **No extra compression**: the tracks – the largest part of the logbook – are already zstd-compressed; this way every backup stays readable with any SQLite tool.
- **Restore** (from the list or *Restore from file …*, e.g. on a new PC from the OneDrive folder): VectaSim checks the file (`PRAGMA integrity_check`, data format not newer than the app), backs up the current state (`vectasim-pre-restore-…`) and restarts; the file is replaced during startup. This is not possible during a recording.
- **Trash**: *Move to trash* in the logbook keeps a flight in the trash for 30 days (toast with an undo button, *Trash* filter in the logbook with restore and permanent delete). VectaSim removes older entries at startup.
- **Moving / merging two PCs**: *Export everything …* writes a `.vectasim` file (a ZIP with all flights including tracks, the fleet and your own aircraft images; with *Include trash* also the deleted flights). On the other PC, choose *Import from file …*: **Merge** (default) takes over only what is still missing there – a flight with the same ID, or with the same route and less than 15 minutes difference at off-block, counts as already present; existing aircraft data is only supplemented, never overwritten. **Replace** first backs up the existing logbook (`vectasim-pre-import-…`) and then replaces all flights and the fleet. VectaSim then recalculates the landing and approach analyses. Demo flights are not exported.
- **Flights from other logbooks** (*Import → Import CSV …*): reads Volanta’s import CSV, VectaSim’s own logbook CSV, a SimToolkitPro or VA export, and any other CSV/TXT file up to 50 MB. VectaSim detects delimiter, encoding and format and suggests a column mapping; you check it, choose the date format, time zone (UTC or this PC’s local time) and kg/lb, and see the first 20 rows with notes before anything is written. Imported flights have no track: they count towards hours, routes, fleet and countries, while landing analysis and dispersion plot stay empty for them; a landing rate from the file goes into the notes. Flights that already exist (same route, off-block less than 15 minutes apart, also in the trash) are skipped. You find imported flights in the logbook via the tag `import`; before a large import, *Back up now* is worth it.
- **Delete all data** removes all flights and the fleet after two confirmations; a backup is made first (`vectasim-pre-wipe-…`). Settings are kept.
- **Data format**: migrations run step by step, each in a transaction – if one fails, the file stays unchanged, and at startup VectaSim shows a dialog with the paths of the database and the backup instead of closing silently. An older VectaSim version does not open a logbook from a newer version (hint: install the new version).
