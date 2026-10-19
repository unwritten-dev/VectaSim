// Live view and map texts in both languages (W5 of the i18n migration): the German reference
// and the English translation of the central cards, rendered statically (no effects run).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
// the prefs store's useSyncExternalStore has no server snapshot: read the defaults directly
vi.mock("../prefs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../prefs")>();
  return {
    ...orig,
    usePrefs: () => orig.getPrefs(),
    usePrivacy: () => ({ on: false, mask: (v: string | null | undefined) => v ?? "", title: (text: string | null | undefined) => text ?? "" }),
  };
});

import { I18nProvider, setLanguageSetting, type Language } from "../i18n";
import ReadyCard from "./ReadyCard";
import TrafficCard from "../map/TrafficCard";
import type { RecStatus } from "../status";
import type { Pilot } from "../types";
import type { TrafficSelection } from "../map/trafficInfo";

afterEach(() => setLanguageSetting("de"));

const rec: RecStatus = { kind: "waiting", label: "Waiting", text: "Waiting", hint: "", color: "", error: null } as unknown as RecStatus;

const pilot: Pilot = {
  network: "vatsim",
  cid: 1,
  callsign: "DLH4AB",
  latitude: 50,
  longitude: 8.5,
  altitudeFt: 3500,
  groundSpeedKt: 300,
  headingDeg: 90,
  transponder: "1000",
  aircraftShort: "A20N",
  departure: "",
  arrival: "",
  route: "",
  flightRules: "I",
};
const sel: TrafficSelection = { network: "vatsim", cid: 1, pilot, prev: null, last: null, goneSinceMs: null };

const ready = (lang: Language) => {
  setLanguageSetting(lang);
  return renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <ReadyCard rec={rec} status={null} ofp={null} aircraft={null} onOpenDispatch={() => {}} onTryDemo={() => {}} onDismiss={() => {}} />
    </I18nProvider>,
  );
};

const traffic = (lang: Language) => {
  // numbers (i18n/number) follow the global language, so set it rather than only pinning the provider
  setLanguageSetting(lang);
  return renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <TrafficCard sel={sel} own={{ lat: 50, lon: 8 }} following={false} routeShown={false} onFollow={() => {}} onRoute={() => {}} onClose={() => {}} />
    </I18nProvider>,
  );
};

describe("ready card", () => {
  it("German reference", () => {
    const html = ready("de");
    expect(html).toContain('aria-label="Bereit"');
    expect(html).toContain("Simulator noch nicht verbunden");
    expect(html).toContain("kein SimBrief-Flugplan");
    expect(html).toContain("Flugplan");
  });
  it("English", () => {
    const html = ready("en");
    expect(html).toContain('aria-label="Ready"');
    expect(html).toContain("Simulator not connected yet");
    expect(html).toContain("no SimBrief flight plan");
    expect(html).toContain("Flight plan");
    expect(html).not.toContain("Flugplan");
  });
});

describe("traffic card", () => {
  it("German reference", () => {
    const html = traffic("de");
    expect(html).toContain("Online-Verkehr");
    expect(html).toContain("kein Flugplan aufgegeben");
    expect(html).toContain("Folgen");
    expect(html).toContain("Von dir");
  });
  it("English", () => {
    const html = traffic("en");
    expect(html).toContain("Online traffic");
    expect(html).toContain("no flight plan filed");
    expect(html).toContain("Follow");
    expect(html).toContain("Heading");
    expect(html).toContain("From you");
    expect(html).toContain("3,500");
  });
});
