// „CSV importieren …“ (Einstellungen → Daten → Import): flights from other logbooks
// (Volanta's import CSV, SimToolkitPro, VA/phpVMS exports, VectaSim's own logbook CSV).
// Step 1 file → what was recognised, step 2 column mapping, step 3 preview with warnings,
// step 4 import → result toast. A real modal like the debrief: everything behind it is
// inert, Tab stays inside, Esc closes, focus returns to the button that opened it.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type {
  CsvColumnMapping,
  CsvDateFormat,
  CsvField,
  CsvImportOptions,
  CsvImportReport,
  CsvOffsetSpan,
  CsvParsedFlight,
  CsvPreset,
  CsvPreview,
  CsvProfile,
} from "./types";
import { fmt, fmtDateTime } from "./i18n/number";
import { t as tGlobal, useT, type TFunction, type TKey } from "./i18n";
import { showToast } from "./ui/Toast";
import { acquireModal } from "./ui/modalStack";
import { usePrivacy } from "./prefs";

/** i18n key of each preset's name. */
export const PRESET_LABEL: Record<CsvPreset, TKey> = {
  vectasim: "csvImport.preset.vectasim",
  volanta_import: "csvImport.preset.volanta",
  simtoolkitpro: "csvImport.preset.stkp",
  generic: "csvImport.preset.generic",
};
const PRESET_TAG: Record<CsvPreset, string> = { vectasim: "vectasim", volanta_import: "volanta", simtoolkitpro: "stkp", generic: "csv" };
const ENCODING_LABEL: Record<string, string> = {
  utf8: "UTF-8",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE",
  latin1: "Latin-1 / Windows-1252",
};
const DELIMITER_LABEL: Record<string, TKey> = {
  ",": "csvImport.delimiter.comma",
  ";": "csvImport.delimiter.semicolon",
  "\t": "csvImport.delimiter.tab",
  "|": "csvImport.delimiter.pipe",
};

/** Fields in the mapping table, grouped; `*` = required. */
/** Fields in the mapping table, grouped (i18n keys `csvImport.group.*` / `csvImport.field.*`); required ones get " *". */
const FIELD_GROUPS: { title: TKey; fields: CsvField[] }[] = [
  { title: "csvImport.group.route", fields: ["dep_icao", "arr_icao", "distance_nm"] },
  { title: "csvImport.group.times", fields: ["date", "off_block", "takeoff", "landing", "on_block", "block_min", "air_min"] },
  { title: "csvImport.group.flight", fields: ["callsign", "flight_number", "airline", "aircraft_title", "aircraft_icao", "registration"] },
  { title: "csvImport.group.values", fields: ["fuel_start", "fuel_end", "fuel_used", "max_alt_ft", "landing_rate_fpm"] },
  { title: "csvImport.group.own", fields: ["notes", "tags", "rating"] },
];
const FIELD_LABEL: Record<CsvField, TKey> = {
  dep_icao: "csvImport.field.depIcao",
  arr_icao: "csvImport.field.arrIcao",
  distance_nm: "csvImport.field.distanceNm",
  date: "csvImport.field.date",
  off_block: "csvImport.field.offBlock",
  takeoff: "csvImport.field.takeoff",
  landing: "csvImport.field.landing",
  on_block: "csvImport.field.onBlock",
  block_min: "csvImport.field.blockMin",
  air_min: "csvImport.field.airMin",
  callsign: "csvImport.field.callsign",
  flight_number: "csvImport.field.flightNumber",
  airline: "csvImport.field.airline",
  aircraft_title: "csvImport.field.aircraftTitle",
  aircraft_icao: "csvImport.field.aircraftIcao",
  registration: "csvImport.field.registration",
  fuel_start: "csvImport.field.fuelStart",
  fuel_end: "csvImport.field.fuelEnd",
  fuel_used: "csvImport.field.fuelUsed",
  max_alt_ft: "csvImport.field.maxAltFt",
  landing_rate_fpm: "csvImport.field.landingRateFpm",
  notes: "csvImport.field.notes",
  tags: "csvImport.field.tags",
  rating: "csvImport.field.rating",
};
const REQUIRED_FIELDS: ReadonlySet<CsvField> = new Set(["dep_icao", "arr_icao"]);
const DATE_FORMATS: [CsvDateFormat, TKey][] = [
  ["auto", "csvImport.dateFormat.auto"],
  ["iso", "csvImport.dateFormat.iso"],
  ["dmy", "csvImport.dateFormat.dmy"],
  ["mdy", "csvImport.dateFormat.mdy"],
  ["epoch_s", "csvImport.dateFormat.epochS"],
  ["epoch_ms", "csvImport.dateFormat.epochMs"],
];

