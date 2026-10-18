# Erster Test am Sim-PC – Anleitung

Ziel des Tests ist nicht „alles funktioniert“, sondern **von jedem Szenario ein Roh-Dump, das Log und eine Notiz** mitzubringen. Fehler werden danach am Entwicklungsrechner per Replay nachgestellt und behoben. Die Reihenfolge einhalten – jeder Schritt baut auf dem vorigen auf. Pro Schritt die Uhrzeit notieren; das erleichtert die Zuordnung im Log.

Alles unten wurde bisher nur gegen den Mock-Provider und per Unit-Tests abgesichert und muss einmal live gegen MSFS bestätigt werden.

## Vorbereitung

- Protokoll-Tabelle anlegen: Zeit · Sim (2020/2024) · Flugzeug · Szenario · erwartet · beobachtet · Dump-Datei.
- Unter *Einstellungen → Diagnose* den **Roh-Dump** einschalten (pro Flug eine Datei) und das Log-Level auf `debug` stellen.
- Pfade: Logs `%LOCALAPPDATA%\io.vectasim.app\logs\`, Dumps `%LOCALAPPDATA%\io.vectasim.app\dumps\` (Buttons „Protokoll-Ordner öffnen“ / „Dump-Ordner öffnen“ in der Diagnose). Unabhängig vom Schalter hält VectaSim die letzten 30 min im Speicher – nach einem unerwarteten Fehler sofort „Dump jetzt speichern“.

## Schritt 0 – Umgebung (10 min)

- [ ] Windows-Version, MSFS-Version(en), Store/Steam, parallel laufende Tools (FSUIPC, GSX, Navigraph, FBW-Installer, MobiFlight) notieren. Läuft MSFS als Administrator? VectaSim **nicht** als Admin starten, außer der Sim läuft elevated.
- [ ] SDK installiert? In einer neuen Konsole `echo %MSFS_SDK%` bzw. `echo %MSFS2024_SDK%`. Sonst SDK über den Entwicklermodus installieren oder die DLL unter *Einstellungen → Simulator → SimConnect.dll* wählen.
- [ ] VectaSim **ohne** Sim starten → Diagnose: gefundene DLL und durchsuchte Pfade notieren. Status „Warte auf MSFS“. Log-Datei muss existieren und den fehlgeschlagenen Verbindungsversuch enthalten.

## Schritt 1 – Verbindung (15 min)

- [ ] MSFS starten, VectaSim läuft schon → innerhalb von ≤ 10 s nach dem Hauptmenü „verbunden“. Sim-Name/-Version aus der Diagnose notieren.
- [ ] Log nach `exception` durchsuchen; jede Exception mit Code und Variable notieren. Prüfen, ob Telemetrie ankommt (Datenrate in der Diagnose > 0).
- [ ] **Im Hauptmenü** 2 min stehen lassen: Kommt Telemetrie? Mit welchen Werten (Position, am Boden, AGL, IAS)? Startet fälschlich ein Flug? → **Dump „menu“**.
- [ ] Ereignisse beim Verbinden notieren (Pause, Sim läuft/gestoppt).

## Schritt 2 – Flug laden, Rohwerte am Stand (20 min; GA-Default, z. B. C172 an einem kleinen Platz)

- [ ] Flug am Parkplatz laden. Kommen `Flug geladen`, `Flugzeug geladen`, `Simulation läuft`? Erscheint eine Geister-Landung oder Phase beim Laden?
- [ ] Diagnose → Rohwerte: AGL am Boden (≈ 3–5 ft bei der C172), am Boden = ja, Fahrwerk 100 %, Klappen 0, Treibstoff/Gewicht in kg plausibel, Transponder stimmt mit dem Sim-Panel überein, Zulu-Zeit, Sim-Rate 1, Slew aus.
- [ ] Stammdaten: Titel, ATC-Modell (Token?), ATC-Typ, Kennzeichen, Airline, Flugnummer notieren.
- [ ] **Datenrate** notieren (Erwartung 30–60 Hz) und gleichzeitig die Sim-FPS.
- [ ] Parkbremse an/aus, Lichter, Triebwerk an/aus: ändern sich die Werte?

## Schritt 3 – GA-Platzrunde mit Touch-and-go (30 min) → Dump „ga-pattern“

- [ ] Rollen → Phase *Taxi out*. Start → *Takeoff* → *Climb*.
- [ ] Platzrunde ~1000 ft AGL, **Touch-and-go**: Landebericht mit Touch-and-go, Phase *Landing* → *Climb*.
- [ ] Zweite Runde: **Pause (P) mitten im Queranflug** 60 s → fortsetzen. Phase stabil? Pausenzahl/-dauer im Flug? Kommen während der Pause weiter Frames (Zähler beobachten)? Zusätzlich einmal **Active Pause** und einmal **ESC-Menü** testen und notieren, welche Ereignisse kommen.
- [ ] Full-Stop-Landung. Landerate der App mit einem zweiten Tool (Landing Inspector, FLARE, Volanta) und dem Rohwert des Sims vergleichen; Vorzeichen und Größe notieren.
- [ ] Abrollen, Parken, Triebwerk aus → *Taxi in* → *Shutdown* → Flug im Logbuch, Distanz plausibel. Debrief und Anflug-Abschnitt öffnen.

## Schritt 4 – Airliner-ILS (45–60 min; erst ein Default-Airliner, danach ein Add-on) → Dump „airliner-ils“

- [ ] Gate → Pushback (Default oder GSX) → Taxi → Start → kurzer Steigflug → ILS. Ein „Start auf 15 nm Final“ ist nicht der Haupttest.
- [ ] Pushback als Pushback erkannt? Mit gelöster Parkbremse? Triebwerksstart während des Pushbacks?
- [ ] Phasen: *Climb* → *Cruise* (60 s Level) → *Descent* → *Approach* → *Final* → *Landing* → *Taxi in* → *Shutdown*.
- [ ] Landebericht: Landerate, G, Bounces, Runway-Zuordnung, Aufsetzdistanz. Anflug: Gates, „stabil ab“, Klappenstufen je Hebelstellung notieren.
- [ ] Add-on (Fenix/PMDG/FBW): Kennzeichen, Parkbremse, Lichter, Klappenindex, Treibstoff, Triebwerke, Touchdown-Wert notieren.

## Schritt 5 – Ränder und Missbrauch (30 min) → je ein Dump

- [ ] **Slew** (Y) im Flug und über den Platz ziehen, auch nah am Boden: kein Touchdown, Flag „Slew“.
- [ ] **Zeitraffer** 4× im Reiseflug: Flag „Zeitraffer“, keine Phasenwechsel.
- [ ] **Flug mitten in der Luft beenden → Hauptmenü → neuen Flug an einem anderen Flughafen am Gate laden.** Genau beobachten und dumpen – der wichtigste Reproduktionsfall.
- [ ] MSFS 2024: Teleport über die Weltkarte, Fast-Travel, Start „in der Luft“.
- [ ] Startabbruch bis ~60 kt.

## Schritt 6 – Sim-Neustart und Absturz (15 min)

- [ ] Sim regulär beenden → „Simulator beendet“ → Sim starten → automatische Neuverbindung. Was passiert mit dem offenen Flug?
- [ ] **Sim per Task-Manager beenden** (simuliert einen Absturz): Erkennt die App die Trennung? Wie lange dauert es?
- [ ] App neu starten, während der Sim im Flug ist: Verbindung kommt, Flug wird (nicht) fortgesetzt?
- [ ] Optional: Standby und Aufwachen.

## Schritt 7 – Ressourcen und MSFS 2024

- [ ] RAM/CPU der App im Flug (Task-Manager, alle Prozesse). Spürbare Ruckler im Sim?
- [ ] Falls beide Sims vorhanden: Schritte 1–3 in der anderen Version wiederholen. Besonders: geladene DLL, kommt „Simulation gestoppt“ beim Wechsel ins Menü, Titel vs. Livery.

## Danach

- [ ] Ordner `logs\` und `dumps\` komplett zippen, dazu das Protokoll. Jeder notierte Fehler wird am Entwicklungsrechner per Replay-Provider (`VECTASIM_PROVIDER=replay`, Datei angeben) nachgestellt und als Regressionstest eingecheckt.
