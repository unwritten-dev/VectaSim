#!/usr/bin/env node
// Checks the i18n resources; `npm run i18n:check` in app/. Exit code 1 on
// any error, so it can gate CI. de/*.json (merged) is the reference; every other language folder app/src/i18n/<lang>/*.json must
//   - have exactly the same keys (missing and surplus keys are errors),
//   - use a plural object where de does (and only there), with `other` and only categories
//     Intl.PluralRules knows; categories the language needs (one/other for de/en, few/many
//     for others) must be present,
//   - use the same {placeholders} as de for every key (per plural object: the union),
//   - have no empty strings.
// Also scans app/src for t("…") / tr("…") / tGlobal("…") / tIn(lang, "…") calls with a key that
// de/*.json lacks (tsc catches typed calls too; this also covers plain JS, calls split over
// several lines and the aliases) and lists keys that no source file uses yet (info only).
// Comments are stripped first: a key only mentioned in a comment is not "used". A key counts as
// used when
//   - a call names it,
//   - any string literal in the code equals it (key tables such as LOGBOOK_TABS, TKey props),
//   - it matches a built key: t(`themes.${id}.name`) matches "themes.<segment>.name" and
//     `review.flags.${row.key}` "review.flags.<segment>" – each ${…} stands for one key segment,
//     so a template only covers the keys it can really produce,
//   - it lies under a declared prefix: a source comment `/* i18n-dynamic: errors.service.* */`
//     (several prefixes separated by commas) next to code that builds such keys, or
//     DYNAMIC_PREFIXES below for namespaces without a single building site.
// Templates and prefixes that match no key (localStorage names such as `vectasim.section.${id}`)
// are not counted. What is left is a real orphan candidate; `--unused` prints the list and how
// many keys each template / prefix covers, otherwise only the counts; I18N_DEBUG=1 lists the
// templates and prefixes with the place they were found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// optional argument: another resource folder (used to test the checker itself)
const folderArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dir = folderArg ? resolve(folderArg) : join(root, "app", "src", "i18n");
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

/**
 * The code of a source file with every comment blanked out (newlines kept, so offsets and line
 * numbers stay), plus the comments themselves for the i18n-dynamic markers. Strings and
 * template literals are kept as they are; a regex literal is skipped as a whole so a quote in it
 * does not open a string; a ' or " string ends at the end of its line at the latest (an
 * apostrophe in JSX text then spoils one line, not the file).
 */
