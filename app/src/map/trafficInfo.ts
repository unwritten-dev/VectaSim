// Pure helpers for the traffic card (TrafficCard.tsx): what a selected online pilot is
// (registration, airline, type in words), where it is relative to the own aircraft, and how
// the selection survives feed updates (key = network + CID, "nicht mehr online" after it left).

import type { Network, Pilot } from "../types";
import { getLanguage, tIn, type Language } from "../i18n";

// ---- selection --------------------------------------------------------------------------

export interface TrafficRef {
  network: Network;
  cid: number;
}

/** Stable identity of an online pilot: CIDs are only unique per network. */
export function trafficKey(r: TrafficRef): string {
  return `${r.network}:${r.cid}`;
}

export function sameTraffic(a: TrafficRef | null | undefined, b: TrafficRef | null | undefined): boolean {
  return !!a && !!b && a.network === b.network && a.cid === b.cid;
}

/** One feed position of the selected pilot (for the V/S trend). */
export interface TrackSample {
  atMs: number;
  altitudeFt: number;
  lat: number;
  lon: number;
}

export interface TrafficSelection extends TrafficRef {
  /** Last known state (kept while the pilot is gone, so the card can still say who it was). */
  pilot: Pilot | null;
  prev: TrackSample | null;
  last: TrackSample | null;
  /** When the pilot was first missing from the feed; null while online. */
  goneSinceMs: number | null;
}

/** The card closes this long after its pilot left the feed. */
export const GONE_CLOSE_MS = 30_000;

export function selectTraffic(ref: TrafficRef, pilot: Pilot | null = null): TrafficSelection {
  const s: TrafficSelection = { network: ref.network, cid: ref.cid, pilot: null, prev: null, last: null, goneSinceMs: null };
  return pilot ? applyFeedUpdate(s, pilot, Date.now()) : s;
}

/** The selected pilot in a feed list (same network and CID), else null. */
export function findTraffic(list: readonly Pilot[], ref: TrafficRef): Pilot | null {
  return list.find((p) => (p.network ?? "vatsim") === ref.network && p.cid === ref.cid) ?? null;
}

/**
 * Next selection state after a feed update: `found` is the pilot as the feed has it now (null =
 * not in the feed any more). A new position (moved or climbed) becomes the latest sample and the
 * previous one is kept for the trend; an unchanged repeat (the other network polled) is ignored.
 * Detail fields the update lacks (name, remarks from `online_pilot`) are kept from before.
 */
export function applyFeedUpdate(sel: TrafficSelection, found: Pilot | null, atMs: number): TrafficSelection {
  if (!found) return sel.goneSinceMs != null ? sel : { ...sel, goneSinceMs: atMs };
  const pilot: Pilot = sel.pilot
    ? { ...found, name: found.name ?? sel.pilot.name, remarks: found.remarks ?? sel.pilot.remarks }
    : found;
  const sample: TrackSample = { atMs, altitudeFt: found.altitudeFt, lat: found.latitude, lon: found.longitude };
  const moved = !sel.last || sel.last.altitudeFt !== sample.altitudeFt || sel.last.lat !== sample.lat || sel.last.lon !== sample.lon;
  return {
    ...sel,
    pilot,
    goneSinceMs: null,
    prev: moved && sel.last && atMs > sel.last.atMs ? sel.last : sel.prev,
    last: moved ? sample : sel.last,
  };
}

export function shouldClose(sel: TrafficSelection, nowMs: number): boolean {
  return sel.goneSinceMs != null && nowMs - sel.goneSinceMs >= GONE_CLOSE_MS;
}

/** Vertical speed between the last two feed positions (ft/min); null without two usable ones. */
export function verticalSpeedFpm(sel: Pick<TrafficSelection, "prev" | "last">): number | null {
  const { prev, last } = sel;
  if (!prev || !last) return null;
  const dt = last.atMs - prev.atMs;
  // feeds update every ~15 s; a gap of minutes says nothing about now
  if (dt < 5_000 || dt > 120_000) return null;
  return ((last.altitudeFt - prev.altitudeFt) / dt) * 60_000;
}

/** "steigt" / "sinkt" / "hält Höhe" from a V/S (±200 ft/min dead band); null without one. */
export function trendOf(fpm: number | null): "climb" | "descent" | "level" | null {
  if (fpm == null || !Number.isFinite(fpm)) return null;
  return fpm >= 200 ? "climb" : fpm <= -200 ? "descent" : "level";
}

