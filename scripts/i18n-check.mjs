#!/usr/bin/env node
// Checks the i18n resources; `npm run i18n:check` in app/. Exit code 1 on
// any error, so it can gate CI. de/*.json (merged) is the reference; every other language folder app/src/i18n/<lang>/*.json must
//   - have exactly the same keys (missing and surplus keys are errors),
//   - use a plural object where de does (and only there), with `other` and only categories
//     Intl.PluralRules knows; categories the language needs (one/other for de/en, few/many
//     for others) must be present,
//   - use the same {placeholders} as de for every key (per plural object: the union),
//   - have no empty strings.
// Also scans app/src for t("…") / tIn(lang, "…") calls with a key that de/*.json lacks (tsc
// catches typed calls too; this also covers plain JS and string-built keys) and lists keys
// that no source file uses yet (info only – the pilot namespace is unused on purpose).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// optional argument: another resource folder (used to test the checker itself)
const dir = process.argv[2] ? resolve(process.argv[2]) : join(root, "app", "src", "i18n");
const LOCALES = { de: "de-DE", en: "en-GB" };
const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

const errors = [];
const info = [];

const isPlural = (n) => !!n && typeof n === "object" && typeof n.other === "string" && Object.keys(n).every((k) => CATEGORIES.includes(k));

/** Flatten to { "a.b": string | pluralObject }. */
function flatten(node, prefix, out, file) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string" || isPlural(v)) out.set(key, v);
    else if (v && typeof v === "object") {
      if ("other" in v || Object.keys(v).some((c) => CATEGORIES.includes(c) && typeof v[c] === "string")) {
        errors.push(`${file}: "${key}" looks like a plural object but is invalid (needs "other", only ${CATEGORIES.join("/")})`);
      }
      flatten(v, key, out, file);
    } else errors.push(`${file}: "${key}" has an unsupported value (${JSON.stringify(v)})`);
  }
  return out;
}

const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const placeholdersOf = (v) => (typeof v === "string" ? placeholders(v) : new Set(Object.values(v).flatMap((s) => [...placeholders(s)])));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const fmtSet = (s) => `{${[...s].sort().join(", ")}}`;

/** A language is a folder (de/, en/) with one JSON file per area; all files are merged. */
function load(name) {
  const out = new Map();
  const folder = join(dir, name);
  let files;
  try {
    files = readdirSync(folder).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    errors.push(`${name}/: ${e.message}`);
    return out;
  }
  for (const f of files) {
    try {
      const part = flatten(JSON.parse(readFileSync(join(folder, f), "utf8")), "", new Map(), `${name}/${f}`);
      for (const [k, v] of part) {
        if (out.has(k)) errors.push(`${name}/${f}: "${k}" is defined twice (also in another area file)`);
        out.set(k, v);
      }
    } catch (e) {
      errors.push(`${name}/${f}: ${e.message}`);
    }
  }
  return out;
}

const langs = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort();
if (!langs.includes("de")) errors.push("de/ (reference) is missing");
const ref = load("de");

for (const lang of langs) {
  const res = lang === "de" ? ref : load(lang);
  const locale = LOCALES[lang] ?? lang;
  let needed;
  try {
    needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    errors.push(`${lang}/: unknown locale "${locale}"`);
    continue;
  }
  for (const [key, v] of res) {
    if (typeof v === "string" && !v.trim()) errors.push(`${lang}/: "${key}" is empty`);
    if (isPlural(v)) {
      for (const c of needed) if (typeof v[c] !== "string" && c !== "other") errors.push(`${lang}/: "${key}" lacks plural form "${c}" (${locale} needs ${needed.join("/")})`);
      for (const [c, s] of Object.entries(v)) if (!s.trim()) errors.push(`${lang}/: "${key}.${c}" is empty`);
      if (!placeholders(v.other).has("count") && Object.values(v).every((s) => !placeholders(s).has("count"))) info.push(`${lang}/: "${key}" is a plural without {count} (allowed, e.g. "Bounce"/"Bounces")`);
    }
    if (lang === "de") continue;
    const r = ref.get(key);
    if (r === undefined) {
      errors.push(`${lang}/: surplus key "${key}" (not in de/*.json)`);
      continue;
    }
    if (isPlural(r) !== isPlural(v)) errors.push(`${lang}/: "${key}" is ${isPlural(v) ? "a plural" : "a string"}, de/*.json has ${isPlural(r) ? "a plural" : "a string"}`);
    const a = placeholdersOf(r);
    const b = placeholdersOf(v);
    if (!same(a, b)) errors.push(`${lang}/: "${key}" placeholders ${fmtSet(b)} differ from de/*.json ${fmtSet(a)}`);
  }
  if (lang !== "de") for (const key of ref.keys()) if (!res.has(key)) errors.push(`${lang}/: missing key "${key}"`);
}

// ---- usage in the source ---------------------------------------------------------------

function walk(d, out = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}
const used = new Set();
const CALL_T = /(?<![\w.])t\(\s*["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g;
const CALL_TIN = /(?<![\w.])tIn\(\s*[^,()]+,\s*["'`]([a-z][\w]*(?:\.[\w]+)+)["'`]/g;
// tests and i18n/ itself are skipped: they use keys on purpose (doc comments, fallback tests)
for (const file of walk(join(root, "app", "src")).filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith(join(root, "app", "src", "i18n") + sep))) {
  const rel = relative(root, file).split(sep).join("/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of [CALL_T, CALL_TIN]) {
      for (const m of line.matchAll(re)) {
        used.add(m[1]);
        if (!ref.has(m[1])) errors.push(`${rel}:${i + 1}: t("${m[1]}") – key not in de/*.json`);
      }
    }
  });
}
const unused = [...ref.keys()].filter((k) => !used.has(k));
if (unused.length) info.push(`${unused.length} of ${ref.size} keys not used in app/src yet: ${unused.join(", ")}`);

console.log(`i18n check: ${langs.length} languages (${langs.join(", ")}), ${ref.size} keys in de/*.json`);
for (const m of info) console.log(`  info  ${m}`);
for (const m of errors) console.error(`  error ${m}`);
if (errors.length) {
  console.error(`i18n check failed: ${errors.length} error(s)`);
  process.exit(1);
}
console.log("i18n check: ok");
