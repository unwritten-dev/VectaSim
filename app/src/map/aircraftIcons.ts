// Aircraft symbols for the map, sized by ICAO wake-turbulence category.
//
// Why categories: a C172 and an A380 drawn the same size make the map lie about
// what is flying. We size by the ICAO wake class (Light ≤ 7 000 kg MTOM, Medium
// > 7 000 and < 136 000 kg, Heavy ≥ 136 000 kg, Super = A380/An-225; ICAO Doc 8643,
// classified by MTOM per ICAO Doc 8643) and pick a silhouette per class (single prop,
// twin jet, wide-body). The class comes from the ICAO type designator when we
// have one (VATSIM `aircraft_short`, MSFS `ATC MODEL` tokens like
// `TT:ATCCOM.AC_MODEL_A20N.0.text`), else from the aircraft title, else from the
// current weight as a last resort.

import type * as maplibregl from "maplibre-gl";
import { COLOR, TRAFFIC, getMapTheme } from "../theme";

export type WakeCategory = "light" | "medium" | "heavy" | "super";

export const WAKE_LABEL: Record<WakeCategory, string> = { light: "Light", medium: "Medium", heavy: "Heavy", super: "Super" };

/** Multiplier on the base icon size per class. */
export const WAKE_SIZE: Record<WakeCategory, number> = { light: 1.0, medium: 1.3, heavy: 1.65, super: 1.9 };

const SUPER = new Set(["A388", "A389", "A225"]);
const HEAVY = new Set([
  "A332", "A333", "A337", "A338", "A339", "A342", "A343", "A345", "A346", "A359", "A35K", "A3ST", "A124", "A400",
  "B741", "B742", "B743", "B744", "B748", "B74S", "B74R", "BLCF", "B762", "B763", "B764", "B772", "B773", "B77L", "B77W",
  "B778", "B779", "B788", "B789", "B78X", "MD11", "DC10", "L101", "IL96", "IL76", "C17", "C5M", "K35R", "E3CF", "E767",
  "A310", "A306", "A30B",
]);
const MEDIUM = new Set([
  "A318", "A319", "A19N", "A320", "A20N", "A321", "A21N", "A221", "A223", "BCS1", "BCS3", "B712", "B721", "B722", "B731",
  "B732", "B733", "B734", "B735", "B736", "B737", "B738", "B739", "B37M", "B38M", "B39M", "B3XM", "B752", "B753", "MD80",
  "MD81", "MD82", "MD83", "MD87", "MD88", "MD90", "DC91", "DC93", "DC95", "E170", "E175", "E190", "E195", "E290", "E295",
  "E145", "E135", "E140", "CRJ1", "CRJ2", "CRJ7", "CRJ9", "CRJX", "AT43", "AT45", "AT72", "AT75", "AT76", "DH8A", "DH8B",
  "DH8C", "DH8D", "SF34", "SB20", "F50", "F70", "F100", "RJ85", "RJ1H", "B461", "B462", "B463", "A748", "C560", "C56X",
  "C680", "C68A", "C700", "C750", "CL30", "CL35", "CL60", "GLF4", "GLF5", "GLF6", "GL5T", "GL7T", "GLEX", "FA7X", "FA8X",
  "F900", "F2TH", "LJ35", "LJ45", "LJ60", "LJ75", "E55P", "E545", "E550", "H25B", "PC24",
  "C25C", "DC3", "DC6", "AN24", "AN26", "AN12", "C408", "C130", "C30J", "H60",
]);
/** Light by MTOM (≤ 7 000 kg) although the designator looks like a "real" aircraft. */
const LIGHT = new Set(["TBM9", "PC12", "C208", "DHC6", "DHC2", "BE20", "B350", "E50P", "C525", "C25A", "C25B", "PRM1"]);
const LIGHT_PREFIX = ["C1", "C2", "P2", "PA", "SR2", "DA4", "DA2", "DA6", "BE3", "BE5", "BE9", "M20", "RV", "EVOT", "P46T", "PIVI", "ULAC", "GLID", "R22", "R44", "R66", "EC3", "EC45", "AS50", "B06", "B407", "B412", "EC35", "S76"];

