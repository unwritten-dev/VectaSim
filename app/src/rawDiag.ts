import type { DiagEvent, Telemetry, VarDiag } from "./types";
import { fmt, fmtNum, fmtSigned } from "./i18n/number";
import { t, type TKey } from "./i18n";

/** Raw value exactly as received: full precision (JS shortest round-trip), strings quoted. */
export function fmtRaw(v: VarDiag): string {
  if (v.rawText != null) return t("live.raw.quoted", { text: v.rawText });
  if (v.raw == null) return "–";
  return String(v.raw);
}

const DIGITS: Record<string, number> = { ft: 1, kt: 1, fpm: 0, kg: 0, g: 2, "×": 2, "%": 0, s: 0, Index: 0, Anzahl: 0, Nadel: 0 };

/** Unit names the backend sends in German (decoder.rs, datarefs.rs) → i18n; others are symbols. */
const UNIT_KEY: Record<string, TKey> = { Anzahl: "live.raw.units.count", Nadel: "live.raw.units.needle", Index: "live.raw.units.index" };

/** The converted value's unit as shown (translated where it is a word). */
export function unitLabel(unit: string): string {
  const key = UNIT_KEY[unit];
  return key ? t(key) : unit;
}

/** Converted value (what VectaSim uses), in its unit. */
export function fmtConverted(v: VarDiag): string {
  if (v.valueText != null) return v.valueText || "–";
  if (v.value == null) return "–";
  switch (v.valueUnit) {
    case "bool":
      return v.value !== 0 ? t("live.raw.yes") : t("live.raw.no");
    case "Squawk":
      return String(Math.round(v.value)).padStart(4, "0");
    case "°":
      // coordinates need the digits, angles do not
      return fmt(v.value, /LATITUDE|LONGITUDE/.test(v.name) ? 6 : 1, "°");
    default:
      return fmt(v.value, DIGITS[v.valueUnit] ?? 2, unitLabel(v.valueUnit));
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

/** Replay speeds offered in the UI; 0 = as fast as possible. Labels are read at render time (UI language). */
export const REPLAY_SPEEDS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  {
    value: 1,
    get label() {
      return t("live.raw.replayRealtime");
    },
  },
  { value: 10, label: "10×" },
  { value: 60, label: "60×" },
  {
    value: 0,
    get label() {
      return t("live.raw.replayFastest");
    },
  },
];

/** Suggested name of the Diagnosepaket, local time: `VectaSim-Diagnose_2026-10-18_1432.zip`. */
export function diagPackageName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `VectaSim-Diagnose_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

const onOff = (b: boolean | undefined) => (b == null ? "–" : b ? t("live.raw.on") : t("live.raw.off"));
const optYesNo = (b: boolean | undefined) => (b == null ? "–" : b ? t("live.raw.yes") : t("live.raw.no"));

/** Rows of the track-v2 approach values in a telemetry sample (converted, as recorded). */
export function approachRows(s: Telemetry): Array<[string, string]> {
  const wind = s.windKt == null ? "–" : `${fmt(s.windDirTrueDeg, 0, "°")} / ${fmt(s.windKt, 0, "kt")}`;
  const ils =
    s.navHasLocalizer == null && s.navHasGlideSlope == null
      ? "–"
      : t("live.raw.row.ilsValue", { loc: optYesNo(s.navHasLocalizer), gs: optYesNo(s.navHasGlideSlope), flag: optYesNo(s.navGsFlag) });
  return [
    ["TAS", fmt(s.tasKt, 0, "kt")],
    [t("live.raw.row.wind"), wind],
    ["ILS (NAV 1)", ils],
    [
      t("live.raw.row.glidepath"),
      s.navGsErrorDeg == null ? "–" : t("live.raw.row.glidepathValue", { deviation: fmtSigned(s.navGsErrorDeg, 2, "°"), angle: fmt(s.navGsAngleDeg, 2, "°") }),
    ],
    [
      "Localizer",
      s.navCdi == null
        ? "–"
        : t("live.raw.row.localizerValue", { cdi: fmtSigned(s.navCdi, 0), deviation: fmtSigned(s.navRadialErrorDeg, 2, "°"), course: fmt(s.navLocCourseDeg, 0, "°") }),
    ],
    [
      "Autopilot",
      `AP ${onOff(s.autopilotMaster)} · APPR ${onOff(s.autopilotApproachHold)} · G/S ${onOff(s.autopilotGlideslopeHold)} · A/THR ${onOff(s.autothrottleActive)}`,
    ],
    [t("live.raw.row.thrust"), t("live.raw.row.thrustValue", { n1: fmt(s.n1Pct, 1, "%"), lever: fmt(s.throttleLeverPct, 0, "%") })],
    [
      t("live.raw.row.spoilers"),
      t("live.raw.row.spoilersValue", { area: fmt(s.spoilersPct, 0, "%"), lever: fmt(s.spoilersHandlePct, 0, "%"), armed: optYesNo(s.spoilersArmed) }),
    ],
    [t("live.raw.row.alpha"), fmt(s.alphaDeg, 1, "°")],
    [t("live.raw.row.flapSteps"), s.flapPositions == null ? "–" : t("live.raw.row.flapStepsValue", { steps: s.flapPositions, index: s.flapPositions - 1 })],
    [
      t("live.raw.row.designSpeeds"),
      s.designVs0Kt == null && s.designVs1Kt == null ? "–" : `VS0 ${fmt(s.designVs0Kt, 0, "kt")} · VS1 ${fmt(s.designVs1Kt, 0, "kt")} · VC ${fmt(s.designVcKt, 0, "kt")}`,
    ],
  ];
}

/** Any approach value besides TAS (which every sample has) arrived. */
export function hasApproachData(t: Telemetry): boolean {
  return [t.windKt, t.navHasLocalizer, t.navHasGlideSlope, t.autopilotMaster, t.n1Pct, t.spoilersPct, t.alphaDeg, t.flapPositions, t.designVs0Kt].some((v) => v != null);
}

/** Labels of the connection rows, by raw-diag source (`simconnect` / `xplane` / `replay`):
 * SimConnect terms (DLL, RECV_OPEN, SimConnect version, Sim=0/1) only for SimConnect. */
export function connLabels(source: string | null | undefined): { origin: string; sim: string; api: string; simconnect: boolean } {
  switch (source) {
    case "simconnect":
      return { origin: "SimConnect.dll", sim: t("live.raw.conn.simRecvOpen"), api: t("live.raw.conn.simconnectVersion"), simconnect: true };
    case "xplane":
      return { origin: t("live.raw.conn.source"), sim: t("live.raw.conn.simulator"), api: t("live.raw.conn.webApiVersion"), simconnect: false };
    case "replay":
      return { origin: t("live.raw.conn.file"), sim: t("live.raw.conn.simFromDump"), api: t("live.raw.conn.interface"), simconnect: false };
    default:
      return { origin: t("live.raw.conn.source"), sim: t("live.raw.conn.simulator"), api: t("live.raw.conn.interface"), simconnect: false };
  }
}
