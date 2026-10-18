import type { FlightPhase, Metar, Wind } from "./types";

/**
 * Display formatting for the whole UI. Conventions (one style everywhere):
 * - numbers: de-DE decimal comma, narrow no-break space as thousands separator ("61 959"),
 *   real minus sign U+2212 ("−112"), narrow no-break space before units ("412 kt");
 * - durations never as m:ss: "43 s", "7 min 43 s", "1 h 05 min", "26 h 30 min";
 * - clock times 24 h, UTC with a "z" suffix by default ("14:30z"), local time when the
 *   `time_local` setting is on (see prefs.ts → setTimeLocal);
 * - one date format: "17.10.2026";
 * - weights and fuel are stored in kg and shown in kg or lb (`weight_unit` setting, see
 *   prefs.ts → setWeightUnit); always through fmtWeight / fmtWeightNum / fmtDeltaKg.
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

/** "61 959", "1,25", "−1 800". */
export function fmtNum(n: number | undefined | null, digits = 0): string {
  if (!isNum(n)) return DASH;
  const fixed = Math.abs(n).toFixed(digits);
  // -0 and values that round to zero lose their sign
  const negative = n < 0 && Number(fixed) !== 0;
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  return `${negative ? MINUS : ""}${grouped}${frac ? `,${frac}` : ""}`;
}

/** Units glued to the number without a gap. */
const TIGHT_UNITS = new Set(["°", "×", "′", "″"]);

function withUnit(value: string, unit: string): string {
  const u = unit.trim();
  if (!u) return value;
  return TIGHT_UNITS.has(u[0]) ? `${value}${u}` : `${value}${NNBSP}${u}`;
}

/**
 * Number with optional unit: fmt(61959, 0, "kg") → "61 959 kg", fmt(-1.5, 1) → "−1,5".
 * A leading space in `unit` is ignored (legacy call style " kg").
 */
export function fmt(n: number | undefined | null, digits = 0, unit = ""): string {
  if (!isNum(n)) return DASH;
  return withUnit(fmtNum(n, digits), unit);
}

/** Always signed ("+4 260 fpm", "−112 fpm", "±0 fpm"); for deltas and rates where the sign matters. */
export function fmtSigned(n: number | undefined | null, digits = 0, unit = ""): string {
  if (!isNum(n)) return DASH;
  const body = fmtNum(Math.abs(n), digits);
  const zero = Number(Math.abs(n).toFixed(digits)) === 0;
  return withUnit(`${zero ? "±" : n > 0 ? "+" : MINUS}${body}`, unit);
}

// ---- durations -----------------------------------------------------------------------

/**
 * Unambiguous duration: "43 s", "7 min 43 s", "1 h 05 min", "26 h 30 min".
 * Under one hour the seconds are shown (unless `seconds: false`, then "7 min");
 * from one hour on only hours and minutes. Values are truncated, never rounded up.
 */
