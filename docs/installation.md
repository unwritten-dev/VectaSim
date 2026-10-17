# VectaSim installieren (Windows, Sim-PC)

Zwei Wege: **A** über den fertigen Installer aus den GitHub-Releases (empfohlen, bekommt Auto-Updates) oder **B** direkt aus dem Quellcode.

## Voraussetzungen auf dem Sim-PC

- Windows 10/11 64-bit, WebView2 (ist in Windows enthalten).
- MSFS 2020 oder 2024 (Store oder Steam). X-Plane folgt.
- **SimConnect.dll** – wird beim Start gesucht in dieser Reihenfolge:
  1. Umgebungsvariable `VECTASIM_SIMCONNECT_DLL=<voller Pfad zur SimConnect.dll>`
  2. neben `VectaSim.exe`
  3. `%MSFS2024_SDK%\SimConnect SDK\lib\SimConnect.dll` bzw. `%MSFS_SDK%\SimConnect SDK\lib\SimConnect.dll` (gesetzt, wenn das MSFS SDK installiert ist)
  4. Windows-Suchpfad.

  Die DLL kommt aus dem offiziellen **MSFS SDK**: im Sim unter *Optionen → Allgemein → Entwickler* den Entwicklermodus einschalten, dann im Menü *Hilfe → SDK-Installer* das SDK installieren. VectaSim liefert die DLL nicht mit. Die App zeigt in *Einstellungen → Diagnose*, welche DLL sie gefunden hat.

## Weg A – Installer aus GitHub Releases

1. Unter https://github.com/unwritten-dev/VectaSim/releases die neueste Version öffnen und `VectaSim_<version>_x64-setup.exe` herunterladen.
2. Installer starten. Windows SmartScreen meldet „unbekannter Herausgeber" (noch kein Code-Signing-Zertifikat) → *Weitere Informationen → Trotzdem ausführen*. Der Installer braucht keine Adminrechte (Installation pro Benutzer).
3. SimConnect.dll bereitstellen (siehe oben), falls das MSFS SDK noch nicht installiert ist.
4. VectaSim starten, MSFS starten – sobald der Sim im Hauptmenü ist, springt die Statuspille auf „Bereit"; die Aufzeichnung beginnt beim Losrollen.

**Updates:** Installierte Apps melden ein neues Release beim nächsten Start (Toast „Update verfügbar") oder über *Einstellungen → Updates* und installieren es nach Bestätigung.

## Weg B – aus dem Quellcode

Auf dem Sim-PC:

1. Installieren: [Git](https://git-scm.com), [Node.js 22](https://nodejs.org), [Rust](https://rustup.rs) (Toolchain `stable-x86_64-pc-windows-msvc`), [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/de/visual-cpp-build-tools/) mit Workload „Desktopentwicklung mit C++".
2. Code holen und Frontend-Abhängigkeiten installieren:
   ```bash
   git clone https://github.com/unwritten-dev/VectaSim.git && cd VectaSim/app && npm ci
   ```
3. Entweder direkt starten (Dev-Modus, startet in ~1 min):
   ```bash
   npm run tauri dev
   ```
   oder einen eigenen Installer bauen. Ohne Signaturschlüssel muss dabei das Updater-Artefakt abgeschaltet werden (cmd):
   ```bat
   npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"
   ```
   Ergebnis: `target/release/bundle/nsis/VectaSim_<version>_x64-setup.exe`. Ein so gebauter Installer funktioniert normal; nur die Auto-Update-Signatur fehlt.

## Erster Flug – kurz

1. VectaSim läuft, MSFS steht im Hauptmenü → Pille „Bereit · Aufzeichnung startet beim Losrollen".
2. Optional *Flugplan*: SimBrief-ID eintragen, „SimBrief-OFP laden" – Route erscheint gestrichelt, Soll/Ist wird verglichen.
3. Fliegen. Nach dem Aufsetzen: Lande-Toast → „Landeauswertung". Nach On-Block: Nach-dem-Flug-Karte, Flug steht im Logbuch.
4. Zum Abgleich: *Einstellungen → Diagnose* zeigt Datenrate (erwartet 30–60 Hz) und gefundene DLL; Punkte für den ersten Live-Test stehen in [sim-pc-checklist.md](sim-pc-checklist.md).

## Daten

Alles liegt lokal unter `%APPDATA%\io.vectasim.app\` (`vectasim.db` = Logbuch, `airframes\` = eigene Flugzeugbilder). Kein Account, keine Cloud. Netzzugriffe: OpenFreeMap (Karte), aviationweather.gov/VATSIM (METAR, nur Flughäfen im Ausschnitt), VATSIM-Feed (nur wenn „Verkehr" an), SimBrief (nur auf Knopfdruck), Planespotters.net (Flugzeugfotos, abschaltbar), GitHub (Update-Prüfung).
