import { describe, expect, it } from "vitest";
import type { TrackSample } from "./types";
import type { ApproachAnalysis, ApproachGate, Exceedance } from "./landing/approachTypes";
import { setLanguageSetting } from "./i18n";
import CONSTANTS from "./trackEvents.constants.json";
import VECTORS from "./fixtures/track-metrics-vectors.json";
import {
  DEFAULT_FILTER,
  AIRBORNE_MIN_S,
  CONFIG_HOLD_S,
  GEAR_THRESHOLD_PCT,
  ROLL_MIN_S,
  ROT_CONT_DEG_S,
  ROT_MIN_GS_KT,
  ROT_START_DEG_S,
  approachEvents,
  flapEvents,
  flightMetrics,
  gateVerdict,
  landingTouchdownIndex,
  gearEvents,
  landingGearDownIndex,
  ROTATION_FAST_DEG_S,
  ROTATION_SLOW_DEG_S,
  parseFilter,
  rotationBand,
  rotationAt,
  rotationEvents,
  trackEventDetail,
  trackEventLabel,
  trackEvents,
} from "./trackEvents";

const T0 = 1_700_000_000_000;

function sample(i: number, p: Partial<TrackSample> = {}): TrackSample {
  return {
    tMs: T0 + i * 1000,
    latitude: 50 + i * 1e-4,
    longitude: 8.5,
    altitudeMslFt: 400,
    altitudeAglFt: 0,
    groundSpeedKt: 0,
    iasKt: 0,
    verticalSpeedFpm: 0,
    headingTrueDeg: 250,
    pitchDeg: 0,
    bankDeg: 0,
    gForce: 1,
    onGround: true,
    flapsIndex: 0,
    gearPct: 100,
    fuelTotalKg: 5000,
    ...p,
  };
}

const track = (n: number, f: (i: number) => Partial<TrackSample>) => Array.from({ length: n }, (_, i) => sample(i, f(i)));

describe("gear events", () => {
  it("finds up and down at the 50 % crossing", () => {
    // 100 % → retracts from i = 10 at 10 %/s → back down from i = 40
    const s = track(60, (i) => ({ gearPct: i < 10 ? 100 : i < 20 ? 100 - (i - 10) * 10 : i < 40 ? 0 : Math.min(100, (i - 40) * 10), onGround: false, altitudeAglFt: 1000 + i, iasKt: 180 }));
    const ev = gearEvents(s);
    expect(ev.map((e) => e.kind)).toEqual(["gearUp", "gearDown"]);
    expect(ev[0].tMs).toBe(T0 + 16_000); // below 50 % from i = 16
    expect(ev[1].tMs).toBe(T0 + 45_000);
    expect(ev[0].aglFt).toBe(1016);
    expect(ev[0].iasKt).toBe(180);
  });

  it("ignores a one-sample glitch", () => {
    const s = track(20, (i) => ({ gearPct: i === 8 ? 0 : 100 }));
    expect(gearEvents(s)).toEqual([]);
  });

  it("landing gear extension: the last gear down after a retraction, else none", () => {
    const s = track(60, (i) => ({ gearPct: i < 10 ? 100 : i < 20 ? 100 - (i - 10) * 10 : i < 40 ? 0 : Math.min(100, (i - 40) * 10) }));
    expect(landingGearDownIndex(s)).toBe(45);
    // fixed gear (never retracted) and gear up without extension: nothing to colour
    expect(landingGearDownIndex(track(30, () => ({ gearPct: 100 })))).toBe(-1);
    expect(landingGearDownIndex(track(30, (i) => ({ gearPct: i < 10 ? 100 : 0 })))).toBe(-1);
    // a go-around cycle: the final extension counts
    const ga = track(100, (i) => ({ gearPct: i < 10 ? 100 : i < 40 ? 0 : i < 60 ? 100 : i < 80 ? 0 : 100 }));
    expect(landingGearDownIndex(ga)).toBe(80);
    expect(landingGearDownIndex([])).toBe(-1);
    // recording started in the air with the gear up (demo flight, resumed flight): the extension counts
    const air = track(30, (i) => ({ gearPct: i < 20 ? 0 : 100 }));
    expect(landingGearDownIndex(air)).toBe(20);
  });
});

