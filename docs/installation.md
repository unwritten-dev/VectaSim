# VectaSim installieren (Windows, Sim-PC)

Der fertige Installer aus den GitHub-Releases bekommt Auto-Updates und ist der normale Weg. Wer selbst aus dem Quellcode bauen will, findet das in [DEVELOPMENT.md](../DEVELOPMENT.md).

## Voraussetzungen auf dem Sim-PC

- Windows 10/11 64-bit, WebView2 (ist in Windows enthalten).
- MSFS 2020 oder 2024 (Store oder Steam). X-Plane folgt.
- **SimConnect.dll** – die Verbindung zum Sim. Sie gehört zum **MSFS-SDK** von Microsoft und darf nicht ohne Weiteres mit VectaSim verteilt werden; VectaSim holt sie deshalb auf Knopfdruck selbst vom Microsoft-Server (siehe unten). Ist das SDK schon installiert, findet VectaSim die Datei von selbst.

### SimConnect.dll bereitstellen

Meldet VectaSim „SimConnect fehlt noch“, zeigt *Einstellungen → Simulator* die Karte *SimConnect einrichten* (das Status-Symbol in der Seitenleiste führt mit *SimConnect einrichten* direkt dorthin). Ein Klick auf *SimConnect herunterladen* genügt; ein Balken zeigt den Fortschritt (Laden, Prüfen, Entpacken), danach meldet VectaSim „SimConnect eingerichtet“. VectaSim lädt das offizielle MSFS-2020-SDK (Core, Version 0.24.6.0, ca. 108 MB) von `sdk.flightsimulator.com`, prüft es, nimmt nur die `SimConnect.dll` heraus und legt sie unter `%LOCALAPPDATA%\io.vectasim.app\simconnect\` ab – ohne Adminrechte und ohne etwas zu installieren. Mit dem Download gelten die [Lizenzbedingungen des MSFS-SDK](https://docs.flightsimulator.com/html/Introduction/SDK_EULA.htm). Die Datei passt zu MSFS 2020 **und** 2024; danach verbindet sich VectaSim von selbst.

Ohne den Knopf geht es auch über das SDK im Sim:

1. Im Sim unter *Optionen → Allgemein → Entwickler* den **Entwicklermodus** einschalten.
2. In der neuen Menüleiste oben *Hilfe → SDK-Installer* wählen und das SDK installieren.
3. VectaSim sucht automatisch weiter und verbindet sich, sobald die Datei da ist.

Liegt die Datei schon woanders (z. B. aus einer älteren SDK-Installation): *Einstellungen → Simulator → SimConnect.dll → Datei wählen …* und die `SimConnect.dll` auswählen. VectaSim versucht die Verbindung sofort neu. *Zurücksetzen* schaltet wieder auf die automatische Suche.

*Einstellungen → Diagnose* zeigt, welche DLL gefunden wurde und woher sie stammt (heruntergeladen, MSFS SDK, manuell gewählt …) – und wenn keine, welche Orte durchsucht wurden. Gesucht wird in dieser Reihenfolge: gewählte Datei bzw. `VECTASIM_SIMCONNECT_DLL` → heruntergeladene DLL → neben `vectasim.exe` → `%MSFS2024_SDK%`/`%MSFS_SDK%` → `C:\MSFS 2024 SDK`, `C:\MSFS SDK` → Windows-Suchpfad.

## Installer aus GitHub Releases

1. Unter https://github.com/unwritten-dev/VectaSim/releases die neueste Version öffnen und `VectaSim_<version>_x64-setup.exe` herunterladen.
2. Installer starten. Windows SmartScreen meldet „unbekannter Herausgeber" (noch kein Code-Signing-Zertifikat) → *Weitere Informationen → Trotzdem ausführen*. Der Installer braucht keine Adminrechte (Installation pro Benutzer).
3. Falls das MSFS SDK nicht installiert ist: in VectaSim *Einstellungen → Simulator → SimConnect herunterladen* (siehe oben).
4. VectaSim starten, MSFS starten – sobald der Sim im Hauptmenü ist, zeigt die Bereit-Karte auf der Karte „Bereit“; die Aufzeichnung beginnt beim Losrollen. Ohne Simulator: *Demo-Flug starten* auf der Bereit-Karte.

VectaSim läuft immer nur einmal: Ein zweiter Start holt das offene Fenster nach vorn.

**Fenster:** Das Fenster lässt sich bis 1024 × 640 verkleinern und startet wieder mit der zuletzt benutzten Größe und Position (auch auf dem zweiten Bildschirm); mit Strg+Plus/Minus wird die ganze Oberfläche größer oder kleiner, Strg+0 setzt sie auf 100 % zurück.

**Länder:** *Länder* in der Sidebar (Strg+3) färbt jedes Land ein, in dem du gelandet bist – gezählt wird nur der Ankunftsflughafen abgeschlossener Flüge, Demo-Flüge nur mit *Einstellungen → Anzeige → Demo-Flüge einbeziehen*. Ein Klick auf ein Land listet die Flüge dorthin; *Als Bild speichern* legt die Karte als PNG ab.

**Updates:** Installierte Apps melden ein neues Release beim nächsten Start (Toast „Update verfügbar") oder über *Einstellungen → Updates* und installieren es nach Bestätigung. Die Installation startet VectaSim neu – während eines aufgezeichneten Flugs lässt sich ein Update deshalb erst nach dem Flug installieren.

**Beenden während eines Flugs:** VectaSim fragt nach. Beendest du trotzdem, steht der Flug als „unterbrochen“ im Logbuch.

## Erster Flug – kurz

1. VectaSim läuft, MSFS steht im Hauptmenü → „Bereit“-Karte auf der Karte mit Simulator, Flugplan und Flugzeug; die Aufzeichnung startet beim Losrollen.
2. Optional SimBrief: Pilot-ID unter *Einstellungen → Flugplanung* eintragen – der letzte Flugplan wird ab dann beim Start und beim Verbinden automatisch geladen (Seitenpanel → *Dispatch* zum Nachladen). Route erscheint gestrichelt, Soll/Ist wird verglichen.
3. Fliegen. Nach dem Aufsetzen: Lande-Toast → „Landeauswertung“. Nach On-Block: Nach-dem-Flug-Karte mit *Landeauswertung*, *Landekarte* (PNG zum Teilen) und *Im Logbuch*.
   Unter *Einstellungen → Anzeige* kannst du die Landekarte nach jeder Landung automatisch speichern lassen (Standard-Ordner `Bilder\VectaSim`). Wer streamt, schaltet dort oder mit Strg+Umschalt+P den **Streamer-Modus** ein: Kennzeichen, Rufzeichen, Airline, SimBrief-ID und dein Windows-Benutzername in Pfaden sind dann überall ausgeblendet. Gespeichert wird weiterhin alles vollständig – nur Anzeige, Landekarte und Diagnosepaket sind maskiert.

   **Piste korrigieren:** Stimmt eine Piste nicht (viele kleine Plätze haben in OurAirports keine Koordinaten, dann leitet VectaSim sie aus deiner Rollspur ab), öffne in der Landeauswertung unter dem Pistennamen *Piste korrigieren …* und trag Schwelle und Ende in Dezimalgrad ein – oder übernimm sie mit einem Klick aus der aktuellen Landung. Deine Piste hat Vorrang vor der Datenbank und gilt für alle Landungen an diesem Platz; *Zurücksetzen auf Datenbank* macht das rückgängig.
   **Notizen & Tags:** Im Logbuch steht unter dem Kopf jedes Flugs der Bereich *Notizen & Tags* für eigene Notizen, Tags und eine Bewertung mit 1–5 Sternen; mit *Korrigieren …* überschreibst du ein falsch aufgezeichnetes Rufzeichen, einen Flughafen, den Flugzeugnamen oder das Kennzeichen, der Originalwert bleibt gespeichert und steht im Tooltip. Die Logbuch-Suche findet auch Notizen und Tags, der Filter *Tags* zeigt nur Flüge mit den gewählten Tags.
   **Integrationen:** Unter *Einstellungen → Integrationen* zeigt VectaSim deinen Flug auf Wunsch als Discord-Status (Route, Typ, Phase, Flugzeit; im Streamer-Modus ohne Rufzeichen), meldet Landung, gespeicherten Flug, Verbindungsabbrüche und Updates als Windows-Benachrichtigung, solange das Fenster im Hintergrund ist, und legt sich beim Minimieren in den Infobereich (Tray). Der Discord-Status braucht eine Discord-Anwendung mit dem Bild-Asset `vectasim`: Solange die VectaSim-App-ID noch nicht hinterlegt ist, trägst du dort die Application ID deiner eigenen Anwendung aus dem Discord Developer Portal ein. Benachrichtigungen tragen erst im installierten VectaSim Namen und Symbol der App, und ein Klick holt das Fenster nur nach vorn, solange die Meldung noch auf dem Bildschirm ist (nicht aus dem Info-Center).
4. Wenn etwas nicht erkannt wird: *Einstellungen → Diagnose* zeigt die Datenrate (zählt sie nicht hoch, kommen keine Daten vom Sim) und die gefundene DLL.

**Nach einem Absturz** (VectaSim oder Simulator): Starte beides neu und lade den Flug an derselben Stelle – bist du höchstens 30 Minuten später und 5 nm entfernt wieder da, fragt VectaSim „Flug fortsetzen?“, und *Fortsetzen* macht daraus wieder einen einzigen Flug. Hast du das verpasst, bietet das Logbuch über der Liste *Zusammenführen* für die beiden Teile an; der zweite Teil liegt danach im Papierkorb.

## Wenn etwas nicht klappt

*Einstellungen → Diagnose* öffnen:

- **Diagnose kopieren** legt alle Zeilen (Version, Status, DLL, Pfade, Meldung) in die Zwischenablage – zum Einfügen in ein GitHub-Issue.
- **Protokoll-Ordner öffnen** zeigt `vectasim.log` im Explorer (`%LOCALAPPDATA%\io.vectasim.app\logs\`). Die Datei wird bei 5 MB gewechselt, höchstens 5 Dateien bleiben liegen. Bitte die Datei an einen Fehlerbericht anhängen.
- **Protokollstufe** auf *Ausführlich* stellen, wenn der Support danach fragt, den Fehler nachstellen, danach wieder auf *Normal*.
- **Debug-Modus** einschalten, den Fehler nachstellen und dann **Diagnosepaket erstellen** klicken: VectaSim speichert eine ZIP-Datei (Vorschlag: auf dem Desktop) mit Protokollen, Einstellungen und Simulator-Aufzeichnungen, die du an den Entwickler schickst. Passwörter oder Schlüssel sind nicht enthalten, die SimBrief-ID ist unkenntlich gemacht, und nach der Fehlersuche schaltest du den Debug-Modus einfach wieder aus.

## Daten

Alles liegt lokal unter `%APPDATA%\io.vectasim.app\` (`vectasim.db` = Logbuch, `airframes\` = eigene Flugzeugbilder), die Protokolle unter `%LOCALAPPDATA%\io.vectasim.app\logs\`. Kein Account, keine Cloud. Netzzugriffe: OpenFreeMap (Karte), aviationweather.gov/VATSIM (METAR, nur Flughäfen im Ausschnitt), VATSIM-Feed (nur wenn „Verkehr" an), SimBrief (beim Start und beim Verbinden mit dem Sim, wenn eine Pilot-ID eingetragen ist; abschaltbar unter *Einstellungen → Flugplanung*), Planespotters.net (Flugzeugfotos, abschaltbar), GitHub (Update-Prüfung).

### Sicherungen, Wiederherstellen, Papierkorb (*Einstellungen → Daten*)

- **Sicherungen** landen standardmäßig in `%LOCALAPPDATA%\io.vectasim.app\backups\` als normale SQLite-Dateien (`vectasim-<Datum>-<Uhrzeit>.db`, Zeit in UTC). Mit **Ändern …** wählst du einen anderen Ordner – ein Ordner in OneDrive, Dropbox, Google Drive oder auf einem NAS ist ideal, dann liegt eine Kopie außerhalb dieses PCs. Die Datenbank selbst bleibt lokal: Sync-Dienste können eine geöffnete SQLite-Datenbank (WAL) beschädigen, VectaSim warnt, wenn sie doch in so einem Ordner liegt.
- **Automatisch**: einmal am Tag (kurz nach dem Start bzw. stündlich geprüft, nie während einer Aufzeichnung), vor jedem Update (`vectasim-pre-update-…`) und vor jeder Umstellung des Datenformats (`vectasim-pre-v<alt>-…`). Aufbewahrt werden die letzten 7 Tage (je eine Sicherung pro Tag), die letzten 5 Sicherungen vor Update/Wiederherstellen/Löschen und alle Sicherungen vor Datenformat-Umstellungen. Andere Dateien im Ordner fasst VectaSim nicht an.
- **Keine Zusatz-Kompression**: die Tracks – der größte Teil des Logbuchs – sind bereits zstd-komprimiert; so bleibt jede Sicherung mit jedem SQLite-Werkzeug lesbar.
- **Wiederherstellen** (aus der Liste oder *Aus Datei wiederherstellen …*, z. B. auf einem neuen PC aus dem OneDrive-Ordner): VectaSim prüft die Datei (`PRAGMA integrity_check`, Datenformat nicht neuer als die App), sichert den aktuellen Stand (`vectasim-pre-restore-…`) und startet neu; beim Start wird die Datei ersetzt. Während einer Aufzeichnung geht das nicht.
- **Papierkorb**: *Löschen* im Logbuch legt einen Flug für 30 Tage in den Papierkorb (Toast mit *Rückgängig*, Filter *Papierkorb* im Logbuch mit *Wiederherstellen* und *Endgültig löschen*). Ältere Einträge entfernt VectaSim beim Start.
- **Umzug / zwei PCs zusammenführen**: *Alles exportieren …* schreibt eine `.vectasim`-Datei (ein ZIP mit allen Flügen samt Tracks, der Flotte und deinen eigenen Flugzeugbildern; mit *Papierkorb einschließen* auch die gelöschten Flüge). Auf dem anderen PC *Aus Datei importieren …* wählen: **Zusammenführen** (Standard) übernimmt nur, was dort noch fehlt – ein Flug mit derselben Kennung oder derselben Strecke und weniger als 15 Minuten Unterschied beim Off-Block gilt als schon vorhanden; vorhandene Flugzeugdaten werden nur ergänzt, nie überschrieben. **Ersetzen** sichert zuerst das bisherige Logbuch (`vectasim-pre-import-…`) und ersetzt dann alle Flüge und die Flotte. Landungs- und Anflugauswertungen rechnet VectaSim danach neu. Demo-Flüge werden nicht exportiert.
- **Flüge aus anderen Logbüchern** (*Import → CSV importieren …*): liest die Import-CSV von Volanta, VectaSims eigenes Logbuch-CSV, einen SimToolkitPro- oder VA-Export und jede andere CSV-/TXT-Datei bis 50 MB. VectaSim erkennt Trennzeichen, Kodierung und Format und schlägt eine Spaltenzuordnung vor; du prüfst sie, wählst Datumsformat, Zeitzone (UTC oder Ortszeit dieses PCs), kg/lb und siehst die ersten 20 Zeilen mit Hinweisen, bevor etwas geschrieben wird. Importierte Flüge haben keinen Track: Sie zählen für Stunden, Strecken, Flotte und Länder, Landeanalyse und Streubild bleiben für sie leer; eine Landerate aus der Datei steht in den Notizen. Flüge, die schon da sind (gleiche Strecke, Off-Block weniger als 15 Minuten auseinander, auch im Papierkorb), werden übersprungen. Importierte Flüge findest du im Logbuch über den Tag `import`; vor einem großen Import lohnt *Jetzt sichern*.
- **Alle Daten löschen** entfernt alle Flüge und die Flotte nach zwei Bestätigungen; vorher wird eine Sicherung angelegt (`vectasim-pre-wipe-…`). Einstellungen bleiben.
- **Datenformat**: Umstellungen laufen pro Schritt in einer Transaktion – schlägt eine fehl, bleibt die Datei unverändert, und VectaSim zeigt beim Start einen Dialog mit dem Pfad der Datenbank und der Sicherung statt sich still zu schließen. Ein Logbuch einer neueren VectaSim-Version öffnet eine ältere Version nicht (Hinweis: neue Version installieren).
