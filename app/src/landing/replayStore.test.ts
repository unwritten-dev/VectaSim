import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguageSetting } from "../i18n";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis } from "./approachTypes";
import { ReplayContext, createReplayStore, debriefReplayPlan, lerpHeading, nearestIndex, sampleAt, timeAtValue, trackBearingAt } from "./replayStore";

// useThemeId is a useSyncExternalStore without a server snapshot
vi.mock("../themes", async (importOriginal) => ({ ...(await importOriginal<typeof import("../themes")>()), useThemeId: () => "default" }));
const { default: ApproachChart } = await import("./ApproachChart");
const { default: ReplayBar, ReplayValues } = await import("./ReplayBar");

// jsdom reports en-US: pin the reference language, also for the plans built while collecting
setLanguageSetting("de");
beforeEach(() => setLanguageSetting("de"));
afterEach(() => setLanguageSetting("de"));

const mock = mockJson as unknown as ApproachAnalysis;
const R = { startMs: 10_000, endMs: 70_000 };
const MARKERS = [
  { key: "td", label: "Aufsetzen", tMs: 60_000 },
  { key: "faf", label: "FAF", tMs: 20_000 },
  { key: "out", label: "außerhalb", tMs: 90_000 },
];

function configured() {
  const s = createReplayStore();
  s.configure(R, MARKERS);
  return s;
}

describe("replayStore", () => {
  it("starts empty and notifies on changes only", () => {
    const s = createReplayStore();
    const l = vi.fn();
    s.subscribe(l);
    expect(s.get()).toMatchObject({ tMs: null, playing: false, speed: 1, range: null, markers: [] });
    s.setCursor(null);
    expect(l).not.toHaveBeenCalled();
    s.setCursor(5);
    expect(l).toHaveBeenCalledTimes(1);
    s.setCursor(5);
    expect(l).toHaveBeenCalledTimes(1);
  });

  it("sorts markers and drops those outside the range", () => {
    const s = configured();
    expect(s.get().markers.map((m) => m.key)).toEqual(["faf", "td"]);
  });

  it("rejects an empty range", () => {
    const s = createReplayStore();
    s.configure({ startMs: 5, endMs: 5 });
    expect(s.get().range).toBeNull();
    s.play();
    expect(s.get().playing).toBe(false);
  });

  it("clamps the cursor into the range", () => {
    const s = configured();
    s.setCursor(0);
    expect(s.get().tMs).toBe(10_000);
    s.setCursor(1e9);
    expect(s.get().tMs).toBe(70_000);
    s.configure({ startMs: 10_000, endMs: 40_000 });
    expect(s.get().tMs).toBe(40_000);
  });

  it("plays from the start without a cursor, and again from the start at the end", () => {
    const s = configured();
    s.play();
    expect(s.get()).toMatchObject({ playing: true, tMs: 10_000 });
    s.toEnd();
    expect(s.get()).toMatchObject({ playing: false, tMs: 70_000 });
    s.play();
    expect(s.get().tMs).toBe(10_000);
  });

  it("advances by real time × speed and stops at the end", () => {
    const s = configured();
    s.setCursor(30_000);
    s.advance(1000);
    expect(s.get().tMs).toBe(30_000); // paused: no movement
    s.setSpeed(4);
    s.play();
    s.advance(1000);
    expect(s.get().tMs).toBe(34_000);
    s.advance(60_000);
    expect(s.get()).toMatchObject({ tMs: 70_000, playing: false });
  });

  it("ignores unknown speeds", () => {
    const s = configured();
    s.setSpeed(3 as 1);
    expect(s.get().speed).toBe(1);
    s.setSpeed(8);
    expect(s.get().speed).toBe(8);
  });

  it("steps ±s, pauses and clamps", () => {
    const s = configured();
    s.step(1);
    expect(s.get().tMs).toBe(11_000); // from the range start
    s.play();
    s.step(-10);
    expect(s.get()).toMatchObject({ tMs: 10_000, playing: false });
    s.step(10);
    s.step(10);
    expect(s.get().tMs).toBe(30_000);
  });

  it("jumps to markers by object or key, keeps playing", () => {
    const s = configured();
    s.jumpTo("faf");
    expect(s.get().tMs).toBe(20_000);
    s.play();
    s.jumpTo(MARKERS[0]);
    expect(s.get()).toMatchObject({ tMs: 60_000, playing: true });
    s.jumpTo("unknown");
    expect(s.get().tMs).toBe(60_000);
    s.jumpTo({ key: "x", label: "x", tMs: 1e12 });
    expect(s.get().tMs).toBe(70_000);
  });

  it("previews on hover and returns to the pinned cursor", () => {
    const s = configured();
    s.setCursor(25_000);
    s.hover(40_000);
    expect(s.get().tMs).toBe(40_000);
    s.hover(null);
    expect(s.get().tMs).toBe(25_000);
    s.play();
    s.hover(50_000);
    expect(s.get().tMs).toBe(25_000); // no preview while playing
  });

  it("toggles and resets", () => {
    const s = configured();
    s.toggle();
    expect(s.get().playing).toBe(true);
    s.toggle();
    expect(s.get().playing).toBe(false);
    s.setSpeed(2);
    s.reset();
    expect(s.get()).toMatchObject({ tMs: null, playing: false, speed: 1, range: null, markers: [] });
    s.hover(null);
    expect(s.get().tMs).toBeNull();
  });

  it("Home/End go to the range edges", () => {
    const s = configured();
    s.toEnd();
    expect(s.get().tMs).toBe(70_000);
    s.toStart();
    expect(s.get().tMs).toBe(10_000);
  });
});