describe("flap events", () => {
  it("one event per held stage, with from → to", () => {
    const idx = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3];
    const ev = flapEvents(track(idx.length, (i) => ({ flapsIndex: idx[i] })));
    expect(ev.map((e) => [e.flapsFrom, e.flapsTo])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("skips a stage passed through in under 2 s", () => {
    const idx = [1, 1, 1, 2, 3, 3, 3, 3];
    const ev = flapEvents(track(idx.length, (i) => ({ flapsIndex: idx[i] })));
    expect(ev.map((e) => [e.flapsFrom, e.flapsTo])).toEqual([[1, 3]]);
  });

  it("debounces a flicker back to the old stage", () => {
    const idx = [2, 2, 2, 3, 2, 2, 2];
    expect(flapEvents(track(idx.length, (i) => ({ flapsIndex: idx[i] })))).toEqual([]);
  });
});

/** Take-off roll: accelerating on the ground, pitch from i = R at `rate` °/s, airborne from i = L. */
function takeoff(R: number, L: number, rate: number, n = 60) {
  return track(n, (i) => ({
    groundSpeedKt: Math.min(170, 5 + i * 4),
    iasKt: Math.min(170, 5 + i * 4),
    pitchDeg: i < R ? 0 : Math.min((i - R) * rate, 15),
    onGround: i < L,
    altitudeAglFt: i < L ? 0 : (i - L) * 30,
  }));
}

describe("rotation", () => {
  it("measures the mean pitch rate from rotation start to lift-off", () => {
    const s = takeoff(30, 33, 2.5);
    const ev = rotationEvents(s);
    expect(ev).toHaveLength(1);
    const r = ev[0].rotation!;
    expect(ev[0].tMs).toBe(T0 + 33_000);
    expect(r.startTMs).toBe(T0 + 30_000);
    expect(r.durationS).toBe(3);
    expect(r.rateDegS).toBeCloseTo(2.5);
    expect(r.peakDegS).toBeCloseTo(2.5);
    expect(r.band).toBe("normal");
  });

  it("mean vs peak on an uneven rotation, flags > ROTATION_FAST_DEG_S as fast", () => {
    const pitch = [0, 0, 3, 8, 12];
    const s = track(30, (i) => ({ groundSpeedKt: 150, iasKt: 150, pitchDeg: i < 20 ? 0 : (pitch[i - 20] ?? 12), onGround: i < 24, altitudeAglFt: i < 24 ? 0 : 50 }));
    const r = rotationAt(s, 24)!;
    expect(r.startTMs).toBe(T0 + 21_000);
    expect(r.rateDegS).toBeCloseTo(4); // 12° in 3 s
    expect(r.peakDegS).toBeCloseTo(5);
    expect(r.band).toBe("normal"); // 4 °/s is still inside the band
    const fast = track(30, (i) => ({ groundSpeedKt: 150, pitchDeg: i < 21 ? 0 : (i - 21) * 5, onGround: i < 24 }));
    expect(rotationAt(fast, 24)!.band).toBe("fast");
  });

  it("no rotation for a track that starts airborne", () => {
    const s = track(40, (i) => ({ onGround: false, altitudeAglFt: 2000, pitchDeg: i, groundSpeedKt: 200 }));
    expect(rotationEvents(s)).toEqual([]);
  });

  it("no rotation for a landing bounce", () => {
    // airborne, 3 s on the ground, airborne again for good
    const s = track(40, (i) => ({ onGround: i >= 10 && i < 13, groundSpeedKt: 130, pitchDeg: 3 + (i >= 13 ? 1 : 0), altitudeAglFt: i >= 10 && i < 13 ? 0 : 10 }));
    expect(rotationEvents(s)).toEqual([]);
  });

  it("lift-off without a pitch-up run: event without a rate", () => {
    const s = track(40, (i) => ({ groundSpeedKt: 120, onGround: i < 25, altitudeAglFt: i < 25 ? 0 : (i - 25) * 20 }));
    const ev = rotationEvents(s);
    expect(ev).toHaveLength(1);
    expect(ev[0].rotation).toBeNull();
  });

  it("labels the rate and the duration", () => {
    setLanguageSetting("en");
    const ev = rotationEvents(takeoff(30, 33, 2.6));
    expect(trackEventLabel(ev[0])).toBe("Rotation 2.6 °/s");
    expect(ev[0].tone).toBe("neutral");
    expect(trackEventDetail(ev[0]).join("\n")).toContain("2–3 °/s");
  });

  it("classifies both band edges: slow below 1.5 °/s, fast above 4 °/s (warn tone, labelled)", () => {
    expect(ROTATION_SLOW_DEG_S).toBe(1.5);
    expect(ROTATION_FAST_DEG_S).toBe(4);
    expect(rotationBand(1.49)).toBe("slow");
    expect(rotationBand(1.5)).toBe("normal");
    expect(rotationBand(4)).toBe("normal");
    expect(rotationBand(4.01)).toBe("fast");
    setLanguageSetting("en");
    const slow = rotationEvents(takeoff(28, 33, 1.2))[0];
    expect(slow.rotation!.band).toBe("slow");
    expect(slow.tone).toBe("warn");
    expect(trackEventLabel(slow)).toBe("Rotation 1.2 °/s · slow");
    const fast = rotationEvents(takeoff(31, 33, 5))[0];
    expect(fast.rotation!.band).toBe("fast");
    expect(fast.tone).toBe("warn");
    expect(trackEventLabel(fast)).toBe("Rotation 5.0 °/s · fast");
    setLanguageSetting("de");
    expect(trackEventLabel(slow)).toBe("Rotation 1,2 °/s · langsam");
    expect(trackEventLabel(fast)).toBe("Rotation 5,0 °/s · schnell");
    setLanguageSetting("en");
  });
});

function gate(kind: ApproachGate["kind"], tMs: number, statuses: Array<"pass" | "fail" | "unavailable">): ApproachGate {
  return {
    kind,
    reached: true,
    fafReason: null,
    sample: { tMs, hatFt: kind === "ft1000" ? 1000 : 500, iasKt: 140 } as ApproachGate["sample"],
    criteria: statuses.map((status, i) => ({ kind: i === 0 ? "speed" : "verticalSpeed", status }) as ApproachGate["criteria"][number]),
  };
}

describe("approach events", () => {
  const s = track(200, (i) => ({ onGround: false, altitudeAglFt: 2000 - i * 10, iasKt: 140 }));
  const exc: Exceedance = { kind: "speed", level: "s2", startTMs: T0 + 120_000, endTMs: T0 + 130_000, durationS: 10, startHatFt: 800, endHatFt: 700, peak: 22, limit: 10, below500: false };
  const a = {
    index: 0,
    gates: [gate("tenNm", T0, ["pass"]), gate("ft1000", T0 + 100_000, ["pass", "pass"]), gate("ft500", T0 + 150_000, ["pass", "fail"])],
    exceedances: [exc],
    stability: { stableFromFt: 600 },
    goAround: null,
    endTMs: T0 + 199_000,
    samples: Array.from({ length: 20 }, (_, k) => ({ tMs: T0 + k * 10_000, hatFt: 2000 - k * 100, onGround: false })),
  } as unknown as ApproachAnalysis;

  it("gates 1000/500 with their verdict, exceedance runs, stable from", () => {
    const ev = approachEvents(s, [a]);
    const g = ev.filter((e) => e.kind === "gate");
    expect(g.map((e) => [e.gate!.kind, e.gate!.stable, e.tone])).toEqual([
      ["ft1000", true, "ok"],
      ["ft500", false, "err"],
    ]);
    expect(g[1].gate!.failed).toEqual(["verticalSpeed"]);
    const x = ev.find((e) => e.kind === "exceedance")!;
    expect([x.tMs, x.endTMs, x.tone]).toEqual([T0 + 120_000, T0 + 130_000, "err"]);
    const sf = ev.find((e) => e.kind === "stableFrom")!;
    expect(sf.tMs).toBe(T0 + 140_000); // the profile passes 600 ft at k = 14
  });

  it("everything sorted in time", () => {
    const ev = trackEvents(s, [a], []);
    expect(ev.map((e) => e.tMs)).toEqual([...ev.map((e) => e.tMs)].sort((x, y) => x - y));
  });
});

describe("filter", () => {
  it("defaults and keeps unknown keys out", () => {
    expect(parseFilter(null)).toEqual(DEFAULT_FILTER);
    expect(parseFilter("{bad")).toEqual(DEFAULT_FILTER);
    expect(parseFilter(JSON.stringify({ gear: false, nope: true }))).toEqual({ ...DEFAULT_FILTER, gear: false });
  });
});

describe("flight metrics (shared vectors with the backend)", () => {
  it("the thresholds come from the shared constants file", () => {
    expect([GEAR_THRESHOLD_PCT, CONFIG_HOLD_S, ROT_START_DEG_S, ROT_CONT_DEG_S, ROT_MIN_GS_KT, ROLL_MIN_S, AIRBORNE_MIN_S, ROTATION_SLOW_DEG_S, ROTATION_FAST_DEG_S]).toEqual([
      CONSTANTS.gearThresholdPct,
      CONSTANTS.configHoldS,
      CONSTANTS.rotStartDegS,
      CONSTANTS.rotContDegS,
      CONSTANTS.rotMinGsKt,
      CONSTANTS.rollMinS,
      CONSTANTS.airborneMinS,
      CONSTANTS.rotationSlowDegS,
      CONSTANTS.rotationFastDegS,
    ]);
  });

  for (const c of VECTORS.cases) {
    it(c.name, () => {
      const samples = c.samples.map((r, i) =>
        sample(i, { tMs: r[0], onGround: r[1] === 1, groundSpeedKt: r[2], iasKt: r[2], pitchDeg: r[3], altitudeAglFt: r[4], gearPct: r[5], flapsIndex: r[6], latitude: r[7], longitude: r[8] }),
      );
      const approaches = c.approaches.map((a) => ({ ...a, exceedances: Array.from({ length: a.exceedances }, () => exc0) })) as unknown as ApproachAnalysis[];
      const got = flightMetrics(samples, approaches, c.touchdowns);
      for (const [k, want] of Object.entries(c.expected)) {
        const v = got[k as keyof typeof got];
        if (typeof want === "number") expect(v, k).toBeCloseTo(want, 4);
        else expect(v, k).toBe(want);
      }
    });
  }

  it("landing = last full stop, else the last touchdown", () => {
    expect(landingTouchdownIndex([])).toBeNull();
    expect(landingTouchdownIndex([{ touchAndGo: false }, { touchAndGo: true }])).toBe(0);
    expect(landingTouchdownIndex([{ touchAndGo: true }, { touchAndGo: true }])).toBe(1);
  });

  it("gate verdict: failed, measured, not measurable, not reached", () => {
    expect(gateVerdict({ reached: false, criteria: [] })).toBeNull();
    expect(gateVerdict(gate("ft500", 0, ["pass", "fail"]))).toBe(false);
    expect(gateVerdict(gate("ft500", 0, ["pass", "unavailable"]))).toBe(true);
    expect(gateVerdict(gate("ft500", 0, ["unavailable"]))).toBeNull();
  });
});

const exc0: Exceedance = { kind: "speed", level: "s1", startTMs: 0, endTMs: 0, durationS: 0, startHatFt: 0, endHatFt: 0, peak: 0, limit: 0, below500: false };
