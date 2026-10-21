import type { FlightPhase, Metar } from "./types";

/**
 * Language-neutral display helpers and the global display settings (time base, weight unit,
 * Streamer-Modus). Language-aware number, unit, duration, date, altitude, coordinate and METAR
 * formatting lives in i18n/number.ts (de + en); the former German-only copies here were removed
 * so a stray import cannot bring German numbers back into English.
 * Conventions: placeholder "–", 24 h clock with "z" for UTC (fmtClock, used by i18n/number),
 * weights stored in kg and converted by weightIn.
 * Everything here is pure (no Tauri calls) so it can be unit-tested.
 */

/** Flight phases stay English cockpit terms by product decision. */
export const PHASE_LABEL: Record<FlightPhase, string> = {
  preflight: "Preflight",
  pushback: "Pushback",
  taxiOut: "Taxi out",
  takeoff: "Takeoff",
  climb: "Climb",
  cruise: "Cruise",
  descent: "Descent",
  approach: "Approach",
  final: "Final",
  landing: "Landing",
  taxiIn: "Taxi in",
  shutdown: "Shutdown",
};

/** Narrow no-break space: thousands separator and number–unit gap. */
export const NNBSP = " ";
/** Real minus sign. */
export const MINUS = "−";
/** Placeholder for "no value". */
export const DASH = "–";

// ---- time zone preference ------------------------------------------------------------

let timeLocal = false;

/** Switch clock/date output between UTC ("z") and local time. Called by prefs.ts. */
export function setTimeLocal(local: boolean) {
  timeLocal = local;
}

export function isTimeLocal(): boolean {
  return timeLocal;
}

// ---- numbers -------------------------------------------------------------------------

const isNum = (n: number | undefined | null): n is number => typeof n === "number" && Number.isFinite(n);

// ---- weights -------------------------------------------------------------------------

export type WeightUnit = "kg" | "lb";
/** International avoirdupois pound: 1 lb = 0.45359237 kg exactly. */
export const LB_PER_KG = 1 / 0.45359237;

let weightUnit: WeightUnit = "kg";

/** Switch weight/fuel output between kg and lb. Called by prefs.ts. */
export function setWeightUnit(unit: WeightUnit) {
  weightUnit = unit;
}

export function getWeightUnit(): WeightUnit {
  return weightUnit;
}

export function isWeightUnit(v: unknown): v is WeightUnit {
  return v === "kg" || v === "lb";
}

/** A weight given in kg, in the display unit (null for no value). */
export function weightIn(kg: number | undefined | null, unit: WeightUnit = weightUnit): number | null {
  if (!isNum(kg)) return null;
  return unit === "lb" ? kg * LB_PER_KG : kg;
}

// ---- clock & date --------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Clock time "14:30z" (UTC) or "16:30" (local, if enabled). `seconds` only where they
 * matter (event log, touchdown). `local` overrides the global preference.
 */
export function fmtClock(ms: number | undefined | null, opts: { seconds?: boolean; local?: boolean } = {}): string {
  if (!isNum(ms) || ms <= 0) return DASH;
  const local = opts.local ?? timeLocal;
  const d = new Date(ms);
  const h = local ? d.getHours() : d.getUTCHours();
  const m = local ? d.getMinutes() : d.getUTCMinutes();
  const s = local ? d.getSeconds() : d.getUTCSeconds();
  return `${p2(h)}:${p2(m)}${opts.seconds ? `:${p2(s)}` : ""}${local ? "" : "z"}`;
}

// ---- geo -----------------------------------------------------------------------------

/**
 * Transition altitude: above it altitudes read as flight levels. 5000 ft is the common
 * value in Germany (AIP Germany ENR 1.7); the US value 18 000 ft would call FL120 "12 000 ft"
 * (see the methodology notes in the debrief, "Methodik"). One constant until the TA comes from the OFP or a setting.
 */
export const TRANSITION_ALTITUDE_FT = 5000;

// ---- weather -------------------------------------------------------------------------

export function fmtPressure(m: Metar): string {
  if (m.altimeterInhg != null) return `A${m.altimeterInhg.toFixed(2)}`;
  return m.qnhHpa != null ? `Q${m.qnhHpa}` : `QNH ${DASH}`;
}

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dp = (lat2 - lat1) * r;
  const dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a));
}

// ---- Streamer-/Datenschutzmodus (privacy_mode) ----------------------------------------
// Display-only masking: the data stays as it is, only what the UI (and the landing card PNG)
// shows changes. One look everywhere: registrations keep their first segment ("D-••••"),
// callsigns/flight numbers and airlines become bullets, the SimBrief ID "••••", paths lose
// the Windows user name ("%LOCALAPPDATA%\…" instead of "C:\Users\<Name>\AppData\Local\…").
// Components read the mode through prefs.ts → usePrivacy(); prefs.ts calls setPrivacyMode.

