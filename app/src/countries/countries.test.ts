import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguageSetting } from "../i18n";
import {
  NO_FILTER,
  globeZoomFor,
  buildRows,
  continentLabel,
  continentProgress,
  countryName,
  exportFileName,
  filterRows,
  fold,
  geometryBounds,
  landingsLabel,
  otherCountryName,
  progressLabel,
  progressOf,
  visitSummary,
  type Country,
  type CountryVisit,
} from "./countries.ts";

const C = (iso2: string, continent: Country["continent"], nameDe: string, nameEn: string): Country => ({ iso2, continent, nameDe, nameEn });
const LIST: Country[] = [
  C("AT", "EU", "Österreich", "Austria"),
  C("DE", "EU", "Deutschland", "Germany"),
  C("FR", "EU", "Frankreich", "France"),
  C("JP", "AS", "Japan", "Japan"),
  C("US", "NA", "Vereinigte Staaten", "United States"),
  C("CW", "NA", "Curaçao", "Curaçao"),
];
const V = (iso2: string, landings: number, firstMs: number, lastMs: number): CountryVisit => ({ iso2, landings, firstMs, lastMs, airports: [], flightIds: [] });
const VISITS = [V("DE", 3, 100, 900), V("US", 1, 500, 500), V("ZZ", 2, 1, 2)];

// texts are pinned to German; the English cases switch explicitly
beforeEach(() => setLanguageSetting("de"));
afterEach(() => setLanguageSetting("de"));

describe("buildRows", () => {
  it("joins visits to the list, sorted by German name, unknown codes dropped", () => {
    const rows = buildRows(LIST, VISITS);
    expect(rows.map((r) => r.country.iso2)).toEqual(["CW", "DE", "FR", "JP", "AT", "US"]);
    expect(rows.find((r) => r.country.iso2 === "DE")?.visit?.landings).toBe(3);
    expect(rows.find((r) => r.country.iso2 === "FR")?.visit).toBeNull();
    expect(rows).toHaveLength(LIST.length);
  });
});

describe("progress", () => {
  it("counts visited countries against the whole list", () => {
    const p = progressOf(buildRows(LIST, VISITS));
    expect(p).toEqual({ visited: 2, total: 6, percent: 33.3 });
    expect(progressLabel(p)).toBe("2 / 6");
    expect(progressOf([])).toEqual({ visited: 0, total: 0, percent: 0 });
  });

  it("per continent", () => {
    const m = continentProgress(buildRows(LIST, VISITS));
    expect(m.get("EU")).toEqual({ visited: 1, total: 3, percent: 33.3 });
    expect(m.get("NA")).toEqual({ visited: 1, total: 2, percent: 50 });
    expect(m.get("AS")?.visited).toBe(0);
    expect(m.get("AN")).toEqual({ visited: 0, total: 0, percent: 0 });
  });
});

describe("filterRows", () => {
  const rows = buildRows(LIST, VISITS);
  const codes = (f: Partial<typeof NO_FILTER>) => filterRows(rows, { ...NO_FILTER, ...f }).map((r) => r.country.iso2);

  it("by continent", () => {
    expect(codes({ continent: "EU" })).toEqual(["DE", "FR", "AT"]);
    expect(codes({ continent: "AN" })).toEqual([]);
    expect(codes({})).toHaveLength(6);
  });

  it("by visit state", () => {
    expect(codes({ visit: "visited" })).toEqual(["DE", "US"]);
    expect(codes({ visit: "open", continent: "NA" })).toEqual(["CW"]);
  });

  it("search ignores case and diacritics, matches English names and ISO codes", () => {
    expect(codes({ query: "oster" })).toEqual(["AT"]);
    expect(codes({ query: "curacao" })).toEqual(["CW"]);
    expect(codes({ query: "germany" })).toEqual(["DE"]);
    expect(codes({ query: "us" })).toEqual(["AT", "US"]); // ISO code and "Austria"
    expect(codes({ query: "  " })).toHaveLength(6);
    expect(fold(" Ärmelkanal ")).toBe("armelkanal");
  });
});

describe("helpers", () => {
  it("summary of all visits", () => {
    expect(visitSummary(VISITS.slice(0, 2))).toEqual({ landings: 4, lastMs: 900, lastIso: "DE" });
    expect(visitSummary([])).toEqual({ landings: 0, lastMs: null, lastIso: null });
  });

  it("file name and labels", () => {
    expect(exportFileName(new Date(2026, 9, 8, 23, 30))).toBe("VectaSim_Laender_2026-10-08.png");
    expect(landingsLabel(1)).toBe("1 Landung");
    expect(landingsLabel(4)).toBe("4 Landungen");
  });

  it("English: names, sort order, continents, file name and labels", () => {
    const rows = buildRows(LIST, VISITS, "en");
    expect(rows.map((r) => r.country.iso2)).toEqual(["AT", "CW", "FR", "DE", "JP", "US"]);
    const at = LIST[0];
    expect(countryName(at, "en")).toBe("Austria");
    expect(countryName(at, "de")).toBe("Österreich");
    expect(otherCountryName(at, "en")).toBe("Österreich");
    expect(countryName({ nameDe: "Kosovo", nameEn: "" }, "en")).toBe("Kosovo");
    expect(continentLabel("NA", "en")).toBe("North America");
    expect(continentLabel("NA", "de")).toBe("Nordamerika");
    expect(continentLabel("XX", "en")).toBe("XX");
    expect(exportFileName(new Date(2026, 9, 8, 23, 30), "en")).toBe("VectaSim_Countries_2026-10-08.png");
    expect(landingsLabel(1, "en")).toBe("1 landing");
    expect(landingsLabel(1500, "en")).toBe("1,500 landings");
    setLanguageSetting("en");
    expect(landingsLabel(4)).toBe("4 landings");
  });

  it("bounds of polygons", () => {
    const poly: GeoJSON.Polygon = { type: "Polygon", coordinates: [[[5, 47], [15, 47], [15, 55], [5, 47]]] };
    expect(geometryBounds(poly)).toEqual([[5, 47], [15, 55]]);
    const multi: GeoJSON.MultiPolygon = { type: "MultiPolygon", coordinates: [poly.coordinates, [[[-60, 2], [-50, 2], [-50, 6], [-60, 2]]]] };
    expect(geometryBounds(multi)).toEqual([[-60, 2], [15, 55]]);
    expect(geometryBounds({ type: "Point", coordinates: [1, 2] })).toBeNull();
    expect(geometryBounds(null)).toBeNull();
  });
});

describe("globeZoomFor", () => {
  it("fills ~90 % of the smaller side and stays within 1..3", () => {
    const z = globeZoomFor(960, 750);
    expect((512 * 2 ** z) / Math.PI).toBeCloseTo(0.9 * 750, 0);
    expect(globeZoomFor(100, 100)).toBe(1);
    expect(globeZoomFor(10000, 10000)).toBe(3);
    expect(globeZoomFor(0, 0)).toBe(1.9);
  });
});
