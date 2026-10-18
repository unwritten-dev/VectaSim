import { describe, expect, it } from "vitest";
import { RESUME_MAX_AGE_MS, gapTitle, mergeHint, mergeKey, resumeCandidate } from "./resume";
import type { FlightRow, MergeCandidate, ResumeCandidate } from "./types";

const NOW = Date.UTC(2026, 9, 18, 12, 30);
const MIN = 60_000;

const offer = (over: Partial<ResumeCandidate> = {}): ResumeCandidate => ({
  flightId: "f1",
  dep: "EDDF",
  arr: null,
  offBlockMs: Date.UTC(2026, 9, 18, 12, 4),
  lastMs: NOW - 4 * MIN,
  distanceNm: 1.24,
  altDiffFt: 300,
  ...over,
});

const integrity = { pausedMs: 0, pauseCount: 0, slewDetected: false, timeAccelerationDetected: false, maxSimRate: 1, crashed: false, fuelIncreasedAirborne: false };

function row(over: Partial<FlightRow>): FlightRow {
  return {
    id: "x",
    state: "completed",
    phase: "shutdown",
    createdMs: Date.UTC(2026, 9, 18, 12, 4),
    updatedMs: 0,
    offBlockMs: Date.UTC(2026, 9, 18, 12, 4),
    maxAltMslFt: 0,
    distanceNm: 0,
    aircraft: { title: "", atcModel: "", atcType: "", atcId: "", atcAirline: "", atcFlightNumber: "" },
    hasOfp: false,
    integrity,
    landingCount: 0,
    ...over,
  };
}

describe("resumeCandidate", () => {
  it("asks with route, off-block time (UTC) and how far away", () => {
    const p = resumeCandidate(offer(), { demo: false, nowMs: NOW });
    expect(p?.id).toBe("resume-f1");
    expect(p?.title).toBe("Flug fortsetzen?");
    expect(p?.body).toContain("EDDF → … seit 12:04z");
    expect(p?.body).toContain("1,2");
    expect(p?.body).toContain("neuer Flug");
    const named = resumeCandidate(offer({ callsign: "DLH4AB", arr: "EGLL" }), { demo: false, nowMs: NOW });
    expect(named?.body.startsWith("DLH4AB · EDDF → EGLL")).toBe(true);
  });

  it("stays quiet for demo, answered, stale or broken offers", () => {
    expect(resumeCandidate(offer(), { demo: true, nowMs: NOW })).toBeNull();
    expect(resumeCandidate(offer(), { demo: false, nowMs: NOW, answered: new Set(["f1"]) })).toBeNull();
    expect(resumeCandidate(offer({ lastMs: NOW - RESUME_MAX_AGE_MS - 1 }), { demo: false, nowMs: NOW })).toBeNull();
    expect(resumeCandidate(offer({ flightId: "" }), { demo: false, nowMs: NOW })).toBeNull();
    expect(resumeCandidate(null, { demo: false, nowMs: NOW })).toBeNull();
  });

  it("works without off-block time and departure", () => {
    const p = resumeCandidate(offer({ offBlockMs: null, dep: null }), { demo: false, nowMs: NOW });
    expect(p?.body).toContain("···· → …. ");
    expect(p?.body).not.toContain("seit");
  });
});

describe("merge hint", () => {
  const c: MergeCandidate = {
    first: row({ id: "a", state: "interrupted", depIcao: "EDDF", arrIcao: null, plannedArr: "EGLL" }),
    second: row({ id: "b", depIcao: null, arrIcao: "EGLL" }),
    gapMs: 8 * MIN,
    distanceNm: 0.8,
  };

  it("names both flights, the gap and the offset", () => {
    const h = mergeHint(c);
    expect(h.text).toContain("Fortsetzung von EDDF → EGLL (12:04z)");
    expect(h.text.startsWith("···· → EGLL")).toBe(true);
    expect(h.detail).toContain("8");
    expect(h.detail).toContain("0,8");
    expect(mergeKey(c)).toBe("a>b");
  });
});

describe("gapTitle", () => {
  it("explains an interrupted flight, with the gap to the next one when known", () => {
    const f = row({ state: "interrupted" });
    expect(gapTitle(f)).toMatch(/^Aufzeichnung unterbrochen\. Ohne Abstellen beendet/);
    expect(gapTitle(f, 8 * MIN)).toContain("Nächster Flug folgt nach 8");
  });

  it("names the recording gap of a resumed flight, nothing for a normal one", () => {
    expect(gapTitle(row({}))).toBeNull();
    expect(gapTitle(row({ integrity: { ...integrity, gapMs: 2 * MIN } }))).toMatch(/^Aufzeichnungslücke 2.*fortgesetzt/);
  });
});
