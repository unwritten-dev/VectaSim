import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerStatus } from "./serverLinks";
import { I18nProvider, setLanguageSetting } from "./i18n";

beforeEach(() => setLanguageSetting("de"));

// the panel only reads the Streamer-Modus flag; no Tauri calls happen in a static render
const privacy = { on: false };
vi.mock("./prefs", () => ({ usePrivacy: () => privacy }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const { default: ServerPanel } = await import("./ServerPanel");

const base: ServerStatus = {
  enabled: true,
  running: true,
  port: 8095,
  lan: false,
  token: "",
  lanAddress: null,
  sinceMs: null,
  clients: 2,
  error: null,
};

const render = (s: ServerStatus | null) => renderToStaticMarkup(<ServerPanel initialStatus={s} />);

describe("ServerPanel", () => {
  it("before the first status: everything disabled, no addresses", () => {
    const html = render(null);
    expect(html).toContain("Overlay &amp; Schnittstelle");
    expect(html).toContain("Status wird gelesen");
    expect(html).not.toContain("127.0.0.1");
  });

  it("off: no port open, no URLs", () => {
    const html = render({ ...base, enabled: false, running: false, clients: 0 });
    expect(html).toContain("Aus · kein Port offen.");
    expect(html).not.toContain("/overlay/hud");
    expect(html).not.toContain("server-token");
  });

  it("running locally: status line and every overlay URL", () => {
    const html = render(base);
    expect(html).toContain("Port 8095");
    expect(html).toContain("nur auf diesem PC");
    expect(html).toContain("2 Overlays verbunden");
    for (const p of ["/overlay/hud", "/overlay/landing", "/overlay/route", "/api/v1/status"]) {
      expect(html).toContain(`http://127.0.0.1:8095${p}`);
    }
    expect(html).not.toContain("token=");
  });

  it("LAN: token and LAN URLs, masked in the Streamer-Modus", () => {
    const lan = { ...base, lan: true, token: "abcDEF123xyz", lanAddress: "192.168.1.5" };
    privacy.on = false;
    let html = render(lan);
    expect(html).toContain("abcDEF123xyz");
    expect(html).toContain("http://192.168.1.5:8095/overlay/hud?token=abcDEF123xyz");
    expect(html).toContain("Neu erzeugen");
    privacy.on = true;
    html = render(lan);
    expect(html).not.toContain("abcDEF123xyz");
    expect(html).toContain("Anzeigen");
    privacy.on = false;
  });

  it("an error is shown instead of the running line", () => {
    const html = render({ ...base, running: false, error: "Port 8095 ist belegt" });
    expect(html).toContain("Port 8095 ist belegt");
  });
});

describe("ServerPanel in English", () => {
  it("renders the panel texts in the pinned language", () => {
    const html = renderToStaticMarkup(
      <I18nProvider lang="en">
        <ServerPanel initialStatus={base} />
      </I18nProvider>,
    );
    expect(html).toContain("Overlay &amp; API");
    expect(html).toContain("Turn on local server");
    expect(html).toContain("Open in browser");
  });
});
