# Releases and automatic updates

Documentation for maintainers. Users install according to [installation.md](installation.md).

VectaSim updates itself via `tauri-plugin-updater`: at startup (silently, after 10 s) and on request in *Settings → Updates*, the app downloads the file

```
https://github.com/unwritten-dev/VectaSim/releases/latest/download/latest.json
```

and installs a newer version after the user confirms (NSIS, `installMode: passive`), followed by a restart. Every update file is signed with a minisign key; the public key is in `app/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Without a valid signature the app installs nothing.

## Keys

Generated with `npx tauri signer generate`. **Not in the repo.** Stored on the maintainer’s machine under

```
%USERPROFILE%\.tauri\vectasim.key            (private key, password-protected)
%USERPROFILE%\.tauri\vectasim.key.password   (password)
%USERPROFILE%\.tauri\vectasim.key.pub        (public key, identical to tauri.conf.json)
```

Back up the key and password (password manager). If the key is lost, existing installations can no longer accept updates – the only way out is a new installer with a new key.

## GitHub secrets

The release workflow needs, under *Repository → Settings → Secrets and variables → Actions*:

| Secret | Content |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | full content of `vectasim.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | content of `vectasim.key.password` |

## Creating a release

1. Bump the version in `app/src-tauri/tauri.conf.json` (`version`) and `app/package.json`, add to `CHANGELOG.md` (in English), commit.
2. Create and push the tag:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. The workflow `.github/workflows/release.yml` builds the NSIS installer on `windows-latest`, signs the updater artifact and creates a **draft release** with `VectaSim_0.2.0_x64-setup.exe`, `…-setup.exe.sig` and `latest.json` (takes about 10–15 min).
4. Check the draft and publish it – from then on, running installations find the update.

The workflow `ci.yml` runs `cargo test`, `clippy -D warnings`, `tsc` and `npm test` on every push.

The release workflow pins `tauri-apps/tauri-action` to a fixed commit SHA (the comment names the version), so that a moved tag cannot slip unnoticed into the build that has access to the signing key. When updating, change the SHA and the comment together.

## Testing locally

An `npm run tauri build` without the signing variables set fails as long as `createUpdaterArtifacts` is enabled. To sign locally (cmd):

```bat
set TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\vectasim.key
set /p TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<%USERPROFILE%\.tauri\vectasim.key.password
cd app && npm run tauri build
```

Without a key: `npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"`.

In dev mode (`npm run tauri dev`) the update check comes up empty (no release matches the dev version) and only reports this quietly in Diagnostics.
