import { afterEach, describe, expect, it } from "vitest";
import { setLanguageSetting, t } from "../i18n";
import type { RouteResolution } from "../types";
import { routeStatusLine } from "./TrafficCard";

const res = (over: Partial<RouteResolution>): RouteResolution => ({
  points: [],
  unresolved: [],
  total: 18,
  resolvedCount: 14,
  enroute: 12,
  airwaysExpanded: 2,
  sources: ["msfs", "xplane", "airport"],
  ...over,
});

describe("route status line", () => {
  afterEach(() => setLanguageSetting("system"));

  it("counts waypoints and names the sources in both languages", () => {
    setLanguageSetting("de");
    expect(routeStatusLine({ status: "done", res: res({ unresolved: ["ABCDE", "XYZ"] }) }, t)).toEqual({
      text: "14 von 18 Wegpunkten aufgelöst · MSFS, X-Plane",
      title: "Nicht gefunden: ABCDE XYZ",
    });
    expect(routeStatusLine({ status: "done", res: res({ enroute: 0 }) }, t).text).toBe("keine Navigationsdaten – Großkreis");
    setLanguageSetting("en");
    expect(routeStatusLine({ status: "done", res: res({}) }, t)).toEqual({ text: "14 of 18 waypoints resolved · MSFS, X-Plane", title: undefined });
    expect(routeStatusLine({ status: "done", res: res({ sources: ["airport", "coord"] }) }, t).text).toBe("14 of 18 waypoints resolved");
    expect(routeStatusLine({ status: "failed" }, t).text).toBe("no navigation data – great circle");
    expect(routeStatusLine({ status: "resolving" }, t).text).toBe("Resolving route …");
  });
});
