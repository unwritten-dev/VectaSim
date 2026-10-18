import { describe, expect, it } from "vitest";
import { localOffsetSpans, mergeColumns } from "./CsvImport";

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
