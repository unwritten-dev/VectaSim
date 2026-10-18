import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NNBSP } from "../format";
import mockJson from "./fixtures/approach-mock.json";
import type { ApproachAnalysis } from "./approachTypes";

// useThemeId is a useSyncExternalStore without a server snapshot
vi.mock("../themes", async (importOriginal) => ({ ...(await importOriginal<typeof import("../themes")>()), useThemeId: () => "default" }));

const { default: ApproachChart } = await import("./ApproachChart");
const { rangeDomain } = await import("./ApproachProfile");

const mock = mockJson as unknown as ApproachAnalysis;
const N = (s: string) => s.split(NNBSP).join(" ");

describe("ApproachProfile", () => {
  it("renders the range switch, reference band, markers and the lateral strip", () => {
    const h = N(renderToStaticMarkup(<ApproachChart approach={mock} />));
    for (const r of ["Final (1000 ft)", "10 nm", "ab TOD"]) expect(h).toContain(r);
    expect(h).toContain('aria-checked="true"');
    expect(h).toContain("3°-Pfad (Annahme) ±1 Dot");
    expect(h).toContain("Referenz 128 kt (geflogen)");
    expect(h).toContain(">1000<");
    expect(h).toContain(">Schwelle<");
    expect(h).toContain(">Aufsetzen<");
    expect(h).toContain("Querablage (m) zur verlängerten Mittellinie RWY 25C");
    expect(h).not.toContain("NaN");
  });

  it("sets the domain per range", () => {
    const [finalFar] = rangeDomain(mock, "final");
    const [tenFar] = rangeDomain(mock, "tenNm");
    const [todFar, near] = rangeDomain(mock, "tod");
    const tod = mock.markers.find((m) => m.kind === "tod")!;
    expect(finalFar).toBeLessThan(tenFar);
    expect(tenFar).toBeCloseTo(10.5 * 1852, 0);
    // from half a mile before the top of descent (here a circuit: inside 10 nm)
    expect(todFar).toBeCloseTo(tod.trackDistM + 926, 0);
    expect(near).toBeLessThan(0);
  });

  it("falls back to the landing profile without an approach", () => {
    expect(renderToStaticMarkup(<ApproachChart />)).toContain("Zu wenige Trackpunkte");
  });
});