describe("sampleAt", () => {
  const pts = [
    { tMs: 0, h: 100, g: false, n: 1 as number | null, s: "a" },
    { tMs: 1000, h: 80, g: false, n: null as number | null, s: "b" },
    { tMs: 2000, h: 0, g: true, n: 3 as number | null, s: "c" },
  ];

  it("interpolates numbers linearly", () => {
    const p = sampleAt(pts, 250)!;
    expect(p.tMs).toBe(250);
    expect(p.h).toBeCloseTo(95);
    expect(sampleAt(pts, 1500)!.h).toBeCloseTo(40);
  });

  it("takes booleans, strings and nulls from the nearer sample", () => {
    expect(sampleAt(pts, 1400)).toMatchObject({ g: false, s: "b", n: null });
    expect(sampleAt(pts, 1600)).toMatchObject({ g: true, s: "c", n: 3 });
    expect(sampleAt(pts, 400)!.n).toBe(1);
  });

  it("returns exact samples and the edges", () => {
    expect(sampleAt(pts, 1000)).toBe(pts[1]);
    expect(sampleAt(pts, 0)).toBe(pts[0]);
    expect(sampleAt(pts, 2000)).toBe(pts[2]);
  });

  it("is null outside, without samples or without a time", () => {
    expect(sampleAt(pts, -1)).toBeNull();
    expect(sampleAt(pts, 2001)).toBeNull();
    expect(sampleAt([], 0)).toBeNull();
    expect(sampleAt(pts, null)).toBeNull();
    expect(sampleAt(pts, NaN)).toBeNull();
  });

  it("handles a single sample and duplicate times", () => {
    expect(sampleAt([pts[0]], 0)).toBe(pts[0]);
    const dup = [
      { tMs: 0, h: 1 },
      { tMs: 0, h: 2 },
    ];
    expect(sampleAt(dup, 0)!.h).toBe(1);
  });
});

describe("timeAtValue / headings", () => {
  const pts = [
    { tMs: 0, d: 3000 },
    { tMs: 10_000, d: 2000 },
    { tMs: 20_000, d: 1000 },
  ];
  it("inverts a monotonic distance", () => {
    expect(timeAtValue(pts, (s) => s.d, 1500)).toBeCloseTo(15_000);
    expect(timeAtValue(pts, (s) => s.d, 3000)).toBe(0);
  });
  it("falls back to the nearest sample outside", () => {
    expect(timeAtValue(pts, (s) => s.d, 9000)).toBe(0);
    expect(timeAtValue(pts, (s) => s.d, -50)).toBe(20_000);
    expect(timeAtValue([], (s: { tMs: number }) => s.tMs, 1)).toBeNull();
  });
  it("interpolates headings over north", () => {
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpHeading(10, 350, 0.25)).toBeCloseTo(5);
  });
  it("derives a bearing from positions", () => {
    const east = [
      { tMs: 0, latitude: 50, longitude: 8 },
      { tMs: 1000, latitude: 50, longitude: 8.01 },
      { tMs: 2000, latitude: 50, longitude: 8.01 },
    ];
    expect(trackBearingAt(east, 500)).toBeCloseTo(90, 0);
    expect(trackBearingAt(east, 2000)).toBeCloseTo(90, 0); // standing still: the last movement
  });
});

