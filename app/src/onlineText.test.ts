import { beforeEach, describe, expect, it } from "vitest";
import { fmt } from "./i18n/number";
import {
  backgroundNetworks,
  diagText,
  fmtAgo,
  networkStatuses,
  networksWith,
  onlineDiagRows,
  onlineLine,
  onlineTone,
  shownChoice,
  sourceHost,
  trafficShown,
} from "./onlineText";
import type { NetworkStatus, OnlineSummary } from "./types";
import { setLanguageSetting } from "./i18n";

beforeEach(() => setLanguageSetting("de"));

const net = (p: Partial<NetworkStatus> & Pick<NetworkStatus, "network">): NetworkStatus => ({
  label: p.network === "vatsim" ? "VATSIM" : "IVAO",
  enabled: false,
  pilots: 0,
  controllers: 0,
  atis: 0,
  prefiles: 0,
  consecutiveErrors: 0,
  nextPollS: 15,
  ...p,
});

const summary = (networks: NetworkStatus[] | undefined, p: Partial<OnlineSummary> = {}): OnlineSummary => ({
  network: "off",
  enabled: networks?.some((n) => n.enabled) ?? false,
  pilots: 0,
  controllers: 0,
  atis: 0,
  prefiles: 0,
  consecutiveErrors: 0,
  nextPollS: 15,
  networks,
  ...p,
});

const vatsimOn = net({
  network: "vatsim",
  enabled: true,
  pilots: 2176,
  controllers: 211,
  fetchedMs: 1,
  source: "https://data.vatsim.net/v3/vatsim-data.json",
  ageS: 12,
});

describe("onlineLine", () => {
  it("names each network with its own numbers", () => {
    const s = summary([vatsimOn, net({ network: "ivao" })], { network: "vatsim", pilots: 2176, controllers: 211 });
    expect(onlineLine(s)).toBe(`Online-Verkehr: VATSIM an (${fmt(2176)} Piloten, ${fmt(211)} Lotsen) · IVAO aus`);
    expect(onlineTone(s)).toBe("ok");
  });
  it("both networks, IVAO failing and waiting", () => {
    const s = summary([
      vatsimOn,
      net({ network: "ivao", enabled: true, lastError: "network: error sending request for url (https://api.ivao.aero/v2/tracker/whazzup)", nextPollS: 30 }),
    ]);
    expect(onlineLine(s)).toBe(`Online-Verkehr: VATSIM an (${fmt(2176)} Piloten, ${fmt(211)} Lotsen) · IVAO an (IVAO ist nicht erreichbar – nächster Versuch in 30 s)`);
    expect(onlineTone(s)).toBe("warn");
    const waiting = summary([net({ network: "vatsim" }), net({ network: "ivao", enabled: true })]);
    expect(onlineLine(waiting)).toBe("Online-Verkehr: VATSIM aus · IVAO an (warte auf ersten Abruf …)");
  });
  it("all off, not loaded, and summaries without networks (VATSIM-only builds)", () => {
    const off = summary([net({ network: "vatsim" }), net({ network: "ivao" })]);
    expect(onlineLine(off)).toBe("Online-Verkehr: VATSIM aus · IVAO aus");
    expect(onlineTone(off)).toBe("off");
    expect(onlineLine(null)).toBe("Online-Verkehr: Status wird geladen …");
    const legacy = summary(undefined, { network: "vatsim", enabled: true, pilots: 5, controllers: 1, fetchedMs: 1 });
    expect(onlineLine(legacy)).toBe("Online-Verkehr: VATSIM an (5 Piloten, 1 Lotsen) · IVAO aus");
    expect(networkStatuses(legacy).map((n) => n.network)).toEqual(["vatsim", "ivao"]);
  });
});

describe("networksWith", () => {
  const s = summary([vatsimOn, net({ network: "ivao" })]);
  it("adds and removes one network, order VATSIM, IVAO", () => {
    expect(networksWith(s, "ivao", true)).toEqual(["vatsim", "ivao"]);
    expect(networksWith(s, "vatsim", false)).toEqual([]);
    expect(networksWith(null, "ivao", true)).toEqual(["ivao"]);
  });
});

