import { describe, expect, it } from "vitest";
import { lonExtent, pointsBounds, queryBox, unwrapLon, unwrapPath, viewBbox, wrapLon } from "./geo";

describe("wrapLon / unwrapLon", () => {
  it("wraps into [-180, 180)", () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(540)).toBe(-180);
    expect(wrapLon(8.5)).toBe(8.5);
  });

  it("unwraps against a reference across ±180", () => {
    expect(unwrapLon(-179.9, 179.9)).toBeCloseTo(180.1, 9);
    expect(unwrapLon(179.9, -179.9)).toBeCloseTo(-180.1, 9);
    expect(unwrapLon(10, 12)).toBe(10);
  });

  it("unwrapPath keeps a Pacific track continuous", () => {
    const p = unwrapPath([
      [178, 35],
      [179.5, 36],
      [-179.5, 37],
      [-178, 38],
    ]);
    expect(p.map((c) => c[0])).toEqual([178, 179.5, 180.5, 182]);
  });
});

describe("queryBox / viewBbox", () => {
  it("wraps a view across the antimeridian into min > max", () => {
    expect(queryBox({ west: 170, south: 30, east: 190, north: 40 })).toEqual({ minLon: 170, minLat: 30, maxLon: -170, maxLat: 40 });
  });

  it("is the whole world when wider than a turn, and clamps latitudes", () => {
    expect(queryBox({ west: -300, south: -95, east: 200, north: 95 })).toEqual({ minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 });
  });

  it("reads MapLibre bounds", () => {
    const bounds = { getWest: () => -190, getEast: () => -170, getSouth: () => 10, getNorth: () => 20 };
    expect(viewBbox({ getBounds: () => bounds })).toEqual({ minLon: 170, minLat: 10, maxLon: -170, maxLat: 20 });
  });
});

describe("lonExtent / pointsBounds", () => {
  it("takes the short way across ±180 (Pacific flight)", () => {
    const e = lonExtent([139.8, 160, 179.9, -179.9, -150, -122.4])!;
    expect(e[0]).toBe(139.8);
    expect(e[1]).toBeCloseTo(237.6, 9);
  });

  it("stays a normal box when the track does not cross", () => {
    expect(lonExtent([8.5, -0.4, 13.3])).toEqual([-0.4, 13.3]);
    expect(lonExtent([])).toBeNull();
  });

  it("bounds of a synthetic NRT → SFO track span ~98°, not the world", () => {
    const track: Array<[number, number]> = [];
    for (let i = 0; i <= 100; i++) track.push([wrapLon(140.4 + (237.6 - 140.4) * (i / 100)), 35.8 + (37.6 - 35.8) * (i / 100)]);
    const b = pointsBounds(track)!;
    expect(b[0][0]).toBeCloseTo(140.4, 6);
    expect(b[1][0]).toBeCloseTo(237.6, 6);
    expect(b[1][0] - b[0][0]).toBeLessThan(100);
    expect(b[0][1]).toBeCloseTo(35.8, 6);
    expect(b[1][1]).toBeCloseTo(37.6, 6);
  });
});
