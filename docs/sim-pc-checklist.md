# Checkliste: erster Test auf dem Sim-PC

Alles unten ist bisher nur gegen den Mock-Provider und per Unit-Tests abgesichert und muss einmal live gegen MSFS bestätigt werden.

## Vorbereitung
- [ ] `SimConnect.dll` auffindbar: MSFS SDK installiert (`MSFS_SDK`/`MSFS2024_SDK` gesetzt) **oder** DLL neben `VectaSim.exe` **oder** `VECTASIM_SIMCONNECT_DLL=<Pfad>`. Die App zeigt sonst einen roten Banner mit den durchsuchten Pfaden.
- [ ] `RUST_LOG=info` setzen und die Konsole mitlaufen lassen (`npm run tauri dev` oder Debug-EXE).

## SimConnect-Verbindung
- [ ] Verbindung kommt zustande, `sim:status` zeigt Sim-Name/Version aus `SIMCONNECT_RECV_OPEN` (MSFS 2020 **und** 2024 testen).
- [ ] Keine `SimConnect exception …`-Logs beim Registrieren der Definitionen. Falls `NAME_UNRECOGNIZED`/`INVALID_DATA_TYPE`: betroffene SimVar/Unit in `FAST_VARS`/`SLOW_VARS`/`STATIC_VARS` prüfen (Kandidaten: `TRANSPONDER CODE:1` mit `bco16`, `IS SLEW ACTIVE`, `GEAR TOTAL PCT EXTENDED`).
- [ ] Tatsächliche Rate des `SIM_FRAME`-Requests messen (Frames-Zähler im Footer): Erwartung 30–60 Hz. Falls sie in dichtem Live-Traffic auf ~1 Hz fällt → `VISUAL_FRAME` testen.
- [ ] Sim beenden → `Disconnected (simulator quit)` → App verbindet nach Neustart des Sims automatisch neu (Backoff 2→30 s).
- [ ] Sim starten, **nachdem** die App läuft → Verbindung kommt ohne Zutun.
- [ ] PC in Standby und zurück: Verbindung überlebt oder stellt sich wieder her; kein Phasensprung.

## Datenqualität
- [ ] `ATC MODEL`/`ATC TYPE` liefern bei Default-Flugzeugen `TT:ATCCOM…`-Tokens → Mapping Title→ICAO-Typ nötig. Bei Add-ons (PMDG, Fenix, FBW) Werte notieren.
- [ ] `PLANE TOUCHDOWN NORMAL VELOCITY`: Vorzeichen und Größenordnung gegen die gemessene V/S vergleichen (Landebericht zeigt beide). Erwartung: Sim-Wert positiv-down in ft/s ×60, Detektor normalisiert auf negativ.
- [ ] Landerate gegen ein zweites Tool (MSFS Landing Inspector, FLARE, Volanta) vergleichen – Abweichung dokumentieren.
- [ ] `G FORCE` am Touchdown plausibel (1.1–2.0), keine Ausreißer bei niedriger FPS.
- [ ] `SIM ON GROUND` flackert nicht beim Rollen (sonst Hysterese im Detektor nötig).
- [ ] Fuel/Weight in kg plausibel (Umrechnung aus pounds).
- [ ] `ZULU TIME` korrekt; `SIMULATION RATE` reagiert auf Zeitraffer (Integritäts-Flag erscheint).

## Phasen
- [ ] Kompletter Flug: Preflight → (Pushback) → Taxi out → Takeoff → Climb → Cruise → Descent → Approach → Final → Landing → Taxi in → Shutdown, ohne Rücksprünge.
- [ ] Pushback mit Standard-Pushback und mit GSX: wird er erkannt oder als Taxi gewertet?
- [ ] Touch-and-go im Platzrundenflug: Landing → Climb, Landebericht mit `touchAndGo`.
- [ ] Pause im Flug: Phase bleibt, Integritäts-Flag zählt.
- [ ] Flugzeug im Menü wechseln / Flug neu laden: `AircraftLoaded` kommt, Static-Daten aktualisieren sich, kein Geister-Touchdown.
- [ ] Slew über den Flughafen ziehen: kein Flugstart, Flag `slewDetected`.

## Ressourcen
- [ ] RAM der App (Task-Manager, alle Prozesse zusammen) idle und mit Karte später: Ziel < 150 MB / < 300 MB.
- [ ] Keine spürbaren Stutter im Sim; CPU der App < 2 % im Flug.
