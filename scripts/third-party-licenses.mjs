#!/usr/bin/env node
// Generates THIRD-PARTY-LICENSES.txt: the full licence text, with its copyright lines, of every
// third-party component the installer ships in compiled form – the embedded data (OurAirports,
// Natural Earth, Unicode CLDR), the npm production dependencies of the frontend (including the
// ten fonts, SIL OFL 1.1) and the Rust crates of the Windows build. The installer places the
// file next to vectasim.exe (app/src-tauri/tauri.conf.json -> bundle.resources).
//
//   node scripts/third-party-licenses.mjs           regenerate the file
//   node scripts/third-party-licenses.mjs --check   exit code 1 when the file does not match
//                                                   the dependencies in Cargo.lock and
//                                                   app/package-lock.json (no tools needed)
//
// Regenerating needs:
//   - cargo-about, pinned (ABOUT_VERSION below):
//       cargo install cargo-about --locked --version 0.9.2 --features cli
//     It runs offline (--frozen) with scripts/third-party-licenses/about.toml (same graph as
//     deny.toml: x86_64-pc-windows-msvc, normal dependencies, workspace crates skipped) and the
//     template about.hbs, so the result only depends on Cargo.lock and the crate sources in
//     the cargo cache (`cargo fetch --locked` first on a fresh machine).
//   - npm packages installed in app/ (`npm ci`); license-checker-rseidelsohn is run through
//     npx at a pinned version (CHECKER below) with --production.
//   - scripts/third-party-licenses/data-licenses.txt: the hand-written part for the embedded
//     data; edit it when a data source changes (see THIRD-PARTY-NOTICES.md, "Data and services").
//
// The file records a fingerprint of the dependency set (every registry package of Cargo.lock
// and every non-dev package of app/package-lock.json, name and version). --check recomputes it;
// a version bump of VectaSim itself does not change it, an added, removed or updated
// dependency does. Cargo.lock lists the packages of every target, so a change in a Linux- or
// macOS-only crate also asks for a regeneration (harmless: the content stays the same).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ABOUT_VERSION = "0.9.2";
const CHECKER = "license-checker-rseidelsohn@5.0.1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "scripts", "third-party-licenses");
const outFile = join(root, "THIRD-PARTY-LICENSES.txt");
const appDir = join(root, "app");
const RULE = "=".repeat(80);
const MIT_TEXT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const LINE = "-".repeat(80);

// ---- fingerprint of the dependency set -------------------------------------------------------

function cargoPackages() {
  const text = readFileSync(join(root, "Cargo.lock"), "utf8").replace(/\r\n/g, "\n");
  const out = [];
  for (const block of text.split("\n[[package]]\n").slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    // workspace crates have no `source`
    if (name && version && /^source = /m.test(block)) out.push(`cargo:${name}@${version}`);
  }
  return out;
}

function npmPackages() {
  const lock = JSON.parse(readFileSync(join(appDir, "package-lock.json"), "utf8"));
  const out = [];
  for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
    if (!key || pkg.dev || pkg.link) continue;
    const name = pkg.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    out.push(`npm:${name}@${pkg.version}`);
  }
  return out;
}

function fingerprint() {
  const all = [...cargoPackages(), ...npmPackages()].sort();
  return createHash("sha256").update(all.join("\n")).digest("hex");
}

const FP_LABEL = "Dependency fingerprint (scripts/third-party-licenses.mjs --check): ";

if (process.argv.includes("--check")) {
  if (!existsSync(outFile)) {
    console.error("THIRD-PARTY-LICENSES.txt is missing - run `node scripts/third-party-licenses.mjs`");
    process.exit(1);
  }
  const recorded = readFileSync(outFile, "utf8").split(/\r?\n/).find((l) => l.startsWith(FP_LABEL))?.slice(FP_LABEL.length).trim();
  const current = fingerprint();
  if (recorded !== current) {
    console.error(
      "THIRD-PARTY-LICENSES.txt is out of date: Cargo.lock or app/package-lock.json changed its dependencies.\n" +
        "Regenerate it with `node scripts/third-party-licenses.mjs` (see the comment at the top of the script)\n" +
        "and update the tables in THIRD-PARTY-NOTICES.md.",
    );
    process.exit(1);
  }
  console.log("THIRD-PARTY-LICENSES.txt ok: matches Cargo.lock and app/package-lock.json");
  process.exit(0);
}

// ---- generation ------------------------------------------------------------------------------

const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  // npx is a .cmd on Windows: start it through cmd.exe (every argument here is a constant)
  const [file, argv] = isWin && cmd === "npx" ? ["cmd.exe", ["/d", "/s", "/c", "npx", ...args]] : [cmd, args];
  return execFileSync(file, argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
}

function clean(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\n+$/g, "");
}

