import { beforeEach, describe, expect, it } from "vitest";
import { MASK, NNBSP } from "./format";
import { OVERLAYS, clientsText, lanBase, localBase, obsSize, parsePortInput, shownToken, statusLine, urlFor, type ServerStatus } from "./serverLinks";
import { setLanguageSetting } from "./i18n";

beforeEach(() => setLanguageSetting("de"));

const base: ServerStatus = {
  enabled: true,
  running: true,
  port: 8095,
  lan: false,
  token: "AbCdEfGhJkMnPqRsTuVwXyZ2",
  lanAddress: null,
  sinceMs: null,
  clients: 0,
  error: null,
};

describe("overlay URLs", () => {
  it("builds local and LAN URLs", () => {
    expect(localBase(8095)).toBe("http://127.0.0.1:8095");
    expect(urlFor(localBase(8095), "/overlay/hud")).toBe("http://127.0.0.1:8095/overlay/hud");
    expect(lanBase(base)).toBeNull();
    expect(lanBase({ ...base, lan: true })).toBeNull();
    expect(lanBase({ ...base, lan: true, lanAddress: "192.168.1.5" })).toBe("http://192.168.1.5:8095");
    expect(lanBase({ ...base, lan: true, lanAddress: "fe80::1", port: 9000 })).toBe("http://[fe80::1]:9000");
  });

  it("appends the token", () => {
    expect(urlFor("http://192.168.1.5:8095", "/overlay/hud", "a b")).toBe("http://192.168.1.5:8095/overlay/hud?token=a%20b");
    expect(urlFor("http://192.168.1.5:8095", "/api/v1/logbook?limit=5", "tok")).toBe("http://192.168.1.5:8095/api/v1/logbook?limit=5&token=tok");
    expect(urlFor("http://x", "/", "")).toBe("http://x/");
  });

  it("lists the server's pages with OBS sizes", () => {
    expect(OVERLAYS.map((o) => o.path)).toEqual(["/overlay/hud", "/overlay/landing", "/overlay/route", "/", "/api/v1/status"]);
    expect(obsSize(OVERLAYS[0])).toBe(`Breite${NNBSP}1920 · Höhe${NNBSP}120`);
    expect(obsSize(OVERLAYS[3])).toBeNull();
  });
});

describe("status line", () => {
  const now = Date.UTC(2026, 9, 18, 14, 0);
  it("covers off, error, starting and running", () => {
    expect(statusLine(null, now).tone).toBe("info");
    expect(statusLine({ ...base, enabled: false, running: false }, now)).toEqual({ tone: "off", text: "Aus · kein Port offen." });
    expect(statusLine({ ...base, running: false, error: "Port 8095 ist schon belegt – anderen Port wählen." }, now)).toEqual({
      tone: "err",
      text: "Port 8095 ist schon belegt – anderen Port wählen.",
    });
    expect(statusLine({ ...base, running: false }, now).tone).toBe("warn");
    const run = statusLine({ ...base, sinceMs: now - 65 * 60_000, clients: 2 }, now);
    expect(run.tone).toBe("ok");
    expect(run.text).toContain("Port 8095");
    expect(run.text).toContain("nur auf diesem PC");
    expect(run.text).toContain("2 Overlays verbunden");
    expect(run.text).toContain(`1${NNBSP}h${NNBSP}05${NNBSP}min`);
    expect(statusLine({ ...base, lan: true }, now).text).toContain("im Netzwerk erreichbar");
  });

  it("counts clients in German", () => {
    expect(clientsText(0)).toBe("kein Overlay verbunden");
    expect(clientsText(1)).toBe("1 Overlay verbunden");
    expect(clientsText(4)).toBe("4 Overlays verbunden");
  });
});

describe("inputs", () => {
  it("parses the port", () => {
    expect(parsePortInput("")).toEqual({ port: 8095 });
    expect(parsePortInput(" 9000 ")).toEqual({ port: 9000 });
    expect(parsePortInput("80")).toHaveProperty("error");
    expect(parsePortInput("70000")).toHaveProperty("error");
    expect(parsePortInput("80a")).toHaveProperty("error");
  });

  it("masks the token in the Streamer-Modus", () => {
    expect(shownToken("secret", false, false)).toBe("secret");
    expect(shownToken("secret", true, false)).toBe(MASK.repeat(8));
    expect(shownToken("secret", true, true)).toBe("secret");
    expect(shownToken("", true, false)).toBe("");
  });
});

describe("in English", () => {
  it("status line, client count and port errors", () => {
    setLanguageSetting("en");
    const now = Date.UTC(2026, 9, 18, 14, 0);
    expect(clientsText(0)).toBe("no overlay connected");
    expect(clientsText(1)).toBe("1 overlay connected");
    expect(clientsText(3)).toBe("3 overlays connected");
    expect(statusLine({ ...base, enabled: false, running: false }, now).text).toBe("Off · no port open.");
    expect(statusLine({ ...base, clients: 2 }, now).text).toBe("Running · port 8095 · this PC only · 2 overlays connected");
    expect(OVERLAYS[1].label).toBe("Landing");
    expect(obsSize(OVERLAYS[0])).toBe(`width${NNBSP}1920 · height${NNBSP}120`);
    expect(parsePortInput("80a")).toEqual({ error: "The port must be a number." });
  });
});
