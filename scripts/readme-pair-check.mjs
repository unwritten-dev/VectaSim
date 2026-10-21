#!/usr/bin/env node
// Checks that README.md (English) and README.de.md (German) have the same structure, so a
// feature added to one is not forgotten in the other (DEVELOPMENT.md -> Conventions -> README
// pairs). Run from anywhere: `node scripts/readme-pair-check.mjs [english.md german.md]`.
// Exit code 1 on any difference, so it can gate CI.
//
// Compared line by line, outside the prose:
//   - headings (level, in order),
//   - list items (indent level) and table rows (column count) per section,
//   - fenced code blocks (count and content - commands are not translated),
//   - images: count per section and the same file once /en/ and /de/ are ignored.
// Also checked per file: every relative link and image target exists, every in-page anchor
// (#...) matches a heading of that file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [enPath, dePath] = process.argv.length >= 4
  ? [resolve(process.argv[2]), resolve(process.argv[3])]
  : [join(root, "README.md"), join(root, "README.de.md")];

// GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens.
function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

// One entry per structural line: { kind, detail, line, section }.
function skeleton(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const out = [];
  const anchors = new Set();
  const links = [];
  let section = "(top)";
  let fence = null;
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (fence !== null) {
      if (/^\s*```/.test(raw)) {
        out.push({ kind: "code", detail: fence.join("\n"), line, section });
        fence = null;
      } else fence.push(raw);
      return;
    }
    if (/^\s*```/.test(raw)) { fence = []; return; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      section = h[2];
      anchors.add(slug(h[2]));
      out.push({ kind: `h${h[1].length}`, detail: "", line, section });
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(raw)) {
      const indent = Math.floor(/^\s*/.exec(raw)[0].length / 2);
      out.push({ kind: "li", detail: `indent ${indent}`, line, section });
    } else if (/^\s*\|.*\|\s*$/.test(raw)) {
      const cols = raw.trim().slice(1, -1).split(/(?<!\\)\|/).length;
      out.push({ kind: "tr", detail: `${cols} columns`, line, section });
    }
    for (const m of raw.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img\b[^>]*\bsrc="([^"]+)"/g)) {
      const src = m[1] || m[2];
      out.push({ kind: "img", detail: src.replace(/\/(en|de)\//, "/<lang>/"), line, section });
      links.push({ target: src, line });
    }
    for (const m of raw.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)[^)]*\)|<a\b[^>]*\bhref="([^"]+)"/g)) {
      links.push({ target: m[1] || m[2], line });
    }
  });
  if (fence !== null) out.push({ kind: "error", detail: "unclosed code block", line: 0, section });
  return { out, anchors, links };
}

const errors = [];
const files = {};
for (const [name, path] of [["en", enPath], ["de", dePath]]) {
  if (!existsSync(path)) { console.error(`missing ${path}`); process.exit(1); }
  files[name] = skeleton(path);
  const { anchors, links, out } = files[name];
  for (const e of out.filter((x) => x.kind === "error")) errors.push(`${path}: ${e.detail}`);
  for (const { target, line } of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto: ...
    if (target.startsWith("#")) {
      if (!anchors.has(target.slice(1))) errors.push(`${path}:${line}: anchor ${target} matches no heading`);
      continue;
    }
    const file = decodeURIComponent(target.split("#")[0]);
    if (file && !existsSync(join(dirname(path), file))) errors.push(`${path}:${line}: ${file} does not exist`);
  }
}

const en = files.en.out.filter((x) => x.kind !== "error");
const de = files.de.out.filter((x) => x.kind !== "error");
const describe = (x) => (x ? `${x.kind}${x.detail && x.kind !== "code" ? ` (${x.detail})` : ""} at line ${x.line}, section "${x.section}"` : "nothing");
for (let i = 0; i < Math.max(en.length, de.length); i++) {
  const a = en[i], b = de[i];
  if (a && b && a.kind === b.kind && a.detail === b.detail) continue;
  errors.push(`structure differs:\n    ${enPath}: ${describe(a)}\n    ${dePath}: ${describe(b)}`);
  break; // everything after the first difference is shifted
}

if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
const count = (k) => en.filter((x) => x.kind.startsWith(k)).length;
console.log(`README pair ok: ${count("h")} headings, ${count("li")} list items, ${count("tr")} table rows, ${count("img")} images, ${count("code")} code blocks`);