const aboutVersion = (() => {
  try {
    return run("cargo", ["about", "--version"]).trim();
  } catch {
    return "";
  }
})();
if (!aboutVersion.endsWith(` ${ABOUT_VERSION}`)) {
  console.error(
    `cargo-about ${ABOUT_VERSION} is needed (found: ${aboutVersion || "none"}). Install it with\n` +
      `  cargo install cargo-about --locked --version ${ABOUT_VERSION} --features cli`,
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "vectasim-licenses-"));
try {
  // Rust crates
  const rustFile = join(tmp, "rust.txt");
  run("cargo", [
    "about", "generate", "--frozen", "--workspace", "--fail",
    "-c", join(here, "about.toml"),
    "-m", join(root, "Cargo.toml"),
    "-o", rustFile,
    join(here, "about.hbs"),
  ], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const rust = clean(readFileSync(rustFile, "utf8"));
  const crateCount = new Set(rust.split("\n").filter((l) => l.startsWith("  - ")).map((l) => l.split(" ").slice(3, 5).join(" "))).size;

  // npm production packages
  const report = JSON.parse(run("npx", ["--yes", CHECKER, "--production", "--json", "--excludePrivatePackages"], { cwd: appDir }));
  const npmEntries = Object.entries(report).sort(([a], [b]) => a.localeCompare(b));

  // licenseFile is the file the checker judged to be the licence. Some packages ship only an SPDX
  // manifest (LICENSE.spdx, all @tauri-apps packages) or keep the licence in the README; then
  // the real text comes from the package folder.
  function npmLicenceText(id, info) {
    const file = info.licenseFile ?? "";
    const name = basename(file).toLowerCase();
    const looksReal = file && !name.includes(".spdx") && !name.includes("readme");
    if (looksReal) return clean(readFileSync(file, "utf8"));
    const dir = info.path;
    const files = readdirSync(dir);
    const licences = files.filter((f) => /^(licen[cs]e|copying)/i.test(f) && !/\.spdx$/i.test(f));
    // "MIT OR Apache-2.0": VectaSim chooses MIT
    const mit = licences.find((f) => /mit/i.test(f));
    const pick = /\bMIT\b/.test(info.licenses ?? "") && mit ? mit : licences[0];
    if (pick) return clean(readFileSync(join(dir, pick), "utf8"));
    const readme = files.find((f) => /^readme/i.test(f));
    if (readme) {
      const text = clean(readFileSync(join(dir, readme), "utf8"));
      const m = /^#{1,6}\s*Licen[cs]e.*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im.exec(text);
      if (m && /permission|copyright/i.test(m[1])) return clean(m[1]);
    }
    // only an SPDX manifest (the @tauri-apps plugins): its copyright line plus the MIT text
    const spdx = files.find((f) => /\.spdx$/i.test(f));
    if (spdx && /\bMIT\b/.test(info.licenses ?? "")) {
      const copyright = /^PackageCopyrightText:\s*(.+)$/m.exec(readFileSync(join(dir, spdx), "utf8"))?.[1]?.trim();
      if (copyright) {
        const note = `(The package ships only an SPDX manifest, ${spdx}; copyright from there, licence text: MIT.)`;
        return `${note}\n\nCopyright (c) ${copyright}\n\n${MIT_TEXT}`;
      }
    }
    throw new Error(`no licence text found for ${id} (${info.licenses}) in ${dir}`);
  }

  const npmText = npmEntries
    .map(([id, info]) => [LINE, `${id} - ${info.licenses}${info.repository ? ` - ${info.repository}` : ""}`, "", npmLicenceText(id, info), ""].join("\n"))
    .join("\n");

  const data = clean(readFileSync(join(here, "data-licenses.txt"), "utf8"));

  const out = [
    "VectaSim - third-party licences",
    RULE,
    "",
    "VectaSim itself is licensed under the MIT License (LICENSE.txt in this folder). This file",
    "holds the licence texts, with their copyright notices, of the third-party data, fonts and",
    "libraries that are compiled into vectasim.exe or bundled with it. THIRD-PARTY-NOTICES.md (in",
    "this folder) is the overview: sources, versions, the online services the app uses and their",
    "terms. Where a component is offered under a choice of licences (\"MIT OR Apache-2.0\"),",
    "VectaSim chooses the MIT License if it is one of the options; the text below is the one of",
    "the chosen licence.",
    "",
    "Contents:",
    "  1. Embedded data",
    `  2. Frontend: npm packages, including the fonts (${npmEntries.length} packages)`,
    `  3. Backend: Rust crates of the Windows build (${crateCount} crates, grouped by licence text)`,
    "",
    "Generated by scripts/third-party-licenses.mjs (cargo-about " + ABOUT_VERSION + ", " + CHECKER + ").",
    FP_LABEL + fingerprint(),
    "",
    "",
    RULE,
    "1. Embedded data",
    RULE,
    "",
    data,
    "",
    "",
    RULE,
    "2. Frontend: npm packages (production dependencies, including the fonts)",
    RULE,
    "",
    npmText,
    "",
    RULE,
    "3. Backend: Rust crates (Windows build)",
    RULE,
    "",
    "Each block names one licence text and the crates (version, authors) it applies to.",
    "",
    rust,
    "",
  ].join("\n");

  writeFileSync(outFile, out.replace(/\n{4,}/g, "\n\n\n"), "utf8");
  const size = Buffer.byteLength(out, "utf8");
  console.log(`THIRD-PARTY-LICENSES.txt written: ${npmEntries.length} npm packages, ${crateCount} crates, ${(size / 1024).toFixed(0)} KiB`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
