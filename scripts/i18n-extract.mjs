#!/usr/bin/env node
// Lists UI string candidates for the i18n migration. READ-ONLY: it never
// writes a file, it only prints. Uses the TypeScript compiler API from app/node_modules, so
// JSX text, attributes and string/template literals are found exactly (no regex guessing).
//
//   node scripts/i18n-extract.mjs                 Markdown: summary per file + 30 examples
//   node scripts/i18n-extract.mjs --all           Markdown: every candidate
//   node scripts/i18n-extract.mjs --json          JSON array (file, line, kind, text)
//   node scripts/i18n-extract.mjs --file Fleet    only files whose path contains "Fleet"
//   node scripts/i18n-extract.mjs --examples 50   number of examples in the summary
//
// Kinds:
//   jsx-text   text between JSX tags                       <h2>Flotte</h2>
//   attr       aria-label / title / placeholder / alt / label / … attribute
//   ui-prop    title/body/label/message/… property in an object literal (toasts, tabs, menus)
//   call       first argument of showToast/ask/confirm/message/notice helpers
//   literal    any other string/template literal that looks German (umlauts or common words)
// Excluded: tests, *.d.ts, imports, console.*, invoke("cmd"), CSS-ish and key-ish strings.

import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const require = createRequire(join(appDir, "package.json"));
const ts = require("typescript");

const args = process.argv.slice(2);
const opt = (name) => args.includes(name);
const val = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const filter = val("--file", "");
const nExamples = Number(val("--examples", "30"));

const ATTRS = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "title", "placeholder", "alt", "label", "hint", "description", "summary", "emptyText", "caption", "tooltip", "subtitle", "heading", "sub", "note", "unitLabel"]);
const PROPS = new Set(["title", "body", "label", "message", "hint", "description", "text", "detail", "summary", "caption", "tooltip", "subtitle", "heading", "confirmLabel", "cancelLabel", "okLabel", "action", "placeholder", "aria", "ariaLabel", "empty", "note", "reason", "why", "tip"]);
const CALLS = new Set(["showToast", "ask", "confirm", "message", "notice", "setError", "setStatus", "setNotice", "setMessage", "setHint", "alert", "Error"]);
const GERMAN = /[äöüÄÖÜß„“]|\b(der|die|das|den|dem|des|und|nicht|ist|sind|mit|für|kein|keine|keinen|wird|werden|wurde|oder|noch|beim|vom|zum|zur|ein|eine|einen|auf|bei|nach|aus|über|unter|Flug|Flüge|Fehler|Datei|speichern|gespeichert|laden|geladen|öffnen|schließen|Einstellungen|Landung|Anflug|Logbuch)\b/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "fixtures" && name !== "i18n") walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Has letters and is not a key, class list, URL, colour, path or code identifier. */
function looksLikeText(s) {
  const t = s.trim();
  if (t.length < 2 || !/\p{L}/u.test(t)) return false;
  if (/^https?:|^#[0-9a-f]{3,8}$|^[./\\]|^[a-z][\w-]*(\s+[a-z][\w-]*)*$/.test(t) && !GERMAN.test(t)) return false; // css classes, keys, ids
  if (/^[A-Z0-9_]+$/.test(t)) return false; // CONSTANTS, ICAO codes
  if (/^[\w.-]+\.(png|svg|json|css|ts|tsx|log|db|dll|ps1|zip|vectasim)$/i.test(t)) return false;
  if (/^(M|m)[\d\s.,-]+[A-Za-z]/.test(t) && /\d/.test(t) && !/\s[a-zäöü]{3,}/.test(t)) return false; // SVG path data
  return true;
}

const textOf = (node, src) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `{${s.expression.getText(src)}}${s.literal.text}`).join("");
  }
  return null;
};

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

