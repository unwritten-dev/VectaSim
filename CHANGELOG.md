# Changelog

## Unreleased

## 0.2.0 – 2026-10-18 (Alpha)

Erste öffentliche Vorabversion. Alles unten ist seit 0.1.0 dazugekommen; die Oberfläche ist deutsch, Flugphasen englisch.

### Karte

- Der geflogene Track ist deutlich besser zu sehen: breitere Linie mit kräftigem Rand, und die Höhenfarben der dunklen Themes beginnen heller (Signal zeichnet den Track jetzt in Cyan statt Grau, Graphit & Amber in Amber)
- **3D-Ansicht** auf der Live-Karte und auf der Karte im Logbuch/Debrief (Schalter *3D* in der Kartenleiste): Die Karte neigt sich, und der Track steht als Höhenprofil im Raum – ein durchscheinender Vorhang vom Boden bis zur geflogenen Höhe mit einem farbigen Band an der Höhe selbst. Drehen und neigen geht auch mit der rechten Maustaste oder Strg + Ziehen; der Kompass zeigt die Neigung

### SimConnect
- *SimConnect herunterladen*: VectaSim holt die `SimConnect.dll` auf Klick aus dem offiziellen MSFS-2020-SDK-Download von Microsoft (0.24.6.0, ~108 MB, SHA-256-geprüft, ohne Installation/Adminrechte) nach `%LOCALAPPDATA%\io.vectasim.app\simconnect\` – passt zu MSFS 2020 und 2024; die Diagnose zeigt die Herkunft der DLL (Commands `simconnect_download_info`, `download_simconnect`)
- Karte *SimConnect einrichten* in *Einstellungen → Simulator* (Fortschritt Laden/Prüfen/Entpacken, „Erneut versuchen“ bei Fehlern, Lizenzhinweis); Hinweise lauten jetzt „SimConnect fehlt noch – unter Einstellungen → Simulator mit einem Klick herunterladen“, das Status-Popover springt mit *SimConnect einrichten* dorthin, die Diagnose zeigt Pfad und Herkunft der DLL

### Import
- *Einstellungen → Daten → Import → CSV importieren …*: Flüge aus anderen Logbüchern übernehmen – die **Volanta-Import-CSV** (13 Spalten `Origin,Destination,DepartureTime,Duration,…`), das **eigene Logbuch-CSV** von VectaSim, ein **SimToolkitPro**-Export (ohne Gewähr, Spalten nicht dokumentiert) oder jede andere Tabelle (VA/phpVMS …) mit freier Spaltenzuordnung
- Dialog in drei Schritten: Datei wählen (erkannt werden Format, Trennzeichen `,` `;` Tab `|` inkl. Excels `sep=`-Zeile, Kodierung UTF-8/mit BOM/UTF-16/Latin-1 und die Kopfzeile), Spalten zuordnen (vorbelegt aus dem Format und deutschen/englischen Spaltennamen; Datum und Uhrzeit zusammen oder getrennt; Formate ISO, `TT.MM.JJJJ`, `MM/TT/JJJJ`, Unix-Zeit; Zeiten ohne Zone als UTC oder als Ortszeit dieses PCs mit Sommerzeit; kg/lb; Dauer als `H:MM` oder Zahl), Vorschau der ersten 20 Zeilen mit Hinweisen und Fehlern, dann Import mit Ergebnis-Hinweis. Die Zuordnung merkt sich VectaSim je Format
- Importierte Flüge sind abgeschlossene Flüge ohne Track (`provider = import:<format>`, Simulator „Import“, Tags `import` + Quelle wie `volanta`/`stkp`/Dateiname): sie zählen für Stunden, Strecken, Flotte (Kennzeichen legt das Flugzeug an), Flughäfen und Länder, nicht für Landeanalyse, Streubild und Anflugbewertung. Fehlt die Distanz, trägt VectaSim den Großkreis zwischen den Flughäfen ein; fehlt die Ankunft, rechnet es sie aus der Blockzeit
- Eine **Landerate aus der Datei** steht als Zeile in den Notizen („Landerate laut Importdatei: −142 fpm (nicht von VectaSim gemessen)“) – sie stammt von einem anderen Messverfahren und wird bewusst nicht als Aufsetzer gespeichert; ebenso ein Verbrauch ohne Start-/Endwert
- **Duplikate** (abschaltbar): gleiche Strecke und Off-Block weniger als 15 Minuten auseinander – gegen das Logbuch samt Papierkorb und innerhalb der Datei. Fehlerhafte Zeilen (Flughafen oder Datum fehlt/unlesbar) werden mit Zeilennummer übersprungen
- Commands `csv_sniff`, `csv_preview`, `csv_import` (nur `.csv`/`.txt`, höchstens 50 MB, 100 Zeilen je Transaktion); Modul `vectasim_store::csvimport`

### Integrationen
- Neues Panel *Einstellungen → Integrationen* (zwischen Flugplanung und Anzeige) mit Discord, Benachrichtigungen und Infobereich
- **Discord-Status** (Rich Presence, Standard aus): „DLH4YA · EDDF → EGLL · A20N“ und „Reiseflug FL360 · noch 420 nm“ / „Anflug EGLL“ / „Bereit – wartet auf MSFS“, Flugzeit ab Off-Block; nach der Landung eine Minute „Gelandet · −155 fpm“; Demo und Replay erscheinen als „Demo“; im Streamer-Modus ohne Rufzeichen. Höchstens ein Update alle 15 s; läuft Discord nicht, versucht VectaSim es still alle 30 s erneut. Eigene Discord-App-ID optional eintragbar (Setting `discord_app_id`)
- **Windows-Benachrichtigungen**, solange VectaSim nicht im Vordergrund ist (Standard an): Landung mit Landerate, g-Last und Bounces, Flug gespeichert, Verbindung zum Simulator verloren/wieder da (während eines Flugs), Update verfügbar – einzeln abschaltbar, mit *Test senden*; nie mit Kennzeichen oder Rufzeichen; ein Klick holt das Fenster nach vorn
- **Infobereich (Tray)** (Standard aus): Symbol mit Status als Tooltip und Menü *Öffnen*, Aufzeichnungsstatus, *Debug-Modus*, *Beenden*; Minimieren versteckt das Fenster dorthin, Doppelklick öffnet es wieder; *Beenden* fragt während einer Aufzeichnung wie gewohnt nach
- Settings `discord_presence`, `discord_app_id`, `notifications`, `notify_landing`, `notify_saved`, `notify_connection`, `notify_update`, `tray_minimize`; Commands `discord_status`, `notify`, `notify_test`, `set_tray_enabled`, `tray_active`; Plugin `tauri-plugin-notification`, Crate `discord-rich-presence`

### Notizen & Tags
- Im Flugdetail unter dem Kopf der neue Bereich **Notizen & Tags**: eigene Notizen (bis 2000 Zeichen, Klartext mit Zeilenumbrüchen, gespeichert beim Verlassen des Felds oder mit Strg/⌘+S), Tags als Chips (Eingabe oder Komma fügt hinzu, Rücktaste entfernt den letzten, Vorschläge aus den Tags des Logbuchs; höchstens 20 à 30 Zeichen, „VATSIM“ und „vatsim“ zählen als ein Tag) und eine persönliche **Bewertung** des Flugs mit 1–5 Sternen (auch mit den Pfeiltasten; bewertet den Flug, nicht die Landung)
- *Korrigieren …*: falsch aufgezeichnetes Rufzeichen, Abflug/Ankunft (ICAO, 4 Zeichen), Flugzeugname oder Kennzeichen überschreiben – Logbuch, Flight-Strip, Suche und CSV zeigen die Korrektur, der Tooltip den aufgezeichneten Wert („Sim: ASXGS“); das Original bleibt gespeichert, leere Felder stellen es wieder her. Ein korrigiertes Kennzeichen bucht den Flug auf dieses Flugzeug um (Flotte)
- Logbuch: die Suche findet auch Notizen, Tags und Korrekturen; neuer Chip-Filter **Tags** mit Mehrfachauswahl (mindestens ein Tag passt); Flight-Strips zeigen bis zu zwei Tags, die Sterne kompakt („★4“) und ein Notiz-Symbol mit der ersten Zeile als Tooltip
- Logbuch-CSV mit den neuen Spalten `notes`, `tags` (mit „; “ getrennt) und `rating`; die Spalten Abflug, Ankunft, Rufzeichen, Flugzeug und Kennzeichen enthalten die Korrekturen. Der Gesamtexport (`.vectasim`) nimmt alles mit; beim Zusammenführen bekommt ein schon vorhandener Flug Notizen, Tags, Bewertung und Korrekturen aus der Datei, wenn er selbst keine hat; beim Zusammenführen zweier Flugteile bleiben die Angaben beider Teile erhalten
- Datenformat v14 (Spalten `notes`, `tags`, `rating`, `user_callsign`, `user_dep_icao`, `user_arr_icao`, `user_aircraft_title`, `user_registration`), Commands `update_flight_user` und `list_tags`

### Streamer-Modus
- Neuer **Streamer-Modus** (*Einstellungen → Anzeige* oder Strg+Umschalt+P, mit kurzem Hinweis): blendet in der ganzen Oberfläche Kennzeichen („D-••••“, das Länderkürzel bleibt), Rufzeichen und Flugnummer, Airline, die SimBrief-ID und deinen Windows-Benutzernamen in Pfaden aus (`%LOCALAPPDATA%\…` statt `C:\Users\<Name>\…`) – Live-HUD und Seitenpanel, Bereit-Karte, Flotte, Landeauswertung, Einstellungen und Diagnose. Nur die Anzeige ändert sich, gespeichert bleibt alles; Foto-Credits bleiben sichtbar. Ein dezentes Augen-Symbol im Status-Popover zeigt den Modus an und schaltet ihn mit einem Klick aus
- Landekarte (PNG) im Streamer-Modus ohne Kennzeichen; dafür auch ohne Streamer-Modus der Schalter *Landekarte ohne Kennzeichen*
- **Landekarte automatisch speichern**: Nach jeder Landung legt VectaSim die Landekarte als `VectaSim_<ICAO>_<RWY>_<Datum_Uhrzeit>.png` in einen Ordner (Standard `Bilder\VectaSim`, *Ändern …*/*Öffnen*/*Zurücksetzen*), mit kurzem Hinweis und *Ordner öffnen*
- Diagnosepaket im Streamer-Modus ohne Benutzernamen in Pfaden (JSON-Dateien, Protokolle, Hinweise); die README im Paket sagt es dazu

### Länder
- Neuer Menüpunkt *Länder* in der Sidebar (zwischen Logbuch und Einstellungen, Strg+3; Einstellungen jetzt Strg+4): Weltkarte mit Ländergrenzen (Natural Earth 1:110m, gleiche Basemap und Themes wie die Live-Karte, Zoom 1–6), besuchte Länder in der Akzentfarbe, Tooltip beim Überfahren, Legende
- Ein Land gilt nur durch eine Landung als besucht: Ankunftsflughafen abgeschlossener Flüge (nicht im Papierkorb, Demo nur mit *Demo-Flüge einbeziehen*), Land aus der Flughafen-Datenbank; aktualisiert sich bei jeder Änderung im Logbuch
- Liste aller 250 Länder (ISO 3166 + Kosovo) mit ✓/–, Landungen und letztem Datum als Tabellen-Alternative zur Karte; Fortschritt „n / 250“ gesamt und je Kontinent, Kontinent-Chips, Suche (Deutsch, Englisch, ISO-Code), Filter Besucht/Offen
- Klick auf ein Land: erste/letzte Landung, Flughäfen und die Flüge dorthin, jeder öffnet sich im Logbuch; Ankunftsflughäfen als Punkte (abschaltbar) – auch für kleine Staaten ohne Umriss in 1:110m
- *Als Bild speichern*: Karte mit Fortschrittszeile als PNG (`VectaSim_Laender_<datum>.png`)
- Commands `countries_list`, `countries_geojson` (eingebettet zstd-komprimiert, ≈ 40 KiB) und `visited_countries`; Daten über `scripts/update-countries.py`

### Leistung
- Die Live-Karte bleibt auch auf Langstreckenflügen flüssig: Der Flugweg wird in Abschnitten gezeichnet statt jede Sekunde komplett neu; Logbuch-Karte und Höhenprofil öffnen lange Flüge schneller, kurze Spitzen (Sinkrate beim Aufsetzen) bleiben sichtbar
- Flughafen-Datenbank startet in Millisekunden statt in einer halben Sekunde; im Hintergrund oder minimiert sendet VectaSim nur noch 1 Mal pro Sekunde an die Oberfläche; die SimConnect-Verbindung wartet auf Ereignisse statt dauernd zu fragen; Tracks werden alle 15 s statt 60 s gesichert
- Graphit & Amber: Warnungen sind jetzt rot-orange und nicht mehr mit Akzent oder Fehlern zu verwechseln; Karten-Schalter sehen einheitlich aus, Zoom/Kompass/Quellenhinweis mit Fokusrahmen und größeren Klickflächen

### Nachbesprechung
- Profil, Pistenansicht, Querablage und Gate-Tabelle zeigen denselben Zeitpunkt – zeigen oder klicken in einem Diagramm bewegt alle mit; neue Wiedergabe des Anflugs (Play/Pause, 1–8×, Schieberegler, Sprünge zu 10 nm/FAF/1000/500 ft/Schwelle/Aufsetzen/Stillstand) mit den Messwerten am Cursor; im Logbuch zeigt die Karte die Position zum Profil-Cursor
- Piste aus der Rollspur: Landet man an einem Platz, dessen Piste in der Datenbank keine Koordinaten hat (viele kleine Plätze, Grasbahnen), leitet VectaSim die Bahn aus Anflug und Ausrollen ab, kennzeichnet sie als „abgeleitet“ und merkt sie sich pro Flughafen; weitere Landungen verfeinern sie
  - Unter dem Pistennamen steht jetzt, woher die Piste stammt: „Piste aus OurAirports“, „Piste aus deiner Rollspur abgeleitet (n Landungen)“ oder „Piste von dir festgelegt“
  - Ehrliche Werte bei abgeleiteten Pisten: Der Aufsetzpunkt steht mit „± 50 m“ da, die Abweichung von der Mittellinie heißt „nicht messbar“ (die Achse ist ja deine eigene Linie), ohne bekannte Länge gilt die Aufsetzzone als „angenommen (0–900 m)“ und der Rest der Piste wird nicht mehr angezeigt; der VectaSim-Index heißt dann „nicht vergleichbar“
  - Im Streubild stehen solche Landungen hohl auf der Mittellinie und zählen nicht zur Ø Mittellinie; bei den Anflügen fehlt für sie die Querablage bei 1000/500 ft
  - Neu: *Piste korrigieren …* in der Landeauswertung – Bezeichnung, Schwelle und Ende (Breite/Länge in Dezimalgrad), Breite und Höhe selbst eintragen, mit einem Klick die Werte aus der aktuellen Landung übernehmen oder mit *Zurücksetzen auf Datenbank* wieder vergessen; dazu die Liste der gemerkten Pisten des Platzes mit Herkunft und Anzahl der Landungen. Deine eigene Piste hat Vorrang vor OurAirports, alle Landungen an dem Platz werden damit neu ausgewertet
  - Gemerkte und selbst festgelegte Pisten wandern beim Gesamtexport (`.vectasim`) mit; beim Zusammenführen gewinnt eine selbst festgelegte Piste, zwei abgeleitete werden nach Anzahl der Landungen gemittelt

- Fehlersuche ohne Simulator: Roh-Dump der SimConnect-Daten (*Einstellungen → Diagnose*, ca. 5–10 MB pro Stunde), Replay eines Dumps als Datenquelle, Live-Rohdaten-Ansicht, **Debug-Modus** und **Diagnosepaket** (ZIP mit Protokollen, Dumps, Einstellungen ohne Geheimnisse, System- und Datenbankinfo) zum Weitergeben
- Verlässlichkeit für den ersten Sim-Einsatz: Protokolldatei mit Rotation (*Einstellungen → Diagnose → Protokoll-Ordner öffnen*, Protokollstufe einstellbar, „Diagnose kopieren“), nur eine App-Instanz, Rückfrage beim Schließen oder Update während einer Aufzeichnung
- SimConnect: Absturz des Simulators wird erkannt und neu verbunden (Watchdog), Fehler einzelner Variablen legen die Telemetrie nicht mehr still, korrekte Fehlernamen, Slew/Zeitraffer ohne Verzögerung, Transponder korrekt, breitere Suche nach `SimConnect.dll` mit Liste der durchsuchten Pfade und Auswahl der Datei in den Einstellungen
- Keine Geister-Landungen mehr: Neuladen eines Flugs, Hauptmenü, Teleport und Wiederverbinden setzen die Erkennung zurück; unterbrochene Flüge werden sauber abgeschlossen; Pausen ohne Telemetrie werden erkannt; Startzeit ab dem Abheben; Block-on erst mit abgestellten Triebwerken; Flag „Positionssprung“ im Logbuch und Export
- Anflugbewertung: neues Core-Modul wertet jeden Anflug auf dem 1-Hz-Track aus (Anflugversuche inkl. Go-around, Runway-Zuordnung ohne Touchdown, Gates 10 nm/FAF/1000/500/50 ft, Gleitpfad- und Grundlinien-Dots, Speed gegen geflogene Referenz, V/S, Bank, Konfiguration, Energie-Proxy, Stabilitätsmaße, „stabil ab“); EASA-Zwei-Stufen-Kriterien mit Mindestdauern; vier Bänder
- Debrief: Abschnitt „Anflug“ mit Kernsatz, Band, drei Kennzahlen mit Herkunft, Konfigurationsereignissen und Überschreitungen; Gate-Tabelle mit fünf Gates und „nicht messbar“ samt Grund; Anflugprofil mit Bereichen Final/10 nm/ab TOD und Grundlinien-Streifen; Anflugwähler; eigener Durchstarten-Debrief; Index-Anteil „Stabilisierter Anflug“ aus „stabil ab“ + Gates
- Landekarte zeigt Referenz, „stabil ab“ und Gate-Ergebnis; Flight-Strips zeigen „stabil ab“ und Go-arounds; Logbuch → Landungen hat die Ansichten „Aufsetzpunkte“ und „Anflüge“
- Cache-Tabelle `approach_facts` (Schema 8), Commands `approach_analysis` und `approach_facts_recent`, Berechnung beim Flugende; Mock-Variante `VECTASIM_MOCK=goaround`
- Sidebar auf drei Einträge (Karte, Logbuch, Einstellungen; Strg+1/2/3); Flotte und Aktivitäten sind jetzt die Logbuch-Bereiche *Flugzeuge* und *Flughäfen*, dazu *Landungen*
- Logbuch-Zeilen als Flight-Strips: Rufzeichen/Muster, Route mit Blockzeiten, Integritätszeichen (Pause, Slew, Zeitraffer), Landerate mit Runway-Glyphe und Aufsetzpunkt
- Landekarte als PNG (1200×675) aus dem Debrief und dem Lande-Toast: speichern oder in die Zwischenablage kopieren
- Streubild der letzten 20 Landungen im Logbuch-Bereich *Landungen*: normierte Runway, Band-Farben, 1σ-Ellipse, TDZ-Quote, Sparkline, Filter nach Typ/Flughafen; Ergebnisse werden in der Tabelle `landing_facts` zwischengespeichert (Schema 7)
- „Bereit“-Karte auf der Live-Karte vor dem Flug: Verbindungsstatus, geladener Flugplan, erkanntes bzw. zuletzt geflogenes Flugzeug, Demo-Start ohne Simulator
- SimBrief-Flugplan wird mit hinterlegter Pilot-ID automatisch geladen (Start und Verbinden, höchstens alle 5 Minuten; Einstellung *Flugplanung*)
- Seitenpanel der Live-Karte auf zwei Tabs reduziert: *Flug* (bisher Flug, Systeme, Ereignisse) und *Dispatch* (bisher Flugplan, Online)
- Demo-Flüge sind nur noch Sitzungsgäste: beim Beenden der Demo und beim nächsten Start werden sie samt nur von ihnen angelegter Flugzeuge gelöscht

### Einordnung & Verlauf

- *Einordnung* im Flugdetail (unter der Landezusammenfassung): ein Satz „Deine letzten 20 Landungen auf EDDF 25C: Median −180 fpm · du: −155 fpm (besser als 70 %)“ und drei Kacheln Landerate, Aufsetzpunkt und „stabil ab“ – jeweils Ist gegen Median mit Abstand und Perzentil; Umschalter *gleiche Piste / gleicher Typ / alle* (automatisch die engste Auswahl mit mindestens drei Vergleichslandungen); unter drei Landungen nur der Hinweis „Noch zu wenig Landungen zum Vergleich“
- Die *Nach dem Flug*-Karte zeigt eine Zeile „besser als 70 % deiner letzten 20 Landungen auf EDDF 25C“
- Neuer Tab *Logbuch → Landungen → Verlauf*: Landerate (Betrag), Aufsetzdistanz, „stabil ab“ und Anteil in der Aufsetzzone je Landung, Woche oder Monat mit gleitendem Median (Fenster 5 bzw. 10 Landungen, 3 Zeiträume) und Quartilsband; Filter Typ, Flughafen und Zeitraum (letzte 20/50/200); Kacheln „Dieser Monat vs. Vormonat“ mit Δ; alle Werte auch als Tabelle
- *Platzrunden* im Flugdetail ab zwei Bodenkontakten: jeder Touch-and-go und der Full Stop als Zeile (Zeit, Art, Landerate, g, Bounces, Aufsetzpunkt und „stabil ab“, wo ausgewertet) mit Mini-Verlauf der Landeraten; ein Klick öffnet die Landeauswertung des Kontakts
- Fehlende Werte (Mittellinie, nicht bewerteter Anflug) bleiben aus Median und Quoten heraus; Demo-Landungen zählen nur im Vergleich mit Demo-Landungen oder wenn Demo-Flüge eingeblendet sind

### Plan gegen Ist

- Neuer Abschnitt *Plan gegen Ist* im Flugdetail, sobald ein SimBrief-Flugplan am Flug hängt: Plan, Ist und Abweichung für Off-Block, Takeoff, Landung und On-Block, Taxi-out/-in, Block- und Luftzeit, Treibstoff beim Off-Block, Trip-Fuel, Blockverbrauch, Landetreibstoff, Distanz und Reiseflughöhe
- Pünktlichkeit nach Airline-Definition: bis 15 Minuten nach Plan gilt als „pünktlich“, sonst „verspätet“ (am On-Block, ohne Ankunft am Off-Block)
- Trip-Fuel kommt aus dem Track (Treibstoff beim Abheben minus beim Aufsetzen); ohne Track wird er aus dem Blockverbrauch abzüglich des geplanten Taxi-Treibstoffs geschätzt und mit „≈“ markiert
- Die Live-Ansicht (*Flug → Ist gegen Plan*) rechnet mit denselben Regeln und zeigt jetzt auch die Abweichung bei Off-Block, Start und Landung
- *Dispatch* zeigt zusätzlich geplante Taxi-Zeiten, Taxi-Treibstoff, Reserve, Alternate und Contingency
- PIREP: *Flug exportieren → PIREP als Text kopieren* legt einen Bericht für VA-Formulare in die Zwischenablage (Callsign, Flugnummer, Strecke, Zeiten in UTC, Block-/Luftzeit, Distanz, Treibstoff, Landerate, g-Last, Bounces, „stabil ab“, Pünktlichkeit, Integrität, Sim, Flugzeug, Kennzeichen); *PIREP als JSON speichern …* schreibt dieselben Angaben als Datei (Schema `pirep/v1`)
- Logbuch-CSV hat sechs neue Spalten am Ende: `sched_out`, `sched_in`, `delay_out_min`, `delay_in_min`, `planned_block_s`, `planned_trip_kg`

### Nach einem Absturz

- **Flug fortsetzen:** Stürzt VectaSim oder der Simulator mitten im Flug ab und bist du danach wieder in der Nähe (letzte Aufzeichnung höchstens 30 Minuten alt, höchstens 5 nm und ±3000 ft entfernt, in der Luft oder noch nicht abgestellt), fragt VectaSim beim Verbinden „Flug fortsetzen?“ mit Strecke und Off-Block-Zeit. *Fortsetzen* hängt den Rest an den unterbrochenen Flug an – Off-Block- und Startzeit, Strecke, Treibstoff und Landungen zählen weiter, die Pause steht als Aufzeichnungslücke im Flug; *Neuer Flug* oder keine Antwort innerhalb von 60 Sekunden lässt den Rest als eigenen Flug stehen. Bei Demo und Replay wird nicht gefragt
- **Nachträglich zusammenführen:** Folgt auf einen unterbrochenen Flug innerhalb von 60 Minuten und höchstens 5 nm entfernt ein weiterer, zeigt das Logbuch über der Liste „… ist vermutlich die Fortsetzung von …“ mit *Zusammenführen*: Zeiten, Track, Landungen, Distanz, Treibstoff und Integritätszeichen werden ein Flug, Flugplan, Wetter und Flugzeug kommen vom ersten Teil (Fehlendes vom zweiten); der zweite Teil landet vollständig im Papierkorb. *Ignorieren* blendet den Hinweis aus
- Flight-Strips zeigen „unterbrochen“ mit Erklärung und Abstand zum nächsten Flug im Tooltip; fortgesetzte oder zusammengeführte Flüge tragen das Zeichen „⋯“ mit der Länge der Lücke
- Technisch: Schema 13 (Spalte `flights.gap_ms`, `integrity.gapMs`), Event `flight:resumable` / `flight:resumed`, Commands `resume_flight`, `list_merge_candidates`, `merge_flights`

### Datensicherheit
- SQLite auf 3.53.2 aktualisiert (rusqlite 0.40.2 / libsqlite3-sys 0.38.2, vorher 3.46.0) – behebt CVE-2025-6965
- Kartenbibliothek MapLibre GL JS auf 6.12 aktualisiert (behebt die XSS-Lücke GHSA-jrc7-96c5-q579 aus 5.x); die CI prüft die Frontend-Abhängigkeiten jetzt mit `npm audit`
- Mehr Sicherheit: Die App lädt Inhalte nur noch von bekannten Quellen, und beim Öffnen des CSV-Logbuchs in Excel werden Flugzeugnamen oder Rufzeichen nicht mehr als Formel ausgeführt
- Eine verstellte Systemuhr (Zeitumstellung, Synchronisierung) bringt die Phasen- und Landeerkennung nicht mehr durcheinander; Zeitraffer wird bei Phasen und Landungen einheitlich behandelt

- Datenformat-Umstellungen (Migrationen) laufen pro Schritt in einer Transaktion; vorher kopiert VectaSim das Logbuch nach `vectasim-pre-v<alt>-<Datum>.db` im Sicherungsordner. Schlägt ein Schritt fehl, bleibt die Datei unverändert
- Ein Logbuch aus einer neueren VectaSim-Version wird nicht mehr geöffnet (statt es mit der alten Version weiterzubeschreiben); Fehler beim Öffnen zeigen einen Dialog mit den Pfaden von Datenbank und Sicherung, statt dass das Fenster verschwindet
- Papierkorb: gelöschte Flüge bleiben 30 Tage wiederherstellbar (Toast mit *Rückgängig*, Logbuch-Filter *Papierkorb*), Summen, Flotte, Landungen, Anflüge und Flughäfen zählen sie nicht mehr mit (Schema 10, Spalte `deleted_ms`); Bestätigen beim Löschen mit Fokus auf *Abbrechen*
- *Einstellungen → Daten*: Speicherort der Datenbank, Sicherungsordner frei wählbar (z. B. OneDrive/Dropbox/NAS, mit Hinweis), tägliche automatische Sicherung und vor jedem Update, 7 Tage Rotation, *Jetzt sichern*, *Wiederherstellen* mit Neustart, *Papierkorb leeren*, *Alle Daten löschen* (zweistufig, mit Sicherung davor); Warnung, wenn die Datenbank in einem Sync-Ordner liegt
- Gesamtexport/-import: *Einstellungen → Daten → Alles exportieren …* schreibt das ganze Logbuch (Flüge mit Tracks, Flotte, eigene Flugzeugbilder; Papierkorb auf Wunsch) in eine `.vectasim`-Datei; *Aus Datei importieren …* führt sie zusammen (Duplikate – gleicher Flug oder gleiche Strecke mit weniger als 15 min Abstand beim Off-Block – werden übersprungen, vorhandene Flugzeugdaten bleiben) oder ersetzt das Logbuch nach einer Sicherung (`vectasim-pre-import-…`). Für den Umzug auf einen anderen PC oder zum Zusammenführen zweier PCs
- Schreibende Befehle (Flug-Export, Logbuch-CSV, Landekarte, Gesamtexport, Diagnosepaket) nehmen nur noch vollständige Pfade ohne `..` mit passender Dateiendung an und nie in Windows-, Programm- oder Installationsordnern („Pfad nicht erlaubt“)
- Track laden, Exporte, Logbuch-Liste und Landungs-Streubild laufen außerhalb des UI-Threads; das Logbuch prüft alle 30 s nur noch eine Zählung (`flight_summary_counts`) und lädt die Liste nur bei Änderungen neu
- Diagnosepaket zählt Flüge im Papierkorb getrennt (`flightsDeleted`)

### Fachliche Korrekturen

- Geschwindigkeit am Gate wird gegen eine echte Referenz geprüft (eigene Vapp, sonst der geflogene Mittelwert 500 → 100 ft, sonst 1,3 × VS0) statt gegen sich selbst; die Herkunft steht im Debrief
- Gleitpfad-Toleranz am Gate jetzt ±0,35° (1 Dot) statt ±0,7°; mehr als 2 Dots wird als Stufe S2 genannt
- Aufsetzzone beginnt an der Schwelle (bis 900 m bzw. erstes Pistendrittel); der Zielpunkt (150–400 m je nach Pistenlänge) ist nur noch eine Markierung – eine Landung bei 200 m ist jetzt „in der Aufsetzzone“
- Versetzte Schwellen aus OurAirports werden berücksichtigt; unbekannte Pistenbreite heißt „Breite unbekannt“ statt „0 m“; Mittellinien-Abstand auf ganze Meter gerundet (Pistendaten ca. ±5 m genau)
- METAR: Hinweis, wenn die Meldung mehr als 1 h vor oder nach der Landung beobachtet wurde; bei VRB oder Richtungs-Spanne zusätzlich der ungünstigste Seitenwind; Böen in der Windzeile
- Wirbelschleppen-Klassen nach ICAO: TBM, PC-12, Caravan, Twin Otter, Beaver, King Air, Phenom 100, Citation CJ/M2, Premier als Light; C-130 und UH-60 als Medium; Concorde als Heavy
- VectaSim-Index: „normal“ zählt so viel wie „sanft“, Aufsetzpunkt nach neuer Zone gewertet; ohne Piste, Pistenbreite oder Gate heißt er „nicht vergleichbar“ statt einen Teilwert zu zeigen
- g-Band „hart“ erst ab 2,0 g (bisher 1,75 g) – Begründung in der Methodik
- Begriffe: Aufsetzzone, Mittellinie, Piste, Einheit „g“, „Luftzeit“ statt „Flugzeit“ (auch Export-Spalte `air_time`); Höhen über 5000 ft als Flugfläche; keine „20 Hz“-Angaben mehr
- Bounce erst ab 0,3 s ohne Bodenkontakt – kurzes Flackern auf Gras oder einem Fahrwerksbein ist kein Bounce mehr

### Oberfläche

- Vor dem Flug führt die Bereit-Karte: Die Statuspille auf der Karte sagt dann nur noch „Warte auf MSFS“, die Phasen-Kachel zeigt kein zweites „Bereit“ mehr; ohne Bereit-Karte heißt die Pille „Warte auf MSFS – Aufzeichnung startet beim Losrollen“
- Die Demo heißt überall „Demo-Flug“ (*Demo-Flug starten* / *Demo-Flug beenden*); *Demo-Flug beenden* gibt es jetzt immer, und danach verschwinden Flugzeug, Ereignisse und der Zähler am Tab „Flug“ der Demo von der Karte
- Logbuch-Filter „Abgeschlossen“ statt „Gespeichert“ (gespeichert sind alle Flüge), auch in der Summenleiste und am Flug
- Nach der Landung: Der Debrief hat oben *Im Logbuch* (öffnet den Flug) neben *Schließen*; die Nach-dem-Flug-Karte hat *Landekarte* zum Speichern als Bild; die Bild-Aktion heißt überall „Landekarte speichern“ / „Landekarte kopieren“
- Logbuch bei rund 1100 px Fensterbreite: Rufzeichen-Spalte passt sich an (gekürzt erst ab 110 px), Route in einer Zeile, Abzeichen hinter Datum und Blockzeit, Uhrzeiten und „stabil ab“ nur wenn Platz ist (immer im Tooltip); Flugzeugliste ohne waagrechten Scrollbalken; Werkzeugleiste ohne Umbruch (schmalere Suche, kurzes *Export* unter 1200 px)
- Einstellung *Anzeige → Gewichte*: Treibstoff und Gewichte in kg oder lb
- Vapp pro Flugzeug (*Logbuch → Flugzeuge → Angaben*): Die Anflug- und Landeauswertung nimmt sie als Referenz-Geschwindigkeit („Vapp 138 kt (eingetragen)“), sonst wie bisher den geflogenen Wert (Schema 11)
- Fehlerzustände: Schlägt das Laden des Logbuchs fehl, gibt es *Erneut versuchen* statt eines endlosen „wird geladen“; Flugdetail und Landeauswertung bieten ebenfalls *Erneut versuchen*; lädt die Karte nicht (offline), sagt eine Pille „Karte offline – Tracking läuft weiter“; scheitert der Schalter *Verkehr*, erklärt ein Hinweis warum
- Installationsanleitung: keine feste Hz-Angabe mehr, SimBrief-Autoload richtig beschrieben
- Tastatur und Screenreader: Die Landeauswertung ist ein echtes Fenster im Fenster – Tab bleibt darin, Esc schließt erst einen offenen Herkunfts-Hinweis, Kürzel wirken nicht mehr dahinter; Hinweise (Toasts) werden zuverlässig vorgelesen und sind mit Alt+T erreichbar; Streubilder lassen sich mit den Pfeiltasten durchgehen und als Tabelle aufklappen; alle Kürzel stehen unter *Einstellungen → Tastatur*
- Fenster: kleiner ziehbar (ab 1024 × 640), Größe, Position, Bildschirm und Maximiert merkt sich VectaSim; die Oberfläche lässt sich mit Strg+Plus/Minus vergrößern (Strg+0 zurück, auch unter *Einstellungen → Anzeige → Größe*)
- Beim Wechsel zwischen Karte, Logbuch und Einstellungen bleibt alles, wie es war: Kartenausschnitt, Suche, Filter, Auswahl und Scrollposition im Logbuch, Position in den Einstellungen; eine ausgeblendete Bereit-Karte bleibt bis zum nächsten Flug weg

## 0.1.0 – 2026-10-17

Erster Stand – Phase 1 (MVP).

- Live-Karte (MapLibre/OpenFreeMap) mit Flugzeug, höhencodiertem Track, Flughäfen (OurAirports), Airport-Diagramm beim Hineinzoomen, VATSIM-Verkehr/ATC, METAR-Badges
- Flugphasen-Erkennung, Touchdown-Detektor nach festen, dokumentierten Regeln (Sim-Wert, V/S-Rückfall, Worst-of-Bounces, AGL-Korroboration), Flugzusammenfassung mit Integritäts-Flags
- Lokales SQLite-Logbuch mit komprimierten Tracks, Profil-Chart, Export (CSV/GPX/KML/JSON), Flotte, besuchte Flughäfen
- SimBrief-Dispatch mit geplanter Route und OFP-vs-Ist
- Landing-Debrief: Runway-Draufsicht mit Aufsetzpunkt, Anflugprofil, Stabilized-Approach-Checkliste, gespeichertes METAR
- Oberfläche mit Icon-Sidebar, Vollbild-Karte, Seitenleiste, Logbuch (Liste/Detail), Demo-Modus
- Auto-Update über signierte GitHub-Releases