describe("diagnose rows", () => {
  it("host, age, numbers and status per network", () => {
    expect(diagText(vatsimOn)).toBe(`an · data.vatsim.net · vor 12 s · ${fmt(2176)} Piloten, ${fmt(211)} Lotsen · OK`);
    expect(diagText(net({ network: "ivao" }))).toBe("aus");
    const failing = net({
      network: "ivao",
      enabled: true,
      source: "https://api.ivao.aero/v2/tracker/whazzup",
      ageS: 185,
      fetchedMs: 1,
      pilots: 900,
      controllers: 80,
      lastError: "HTTP 503",
      consecutiveErrors: 3,
      nextPollS: 60,
    });
    expect(diagText(failing)).toBe("an · api.ivao.aero · vor 3 min · 900 Piloten, 80 Lotsen · Fehler (3× in Folge): HTTP 503 · nächster Versuch in 60 s");
    expect(diagText(net({ network: "ivao", enabled: true }))).toBe("an · noch kein Abruf · warte auf ersten Abruf");
  });
  it("one row per network for „Diagnose kopieren“", () => {
    const rows = onlineDiagRows(summary([vatsimOn, net({ network: "ivao" })]));
    expect(rows.map((r) => `${r.label}: ${r.text}`)).toEqual([`Online VATSIM: ${diagText(vatsimOn)}`, "Online IVAO: aus"]);
    expect(onlineDiagRows(null)).toEqual([{ label: "Online-Verkehr", text: "–" }]);
  });
  it("sourceHost and fmtAgo", () => {
    expect(sourceHost("https://data.vatsim.net/v3/vatsim-data.json")).toBe("data.vatsim.net");
    expect(sourceHost("api.ivao.aero/v2/tracker/whazzup")).toBe("api.ivao.aero");
    expect(sourceHost(null)).toBeNull();
    expect(fmtAgo(12.4)).toBe("vor 12 s");
    expect(fmtAgo(125)).toBe("vor 2 min");
    expect(fmtAgo(7300)).toBe("vor 2 h");
    expect(fmtAgo(null)).toBeNull();
  });
});

describe("onlineText in English", () => {
  it("status line and age", () => {
    setLanguageSetting("en");
    const s = summary([vatsimOn, net({ network: "ivao" })], { network: "vatsim", pilots: 2176, controllers: 211 });
    expect(onlineLine(s)).toBe("Online traffic: VATSIM on (2,176 pilots, 211 controllers) · IVAO off");
    expect(fmtAgo(12)).toBe("12 s ago");
    expect(onlineLine(null)).toBe("Online traffic: loading status …");
  });
});

describe("traffic shown on the map vs. network enabled", () => {
  const shownVatsim = { ...vatsimOn, shown: true, background: false, backgroundPollS: 60 };
  const hiddenIvao = net({ network: "ivao", enabled: true, fetchedMs: 1, pilots: 7, controllers: 2, shown: false, background: true, backgroundPollS: 60 });
  it("the status line says shown / hidden / off per network", () => {
    const s = summary([shownVatsim, hiddenIvao], { network: "both", shown: "vatsim" });
    expect(onlineLine(s)).toBe(
      `Online-Verkehr: VATSIM an (${fmt(2176)} Piloten, ${fmt(211)} Lotsen) – auf der Karte angezeigt · IVAO an (7 Piloten, 2 Lotsen) – auf der Karte ausgeblendet, Abruf alle 60 s im Hintergrund`,
    );
    const off = summary([net({ network: "vatsim", shown: true }), net({ network: "ivao" })]);
    expect(onlineLine(off)).toBe("Online-Verkehr: VATSIM aus · IVAO aus");
  });
  it("what the map draws: enabled and shown; older builds: every enabled network", () => {
    expect(shownChoice(summary([shownVatsim, hiddenIvao], { network: "both", shown: "vatsim" }))).toBe("vatsim");
    expect(trafficShown(summary([shownVatsim, hiddenIvao], { network: "both", shown: "vatsim" }))).toBe(true);
    expect(trafficShown(summary([hiddenIvao], { network: "ivao", shown: "off" }))).toBe(false);
    expect(trafficShown(summary(undefined, { network: "vatsim", enabled: true }))).toBe(true);
    expect(trafficShown(summary(undefined, { network: "off" }))).toBe(false);
    expect(trafficShown(null)).toBe(false);
    expect(backgroundNetworks(summary([shownVatsim, hiddenIvao]))).toEqual(["ivao"]);
    expect(backgroundNetworks(summary([{ ...shownVatsim, shown: false }, net({ network: "ivao", shown: false })]))).toEqual(["vatsim"]);
  });
  it("diagnostics name the map state and the background rate", () => {
    expect(diagText(hiddenIvao)).toContain("an · auf der Karte ausgeblendet · Hintergrund-Abruf alle 60 s");
    expect(diagText(shownVatsim)).toContain("an · auf der Karte angezeigt · data.vatsim.net");
    expect(diagText(shownVatsim)).not.toContain("Hintergrund");
  });
});
