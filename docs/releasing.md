# Releases und Auto-Update

Dokumentation für Maintainer. Nutzer installieren nach [installation.md](installation.md).

VectaSim aktualisiert sich selbst über `tauri-plugin-updater`: Die App lädt beim Start (still, nach 10 s) und auf Knopfdruck in *Einstellungen → Updates* die Datei

```
https://github.com/unwritten-dev/VectaSim/releases/latest/download/latest.json
```

und installiert eine neuere Version nach Bestätigung (NSIS, `installMode: passive`), danach Neustart. Jede Update-Datei ist mit einem minisign-Schlüssel signiert; der öffentliche Schlüssel steht in `app/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Ohne gültige Signatur installiert die App nichts.

## Schlüssel

Erzeugt mit `npx tauri signer generate`. **Nicht im Repo.** Liegt auf dem Rechner des Maintainers unter

```
%USERPROFILE%\.tauri\vectasim.key            (privater Schlüssel, passwortgeschützt)
%USERPROFILE%\.tauri\vectasim.key.password   (Passwort)
%USERPROFILE%\.tauri\vectasim.key.pub        (öffentlicher Schlüssel, identisch mit tauri.conf.json)
```

Schlüssel und Passwort sichern (Passwort-Manager). Geht der Schlüssel verloren, können bestehende Installationen kein Update mehr annehmen – dann hilft nur ein neuer Installer mit neuem Schlüssel.

## GitHub-Secrets

Der Release-Workflow braucht in *Repository → Settings → Secrets and variables → Actions*:

| Secret | Inhalt |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | kompletter Inhalt von `vectasim.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Inhalt von `vectasim.key.password` |

## Release erstellen

1. Version in `app/src-tauri/tauri.conf.json` (`version`) und `app/package.json` anheben, `CHANGELOG.md` ergänzen, committen.
2. Tag setzen und pushen:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. Der Workflow `.github/workflows/release.yml` baut auf `windows-latest` den NSIS-Installer, signiert das Updater-Artefakt und legt einen **Draft-Release** mit `VectaSim_0.2.0_x64-setup.exe`, `…-setup.exe.sig` und `latest.json` an (Dauer ca. 10–15 min).
4. Draft prüfen und veröffentlichen – ab dann finden laufende Installationen das Update.

Der Workflow `ci.yml` führt bei jedem Push `cargo test`, `clippy -D warnings`, `tsc` und `npm test` aus.

Der Release-Workflow pinnt `tauri-apps/tauri-action` auf einen festen Commit-SHA (Kommentar nennt die Version), damit ein geänderter Tag nicht unbemerkt in den Build mit Zugriff auf den Signaturschlüssel gelangt. Beim Aktualisieren SHA und Kommentar gemeinsam ändern.

## Lokal testen

Ein `npm run tauri build` ohne gesetzte Signatur-Variablen schlägt fehl, solange `createUpdaterArtifacts` aktiv ist. Lokal signieren (cmd):

```bat
set TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\vectasim.key
set /p TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<%USERPROFILE%\.tauri\vectasim.key.password
cd app && npm run tauri build
```

Ohne Schlüssel: `npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"`.

Im Dev-Modus (`npm run tauri dev`) läuft die Update-Prüfung ins Leere (kein Release passend zur Dev-Version) und meldet das nur still in der Diagnose.
