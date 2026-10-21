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

1. Bump the version everywhere it is written down, add the section to `CHANGELOG.md` (in English) and commit:

   | File | Field |
   |---|---|
   | `app/package.json` | `version` |
   | `app/package-lock.json` | `version` and `packages[""].version` (two places; `npm install` in `app/` rewrites both) |
   | `app/src-tauri/tauri.conf.json` | `version` – the installer and the updater use this one |
   | `Cargo.toml` | `[workspace.package] version` (all crates inherit it) |
   | `Cargo.lock` | the `vectasim*` entries – run any `cargo` command (e.g. `cargo check`) after the Cargo.toml bump |
   | `THIRD-PARTY-NOTICES.md` | “as of version …” in the header, when the tables are regenerated |
   | `README.md`, `README.de.md` | the *Status* line (“Beta 0.5 …”), when the minor version changes |

2. Tag the release on the **public snapshot**, not in a development checkout. Releases are built from a snapshot of the development tree that the maintainer’s snapshot script publishes as a single commit; the same script creates the tag `vX.Y.Z` on that commit and pushes it. Never push a tag from a development checkout to the public repository: its commits contain history that is not part of the snapshot. To make that impossible by accident, the development checkout has no push URL for the public remote:
   ```bash
   git remote set-url --push origin no_push
   ```
3. The workflow `.github/workflows/release.yml` first checks that the tag matches every version field above that it can read (package.json, package-lock.json ×2, tauri.conf.json, Cargo.toml, Cargo.lock) and, in parallel, runs every job of `ci.yml` on the tagged commit; it stops if a version differs or a check fails. Only then does it build the NSIS installer on `windows-latest`, signs the updater artifact and creates a **draft release** with `VectaSim_X.Y.Z_x64-setup.exe`, `…-setup.exe.sig` and `latest.json` (takes about 10–15 min). The release text – also the `notes` in `latest.json`, shown in *Settings → Updates* – is a short English pointer to the CHANGELOG.
4. Check the draft: the workflow names it `VectaSim vX.Y.Z` with a one-line text – set the title (so far `VectaSim X.Y.Z (Beta)`) and the release text (the summary and highlights of the CHANGELOG section) by hand; the `notes` in `latest.json` stay the short pointer. Then publish it **without** the pre-release flag (the updater reads `releases/latest`, which skips pre-releases) – from then on, running installations find the update.

The workflow `ci.yml` runs `cargo clippy -D warnings`, `cargo test`, `cargo audit`, `cargo deny check`, `npm audit --omit=dev --audit-level=high`, `eslint`, `tsc`, `npm test` and the README pair check (`scripts/readme-pair-check.mjs`) on every push to `main` and on every pull request; the release workflow calls it as a reusable workflow (`workflow_call`) with a read-only token and without secrets, so a release can only be built from a commit that passes. A red check in a release run means: fix it in the development tree, publish a new snapshot and tag again with the next patch version – never move a published tag.

Both workflows pin every third-party action to a full commit SHA (the comment names the release), check out without persisting the token (`persist-credentials: false`) and run with read-only permissions; only the release job gets `contents: write`. A moved tag of an action therefore cannot slip unnoticed into the build that has access to the signing key. Accepted residual risk: the signing key is in the environment of the tauri-action step, and that step also runs the frontend build (`beforeBuildCommand`, Vite with its dev dependencies), which `npm audit --omit=dev` does not cover – keep the dev dependencies few and current, and install them only with `npm ci` from the lock file. When updating an action, change the SHA and the comment together and verify the SHA, e.g. `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (an annotated tag needs one more step: `gh api repos/<owner>/<repo>/git/tags/<sha>`). The Rust toolchain is installed with `rustup toolchain install` from `rust-toolchain.toml`.

The installer ships `LICENSE.txt` (VectaSim’s MIT license) and `THIRD-PARTY-NOTICES.md` next to `vectasim.exe` (`tauri.conf.json` → `bundle.resources`). Regenerate the notices when dependencies change.

## Testing locally

An `npm run tauri build` without the signing variables set fails as long as `createUpdaterArtifacts` is enabled. To sign locally (cmd):

```bat
set TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\vectasim.key
set /p TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<%USERPROFILE%\.tauri\vectasim.key.password
cd app && npm run tauri build
```

Without a key: `npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"`.

In dev mode (`npm run tauri dev`) the update check comes up empty (no release matches the dev version) and only reports this quietly in Diagnostics.