// ---- registration -----------------------------------------------------------------------

/**
 * Nationality prefixes written with a dash ("D-AIZB", "OE-LBA", "9H-QAA"). Remarks usually carry
 * the registration without it (REG/DAIZB), Planespotters lists it with it. Longest match wins.
 */
const DASH_PREFIXES = new Set(
  (
    "A4O A9C " +
    "2 B C D F G I M " +
    "3B 4K 4L 4O 4R 4X 5A 5B 5H 5N 5X 5Y 6Y 7T 9A 9G 9H 9J 9K 9M 9N 9V " +
    "A2 A3 A5 A6 A7 AP C2 C3 C5 C6 C9 CC CN CP CS CU CX D2 D4 D6 DQ E3 E5 E7 EC EI EJ EK EP ER ES ET EW EX EY EZ " +
    "HA HB HC HH HI HK HP HR HS HZ J2 J3 J5 J6 J7 J8 JU JY LN LQ LV LX LY LZ OB OD OE OH OK OM OO OY P2 P4 PH PJ PK PP PR PS PT PU PZ " +
    "RA RF RP S2 S5 S7 S9 SE SP ST SU SX T7 T9 TC TF TG TI TJ TL TN TR TS TT TU TY TZ UK UN UP UR V2 V3 V4 V5 V6 V7 V8 VH VN VP VQ VT " +
    "XA XB XC XT XU XY YA YI YJ YK YL YN YR YS YU YV Z3 ZA ZK ZP ZS"
  ).split(" "),
);

/** "DAIZB" → "D-AIZB", "oelba" → "OE-LBA", "N123AB", "JA8089", "D-AIZB" stay; null if not one. */
export function formatRegistration(raw: string | null | undefined): string | null {
  const r = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,10}$/.test(r) || !/[A-Z]/.test(r) || r.startsWith("-") || r.endsWith("-") || r.includes("--")) return null;
  if (r.includes("-")) return r;
  // USA (N12345), Japan (JA8089), Korea (HL7781) write theirs without a dash
  if (/^N[1-9]/.test(r) || /^(JA|HL)\d/.test(r)) return r;
  for (const len of [3, 2, 1]) {
    const head = r.slice(0, len);
    if (DASH_PREFIXES.has(head) && r.length - len >= 2) return `${head}-${r.slice(len)}`;
  }
  return r;
}

/** Registration from the flight-plan remarks (field 18 "REG/DAIZB", VATSIM and IVAO convention). */
export function registrationFromRemarks(remarks: string | null | undefined): string | null {
  const m = /(?:^|[\s/])REG\/([A-Z0-9-]{3,10})(?=$|[\s/])/i.exec(remarks ?? "");
  return m ? formatRegistration(m[1]) : null;
}

/**
 * Registration used as callsign (typical for GA: "DEABC", "N123AB", "GBXYZ"). Only the shapes that
 * cannot be an airline callsign (those carry digits after a three-letter code).
 */
export function registrationFromCallsign(callsign: string | null | undefined): string | null {
  const c = (callsign ?? "").trim().toUpperCase();
  if (/^N[1-9]\d{0,4}[A-Z]{0,2}$/.test(c)) return c;
  if (/^[DFG]-?[A-Z]{4}$/.test(c) || /^(OE|HB|OO|PH|OY|OH|SE|LN|EI|OK|SP)-?[A-Z]{3}$/.test(c) || /^C-?[FGI][A-Z]{3}$/.test(c)) return formatRegistration(c);
  return null;
}

export function trafficRegistration(p: Pick<Pilot, "remarks" | "callsign">): string | null {
  return registrationFromRemarks(p.remarks) ?? registrationFromCallsign(p.callsign);
}

// ---- airline and type -------------------------------------------------------------------