type Zone = "utc" | "local";

/** What is remembered per preset (`localStorage`): columns by name, formats, options. */
interface Remembered {
  columns: Partial<Record<CsvField, string>>;
  dateFormat: CsvDateFormat;
  zone: Zone;
  weightUnit: "kg" | "lb";
  durationUnit: "minutes" | "hours";
  dedupe: boolean;
}

const STORE_KEY = (preset: CsvPreset) => `vectasim.csvImport.${preset}`;

function loadRemembered(preset: CsvPreset): Remembered | null {
  try {
    const raw = localStorage.getItem(STORE_KEY(preset));
    return raw ? (JSON.parse(raw) as Remembered) : null;
  } catch {
    return null;
  }
}

function saveRemembered(preset: CsvPreset, r: Remembered) {
  try {
    localStorage.setItem(STORE_KEY(preset), JSON.stringify(r));
  } catch {
    // private mode / storage off: the next import starts from the suggestion again
  }
}

/** Remembered columns (by header name) over the suggestion, where the file has that column. */
export function mergeColumns(
  suggested: Partial<Record<CsvField, number>>,
  remembered: Partial<Record<CsvField, string>> | undefined,
  columns: string[],
): Partial<Record<CsvField, number>> {
  const out: Partial<Record<CsvField, number>> = { ...suggested };
  if (!remembered) return out;
  for (const [field, name] of Object.entries(remembered) as [CsvField, string][]) {
    if (name === "") {
      delete out[field];
      continue;
    }
    const i = columns.indexOf(name);
    if (i >= 0) out[field] = i;
  }
  return out;
}

/**
 * The PC's UTC offsets with their daylight-saving changes from `fromYear` to `toYear`, so the
 * import reads "Ortszeit" right on both sides of a change. Day steps, refined to the minute.
 */
export function localOffsetSpans(fromYear = 1990, toYear = new Date().getFullYear() + 1): CsvOffsetSpan[] {
  const offsetAt = (ms: number) => -new Date(ms).getTimezoneOffset();
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  const spans: CsvOffsetSpan[] = [{ fromMs: start, offsetMin: offsetAt(start) }];
  const DAY = 86_400_000;
  for (let t = start; t + DAY <= end; t += DAY) {
    const a = offsetAt(t);
    const b = offsetAt(t + DAY);
    if (a === b) continue;
    let lo = t;
    let hi = t + DAY;
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetAt(mid) === a) lo = mid;
      else hi = mid;
    }
    spans.push({ fromMs: hi, offsetMin: b });
  }
  return spans;
}

/** `Volanta-Export_2023` → `Volanta-Export_2023` (path and extension removed, tag-safe). */
function fileStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, "").replace(/,/g, " ").slice(0, 30).trim();
}

function remembering(m: CsvColumnMapping, columns: string[], zone: Zone, dedupe: boolean, hasHeader: boolean): Remembered {
  const named: Partial<Record<CsvField, string>> = {};
  if (hasHeader) {
    for (const g of FIELD_GROUPS) {
      for (const f of g.fields) {
        const i = m.columns[f];
        named[f] = i != null ? (columns[i] ?? "") : "";
      }
    }
  }
  return { columns: named, dateFormat: m.dateFormat, zone, weightUnit: m.weightUnit, durationUnit: m.durationUnit, dedupe };
}

function missingRequired(m: CsvColumnMapping): string | null {
  const c = m.columns;
  if (c.dep_icao == null) return tGlobal("csvImport.missing.dep");
  if (c.arr_icao == null) return tGlobal("csvImport.missing.arr");
  if (c.date == null && c.off_block == null && c.on_block == null && c.takeoff == null) return tGlobal("csvImport.missing.date");
  return null;
}

