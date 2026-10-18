import type { DiagEvent, VarDiag } from "./types";
import { fmt, fmtNum } from "./format";

/** Raw value exactly as received: full precision (JS shortest round-trip), strings quoted. */
export function fmtRaw(v: VarDiag): string {
  if (v.rawText != null) return v.rawText === "" ? "„“" : `„${v.rawText}“`;
  if (v.raw == null) return "–";
  return String(v.raw);
}

const DIGITS: Record<string, number> = { ft: 1, kt: 1, fpm: 0, kg: 0, g: 2, "×": 2, "%": 0, s: 0, Index: 0, Anzahl: 0 };

/** Converted value (what VectaSim uses), in its unit. */
export function fmtConverted(v: VarDiag): string {
  if (v.valueText != null) return v.valueText || "–";
  if (v.value == null) return "–";
  switch (v.valueUnit) {
    case "bool":
      return v.value !== 0 ? "ja" : "nein";
    case "Squawk":
      return String(Math.round(v.value)).padStart(4, "0");
    case "°":
      // coordinates need the digits, angles do not
      return fmt(v.value, /LATITUDE|LONGITUDE/.test(v.name) ? 6 : 1, "°");
    default:
      return fmt(v.value, DIGITS[v.valueUnit] ?? 2, v.valueUnit);
  }
}

/** Age of the last update: "250 ms", "4,2 s", "3 min", "–". */
export function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${fmtNum(ms / 1000, 1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function fmtHz(hz: number | null | undefined): string {
  return hz ? fmt(hz, hz < 10 ? 1 : 0, "Hz") : "–";
}

/** Exceptions, failed calls and warnings stand out in the event log. */
export function eventTone(e: Pick<DiagEvent, "kind">): "err" | "warn" | "info" {
  if (e.kind === "exception" || e.kind === "hr") return "err";
  if (e.kind === "warning" || e.kind === "end" || e.kind === "quit") return "warn";
  return "info";
}

/** Bytes as "312 KB" / "4,1 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1024 * 1024) return `${fmtNum(n / 1024, 0)} KB`;
  return `${fmtNum(n / (1024 * 1024), 1)} MB`;
}

/** Replay speeds offered in the UI; 0 = as fast as possible. */
export const REPLAY_SPEEDS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Echtzeit (1×)" },
  { value: 10, label: "10×" },
  { value: 60, label: "60×" },
  { value: 0, label: "so schnell wie möglich" },
];

/** Suggested name of the Diagnosepaket, local time: `VectaSim-Diagnose_2026-10-18_1432.zip`. */
export function diagPackageName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `VectaSim-Diagnose_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`;
}
