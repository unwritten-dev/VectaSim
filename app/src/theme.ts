// Colours for everything that cannot read CSS variables (MapLibre paint properties, SVG
// charts, inline styles), derived from the active theme (themes.ts). getMapTheme() returns
// the current set; the named exports below are the same objects, updated in place on every
// theme change, so code that reads them at draw time always sees the active theme.
// Map code re-adds its layers on `theme:changed` (see map/LiveMap.tsx, map/TrackMap.tsx).

import { OWN_AIRCRAFT, activeTheme, mixHex, subscribeTheme, type ThemeDef } from "./themes";

export interface MapTheme {
  scheme: "dark" | "light";
  color: {
    bg: string;
    bgSidebar: string;
    surface1: string;
    surface2: string;
    surface3: string;
    border: string;
    hairline: string;
    text: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    ok: string;
    warn: string;
    err: string;
    info: string;
    route: string;
    ownAircraft: string;
    /** Outline around the own aircraft (dark halo, ink on light themes). */
    aircraftEdge: string;
    /** Outline around map symbols and lines so they read on the basemap. */
    halo: string;
  };
  trackRamp: Array<[number, string]>;
  airportDot: { large: string; medium: string; small: string; seaplane: string };
  traffic: string;
  facility: { app: string; twr: string; gnd: string; del: string; atis: string };
  category: { VFR: string; MVFR: string; IFR: string; LIFR: string; UNKNOWN: string };
  diagram: {
    aerodrome: string;
    apron: string;
    apronOutline: string;
    pavement: string;
    taxiway: string;
    runway: string;
    runwayEdge: string;
    centreline: string;
    grassRunway: string;
    gate: string;
    runwayLabel: string;
    gateLabel: string;
    designator: string;
  };
  trackMarker: { dep: string; arr: string; touchdown: string };
  profile: { alt: string; gs: string; vs: string; touchdown: string };
}

/** Builds the map colour set of a theme (pure). */
export function mapThemeOf(t: ThemeDef): MapTheme {
  const c = t.colors;
  const m = t.map;
  const light = t.scheme === "light";
  const halo = light ? c.surface1 : c.bg;
  return {
    scheme: t.scheme,
    color: {
      bg: c.bg,
      bgSidebar: c.sidebar,
      surface1: c.surface1,
      surface2: c.surface2,
      surface3: c.surface3,
      border: c.border,
      hairline: c.hairline,
      text: c.text,
      textMuted: c.textMuted,
      textFaint: c.textFaint,
      accent: c.accent,
      ok: c.ok,
      warn: c.warn,
      err: c.err,
      info: c.info,
      route: c.route,
      ownAircraft: OWN_AIRCRAFT,
      aircraftEdge: c.aircraftEdge,
      halo,
    },
    trackRamp: t.ramp.map(([a, col]) => [a, col] as [number, string]),
    airportDot: { large: m.apt, medium: m.aptSmall, small: c.textFaint, seaplane: c.textFaint },
    traffic: c.traffic,
    // ATC by brightness, not by four hues
    facility: { app: c.text, twr: m.apt, gnd: c.textMuted, del: c.textMuted, atis: c.textFaint },
    // METAR category: green / blue / red / deep red – no magenta in any theme
    category: {
      VFR: c.ok,
      MVFR: light ? "#1d63a6" : "#4c8dff",
      IFR: c.err,
      LIFR: light ? "#7d1c24" : "#c2364a",
      UNKNOWN: c.textMuted,
    },
    diagram: {
      aerodrome: mixHex(m.land, c.text, 0.04),
      apron: mixHex(m.land, c.text, light ? 0.1 : 0.12),
      apronOutline: mixHex(m.land, c.text, 0.22),
      pavement: mixHex(m.land, c.text, 0.16),
      taxiway: m.taxiway,
      runway: m.rwy,
      runwayEdge: m.aptSmall,
      centreline: light ? c.surface1 : c.text,
      grassRunway: mixHex(m.park ?? m.land, c.ok, 0.3),
      gate: c.accent,
      runwayLabel: m.apt,
      gateLabel: mixHex(c.accent, c.text, 0.35),
      designator: light ? c.surface1 : "#ffffff",
    },
    trackMarker: { dep: c.text, arr: c.text, touchdown: OWN_AIRCRAFT },
    profile: { alt: c.accent, gs: c.ok, vs: c.textMuted, touchdown: c.text },
  };
}

let current: MapTheme = mapThemeOf(activeTheme());

/** Map/SVG colours of the active theme. */
export function getMapTheme(): MapTheme {
  return current;
}

// Live named exports (same objects, refreshed in place).
export const COLOR = { ...current.color };
export const TRACK_RAMP: Array<[number, string]> = [...current.trackRamp];
export const AIRPORT_DOT = { ...current.airportDot };
export const FACILITY_COLOR = { ...current.facility };
export const CATEGORY_COLOR = { ...current.category };
export const DIAGRAM = { ...current.diagram };
export const TRACK_MARKER = { ...current.trackMarker };
export const PROFILE = { ...current.profile };
/** Other (online) traffic: darker yellow, so it never competes with the own aircraft. */
export let TRAFFIC = current.traffic;

function refresh() {
  current = mapThemeOf(activeTheme());
  Object.assign(COLOR, current.color);
  TRACK_RAMP.splice(0, TRACK_RAMP.length, ...current.trackRamp);
  Object.assign(AIRPORT_DOT, current.airportDot);
  Object.assign(FACILITY_COLOR, current.facility);
  Object.assign(CATEGORY_COLOR, current.category);
  Object.assign(DIAGRAM, current.diagram);
  Object.assign(TRACK_MARKER, current.trackMarker);
  Object.assign(PROFILE, current.profile);
  TRAFFIC = current.traffic;
}
subscribeTheme(refresh);