/** ICAO airline designators common on the networks (and in real life over Europe). */
const AIRLINES: Record<string, string> = {
  AAL: "American Airlines", ACA: "Air Canada", AEA: "Air Europa", AEE: "Aegean Airlines", AFL: "Aeroflot", AFR: "Air France",
  AIC: "Air India", ANA: "All Nippon Airways", ANZ: "Air New Zealand", ASA: "Alaska Airlines", AUA: "Austrian Airlines",
  AZA: "ITA Airways", ITY: "ITA Airways", BAW: "British Airways", BCS: "European Air Transport", BEL: "Brussels Airlines",
  BOX: "AeroLogic", BTI: "airBaltic", CAL: "China Airlines", CCA: "Air China", CES: "China Eastern", CFG: "Condor",
  CLH: "Lufthansa CityLine", CLX: "Cargolux", CPA: "Cathay Pacific", CSN: "China Southern", CSA: "Czech Airlines",
  CTN: "Croatia Airlines", DAL: "Delta Air Lines", DLA: "Air Dolomiti", DLH: "Lufthansa", EIN: "Aer Lingus", EJU: "easyJet Europe",
  EWG: "Eurowings", EXS: "Jet2", EZS: "easyJet Switzerland", EZY: "easyJet", ETD: "Etihad Airways", ETH: "Ethiopian Airlines",
  EVA: "EVA Air", FDX: "FedEx", FIN: "Finnair", GEC: "Lufthansa Cargo", GTI: "Atlas Air", GWI: "Germanwings", IBE: "Iberia",
  IBK: "Norwegian Air International", ICE: "Icelandair", JAL: "Japan Airlines", JBU: "JetBlue", JZA: "Jazz", KAL: "Korean Air",
  KLM: "KLM", LOT: "LOT Polish Airlines", MSR: "EgyptAir", NAX: "Norwegian", NOZ: "Norwegian", NJE: "NetJets Europe",
  NKS: "Spirit Airlines", OAW: "Helvetic Airways", PGT: "Pegasus Airlines", QFA: "Qantas", QTR: "Qatar Airways", RAM: "Royal Air Maroc",
  RYR: "Ryanair", RUK: "Ryanair UK", SAS: "Scandinavian Airlines", SIA: "Singapore Airlines", SKW: "SkyWest", SVA: "Saudia",
  SWA: "Southwest Airlines", SWR: "Swiss", SXS: "SunExpress", TAP: "TAP Air Portugal", THA: "Thai Airways", THY: "Turkish Airlines",
  TOM: "TUI Airways", TRA: "Transavia", TVF: "Transavia France", TUI: "TUIfly", UAE: "Emirates", UAL: "United Airlines",
  UPS: "UPS Airlines", VIR: "Virgin Atlantic", VLG: "Vueling", VOE: "Volotea", WJA: "WestJet", WZZ: "Wizz Air", WUK: "Wizz Air UK",
  WMT: "Wizz Air Malta", ENT: "Enter Air", LGL: "Luxair", AHO: "Air Hamburg", DCS: "DC Aviation", MBU: "Marabu",
  OCN: "Discover Airlines", BER: "Air Berlin", ADR: "Adria Airways", ROT: "TAROM", BUC: "Bulgarian Air Charter", LZB: "Bulgaria Air",
  ELY: "El Al", KQA: "Kenya Airways", SAA: "South African Airways", TAM: "LATAM Brasil", LAN: "LATAM", AVA: "Avianca",
  AMX: "Aeroméxico", VOI: "Volaris", CMP: "Copa Airlines", GLO: "GOL", AZU: "Azul", QXE: "Horizon Air", ENY: "Envoy Air",
  RPA: "Republic Airways", FFT: "Frontier Airlines", HAL: "Hawaiian Airlines", AAY: "Allegiant Air", JST: "Jetstar", VOZ: "Virgin Australia",
  IGO: "IndiGo", AXB: "Air India Express", PAL: "Philippine Airlines", GIA: "Garuda Indonesia", MAS: "Malaysia Airlines",
  HVN: "Vietnam Airlines", ABL: "Air Busan", OMA: "Oman Air", GFA: "Gulf Air", KAC: "Kuwait Airways", RJA: "Royal Jordanian",
  MEA: "Middle East Airlines", FDB: "flydubai", ABY: "Air Arabia", SVR: "Ural Airlines", SBI: "S7 Airlines",
};

/** Airline of an airline-style callsign ("DLH4AB" → DLH Lufthansa); null for GA/registration callsigns. */
export function airlineFromCallsign(callsign: string | null | undefined): { icao: string; name: string | null } | null {
  const m = /^([A-Z]{3})\d[A-Z0-9]{0,4}$/.exec((callsign ?? "").trim().toUpperCase());
  if (!m) return null;
  return { icao: m[1], name: AIRLINES[m[1]] || null };
}

