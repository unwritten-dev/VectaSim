import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localOffsetSpans, mergeColumns, missingRequired, remembering } from "./CsvImport";
import { setLanguageSetting } from "./i18n";
import type { CsvColumnMapping } from "./types";

const mapping = (columns: CsvColumnMapping["columns"]): CsvColumnMapping => ({
  preset: "generic",
  columns,
  dateFormat: "iso",
  utcOffsetMin: 0,
  localOffsets: [],
  weightUnit: "kg",
  durationUnit: "minutes",
});

beforeEach(() => setLanguageSetting("en"));
afterEach(() => setLanguageSetting("de"));

describe("CSV required fields", () => {
  it("names departure, then arrival, then a date column", () => {
    expect(missingRequired(mapping({}))).toBe("Map the departure airport.");
    expect(missingRequired(mapping({ dep_icao: 0 }))).toBe("Map the arrival airport.");
    expect(missingRequired(mapping({ dep_icao: 0, arr_icao: 1 }))).toBe("Map the date or off-block.");
  });
  it("any of date, off-block, on-block or take-off is enough", () => {
    for (const k of ["date", "off_block", "on_block", "takeoff"] as const) expect(missingRequired(mapping({ dep_icao: 0, arr_icao: 1, [k]: 2 }))).toBeNull();
  });
});

describe("CSV remembered mapping", () => {
  it("stores columns by header name and unmapped fields as empty", () => {
    const r = remembering(mapping({ dep_icao: 0, arr_icao: 1, off_block: 2 }), ["Origin", "Destination", "Out"], "local", true, true);
    expect(r.columns.dep_icao).toBe("Origin");
    expect(r.columns.off_block).toBe("Out");
    expect(r.columns.notes).toBe("");
    expect(r).toMatchObject({ dateFormat: "iso", zone: "local", weightUnit: "kg", durationUnit: "minutes", dedupe: true });
  });
  it("without a header row no column names are remembered", () => {
    expect(remembering(mapping({ dep_icao: 0 }), ["EDDF"], "utc", false, false).columns).toEqual({});
  });
});


describe("CSV import helpers", () => {
  it("remembered columns win by header name, cleared ones stay unmapped, unknown names are ignored", () => {
    const columns = ["Origin", "Destination", "DepartureTime", "Duration"];
    const merged = mergeColumns({ dep_icao: 0, arr_icao: 1, off_block: 2, block_min: 3 }, { off_block: "Duration", block_min: "", notes: "Remarks" }, columns);
    expect(merged).toEqual({ dep_icao: 0, arr_icao: 1, off_block: 3 });
    expect(mergeColumns({ dep_icao: 0 }, undefined, columns)).toEqual({ dep_icao: 0 });
  });

  it("local offset spans follow the PC's zone and are sorted", () => {
    const spans = localOffsetSpans(2020, 2021);
    expect(spans[0].fromMs).toBe(Date.UTC(2020, 0, 1));
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].fromMs).toBeGreaterThan(spans[i - 1].fromMs);
      expect(spans[i].offsetMin).not.toBe(spans[i - 1].offsetMin);
    }
    // every span start has the offset the span names
    for (const s of spans) expect(-new Date(s.fromMs).getTimezoneOffset()).toBe(s.offsetMin);
    const mid = Date.UTC(2020, 6, 1);
    const at = [...spans].reverse().find((s) => s.fromMs <= mid);
    expect(at?.offsetMin).toBe(-new Date(mid).getTimezoneOffset());
  });
});