export function fmtDuration(ms: number | undefined | null, opts: { seconds?: boolean } = {}): string {
  if (!isNum(ms) || ms < 0) return DASH;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${fmtNum(h)}${NNBSP}h${NNBSP}${String(m).padStart(2, "0")}${NNBSP}min`;
  if (opts.seconds === false) return `${m}${NNBSP}min`;
  if (m > 0) return `${m}${NNBSP}min${NNBSP}${String(s).padStart(2, "0")}${NNBSP}s`;
  return `${s}${NNBSP}s`;
}

/** Signed minutes delta (actual minus planned): "+7 min", "−12 min", "±0 min", "+1 h 05 min". */
export function fmtDeltaMin(actualMs: number | null | undefined, plannedMs: number | null | undefined): string {
  if (!isNum(actualMs) || !isNum(plannedMs)) return DASH;
  const d = Math.round((actualMs - plannedMs) / 60000);
  const sign = d > 0 ? "+" : d < 0 ? MINUS : "±";
  const a = Math.abs(d);
  const body = a >= 60 ? `${Math.floor(a / 60)}${NNBSP}h${NNBSP}${String(a % 60).padStart(2, "0")}${NNBSP}min` : `${a}${NNBSP}min`;
  return `${sign}${body}`;
}

/** Delta in minutes as a number (for thresholds), or null. */
export function deltaMinutes(actualMs: number | null | undefined, plannedMs: number | null | undefined): number | null {
  if (!isNum(actualMs) || !isNum(plannedMs)) return null;
  return Math.round((actualMs - plannedMs) / 60000);
}

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

/** Weight number without unit, for a Stat value next to `unit={getWeightUnit()}`: "61 959" / "136 596". */
export function fmtWeightNum(kg: number | undefined | null, unit: WeightUnit = weightUnit): string {
  return fmtNum(weightIn(kg, unit), 0);
}

/** Weight with unit: fmtWeight(61959) → "61 959 kg", with lb → "136 596 lb". */
export function fmtWeight(kg: number | undefined | null, unit: WeightUnit = weightUnit): string {
  return fmt(weightIn(kg, unit), 0, unit);
}

/** Signed weight delta (actual minus planned, both kg) in the display unit: "+120 kg", "−265 lb". */
export function fmtDeltaKg(actual: number | null | undefined, planned: number | null | undefined, unit: WeightUnit = weightUnit): string {
  if (!isNum(actual) || !isNum(planned)) return DASH;
  return fmtSigned(Math.round(weightIn(actual - planned, unit) ?? 0), 0, unit);
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

/** Date "17.10.2026", in UTC or local time like fmtClock. */
export function fmtDate(ms: number | undefined | null, opts: { local?: boolean } = {}): string {
  if (!isNum(ms) || ms <= 0) return DASH;
  const local = opts.local ?? timeLocal;
  const d = new Date(ms);
  const day = local ? d.getDate() : d.getUTCDate();
  const month = (local ? d.getMonth() : d.getUTCMonth()) + 1;
  const year = local ? d.getFullYear() : d.getUTCFullYear();
  return `${p2(day)}.${p2(month)}.${year}`;
}

/** "17.10.2026 14:30z". */
export function fmtDateTime(ms: number | undefined | null, opts: { local?: boolean } = {}): string {
  if (!isNum(ms) || ms <= 0) return DASH;
  return `${fmtDate(ms, opts)} ${fmtClock(ms, opts)}`;
}

/** Short label for the active time base, e.g. for column headers: "UTC" or "Ortszeit". */
export function timeBaseLabel(): string {
  return timeLocal ? "Ortszeit" : "UTC";
}

// ---- geo -----------------------------------------------------------------------------

/** "50,033° N 8,570° E". */
export function fmtCoord(lat: number | null | undefined, lon: number | null | undefined, digits = 3): string {
  if (!isNum(lat) || !isNum(lon)) return DASH;
  return `${fmtNum(Math.abs(lat), digits)}° ${lat >= 0 ? "N" : "S"} ${fmtNum(Math.abs(lon), digits)}° ${lon >= 0 ? "E" : "W"}`;
}

/**
 * Transition altitude: above it altitudes read as flight levels. 5000 ft is the common
 * value in Germany (AIP Germany ENR 1.7); the US value 18 000 ft would call FL120 "12 000 ft"
 * (see the methodology notes in the debrief, "Methodik"). One constant until the TA comes from the OFP or a setting.
 */
export const TRANSITION_ALTITUDE_FT = 5000;

/** Altitude as flight level above the transition altitude, else feet: "FL350", "4 500 ft". */
export function fmtAltitude(ft: number | null | undefined, transitionAltitudeFt = TRANSITION_ALTITUDE_FT): string {
  if (!isNum(ft)) return DASH;
  return ft > transitionAltitudeFt ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : fmt(Math.round(ft), 0, "ft");
}

// ---- weather -------------------------------------------------------------------------

export function fmtWind(w: Wind | null | undefined): string {
  if (!w) return `Wind ${DASH}`;
  if (w.speedKt === 0) return "Windstill";
  const dir = w.directionDeg == null ? "VRB" : `${String(w.directionDeg).padStart(3, "0")}°`;
  const gust = w.gustKt ? `G${w.gustKt}` : "";
  const variable = w.variableFromDeg != null && w.variableToDeg != null ? ` (${w.variableFromDeg}–${w.variableToDeg}°)` : "";
  return `${dir} ${w.speedKt}${gust}${NNBSP}kt${variable}`;
}

export function fmtVisibility(m: Metar): string {
  if (m.cavok) return "CAVOK";
  const v = m.visibilityM;
  if (v == null) return `Sicht ${DASH}`;
  if (v >= 10000) return `≥${NNBSP}10${NNBSP}km`;
  if (v >= 5000) return fmt(v / 1000, 0, "km");
  return fmt(v, 0, "m");
}

export function fmtPressure(m: Metar): string {
  if (m.altimeterInhg != null) return `A${m.altimeterInhg.toFixed(2)}`;
  return m.qnhHpa != null ? `Q${m.qnhHpa}` : `QNH ${DASH}`;
}

/** One-line METAR summary: wind · visibility · QNH · temp/dew · ceiling. */
export function fmtMetarLine(m: Metar): string {
  const parts = [fmtWind(m.wind), fmtVisibility(m), fmtPressure(m)];
  if (m.temperatureC != null) parts.push(`${fmtNum(m.temperatureC)}/${m.dewpointC != null ? fmtNum(m.dewpointC) : DASH}${NNBSP}°C`);
  if (m.ceilingFt != null) parts.push(`Wolkenbasis ${fmt(m.ceilingFt, 0, "ft")}`);
  return parts.join(" · ");
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