/** ICAO type designators → name, the common ones on the networks. */
const TYPES: Record<string, string> = {
  A19N: "Airbus A319neo", A20N: "Airbus A320neo", A21N: "Airbus A321neo", A318: "Airbus A318", A319: "Airbus A319", A320: "Airbus A320",
  A321: "Airbus A321", A306: "Airbus A300-600", A310: "Airbus A310", A332: "Airbus A330-200", A333: "Airbus A330-300",
  A338: "Airbus A330-800neo", A339: "Airbus A330-900neo", A343: "Airbus A340-300", A346: "Airbus A340-600", A359: "Airbus A350-900",
  A35K: "Airbus A350-1000", A388: "Airbus A380-800", BCS1: "Airbus A220-100", BCS3: "Airbus A220-300",
  B712: "Boeing 717", B732: "Boeing 737-200", B733: "Boeing 737-300", B734: "Boeing 737-400", B735: "Boeing 737-500", B736: "Boeing 737-600",
  B737: "Boeing 737-700", B738: "Boeing 737-800", B739: "Boeing 737-900", B37M: "Boeing 737 MAX 7", B38M: "Boeing 737 MAX 8",
  B39M: "Boeing 737 MAX 9", B3XM: "Boeing 737 MAX 10", B744: "Boeing 747-400", B748: "Boeing 747-8", B74F: "Boeing 747 Freighter",
  B752: "Boeing 757-200", B753: "Boeing 757-300", B762: "Boeing 767-200", B763: "Boeing 767-300", B764: "Boeing 767-400",
  B772: "Boeing 777-200", B77L: "Boeing 777-200LR", B773: "Boeing 777-300", B77W: "Boeing 777-300ER", B778: "Boeing 777-8",
  B779: "Boeing 777-9", B788: "Boeing 787-8", B789: "Boeing 787-9", B78X: "Boeing 787-10", MD11: "McDonnell Douglas MD-11",
  MD82: "McDonnell Douglas MD-82", MD88: "McDonnell Douglas MD-88", DC10: "McDonnell Douglas DC-10", CONC: "Concorde",
  CRJ2: "Bombardier CRJ200", CRJ7: "Bombardier CRJ700", CRJ9: "Bombardier CRJ900", CRJX: "Bombardier CRJ1000",
  E170: "Embraer E170", E175: "Embraer E175", E190: "Embraer E190", E195: "Embraer E195", E290: "Embraer E190-E2", E295: "Embraer E195-E2",
  E145: "Embraer ERJ-145", AT45: "ATR 42-500", AT72: "ATR 72", AT76: "ATR 72-600", DH8D: "De Havilland Dash 8-400",
  DH8A: "De Havilland Dash 8-100", F70: "Fokker 70", F100: "Fokker 100", B461: "BAe 146-100", RJ85: "Avro RJ85",
  C172: "Cessna 172 Skyhawk", C152: "Cessna 152", C182: "Cessna 182", C208: "Cessna 208 Caravan", C25A: "Cessna Citation CJ2",
  C25C: "Cessna Citation CJ4", C68A: "Cessna Citation Latitude", C700: "Cessna Citation Longitude", C750: "Cessna Citation X",
  PC12: "Pilatus PC-12", PC24: "Pilatus PC-24", PC6: "Pilatus PC-6 Porter", TBM9: "Daher TBM 900", TBM8: "Daher TBM 850",
  SR22: "Cirrus SR22", SF50: "Cirrus Vision Jet", DA40: "Diamond DA40", DA42: "Diamond DA42", DA62: "Diamond DA62",
  P28A: "Piper PA-28", PA34: "Piper Seneca", BE36: "Beechcraft Bonanza", BE58: "Beechcraft Baron", BE9L: "Beechcraft King Air 90",
  B350: "Beechcraft King Air 350", GLF5: "Gulfstream G550", GLF6: "Gulfstream G650", GL7T: "Bombardier Global 7500",
  CL35: "Bombardier Challenger 350", LJ45: "Learjet 45", H25B: "Hawker 800", DHC6: "De Havilland Twin Otter", DHC2: "De Havilland Beaver",
  J3: "Piper J-3 Cub", A400: "Airbus A400M", C130: "Lockheed C-130 Hercules", C17: "Boeing C-17 Globemaster III",
  F16: "General Dynamics F-16", F18: "Boeing F/A-18", EUFI: "Eurofighter Typhoon", A10: "Fairchild A-10", B52: "Boeing B-52",
  EC35: "Airbus H135", EC45: "Airbus H145", H160: "Airbus H160", B06: "Bell 206", R44: "Robinson R44", AS50: "Airbus H125",
};