function stripComments(src) {
  let code = "";
  const comments = [];
  let i = 0;
  let last = ""; // last significant code character (regex vs division)
  const blank = (text) => text.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      comments.push({ text: src.slice(i + 2, stop), at: i });
      code += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      comments.push({ text: src.slice(i + 2, end < 0 ? src.length : end), at: i });
      code += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && (last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last))) {
      // a regex literal: copied as a whole
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else {
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
      }
      code += src.slice(i, j + 1);
      i = j + 1;
      last = "/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (c !== "`" && d === "\n") break;
        if (c === "`" && d === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (c === "`" && depth > 0 && d === "}") {
          depth--;
          j++;
          continue;
        }
        if (d === c && depth === 0) break;
        j++;
      }
      code += src.slice(i, j + 1);
      i = j + 1;
      last = c;
      continue;
    }
    code += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return { code, comments };
}

/** Key prefixes ending in "." whose keys are built at run time (markers, DYNAMIC_PREFIXES). */
const dynamicPrefixes = new Map(); // prefix → where it was found
/** Built keys: regex source → { re, where } of the template literal it came from. */
const templates = new Map();
// namespaces without one building site (none at the moment; a prefix that covers no key is ignored)
const DYNAMIC_PREFIXES = [];
for (const p of DYNAMIC_PREFIXES) dynamicPrefixes.set(p, "scripts/i18n-check.mjs");
// segments after the first may hold a hyphen (theme ids: "themes.arktis-studio.fonts")
const KEY = String.raw`[a-z][\w]*(?:\.[\w-]+)+`;
/** t( / tr( / tGlobal( "key" – also with the key on the next line. */
const CALL_T = new RegExp(String.raw`(?<![\w.])(?:t|tr|tGlobal)\(\s*["'\x60](${KEY})["'\x60]`, "g");
const CALL_TIN = new RegExp(String.raw`(?<![\w.])tIn\(\s*[^,()]+,\s*["'\x60](${KEY})["'\x60]`, "g");
/** Any quoted dotted literal ("logbook.tabs.flights"); only counts when it is a real key. */
const LITERAL = new RegExp(String.raw`["'\x60](${KEY})["'\x60]`, "g");
/** A template literal that starts like a key and continues with ${…}. */
const TEMPLATE = /`([a-z][\w]*\.(?:[^`$\\]|\$\{[^`]*?\})*?)`/g;
const MARKER = /i18n-dynamic:\s*(.*?)\s*(?:\*\/|$)/gm;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `themes.${id}.name` → /^themes\.[\w-]+\.name$/ (null: no ${…} or not key-shaped). */
function templatePattern(body) {
  const parts = body.split(/\$\{[^}]*\}/);
  if (parts.length < 2) return null;
  if (!parts.every((p) => /^[\w.-]*$/.test(p))) return null;
  return new RegExp(`^${parts.map(escapeRe).join("[\\w-]+")}$`);
}

const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

// tests are skipped (they use keys on purpose, fallback tests); i18n/ itself only counts for
// usage through literals (index.ts: "time.utc"), its doc comments are not checked as calls
const i18nDir = join(root, "app", "src", "i18n") + sep;
for (const file of walk(join(root, "app", "src")).filter((f) => !/\.test\.tsx?$/.test(f))) {
  const rel = relative(root, file).split(sep).join("/");
  const { code, comments } = stripComments(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  for (const m of code.matchAll(LITERAL)) if (ref.has(m[1])) used.add(m[1]);
  if (file.startsWith(i18nDir)) continue;
  for (const re of [CALL_T, CALL_TIN]) {
    for (const m of code.matchAll(re)) {
      used.add(m[1]);
      if (!ref.has(m[1])) errors.push(`${rel}:${lineAt(code, m.index)}: t("${m[1]}") – key not in de/*.json`);
    }
  }
  for (const m of code.matchAll(TEMPLATE)) {
    const re = templatePattern(m[1]);
    if (re && !templates.has(re.source)) templates.set(re.source, { re, where: `${rel}:${lineAt(code, m.index)}` });
  }
  for (const c of comments) {
    for (const m of c.text.matchAll(MARKER)) {
      const where = `${rel}:${lineAt(code, c.at)}`;
      for (const raw of m[1].split(",")) {
        const p = raw.trim().replace(/\*$/, "");
        if (!p) continue;
        if (!p.endsWith(".")) errors.push(`${where}: i18n-dynamic prefix "${raw.trim()}" must end in ".*"`);
        else if (![...ref.keys()].some((k) => k.startsWith(p))) errors.push(`${where}: i18n-dynamic prefix "${p}*" matches no key in de/*.json`);
        else dynamicPrefixes.set(p, where);
      }
    }
  }
}
const allKeys = [...ref.keys()];
// what each built-key template / prefix covers; those that cover no key (localStorage names) drop out
const coverage = [
  ...[...templates.values()].map((x) => ({ label: x.re.source, where: x.where, test: (k) => x.re.test(k) })),
  ...[...dynamicPrefixes].map(([p, where]) => ({ label: `${p}*`, where, test: (k) => k.startsWith(p) })),
]
  .map((c) => ({ ...c, keys: allKeys.filter(c.test) }))
  .filter((c) => c.keys.length > 0);
if (process.env.I18N_DEBUG) for (const c of coverage) console.log(`  dynamic ${c.label} (${c.where}): ${c.keys.length} keys`);
const isDynamic = (k) => coverage.some((c) => c.test(k));
const unused = allKeys.filter((k) => !used.has(k) && !isDynamic(k));
const dynamicCount = allKeys.filter((k) => !used.has(k) && isDynamic(k)).length;
info.push(`${dynamicCount} keys used through ${coverage.length} built-key templates and dynamic prefixes`);
if (process.argv.includes("--unused")) for (const c of coverage) info.push(`dynamic ${c.label} (${c.where}) covers ${c.keys.length} keys`);
if (unused.length) {
  const list = process.argv.includes("--unused") ? `: ${unused.join(", ")}` : " (list: npm run i18n:check -- --unused)";
  info.push(`${unused.length} of ${ref.size} keys not used in app/src – orphan candidates${list}`);
}

console.log(`i18n check: ${langs.length} languages (${langs.join(", ")}), ${ref.size} keys in de/*.json`);
for (const m of info) console.log(`  info  ${m}`);
for (const m of errors) console.error(`  error ${m}`);
if (errors.length) {
  console.error(`i18n check failed: ${errors.length} error(s)`);
  process.exit(1);
}
console.log("i18n check: ok");