describe("debriefReplayPlan", () => {
  it("spans the approach and lists its markers in time order", () => {
    const { range, markers } = debriefReplayPlan(null, mock);
    expect(range!.startMs).toBe(mock.samples[0].tMs);
    expect(range!.endMs).toBe(mock.samples[mock.samples.length - 1].tMs);
    const keys = markers.map((m) => m.key);
    expect(keys).toContain("gate1000");
    expect(keys).toContain("touchdown");
    expect(keys).not.toContain("tod");
    for (let i = 1; i < markers.length; i++) expect(markers[i].tMs).toBeGreaterThanOrEqual(markers[i - 1].tMs);
  });

  it("has no range without samples", () => {
    expect(debriefReplayPlan(null, null).range).toBeNull();
  });
});

describe("cursor rendering", () => {
  const plan = debriefReplayPlan(null, mock);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const render = (store: ReturnType<typeof createReplayStore>, el: (p: any) => ReactNode, props: object) =>
    renderToStaticMarkup(createElement(ReplayContext.Provider, { value: store }, createElement(el, props)));

  it("draws the cursor and the values only with a cursor time", () => {
    const store = createReplayStore();
    store.configure(plan.range, plan.markers);
    expect(render(store, ApproachChart, { approach: mock })).not.toContain("replay-cursor");
    expect(render(store, ReplayValues, { analysis: null, approach: mock })).toContain("Kein Zeitpunkt");
    store.jumpTo("gate1000");
    const h = render(store, ApproachChart, { approach: mock });
    expect(h).toContain("replay-cursor");
    expect(h).toContain('aria-hidden="true"');
    const v = render(store, ReplayValues, { analysis: null, approach: mock });
    expect(v).toContain("gemessen (1");
    expect(v).not.toContain("NaN");
  });

  it("renders the transport bar with an accessible slider and jump buttons", () => {
    const store = createReplayStore();
    expect(render(store, ReplayBar, {})).toBe(""); // no range, no bar
    store.configure(plan.range, plan.markers);
    store.jumpTo("touchdown");
    const h = render(store, ReplayBar, {});
    expect(h).toContain('type="range"');
    expect(h).toMatch(/aria-valuetext="\d\d:\d\d:\d\dz/);
    expect(h).toContain("Zu Aufsetzen springen");
    expect(h).toContain('aria-label="Wiedergabe starten"');
  });

  it("speaks English with English markers", () => {
    setLanguageSetting("en");
    const enPlan = debriefReplayPlan(null, mock);
    expect(enPlan.markers.find((m) => m.key === "touchdown")?.label).toBe("Touchdown");
    const store = createReplayStore();
    store.configure(enPlan.range, enPlan.markers);
    store.jumpTo("touchdown");
    const h = render(store, ReplayBar, {});
    expect(h).toContain("Jump to Touchdown (");
    expect(h).toContain('aria-label="Start playback"');
    expect(h).toMatch(/aria-valuetext="\d\d:\d\d:\d\dz, [\d:]+ min after start, Touchdown"/);
    const v = render(store, ReplayValues, { analysis: null, approach: mock });
    expect(v).toContain("measured (1");
    expect(v).toContain("Gear / flaps");
  });

  it("nearestIndex skips missing times", () => {
    expect(nearestIndex([null, 10, 30], 25)).toBe(2);
    expect(nearestIndex([null, undefined], 5)).toBeNull();
    expect(nearestIndex([1], null)).toBeNull();
  });
});
