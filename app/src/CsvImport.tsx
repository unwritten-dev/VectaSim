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
import { fmt, fmtDateTime } from "./format";
import { showToast } from "./ui/Toast";
import { usePrivacy } from "./prefs";

export const PRESET_LABEL: Record<CsvPreset, string> = {
  vectasim: "VectaSim-Logbuch (CSV)",
  volanta_import: "Volanta-Import-CSV",
  simtoolkitpro: "SimToolkitPro (ohne Gewähr)",
  generic: "Eigene Zuordnung",
};
const PRESET_TAG: Record<CsvPreset, string> = { vectasim: "vectasim", volanta_import: "volanta", simtoolkitpro: "stkp", generic: "csv" };
const ENCODING_LABEL: Record<string, string> = {
  utf8: "UTF-8",
  utf8_bom: "UTF-8 (mit BOM)",
  utf16le: "UTF-16 LE",
  utf16be: "UTF-16 BE",
  latin1: "Latin-1 / Windows-1252",
};
const DELIMITER_LABEL: Record<string, string> = { ",": "Komma", ";": "Semikolon", "\t": "Tabulator", "|": "senkrechter Strich" };

/** Fields in the mapping table, grouped; `*` = required. */
const FIELD_GROUPS: { title: string; fields: [CsvField, string][] }[] = [
  {
    title: "Strecke",
    fields: [
      ["dep_icao", "Abflughafen *"],
      ["arr_icao", "Zielflughafen *"],
      ["distance_nm", "Distanz (nm)"],
    ],
  },
  {
    title: "Zeiten",
    fields: [
      ["date", "Datum"],
      ["off_block", "Off-Block (Abfahrt)"],
      ["takeoff", "Start (Abheben)"],
      ["landing", "Landung (Aufsetzen)"],
      ["on_block", "On-Block (Ankunft)"],
      ["block_min", "Blockzeit"],
      ["air_min", "Flugzeit"],
    ],
  },
  {
    title: "Flug und Flugzeug",
    fields: [
      ["callsign", "Rufzeichen"],
      ["flight_number", "Flugnummer"],
      ["airline", "Airline"],
      ["aircraft_title", "Flugzeug (Name)"],
      ["aircraft_icao", "Flugzeugtyp (ICAO)"],
      ["registration", "Registrierung"],
    ],
  },
  {
    title: "Werte",
    fields: [
      ["fuel_start", "Kraftstoff Start"],
      ["fuel_end", "Kraftstoff Ende"],
      ["fuel_used", "Kraftstoffverbrauch"],
      ["max_alt_ft", "Max. Höhe (ft)"],
      ["landing_rate_fpm", "Landerate (fpm)"],
    ],
  },
  {
    title: "Eigenes",
    fields: [
      ["notes", "Notizen"],
      ["tags", "Tags"],
      ["rating", "Bewertung (1–5)"],
    ],
  },
];
const DATE_FORMATS: [CsvDateFormat, string][] = [
  ["auto", "automatisch erkennen"],
  ["iso", "ISO (2026-10-18 14:05)"],
  ["dmy", "TT.MM.JJJJ (18.10.2026 14:05)"],
  ["mdy", "MM/TT/JJJJ (10/18/2026 2:05 PM)"],
  ["epoch_s", "Unix-Zeit (Sekunden)"],
  ["epoch_ms", "Unix-Zeit (Millisekunden)"],
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
      for (const [f] of g.fields) {
        const i = m.columns[f];
        named[f] = i != null ? (columns[i] ?? "") : "";
      }
    }
  }
  return { columns: named, dateFormat: m.dateFormat, zone, weightUnit: m.weightUnit, durationUnit: m.durationUnit, dedupe };
}

function missingRequired(m: CsvColumnMapping): string | null {
  const c = m.columns;
  if (c.dep_icao == null) return "Ordne den Abflughafen zu.";
  if (c.arr_icao == null) return "Ordne den Zielflughafen zu.";
  if (c.date == null && c.off_block == null && c.on_block == null && c.takeoff == null) return "Ordne Datum oder Off-Block zu.";
  return null;
}

