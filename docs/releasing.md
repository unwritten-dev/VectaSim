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
   | `README.md`, `README.de.md` | the *Status* line (“Beta 0.6 …”), when the minor version changes |

   When `Cargo.lock` or `app/package-lock.json` changed their dependencies since the last release, also regenerate the licence texts and the notices tables in the same commit:
   - `node scripts/third-party-licenses.mjs` rewrites `THIRD-PARTY-LICENSES.txt` (needs `cargo install cargo-about --locked --version 0.9.2 --features cli` once and `npm ci` in `app/`; it runs offline from the cargo cache – `cargo fetch --locked` first on a fresh machine). `node scripts/third-party-licenses.mjs --check` says whether that is needed: it compares the dependency fingerprint recorded in the file with the lock files and fails when they differ; the snapshot script runs the same check and refuses to publish a stale file.
   - Update the npm and Rust tables of `THIRD-PARTY-NOTICES.md` (`npx license-checker-rseidelsohn --production` in `app/`, `cargo tree --workspace -e normal --target x86_64-pc-windows-msvc`) and the “as of version …” in its header.

2. Tag the release on the **public snapshot**, not in a development checkout. Releases are built from a snapshot of the development tree that the maintainer’s snapshot script publishes as a single commit; the same script creates the tag `vX.Y.Z` on that commit and pushes it. Never push a tag from a development checkout to the public repository: its commits contain history that is not part of the snapshot. To make that impossible by accident, the development checkout has no push URL for the public remote:
   ```bash
   git remote set-url --push origin no_push
   ```
3. The workflow `.github/workflows/release.yml` checks that the tag matches every version field above that it can read (package.json, package-lock.json ×2, tauri.conf.json, Cargo.toml, Cargo.lock), that `CHANGELOG.md` has a `## X.Y.Z` section and that both README *Status* lines name the same minor version (“Beta X.Y”), and runs every job of `ci.yml` on the tagged commit. The build (NSIS installer on `windows-latest`, signed updater artifact, a **draft release** with `VectaSim_X.Y.Z_x64-setup.exe`, `…-setup.exe.sig` and `latest.json`) starts as soon as the versions match and runs in parallel with the checks: about 17–21 min from cold; with a warm dependency cache (the `release-cache` job of `ci.yml` refreshes it on every push to the public `main`, built with the same `tauri/custom-protocol` feature that `tauri build` adds) only the workspace crates should compile – the expected 6–8 min are not measured yet: in the first release after a warm cache, count the `Compiling` lines in the tauri-action log and correct this figure. The result is only a draft: publish it solely from a run in which every job is green; if a check failed, delete the draft and the tag (`gh release delete vX.Y.Z --cleanup-tag`) and tag again after the fix. Re-using the same version is allowed only while its draft was never published: the next snapshot then gets the tag, and the public `main` keeps both snapshot commits (this happened with 0.6.0, which has two “VectaSim 0.6.0 (Beta)” commits; the tag points to the second). Once a release is published, its tag never moves – see below. The release text – also the `notes` in `latest.json`, shown in *Settings → Updates* – is a short English pointer to the CHANGELOG.
4. Check the draft: the workflow names it `VectaSim vX.Y.Z` with a one-line text – set the title (so far `VectaSim X.Y.Z (Beta)`) and the release text (the summary and highlights of the CHANGELOG section) by hand; the `notes` in `latest.json` stay the short pointer. Then publish it **without** the pre-release flag (the updater reads `releases/latest`, which skips pre-releases) – from then on, running installations find the update.

The workflow `ci.yml` runs `cargo clippy -D warnings`, `cargo test`, `cargo audit`, `cargo deny check`, `npm audit --omit=dev --audit-level=high`, `eslint`, `tsc`, `npm test` and the README pair check (`scripts/readme-pair-check.mjs`) on every push to `main` and on every pull request; the release workflow calls it as a reusable workflow (`workflow_call`) with a read-only token and without secrets; the build runs alongside, so a red check shows in the release run and the draft must not be published. A red check in a release run means: fix it in the development tree, publish a new snapshot and tag again with the next patch version – never move a published tag.

Both workflows pin every third-party action to a full commit SHA (the comment names the release), check out without persisting the token (`persist-credentials: false`) and run with read-only permissions; only the release job gets `contents: write`. A moved tag of an action therefore cannot slip unnoticed into the build that has access to the signing key. Accepted residual risk: the release job builds and signs in parallel with the `ci` checks (it needs only `versions`), so a red check does not stop the signing – it only makes the run red, and the draft must then not be published (a split into an unprivileged build job and a signing job that needs `ci` would restore the hard gate at the cost of the time saving); the signing key is in the environment of the tauri-action step, and that step also runs the frontend build (`beforeBuildCommand`, Vite with its dev dependencies), which `npm audit --omit=dev` does not cover – keep the dev dependencies few and current, and install them only with `npm ci` from the lock file. The same step also builds on top of the compiled dependencies restored from the `release-build-…` cache, which goes into the signed installer without being rebuilt. Only push runs on the public `main` save that cache (`release-cache`), and caches of pull-request runs are invisible to a tag run, so only code that is already on `main` can reach it – but a poisoned cache entry would be signed like the rest; delete the caches (`gh cache delete --all`) if a run on `main` ever looks wrong. When updating an action, change the SHA and the comment together and verify the SHA, e.g. `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (an annotated tag needs one more step: `gh api repos/<owner>/<repo>/git/tags/<sha>`). The Rust toolchain is installed with `rustup toolchain install` from `rust-toolchain.toml`.

The installer ships `LICENSE.txt` (VectaSim’s MIT license), `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-LICENSES.txt` (full licence texts with copyright notices of the embedded data, the fonts, the npm production packages and the Rust crates) next to `vectasim.exe` (`tauri.conf.json` → `bundle.resources`). Regenerate both when dependencies change (step 1).

## Testing locally

An `npm run tauri build` without the signing variables set fails as long as `createUpdaterArtifacts` is enabled. To sign locally (cmd):

```bat
set TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\vectasim.key
set /p TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<%USERPROFILE%\.tauri\vectasim.key.password
cd app && npm run tauri build
```

Without a key: `npm run tauri build -- --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"`.

In dev mode (`npm run tauri dev`) the update check comes up empty (no release matches the dev version) and only reports this quietly in Diagnostics.
