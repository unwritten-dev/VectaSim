import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, setLanguageSetting, tIn, type TFunction } from "../i18n";
import { themeCardColors } from "../landing/LandingCard";
import type { FlightRow } from "../types";
import ReviewCard, { cardHasData, visibleCards } from "./ReviewCards";
import { reviewNotes } from "./YearReview";
import { FACTS_WINDOW, buildReview, periodOf } from "./stats";
import { CARDS } from "./text";

const H = 3_600_000;

function flight(i: number, p: Partial<FlightRow> = {}): FlightRow {
  const off = Date.parse("2026-07-01T08:00:00Z") + i * 26 * H;
  return {
    id: `f${i}`,
    state: "completed",
    phase: "parked" as FlightRow["phase"],
    createdMs: off,
    updatedMs: off,
    offBlockMs: off,
    takeoffMs: off + 0.2 * H,
    landingMs: off + 1.8 * H,
    onBlockMs: off + 2 * H,
    depLat: 50.03,
    depLon: 8.57,
    arrLat: 51.47,
    arrLon: -0.46,
    maxAltMslFt: 36000,
    distanceNm: 355,
    aircraft: { title: "Airbus A320neo Lufthansa D-AINA", atcModel: "A20N", atcType: "", atcId: "D-AINA", atcAirline: "DLH", atcFlightNumber: "123" },
    provider: "import:volanta_import",
    depIcao: "EDDF",
    arrIcao: "EGLL",
    hasOfp: false,
    integrity: {} as FlightRow["integrity"],
    landingVsFpm: -160,
    landingCount: 1,
    ...p,
  };
}

const flights = [flight(0), flight(1), flight(2, { provider: "simconnect", landingVsFpm: -212, arrIcao: "LFPG", arrLat: 49.0, arrLon: 2.55, distanceNm: 245 })];
const review = buildReview(
  {
    flights,
    landings: [
      {
        flightId: "f2",
        touchdownIndex: 0,
        timestampMs: flights[2].landingMs as number,
        airportIcao: "LFPG",
        runwayIdent: "26R",
        landingRateFpm: -212,
        landingRateSource: "sim",
        peakG: 1.3,
        bounces: 0,
        touchdownDistanceM: 480,
        centerlineOffsetM: -2,
        inTouchdownZone: true,
        provider: "simconnect",
      },
    ],
    approaches: [],
    visits: [
      { iso2: "GB", landings: 2, firstMs: 0, lastMs: 0, airports: ["EGLL"], flightIds: ["f1", "f0"] },
      { iso2: "FR", landings: 1, firstMs: 0, lastMs: 0, airports: ["LFPG"], flightIds: ["f2"] },
    ],
    showDemo: false,
  },
  periodOf("year", 2026, Date.parse("2026-10-18T12:00:00Z"), false),
);
const colors = themeCardColors();
const outlines: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { iso2: "FR" }, geometry: { type: "Polygon", coordinates: [[[-4, 43], [8, 43], [8, 51], [-4, 51], [-4, 43]]] } }],
};

// texts are pinned to German; the English case uses a provider pin
beforeEach(() => setLanguageSetting("de"));
afterEach(() => setLanguageSetting("de"));

const render = (id: (typeof CARDS)[number]["id"], format: "portrait" | "landscape", hideReg = false) =>
  renderToStaticMarkup(<ReviewCard id={id} format={format} review={review} colors={colors} hideReg={hideReg} outlines={outlines} countryNames={new Map([["FR", "Frankreich"]])} />);

describe("ReviewCard", () => {
  it("overview: year on top, the numbers, the lockup", () => {
    const svg = render("overview", "portrait");
    expect(svg).toContain('width="1080" height="1920"');
    expect(svg).toContain("DEIN JAHR");
    expect(svg).toContain(">2026<");
    expect(svg).toContain("Überblick");
    expect(svg).toContain(">3<"); // flights
    expect(svg).toContain("davon 2 importiert");
    expect(svg).toContain("BLOCKSTUNDEN");
    expect(svg).toContain("Jahresrückblick");
    expect(svg).not.toMatch(/Gradient/i);
    expect(svg).not.toContain("var(--");
  });

  it("routes: top routes, longest flight and the map in landscape", () => {
    const svg = render("routes", "landscape");
    expect(svg).toContain('width="1200" height="675"');
    expect(svg).toContain("EDDF");
    expect(svg).toContain("2 Flüge");
    expect(svg).toContain("dein längster Flug");
    expect(svg).toContain("<path"); // outline + great circles
  });

  it("landings count only the recorded flight; the scatter is drawn", () => {
    const svg = render("landings", "portrait");
    expect(svg).toContain("Median-Landerate");
    expect(svg).toContain("1 Landung");
    expect(svg).toContain("LFPG 26R");
    expect(svg).toContain("Aufsetzzone: 100");
  });

  it("masks registrations in the fleet card", () => {
    expect(render("fleet", "portrait")).toContain("D-AINA");
    const masked = render("fleet", "portrait", true);
    expect(masked).not.toContain("D-AINA");
    expect(masked).toContain("D-••••");
  });

  it("countries highlight the new ones by name", () => {
    const svg = render("countries", "portrait");
    expect(svg).toContain("Länder angeflogen");
    expect(svg).toContain("2 davon zum ersten Mal");
    expect(svg).toContain("Frankreich");
  });

  it("English: your landings card in English with English numbers", () => {
    const svg = renderToStaticMarkup(
      <I18nProvider lang="en">
        <ReviewCard id="landings" format="portrait" review={review} colors={colors} outlines={outlines} countryNames={new Map([["FR", "France"]])} />
      </I18nProvider>,
    );
    expect(svg).toContain("YOUR YEAR");
    expect(svg).toContain("Your landings");
    expect(svg).toContain("median landing rate");
    expect(svg).toContain("1 landing");
    expect(svg).toContain("Smoothest");
    expect(svg).toContain("Touchdown zone: 100");
    expect(svg).toContain("Threshold");
    expect(svg).toContain("Year in review");
    expect(svg).not.toContain("Landung");
    expect(svg).not.toContain("Jahresrückblick");
    const overview = renderToStaticMarkup(
      <I18nProvider lang="en">
        <ReviewCard id="overview" format="landscape" review={review} colors={colors} />
      </I18nProvider>,
    );
    expect(overview).toContain("2 of them imported");
    expect(overview).toContain("BLOCK HOURS");
    expect(overview).toMatch(/times around the Earth|of the way around the Earth/);
  });

  it("every card renders in both formats; empty approaches say why", () => {
    for (const c of CARDS) for (const f of ["portrait", "landscape"] as const) expect(render(c.id, f)).toContain("<svg");
    expect(render("approaches", "portrait")).toContain("importierte Flüge zählen");
    expect(cardHasData("approaches", review)).toBe(false);
    expect(cardHasData("landings", review)).toBe(true);
  });
});