/** Bullet used for every masked character. */
export const MASK = "•";

let privacyMode = false;

/** Switch the Streamer-Modus on/off. Called by prefs.ts. */
export function setPrivacyMode(on: boolean) {
  privacyMode = on;
}

export function isPrivacyMode(): boolean {
  return privacyMode;
}

/** "D-AINA" → "D-••••", "N123AB" → "N••••", "" → "". The nationality prefix stays readable. */
export function maskRegistration(reg: string | null | undefined): string {
  const r = (reg ?? "").trim();
  if (!r) return "";
  const dash = r.indexOf("-");
  const head = dash > 0 && dash <= 3 ? r.slice(0, dash + 1) : r.slice(0, 1);
  return `${head}${MASK.repeat(4)}`;
}

/** Callsign / flight number ("DLH4AB", "Lufthansa 123") → "•••••". */
export function maskCallsign(cs: string | null | undefined): string {
  return (cs ?? "").trim() ? MASK.repeat(5) : "";
}

/** Airline name or code → "•••". */
export function maskAirline(a: string | null | undefined): string {
  return (a ?? "").trim() ? MASK.repeat(3) : "";
}

/** SimBrief pilot ID / user name → "••••". */
export function maskSimbriefId(id: string | null | undefined): string {
  return (id ?? "").trim() ? MASK.repeat(4) : "";
}

/**
 * `X:\Users\<Name>` (separator `\`, `/` or a doubled `\\` as in Debug-formatted paths),
 * optionally followed by `\AppData\Local` or `\AppData\Roaming` (not `LocalLow`).
 */
const USER_PATH = /(?<![A-Za-z0-9])[A-Za-z]:(\\\\|\\|\/)Users\1([^\\/:*?"<>|\r\n]+)(?:\1AppData\1(Local|Roaming)(?=[\\/"') \t\r\n]|$))?/gi;

/**
 * Removes the Windows user name from every path in `text` (also inside a longer message):
 * `C:\Users\Max\AppData\Local\io.vectasim.app\x.log` → `%LOCALAPPDATA%\io.vectasim.app\x.log`,
 * `…\AppData\Roaming\…` → `%APPDATA%\…`, any other `C:\Users\Max\…` → `%USERPROFILE%\…`.
 * Same rule as the Rust side (privacy.rs → mask_user_paths).
 */
export function maskPath(text: string | null | undefined): string {
  if (!text) return text ?? "";
  return text.replace(USER_PATH, (_m, _sep: string, _name: string, sub: string | undefined) => {
    const s = sub?.toLowerCase();
    return s === "local" ? "%LOCALAPPDATA%" : s === "roaming" ? "%APPDATA%" : "%USERPROFILE%";
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Values a free text (aircraft title, OFP line) may repeat; see maskTitle. */
export interface KnownSecrets {
  registration?: string | null;
  airline?: string | null;
  callsign?: string | null;
}

/**
 * A free text such as the sim's aircraft title ("A320neo Lufthansa D-AINA") with the known
 * registration, airline and callsign masked where they appear (case-insensitive, at least
 * two characters). Unchanged while `on` is false.
 */
export function maskTitle(text: string | null | undefined, known: KnownSecrets, on: boolean = privacyMode): string {
  let out = text ?? "";
  if (!on || !out) return out;
  const parts: Array<[string | null | undefined, (v: string) => string]> = [
    [known.registration, maskRegistration],
    [known.callsign, maskCallsign],
    [known.airline, maskAirline],
  ];
  for (const [v, mask] of parts) {
    const s = (v ?? "").trim();
    if (s.length < 2) continue;
    out = out.replace(new RegExp(escapeRe(s), "gi"), () => mask(s));
  }
  return out;
}

export type PrivacyKind = "registration" | "callsign" | "airline" | "simbrief" | "path";

/**
 * The value as the UI shows it: masked by `kind` while the Streamer-Modus is on (`on`
 * defaults to the global mode), unchanged otherwise. null/undefined → "".
 */
export function privacy(value: string | null | undefined, kind: PrivacyKind, on: boolean = privacyMode): string {
  const v = value ?? "";
  if (!on || !v) return v;
  switch (kind) {
    case "registration":
      return maskRegistration(v);
    case "callsign":
      return maskCallsign(v);
    case "airline":
      return maskAirline(v);
    case "simbrief":
      return maskSimbriefId(v);
    case "path":
      return maskPath(v);
  }
}