/** Clean up MSFS `ATC MODEL` values like `TT:ATCCOM.AC_MODEL_A20N.0.text` or `$$:A320neo` to a designator-ish token. */
export function icaoFromAtcModel(raw: string | undefined | null): string {
  if (!raw) return "";
  const m = /AC_MODEL_([A-Z0-9]{2,4})/i.exec(raw);
  if (m) return m[1].toUpperCase();
  const t = raw.replace(/^\$\$:/, "").trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(t) ? t : "";
}

function fromTitle(title: string): WakeCategory | null {
  const t = title.toUpperCase();
  if (/A380|A-380|AN-?225/.test(t)) return "super";
  if (/A3(30|40|50)|747|767|777|787|MD-?11|DC-?10|A310|A300|C-?17|IL-?76|L-?1011|AN-?124|BELUGA|CONCORDE/.test(t)) return "heavy";
  // light turboprops and very light jets before the medium families they share words with
  if (/PC-?12|TBM|CARAVAN|TWIN OTTER|BEAVER|KING AIR|VISION ?JET|PHENOM ?100|CITATION ?(CJ[1-4]?|M2|MUSTANG)|PREMIER/.test(t)) return "light";
  if (/A3(18|19|20|21)|A2(20|21)|737|757|727|717|MD-?8|MD-?90|CRJ|E-?JET|E1(70|75|90|95)|E2(90|95)|ERJ|ATR|DASH ?8|Q400|SAAB|FOKKER|BAE ?146|AVRO|CITATION|CHALLENGER|GLOBAL|GULFSTREAM|FALCON|LEARJET|PHENOM|PRAETOR|HAWKER|PC-?24|DC-?3|DC-?6|LONGITUDE|LATITUDE|C-?130|HERCULES|BLACK ?HAWK|UH-?60/.test(t))
    return "medium";
  if (/C172|CESSNA|PIPER|CIRRUS|DIAMOND|BONANZA|BARON|MOONEY|ROBIN|EXTRA|PITTS|CUB|HUSKY|KODIAK|ICON|SAVAGE|SLING|BEECH|GLIDER|ROBINSON|CABRI|H135|H145|EC135|BELL|HELI/.test(t))
    return "light";
  return null;
}

/**
 * Wake category from whatever we know. Order: ICAO type table → title keywords →
 * weight thresholds (kg) → medium (airliners are the common case on VATSIM).
 */
export function wakeCategory(icaoType?: string | null, title?: string | null, weightKg?: number | null): WakeCategory {
  const code = (icaoType ?? "").trim().toUpperCase();
  if (code) {
    if (SUPER.has(code)) return "super";
    if (HEAVY.has(code)) return "heavy";
    if (LIGHT.has(code)) return "light";
    if (MEDIUM.has(code)) return "medium";
    if (LIGHT_PREFIX.some((p) => code.startsWith(p))) return "light";
  }
  if (title) {
    const t = fromTitle(title);
    if (t) return t;
  }
  if (weightKg != null && Number.isFinite(weightKg) && weightKg > 0) {
    if (weightKg >= 136_000) return "heavy";
    if (weightKg > 7_000) return "medium";
    return "light";
  }
  return "medium";
}

// ---- silhouettes (top-down, nose up, 48×48 viewBox) ----------------------------------