describe("Mit Sternchen (eighth card)", () => {
  const integ = { pausedMs: 0, pauseCount: 0, slewDetected: false, timeAccelerationDetected: false, maxSimRate: 1, crashed: false, fuelIncreasedAirborne: false };
  const recorded = (i: number, p: Partial<FlightRow["integrity"]> = {}) => flight(i, { provider: "simconnect", integrity: { ...integ, ...p } });
  const year = periodOf("year", 2026, Date.parse("2026-10-18T12:00:00Z"), false);
  const flagged = buildReview(
    {
      flights: [recorded(0, { pauseCount: 1, pausedMs: 75 * 60_000 }), recorded(1, { timeAccelerationDetected: true, maxSimRate: 4 }), recorded(2), recorded(3, { slewDetected: true, pauseCount: 1, pausedMs: 60_000 }), flight(4)],
      landings: [],
      approaches: [],
      visits: [],
      showDemo: false,
    },
    year,
  );
  const renderFlags = (format: "portrait" | "landscape", lang?: "en") => {
    const card = <ReviewCard id="flags" format={format} review={flagged} colors={colors} />;
    return renderToStaticMarkup(lang ? <I18nProvider lang={lang}>{card}</I18nProvider> : card);
  };

  it("only appears with flagged flights and then counts as card 8 of 8", () => {
    expect(visibleCards(review)).not.toContain("flags");
    expect(visibleCards(review)).toHaveLength(7);
    expect(cardHasData("flags", review)).toBe(false);
    expect(visibleCards(flagged)).toEqual(["overview", "routes", "fleet", "landings", "approaches", "months", "countries", "flags"]);
    expect(renderFlags("portrait")).toContain("8 / 8");
    expect(render("overview", "portrait")).toContain("1 / 7");
  });

  it("renders the counts per flag, the pause total and the rate", () => {
    const svg = renderFlags("portrait");
    expect(svg).toContain("Mit Sternchen");
    expect(svg).toContain(">3<"); // flights with an asterisk
    expect(svg).toContain("Flüge mit Sternchen");
    expect(svg).toContain("von 4 aufgezeichneten Flügen"); // the import is left out
    expect(svg).toContain("Pause");
    expect(svg).toContain("Zeitraffer");
    expect(svg).toContain("Slew");
    expect(svg).toContain("Positionssprung");
    expect(svg).toContain("insgesamt 1 h 16 min pausiert");
    expect(svg).toContain("bis 4-fach");
    expect(svg).toContain("1 Flug ganz ohne Sternchen");
    expect(svg).not.toContain("var(--");
    expect(renderFlags("landscape")).toContain('width="1200" height="675"');
  });

  it("English", () => {
    const svg = renderFlags("portrait", "en");
    expect(svg).toContain("With an asterisk");
    expect(svg).toContain("flights with an asterisk");
    expect(svg).toContain("of 4 recorded flights");
    expect(svg).toContain("Time acceleration");
    expect(svg).toContain("up to 4×");
    expect(svg).not.toContain("Sternchen");
  });
});

describe("reviewNotes", () => {
  const t: TFunction = (key, ...args) => tIn("de", key, ...args);
  it("explains imports, the first recorded flight and the facts window", () => {
    expect(reviewNotes(review, t)).toEqual(["2 importierte Flüge zählen für Stunden, Strecken und Länder – Landungen und Anflüge kommen nur aus aufgezeichneten Flügen."]);
    const onlyImports = buildReview({ flights: [flight(0)], landings: [], approaches: [], visits: [], showDemo: false }, review.period);
    expect(reviewNotes(onlyImports, t)[1]).toBe("Landungen und Anflüge erscheinen nach deinem ersten mit VectaSim aufgezeichneten Flug.");
    const partial = { ...review, imported: 0, landings: { ...review.landings, partial: true }, approaches: { ...review.approaches, partial: true } };
    expect(reviewNotes(partial, t)).toEqual([`Landungen und Anflüge nur aus den letzten ${FACTS_WINDOW} – ältere dieses Zeitraums fehlen in den Karten.`]);
    expect(reviewNotes({ ...partial, approaches: review.approaches }, t)[0]).toMatch(/^Landungen nur aus den letzten 200/);
  });
});