/** "A20N" → "Airbus A320neo"; the feed's own model (IVAO) when the table has no entry; else null. */
export function aircraftTypeName(icao: string | null | undefined, model?: string | null): string | null {
  const t = (icao ?? "").trim().toUpperCase();
  const name = TYPES[t];
  if (name) return name;
  const m = (model ?? "").trim();
  return m && m.toUpperCase() !== t ? m : null;
}

// ---- flight plan ------------------------------------------------------------------------

export function flightRulesLabel(rules: string | null | undefined): string | null {
  switch ((rules ?? "").trim().toUpperCase()) {
    case "I":
      return "IFR";
    case "V":
      return "VFR";
    case "Y":
      return "IFR → VFR";
    case "Z":
      return "VFR → IFR";
    case "":
      return null;
    default:
      return rules!.trim().toUpperCase();
  }
}

/**
 * Filed cruise level as feet for the shared altitude formatter, or a word: VATSIM "36000" or
 * "FL360", IVAO "F340" (flight level), "A045" (hundreds of feet), "VFR". Metric levels stay text.
 */
export function plannedAltitude(raw: string | null | undefined): { ft: number } | { text: string } | null {
  const r = (raw ?? "").trim().toUpperCase();
  if (!r || r === "0") return null;
  let m = /^(?:FL|F)(\d{2,3})$/.exec(r);
  if (m) return { ft: Number(m[1]) * 100 };
  m = /^A(\d{2,3})$/.exec(r);
  if (m) return { ft: Number(m[1]) * 100 };
  if (/^\d{3,5}$/.test(r)) {
    const n = Number(r);
    // some pilots file "350" for FL350
    return { ft: n < 1000 ? n * 100 : n };
  }
  return { text: r };
}

// ---- geometry ---------------------------------------------------------------------------

const R = Math.PI / 180;

/** Initial great-circle course from a to b, degrees true 0–360. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * R;
  const p2 = lat2 * R;
  const dl = (lon2 - lon1) * R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / R) % 360 + 360) % 360;
}

/** 16-point compass word for a bearing in the UI language ("NO"/"NE", "SSW"); the points are one resource string. */
export function compassPoint(deg: number, lang: Language = getLanguage()): string {
  const points = tIn(lang, "map.trafficCard.compass").split(" ");
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Distance (nm) and bearing from the own aircraft to the traffic. */
export function distanceBearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): { nm: number; deg: number } {
  const dp = (to.lat - from.lat) * R;
  const dl = (to.lon - from.lon) * R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(from.lat * R) * Math.cos(to.lat * R) * Math.sin(dl / 2) ** 2;
  const nm = 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
  return { nm, deg: bearingDeg(from.lat, from.lon, to.lat, to.lon) };
}

/**
 * Great circle a → b as `n + 1` [lon, lat] points; longitudes are unwrapped (may leave ±180) so
 * the line crosses the antimeridian without jumping across the map.
 */
export function greatCircle(a: { lat: number; lon: number }, b: { lat: number; lon: number }, n = 64): Array<[number, number]> {
  const p1 = a.lat * R;
  const l1 = a.lon * R;
  const p2 = b.lat * R;
  const l2 = b.lon * R;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!(d > 1e-9)) return [[a.lon, a.lat], [b.lon, b.lat]];
  // antipodes: every great circle joins them (sin d = 0 gave NaN) – take the one a hair off b
  if (Math.PI - d < 1e-6) return greatCircle(a, { lat: b.lat + (b.lat > 0 ? -1e-3 : 1e-3), lon: b.lon }, n);
  const out: Array<[number, number]> = [];
  let prevLon: number | null = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / R;
    let lon = Math.atan2(y, x) / R;
    if (prevLon != null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    } else {
      lon = a.lon;
    }
    prevLon = lon;
    out.push([lon, lat]);
  }
  return out;
}

// ---- selecting from outside the map -----------------------------------------------------

/** Window event the live map listens to: select that aircraft, centre it, open its card. */
export const SELECT_TRAFFIC_EVENT = "vectasim:select-traffic";

export interface SelectTrafficDetail {
  pilot: Pilot;
}

/** Select an online aircraft on the live map (Dispatch panel's online list). */
export function selectTrafficOnMap(pilot: Pilot) {
  window.dispatchEvent(new CustomEvent<SelectTrafficDetail>(SELECT_TRAFFIC_EVENT, { detail: { pilot } }));
}