function importSummary(t: TFunction, r: CsvImportReport): string {
  const parts = [t("csvImport.summary.added", { count: r.added })];
  if (r.skippedDuplicate) parts.push(t("csvImport.summary.duplicate", { count: r.skippedDuplicate }));
  if (r.skippedInvalid) parts.push(t("csvImport.summary.invalid", { count: r.skippedInvalid }));
  if (r.airframesAdded) parts.push(t("csvImport.summary.airframes", { count: r.airframesAdded }));
  return parts.join(" · ");
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const active = document.activeElement;
  const inside = !!active && root.contains(active);
  if (active && !inside && active !== document.body) return; // a toast keeps its own order
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

type Step = 1 | 2 | 3;
const STEP_TITLE: Record<Step, TKey> = { 1: "csvImport.step.file", 2: "csvImport.step.columns", 3: "csvImport.step.preview" };

/** The dialog; `onClose` after import or cancel. */
export default function CsvImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const priv = usePrivacy();
  const [step, setStep] = useState<Step>(1);
  const [path, setPath] = useState<string | null>(null);
  const [profile, setProfile] = useState<CsvProfile | null>(null);
  const [mapping, setMapping] = useState<CsvColumnMapping | null>(null);
  const [zone, setZone] = useState<Zone>("utc");
  const [dedupe, setDedupe] = useState(true);
  const [sourceTag, setSourceTag] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localSpans = useMemo(() => localOffsetSpans(), []);
  /** A running import cannot be cancelled: Esc and "Schließen" are off until it is done. */
  const importing = busy === "Import";
  const closeRef = useRef(onClose);
  const importingRef = useRef(importing);
  useEffect(() => {
    closeRef.current = onClose;
    importingRef.current = importing;
  }, [onClose, importing]);

  // modal: inert behind, Esc closes, Tab cycles, focus back on close
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const modal = acquireModal();
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!modal.isTop()) return;
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        if (!importingRef.current) closeRef.current();
      } else if (e.key === "Tab") trapTab(e, ref.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      modal.release();
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // a new step: focus its first control (keyboard users land in the new content)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`.csv-step ${FOCUSABLE}`)?.focus();
  }, [step]);

  const applyPreset = (p: CsvProfile, preset: CsvPreset, file: string) => {
    const mem = loadRemembered(preset);
    const columns = mergeColumns(p.suggested.columns, p.hasHeader ? mem?.columns : undefined, p.columns);
    setMapping({
      ...p.suggested,
      preset,
      columns,
      dateFormat: mem?.dateFormat ?? p.suggested.dateFormat,
      weightUnit: mem?.weightUnit ?? p.suggested.weightUnit,
      durationUnit: mem?.durationUnit ?? p.suggested.durationUnit,
    });
    setZone(mem?.zone ?? "utc");
    setDedupe(mem?.dedupe ?? true);
    setSourceTag(preset === "generic" ? fileStem(file) || PRESET_TAG.generic : PRESET_TAG[preset]);
  };

  const chooseFile = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({
        title: t("csvImport.pickTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: t("csvImport.fileType"), extensions: ["csv", "txt"] }],
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (typeof picked !== "string" || !picked) return;
    const file = picked;
    setBusy("Lesen");
    setError(null);
    try {
      const p = await invoke<CsvProfile>("csv_sniff", { path: file });
      setPath(file);
      setProfile(p);
      setPreview(null);
      applyPreset(p, p.detectedPreset, file);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const fullMapping = (m: CsvColumnMapping): CsvColumnMapping => ({
    ...m,
    utcOffsetMin: 0,
    localOffsets: zone === "local" ? localSpans : [],
  });
  const options = (): CsvImportOptions => ({ dedupe, sourceTag: sourceTag.trim() });

  const loadPreview = async (dedupeNow = dedupe) => {
    if (!path || !mapping) return;
    setBusy("Vorschau");
    setError(null);
    try {
      setPreview(await invoke<CsvPreview>("csv_preview", { path, mapping: fullMapping(mapping), options: { ...options(), dedupe: dedupeNow } }));
      setStep(3);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!path || !mapping || !profile) return;
    setBusy("Import");
    setError(null);
    try {
      const r = await invoke<CsvImportReport>("csv_import", { path, mapping: fullMapping(mapping), options: options() });
      saveRemembered(mapping.preset, remembering(mapping, profile.columns, zone, dedupe, profile.hasHeader));
      showToast({
        tone: r.warnings.length || r.skippedInvalid ? "warn" : "ok",
        title: t("csvImport.done.title", { added: fmt(r.added), rows: fmt(r.rows) }),
        body: r.warnings.length
          ? t("csvImport.done.bodyWarnings", { summary: importSummary(t, r), warnings: t("csvImport.done.warnings", { count: r.warnings.length }), list: r.warnings.slice(0, 2).join("; ") })
          : importSummary(t, r),
        durationMs: 15_000,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const setColumn = (f: CsvField, v: string) =>
    setMapping((m) => {
      if (!m) return m;
      const columns = { ...m.columns };
      if (v === "") delete columns[f];
      else columns[f] = Number(v);
      return { ...m, columns };
    });

  const missing = mapping ? missingRequired(mapping) : t("csvImport.missing.file");
  const sample = (i: number) => profile?.sampleRows.find((r) => (r[i] ?? "").trim() !== "")?.[i] ?? "";

  return createPortal(
    <div className="csv-backdrop">
      <div ref={ref} className="csv-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={importing || undefined}>
        <header className="csv-head">
          <h2 id={titleId}>{t("csvImport.title")}</h2>
          <ol className="csv-steps" aria-label={t("csvImport.steps")}>
            {([1, 2, 3] as Step[]).map((s) => (
              <li key={s} aria-current={s === step ? "step" : undefined} className={s === step ? "current" : s < step ? "done" : undefined}>
                {s}. {t(STEP_TITLE[s])}
              </li>
            ))}
          </ol>
          <button className="btn-sm" onClick={onClose} aria-label={t("csvImport.close")} disabled={importing} title={importing ? t("csvImport.closeWhileImporting") : undefined}>
            {t("shell.action.close")}
          </button>
        </header>

        {error && (
          <div className="csv-error" role="alert">
            {error}
          </div>
        )}

        {step === 1 && (
          <section className="csv-step" aria-label={t("csvImport.chooseFile")}>
            <p className="detail">{t("csvImport.intro")}</p>
            <div className="setting-row">
              <button className="btn-primary" onClick={() => void chooseFile()} disabled={busy != null}>
                {busy === "Lesen" ? t("csvImport.reading") : path ? t("csvImport.otherFile") : t("csvImport.pickFile")}
              </button>
              {path && (
                <span className="dll-path mono" title={priv.mask(path, "path")}>
                  {priv.mask(path, "path")}
                </span>
              )}
            </div>
            {profile && mapping && (
              <>
                <dl className="csv-facts">
                  <div>
                    <dt>{t("csvImport.facts.detected")}</dt>
                    <dd>{t(PRESET_LABEL[profile.detectedPreset])}</dd>
                  </div>
                  <div>
                    <dt>{t("csvImport.facts.delimiter")}</dt>
                    <dd>{DELIMITER_LABEL[profile.delimiter] ? t(DELIMITER_LABEL[profile.delimiter]) : t("csvImport.delimiter.custom", { char: profile.delimiter })}</dd>
                  </div>
                  <div>
                    <dt>{t("csvImport.facts.encoding")}</dt>
                    <dd>{profile.encoding === "utf8_bom" ? t("csvImport.encodingBom") : (ENCODING_LABEL[profile.encoding] ?? profile.encoding)}</dd>
                  </div>
                  <div>
                    <dt>{t("csvImport.facts.rows")}</dt>
                    <dd>
                      {fmt(profile.rowCount)} {profile.hasHeader ? t("csvImport.facts.withHeader") : t("csvImport.facts.noHeader")}
                    </dd>
                  </div>
                </dl>
                <label className="csv-inline">
                  <span>{t("csvImport.format")}</span>
                  <select value={mapping.preset} onChange={(e) => applyPreset(profile, e.target.value as CsvPreset, path ?? "")}>
                    {(Object.keys(PRESET_LABEL) as CsvPreset[]).map((p) => (
                      <option key={p} value={p}>
                        {t(PRESET_LABEL[p])}
                      </option>
                    ))}
                  </select>
                </label>
                {mapping.preset === "simtoolkitpro" && (
                  <div className="detail">{t("csvImport.stkpHint")}</div>
                )}
                <SampleTable profile={profile} />
              </>
            )}
            <footer className="csv-foot">
              <button className="btn-sm" onClick={onClose}>
                {t("shell.action.cancel")}
              </button>
              <button className="btn-sm btn-primary" onClick={() => setStep(2)} disabled={!profile || profile.rowCount === 0}>
                {t("csvImport.next")}
              </button>
            </footer>
          </section>
        )}

        {step === 2 && profile && mapping && (
          <section className="csv-step" aria-label={t("csvImport.step.columns")}>
            <p className="detail">{t("csvImport.mappingIntro", { preset: t(PRESET_LABEL[mapping.preset]) })}</p>
            <div className="csv-formats">
              <label className="csv-inline">
                <span>{t("csvImport.dateFormat.label")}</span>
                <select value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as CsvDateFormat })}>
                  {DATE_FORMATS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {t(l)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="csv-inline">
                <span>{t("csvImport.zone.label")}</span>
                <select value={zone} onChange={(e) => setZone(e.target.value as Zone)}>
                  <option value="utc">{t("csvImport.zone.utc")}</option>
                  <option value="local">{t("csvImport.zone.local")}</option>
                </select>
              </label>
              <label className="csv-inline">
                <span>{t("csvImport.weightUnit")}</span>
                <select value={mapping.weightUnit} onChange={(e) => setMapping({ ...mapping, weightUnit: e.target.value as "kg" | "lb" })}>
                  <option value="kg">kg</option>
                  <option value="lb">lb</option>
                </select>
              </label>
              <label className="csv-inline">
                <span>{t("csvImport.durationUnit.label")}</span>
                <select value={mapping.durationUnit} onChange={(e) => setMapping({ ...mapping, durationUnit: e.target.value as "minutes" | "hours" })}>
                  <option value="minutes">{t("csvImport.durationUnit.minutes")}</option>
                  <option value="hours">{t("csvImport.durationUnit.hours")}</option>
                </select>
              </label>
            </div>
            <div className="csv-scroll">
              <table className="csv-map">
                <caption className="sr-only">{t("csvImport.map.caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("csvImport.map.field")}</th>
                    <th scope="col">{t("csvImport.map.column")}</th>
                    <th scope="col">{t("csvImport.map.sample")}</th>
                  </tr>
                </thead>
                {FIELD_GROUPS.map((g) => (
                  <tbody key={g.title}>
                    <tr className="csv-group">
                      <th scope="rowgroup" colSpan={3}>
                        {t(g.title)}
                      </th>
                    </tr>
                    {g.fields.map((f) => {
                      const label = `${t(FIELD_LABEL[f])}${REQUIRED_FIELDS.has(f) ? " *" : ""}`;
                      const id = `${titleId}-${f}`;
                      const col = mapping.columns[f];
                      return (
                        <tr key={f}>
                          <th scope="row">
                            <label htmlFor={id}>{label}</label>
                          </th>
                          <td>
                            <select id={id} value={col ?? ""} onChange={(e) => setColumn(f, e.target.value)}>
                              <option value="">{t("csvImport.map.unmapped")}</option>
                              {profile.columns.map((c, i) => (
                                <option key={i} value={i}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="detail mono csv-sample">{col != null ? sample(col) : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
            {missing && <div className="detail warn-text">{missing}</div>}
            <footer className="csv-foot">
              <button className="btn-sm" onClick={() => setStep(1)}>
                {t("csvImport.back")}
              </button>
              <button className="btn-sm btn-primary" onClick={() => void loadPreview()} disabled={!!missing || busy != null}>
                {busy === "Vorschau" ? t("csvImport.reading") : t("csvImport.step.preview")}
              </button>
            </footer>
          </section>
        )}

        {step === 3 && preview && mapping && (
          <section className="csv-step" aria-label={t("csvImport.step.preview")}>
            <div className="csv-counts" role="status">
              {t("csvImport.counts.rows", { rows: fmt(preview.totalRows), valid: fmt(preview.valid) })}
              {preview.invalid ? ` · ${t("csvImport.counts.invalid", { count: preview.invalid })}` : ""}
              {dedupe ? ` · ${t("csvImport.counts.duplicates", { count: preview.duplicates })}` : ""}
            </div>
            <div className="csv-scroll">
              <PreviewTable rows={preview.rows} dedupe={dedupe} />
            </div>
            {preview.totalRows > preview.rows.length && (
              <div className="detail">{t("csvImport.counts.shown", { count: preview.rows.length })}</div>
            )}
            <div className="csv-formats">
              <label className="check">
                <input
                  type="checkbox"
                  checked={dedupe}
                  onChange={(e) => {
                    setDedupe(e.target.checked);
                    void loadPreview(e.target.checked);
                  }}
                />
                {t("csvImport.dedupe")}
              </label>
              <label className="csv-inline">
                <span>{t("csvImport.sourceTag")}</span>
                <input value={sourceTag} onChange={(e) => setSourceTag(e.target.value)} maxLength={30} list={`${titleId}-tags`} autoComplete="off" />
                <datalist id={`${titleId}-tags`}>
                  {[...new Set([PRESET_TAG[mapping.preset], "volanta", "stkp", path ? fileStem(path) : ""])].filter(Boolean).map((tag) => (
                    <option key={tag} value={tag} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="detail">{t("csvImport.tagsHint")}</div>
            <footer className="csv-foot">
              <button className="btn-sm" onClick={() => setStep(2)} disabled={importing}>
                {t("csvImport.back")}
              </button>
              <button
                className="btn-sm btn-primary"
                onClick={() => void runImport()}
                disabled={busy != null || preview.valid - (dedupe ? preview.duplicates : 0) <= 0}
              >
                {busy === "Import" ? t("csvImport.importing") : t("csvImport.importButton", { count: preview.valid - (dedupe ? preview.duplicates : 0) })}
              </button>
            </footer>
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}

function SampleTable({ profile }: { profile: CsvProfile }) {
  const t = useT();
  if (profile.sampleRows.length === 0) return <div className="detail">{t("csvImport.noRows")}</div>;
  return (
    <div className="csv-scroll csv-sample-table">
      <table className="csv-map">
        <caption className="sr-only">{t("csvImport.sampleCaption")}</caption>
        <thead>
          <tr>
            {profile.columns.map((c, i) => (
              <th key={i} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profile.sampleRows.map((r, i) => (
            <tr key={i}>
              {profile.columns.map((_, j) => (
                <td key={j} className="mono">
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function minutes(v: number | null | undefined): string {
  if (v == null) return "–";
  const m = Math.round(v);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function status(t: TFunction, r: CsvParsedFlight, dedupe: boolean): { tone: "ok" | "warn" | "err"; text: ReactNode } {
  if (r.error) return { tone: "err", text: t("csvImport.row.error", { error: r.error }) };
  if (dedupe && r.duplicate) return { tone: "warn", text: t("csvImport.row.duplicate") };
  if (r.warnings.length) return { tone: "warn", text: r.warnings.join(" · ") };
  return { tone: "ok", text: t("csvImport.row.ok") };
}

function PreviewTable({ rows, dedupe }: { rows: CsvParsedFlight[]; dedupe: boolean }) {
  const t = useT();
  return (
    <table className="csv-map csv-preview">
      <caption className="sr-only">{t("csvImport.previewCaption")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("csvImport.col.line")}</th>
          <th scope="col">{t("csvImport.col.offBlock")}</th>
          <th scope="col">{t("csvImport.col.route")}</th>
          <th scope="col">{t("csvImport.col.aircraft")}</th>
          <th scope="col" className="right">
            {t("csvImport.col.block")}
          </th>
          <th scope="col" className="right">
            {t("csvImport.col.distance")}
          </th>
          <th scope="col">{t("csvImport.col.status")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const s = status(t, r, dedupe);
          const block = r.offBlockMs != null && r.onBlockMs != null ? (r.onBlockMs - r.offBlockMs) / 60_000 : r.blockMin;
          return (
            <tr key={r.line} className={`csv-row-${s.tone}`}>
              <td className="num">{r.line}</td>
              <td className="num">{r.offBlockMs != null ? fmtDateTime(r.offBlockMs) : "–"}</td>
              <td className="mono">
                {r.depIcao ?? "?"} → {r.arrIcao ?? "?"}
              </td>
              <td>{[r.aircraftIcao, r.registration].filter(Boolean).join(" · ") || r.aircraftTitle || "–"}</td>
              <td className="num right">{minutes(block)}</td>
              <td className="num right">
                {r.distanceNm != null ? (r.distanceEstimated ? t("csvImport.row.approx", { value: fmt(r.distanceNm, 0, "nm") }) : fmt(r.distanceNm, 0, "nm")) : "–"}
              </td>
              <td className={`csv-status ${s.tone}`}>{s.text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