function scan(file) {
  const code = readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = relative(appDir, file).split(sep).join("/");
  const found = [];
  const seen = new Set();
  const add = (node, kind, text) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!looksLikeText(clean)) return;
    const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
    const id = `${node.pos}:${node.end}`;
    if (seen.has(id)) return;
    seen.add(id);
    found.push({ file: rel, line, kind, text: clean });
  };

  const visit = (node, ctx) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const obj = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : "";
      if (obj === "console" || name === "invoke" || name === "listen" || name === "emit" || name === "getItem" || name === "setItem" || name === "querySelector" || name === "addEventListener" || name === "removeEventListener") return;
      if (CALLS.has(name) && node.arguments[0]) {
        const t = textOf(node.arguments[0], src);
        if (t != null) add(node.arguments[0], "call", t);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error" && node.arguments?.[0]) {
      const t = textOf(node.arguments[0], src);
      if (t != null) add(node.arguments[0], "call", t);
    }
    if (ts.isJsxText(node)) {
      add(node, "jsx-text", node.text);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(src);
      const init = node.initializer;
      if (name === "className" || name === "key" || name === "id" || name === "htmlFor" || name === "href" || name === "src" || name === "d" || name === "role" || name === "type" || name === "style") return;
      if (ATTRS.has(name) && init) {
        if (ts.isStringLiteral(init)) add(init, "attr", init.text);
        else if (ts.isJsxExpression(init) && init.expression) visit(init.expression, "attr");
        return;
      }
    }
    if (ts.isPropertyAssignment(node) && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const pname = node.name.text;
      if (PROPS.has(pname)) {
        const t = textOf(node.initializer, src);
        if (t != null) {
          add(node.initializer, "ui-prop", t);
          return;
        }
        visit(node.initializer, "ui-prop");
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const t = textOf(node, src);
      if (t != null && (ctx || GERMAN.test(t))) add(node, ctx ?? "literal", t);
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression, ctx));
      return;
    }
    ts.forEachChild(node, (c) => visit(c, ctx && (ts.isConditionalExpression(c) || ts.isBinaryExpression(c) || ts.isParenthesizedExpression(c) || ts.isStringLiteral(c) || ts.isTemplateExpression(c) || ts.isNoSubstitutionTemplateLiteral(c)) ? ctx : undefined));
  };
  ts.forEachChild(src, (c) => visit(c, undefined));
  return found.sort((a, b) => a.line - b.line);
}

const files = walk(join(appDir, "src")).filter((f) => !filter || f.includes(filter));
const all = files.flatMap(scan);

if (opt("--json")) {
  process.stdout.write(JSON.stringify(all, null, 2) + "\n");
  process.exit(0);
}

const esc = (s) => s.replace(/\|/g, "\\|").replace(/</g, "&lt;");
const kinds = ["jsx-text", "attr", "ui-prop", "call", "literal"];
const byFile = new Map();
for (const c of all) {
  const row = byFile.get(c.file) ?? Object.fromEntries(kinds.map((k) => [k, 0]));
  row[c.kind]++;
  byFile.set(c.file, row);
}
const total = (r) => kinds.reduce((s, k) => s + r[k], 0);
const rows = [...byFile.entries()].sort((a, b) => total(b[1]) - total(a[1]));
const sum = Object.fromEntries(kinds.map((k) => [k, all.filter((c) => c.kind === k).length]));

const out = [];
out.push(`Kandidaten gesamt: **${all.length}** in ${rows.length} von ${files.length} Dateien (Tests, \`*.d.ts\`, \`fixtures/\`, \`i18n/\` ausgenommen).`, "");
out.push(`| Datei | Summe | JSX-Text | Attribut | UI-Prop | Aufruf | Literal |`, `|---|---:|---:|---:|---:|---:|---:|`);
for (const [f, r] of rows) out.push(`| \`${f}\` | ${total(r)} | ${kinds.map((k) => r[k]).join(" | ")} |`);
out.push(`| **Summe** | **${all.length}** | ${kinds.map((k) => sum[k]).join(" | ")} |`, "");
const examples = opt("--all") ? all : pickExamples(all, nExamples);
out.push(opt("--all") ? "Alle Kandidaten:" : `${examples.length} Beispiele (je Art gestreut):`, "");
out.push(`| Datei:Zeile | Art | Text |`, `|---|---|---|`);
for (const c of examples) out.push(`| \`${c.file}:${c.line}\` | ${c.kind} | ${esc(c.text.length > 90 ? `${c.text.slice(0, 87)}…` : c.text)} |`);
process.stdout.write(out.join("\n") + "\n");

/** Spread examples over kinds and files instead of the first n of one file. */
function pickExamples(list, n) {
  const picked = [];
  const perKind = Math.max(1, Math.floor(n / kinds.length));
  for (const k of kinds) {
    const ofKind = list.filter((c) => c.kind === k);
    const step = Math.max(1, Math.floor(ofKind.length / perKind));
    for (let i = 0; i < ofKind.length && picked.filter((c) => c.kind === k).length < perKind; i += step) picked.push(ofKind[i]);
  }
  return picked.slice(0, n);
}