const SHAPES: Record<WakeCategory, string> = {
  // single-engine piston: straight wing, small tail, propeller disc hint
  light:
    "M24 3 L26 7 L26 18 L44 22 L44 26 L26 25 L25.5 36 L31 39 L31 42 L24 40 L17 42 L17 39 L22.5 36 L22 25 L4 26 L4 22 L22 18 L22 7 Z",
  // narrow-body twin jet: swept wing with two engine pods
  medium:
    "M24 2 L27 8 L27.5 17 L46 28 L46 32 L34 29 L34 33 L31 33 L31 28.5 L27.5 27.5 L27 38 L33 42 L33 45 L24 43 L15 45 L15 42 L21 38 L20.5 27.5 L17 28.5 L17 33 L14 33 L14 29 L2 32 L2 28 L20.5 17 L21 8 Z",
  // wide-body: broader fuselage, longer swept wing, four pods
  heavy:
    "M24 1 L28 7 L28.5 16 L47 29 L47 33 L40 31 L40 35 L37 35 L37 30 L32 29 L32 34 L29 34 L29 28 L28.5 38 L35 43 L35 46 L24 44 L13 46 L13 43 L19.5 38 L19 28 L19 34 L16 34 L16 29 L11 30 L11 35 L8 35 L8 31 L1 33 L1 29 L19.5 16 L20 7 Z",
  // super: like heavy, even wider wing root and nose
  super:
    "M24 0.5 L29 6 L29.5 15 L47.5 28 L47.5 33 L41 31 L41 36 L37.5 36 L37.5 30 L33 29 L33 35 L29.5 35 L29.5 38 L36 43.5 L36 47 L24 45 L12 47 L12 43.5 L18.5 38 L18.5 35 L15 35 L15 29 L10.5 30 L10.5 36 L7 36 L7 31 L0.5 33 L0.5 28 L18.5 15 L19 6 Z",
};

/** Top-down silhouette path (48×48 viewBox, nose up) of a wake class, e.g. for photo placeholders. */
export function silhouettePath(cat: WakeCategory): string {
  return SHAPES[cat];
}

function svg(path: string, fill: string, stroke: string, strokeWidth: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
</svg>`;
}

export function iconId(kind: "own" | "traffic", cat: WakeCategory): string {
  return `ac-${kind}-${cat}`;
}

function loadOne(map: maplibregl.Map, id: string, markup: string): Promise<void> {
  if (map.hasImage(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image(48, 48);
    img.onload = () => {
      if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });
}

/**
 * Registers all eight symbols (own/traffic × four classes) in the active theme. Idempotent
 * per style; a theme change re-adds them after setStyle. Light themes get the ink-outline
 * variant (yellow alone has too little contrast on paper / light grey).
 */
export async function loadAircraftIcons(map: maplibregl.Map): Promise<void> {
  const cats: WakeCategory[] = ["light", "medium", "heavy", "super"];
  const light = getMapTheme().scheme === "light";
  await Promise.all([
    ...cats.map((c) => loadOne(map, iconId("own", c), svg(SHAPES[c], COLOR.ownAircraft, COLOR.aircraftEdge, light ? 1.5 : 1.6))),
    ...cats.map((c) => loadOne(map, iconId("traffic", c), svg(SHAPES[c], TRAFFIC, light ? COLOR.aircraftEdge : COLOR.halo, light ? 1.2 : 1.4))),
  ]);
}

/**
 * Zoom-dependent icon size × per-class factor. A "zoom" expression must be the top-level
 * interpolate in MapLibre, so the factor goes into every stop instead of around it.
 */
export function iconSizeByZoom(stops: Array<[number, number]>): maplibregl.ExpressionSpecification {
  const factor: maplibregl.ExpressionSpecification = ["coalesce", ["get", "sizeFactor"], 1.3];
  return ["interpolate", ["linear"], ["zoom"], ...stops.flatMap(([z, v]) => [z, ["*", factor, v]])] as unknown as maplibregl.ExpressionSpecification;
}

/** MapLibre expression: icon size = base × per-class factor stored on the feature. */
export function iconSizeExpr(base: maplibregl.ExpressionSpecification | number): maplibregl.ExpressionSpecification {
  return ["*", ["coalesce", ["get", "sizeFactor"], 1.3], base];
}