function importSummary(r: CsvImportReport): string {
  const parts = [`${fmt(r.added)} Flüge übernommen`];
  if (r.skippedDuplicate) parts.push(`${fmt(r.skippedDuplicate)} schon vorhanden`);
  if (r.skippedInvalid) parts.push(`${fmt(r.skippedInvalid)} fehlerhaft`);
  if (r.airframesAdded) parts.push(`${fmt(r.airframesAdded)} Flugzeuge neu`);
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
const STEP_TITLE: Record<Step, string> = { 1: "Datei", 2: "Spalten zuordnen", 3: "Vorschau" };

/** The dialog; `onClose` after import or cancel. */
export default function CsvImportDialog({ onClose }: { onClose: () => void }) {
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
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // modal: inert behind, Esc closes, Tab cycles, focus back on close
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const behind = document.querySelector<HTMLElement>(".shell-body");
    behind?.setAttribute("inert", "");
    document.body.classList.add("modal-open");
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab") trapTab(e, ref.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      behind?.removeAttribute("inert");
      document.body.classList.remove("modal-open");
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
        title: "CSV-Datei zum Importieren wählen",
        multiple: false,
        directory: false,
        filters: [{ name: "CSV-Datei", extensions: ["csv", "txt"] }],
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
        title: `CSV importiert · ${fmt(r.added)} von ${fmt(r.rows)} Zeilen`,
        body: `${importSummary(r)}${r.warnings.length ? ` · ${r.warnings.length} Hinweise: ${r.warnings.slice(0, 2).join("; ")}` : ""}`,
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

  const missing = mapping ? missingRequired(mapping) : "Wähle zuerst eine Datei.";
  const sample = (i: number) => profile?.sampleRows.find((r) => (r[i] ?? "").trim() !== "")?.[i] ?? "";

  return createPortal(
    <div className="csv-backdrop">
      <div ref={ref} className="csv-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="csv-head">
          <h2 id={titleId}>CSV importieren</h2>
          <ol className="csv-steps" aria-label="Schritte">
            {([1, 2, 3] as Step[]).map((s) => (
              <li key={s} aria-current={s === step ? "step" : undefined} className={s === step ? "current" : s < step ? "done" : undefined}>
                {s}. {STEP_TITLE[s]}
              </li>
            ))}
          </ol>
          <button className="btn-sm" onClick={onClose} aria-label="Import schließen">
            Schließen
          </button>
        </header>

        {error && (
          <div className="csv-error" role="alert">
            {error}
          </div>
        )}

        {step === 1 && (
          <section className="csv-step" aria-label="Datei wählen">
            <p className="detail">
              Flüge aus anderen Logbüchern übernehmen: die Import-CSV von Volanta, ein SimToolkitPro- oder VA-Export (phpVMS) oder das eigene
              Logbuch-CSV von VectaSim. Importierte Flüge zählen für Stunden, Strecken, Flotte und Länder – Landeanalyse, Streubild und Anflug
              bleiben leer, weil keine Aufzeichnung dabei ist.
            </p>
            <div className="setting-row">
              <button className="btn-primary" onClick={() => void chooseFile()} disabled={busy != null}>
                {busy === "Lesen" ? "Liest …" : path ? "Andere Datei …" : "Datei wählen …"}
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
                    <dt>Erkannt</dt>
                    <dd>{PRESET_LABEL[profile.detectedPreset]}</dd>
                  </div>
                  <div>
                    <dt>Trennzeichen</dt>
                    <dd>{DELIMITER_LABEL[profile.delimiter] ?? `„${profile.delimiter}“`}</dd>
                  </div>
                  <div>
                    <dt>Kodierung</dt>
                    <dd>{ENCODING_LABEL[profile.encoding] ?? profile.encoding}</dd>
                  </div>
                  <div>
                    <dt>Zeilen</dt>
                    <dd>
                      {fmt(profile.rowCount)} {profile.hasHeader ? "(plus Kopfzeile)" : "(ohne Kopfzeile)"}
                    </dd>
                  </div>
                </dl>
                <label className="csv-inline">
                  <span>Format</span>
                  <select value={mapping.preset} onChange={(e) => applyPreset(profile, e.target.value as CsvPreset, path ?? "")}>
                    {(Object.keys(PRESET_LABEL) as CsvPreset[]).map((p) => (
                      <option key={p} value={p}>
                        {PRESET_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </label>
                {mapping.preset === "simtoolkitpro" && (
                  <div className="detail">Die Spalten von SimToolkitPro sind nicht dokumentiert – prüf die Zuordnung im nächsten Schritt.</div>
                )}
                <SampleTable profile={profile} />
              </>
            )}
            <footer className="csv-foot">
              <button className="btn-sm" onClick={onClose}>
                Abbrechen
              </button>
              <button className="btn-sm btn-primary" onClick={() => setStep(2)} disabled={!profile || profile.rowCount === 0}>
                Weiter
              </button>
            </footer>
          </section>
        )}

        {step === 2 && profile && mapping && (
          <section className="csv-step" aria-label="Spalten zuordnen">
            <p className="detail">
              Vorbelegt aus {PRESET_LABEL[mapping.preset]} und den Spaltennamen. Datum und Uhrzeit dürfen in einer Spalte stehen oder getrennt
              (dann Datum + Off-Block-Uhrzeit). Fehlt die Ankunft, rechnet VectaSim sie aus der Blockzeit.
            </p>
            <div className="csv-formats">
              <label className="csv-inline">
                <span>Datumsformat</span>
                <select value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as CsvDateFormat })}>
                  {DATE_FORMATS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="csv-inline">
                <span>Zeiten ohne Zeitzone</span>
                <select value={zone} onChange={(e) => setZone(e.target.value as Zone)}>
                  <option value="utc">sind UTC</option>
                  <option value="local">sind Ortszeit dieses PCs</option>
                </select>
              </label>
              <label className="csv-inline">
                <span>Gewichte in</span>
                <select value={mapping.weightUnit} onChange={(e) => setMapping({ ...mapping, weightUnit: e.target.value as "kg" | "lb" })}>
                  <option value="kg">kg</option>
                  <option value="lb">lb</option>
                </select>
              </label>
              <label className="csv-inline">
                <span>Dauer als Zahl in</span>
                <select value={mapping.durationUnit} onChange={(e) => setMapping({ ...mapping, durationUnit: e.target.value as "minutes" | "hours" })}>
                  <option value="minutes">Minuten</option>
                  <option value="hours">Stunden</option>
                </select>
              </label>
            </div>
            <div className="csv-scroll">
              <table className="csv-map">
                <caption className="sr-only">Zielfeld und Quellspalte</caption>
                <thead>
                  <tr>
                    <th scope="col">Feld in VectaSim</th>
                    <th scope="col">Spalte der Datei</th>
                    <th scope="col">Beispiel</th>
                  </tr>
                </thead>
                {FIELD_GROUPS.map((g) => (
                  <tbody key={g.title}>
                    <tr className="csv-group">
                      <th scope="rowgroup" colSpan={3}>
                        {g.title}
                      </th>
                    </tr>
                    {g.fields.map(([f, label]) => {
                      const id = `${titleId}-${f}`;
                      const col = mapping.columns[f];
                      return (
                        <tr key={f}>
                          <th scope="row">
                            <label htmlFor={id}>{label}</label>
                          </th>
                          <td>
                            <select id={id} value={col ?? ""} onChange={(e) => setColumn(f, e.target.value)}>
                              <option value="">– nicht zugeordnet –</option>
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
                Zurück
              </button>
              <button className="btn-sm btn-primary" onClick={() => void loadPreview()} disabled={!!missing || busy != null}>
                {busy === "Vorschau" ? "Liest …" : "Vorschau"}
              </button>
            </footer>
          </section>
        )}

        {step === 3 && preview && mapping && (
          <section className="csv-step" aria-label="Vorschau">
            <div className="csv-counts" role="status">
              {fmt(preview.totalRows)} Zeilen · {fmt(preview.valid)} gültig
              {preview.invalid ? ` · ${fmt(preview.invalid)} fehlerhaft (werden übersprungen)` : ""}
              {dedupe ? ` · ${fmt(preview.duplicates)} schon im Logbuch` : ""}
            </div>
            <div className="csv-scroll">
              <PreviewTable rows={preview.rows} dedupe={dedupe} />
            </div>
            {preview.totalRows > preview.rows.length && (
              <div className="detail">Gezeigt: die ersten {preview.rows.length} Zeilen. Gezählt und importiert wird die ganze Datei.</div>
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
                Duplikate überspringen (gleiche Strecke, Off-Block weniger als 15 min auseinander)
              </label>
              <label className="csv-inline">
                <span>Quelle (Tag)</span>
                <input value={sourceTag} onChange={(e) => setSourceTag(e.target.value)} maxLength={30} list={`${titleId}-tags`} autoComplete="off" />
                <datalist id={`${titleId}-tags`}>
                  {[...new Set([PRESET_TAG[mapping.preset], "volanta", "stkp", path ? fileStem(path) : ""])].filter(Boolean).map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="detail">
              Jeder Flug bekommt die Tags „import“ und die Quelle. Eine Landerate aus der Datei steht in den Notizen – sie stammt von einem anderen
              Messverfahren und zählt nicht für die Landestatistik.
            </div>
            <footer className="csv-foot">
              <button className="btn-sm" onClick={() => setStep(2)}>
                Zurück
              </button>
              <button
                className="btn-sm btn-primary"
                onClick={() => void runImport()}
                disabled={busy != null || preview.valid - (dedupe ? preview.duplicates : 0) <= 0}
              >
                {busy === "Import" ? "Importiert …" : `${fmt(preview.valid - (dedupe ? preview.duplicates : 0))} Flüge importieren`}
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
  if (profile.sampleRows.length === 0) return <div className="detail">Die Datei enthält keine Datenzeilen.</div>;
  return (
    <div className="csv-scroll csv-sample-table">
      <table className="csv-map">
        <caption className="sr-only">Erste Zeilen der Datei</caption>
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

function status(r: CsvParsedFlight, dedupe: boolean): { tone: "ok" | "warn" | "err"; text: ReactNode } {
  if (r.error) return { tone: "err", text: `Fehler: ${r.error}` };
  if (dedupe && r.duplicate) return { tone: "warn", text: "schon im Logbuch – wird übersprungen" };
  if (r.warnings.length) return { tone: "warn", text: r.warnings.join(" · ") };
  return { tone: "ok", text: "ok" };
}

function PreviewTable({ rows, dedupe }: { rows: CsvParsedFlight[]; dedupe: boolean }) {
  return (
    <table className="csv-map csv-preview">
      <caption className="sr-only">Vorschau der ersten Zeilen</caption>
      <thead>
        <tr>
          <th scope="col">Zeile</th>
          <th scope="col">Off-Block</th>
          <th scope="col">Strecke</th>
          <th scope="col">Flugzeug</th>
          <th scope="col" className="right">
            Block
          </th>
          <th scope="col" className="right">
            Distanz
          </th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const s = status(r, dedupe);
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
                {r.distanceNm != null ? `${r.distanceEstimated ? "ca. " : ""}${fmt(r.distanceNm, 0, "nm")}` : "–"}
              </td>
              <td className={`csv-status ${s.tone}`}>{s.text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
