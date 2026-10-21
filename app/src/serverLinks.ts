// Settings → Overlay & API: pure helpers of ServerPanel.tsx (URLs, status line,
// port input), unit-tested in serverLinks.test.ts. The server itself is the Rust crate
// crates/vectasim-server, switched by app/src-tauri/src/server.rs.

import { MASK } from "./format";
import { t } from "./i18n";
import { fmtClock, fmtDuration } from "./i18n/number";

/** `server_status` (server.rs → ServerStatus). */
export interface ServerStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  lan: boolean;
  token: string;
  lanAddress: string | null;
  sinceMs: number | null;
  clients: number;
  error: string | null;
}

export const DEFAULT_PORT = 8095;
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

export interface OverlayLink {
  id: "hud" | "landing" | "route" | "index" | "api";
  label: string;
  path: string;
  /** OBS browser source size, if it is an overlay. */
  size?: { width: number; height: number };
  hint: string;
}

/** One overlay entry; label and hint are getters, so they follow the UI language. */
function overlay(id: OverlayLink["id"], path: string, size?: OverlayLink["size"]): OverlayLink {
  return {
    id,
    path,
    ...(size ? { size } : {}),
    get label() {
      return t(`settings.server.overlay.${id}.label`);
    },
    get hint() {
      return t(`settings.server.overlay.${id}.hint`);
    },
  };
}

/** What the panel lists (same paths as the server's router and start page). */
export const OVERLAYS: OverlayLink[] = [
  overlay("hud", "/overlay/hud", { width: 1920, height: 120 }),
  overlay("landing", "/overlay/landing", { width: 900, height: 260 }),
  overlay("route", "/overlay/route", { width: 700, height: 200 }),
  overlay("index", "/"),
  overlay("api", "/api/v1/status"),
];

/** `http://127.0.0.1:8095` – what OBS on this PC uses (never needs the token). */
export function localBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** `http://192.168.1.5:8095` for other devices, or null without LAN access / address. */
export function lanBase(s: Pick<ServerStatus, "lan" | "lanAddress" | "port">): string | null {
  if (!s.lan || !s.lanAddress) return null;
  const host = s.lanAddress.includes(":") ? `[${s.lanAddress}]` : s.lanAddress;
  return `http://${host}:${s.port}`;
}

/** `path` on `base`, with `?token=` (or `&token=`) when given. */
export function urlFor(base: string, path: string, token?: string | null): string {
  const url = `${base}${path}`;
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/** The token as shown: masked while the Streamer-Modus is on and it is not revealed. */
export function shownToken(token: string, privacy: boolean, revealed: boolean): string {
  if (!token) return "";
  return privacy && !revealed ? MASK.repeat(8) : token;
}

/** "kein Overlay verbunden" · "1 Overlay verbunden" · "3 Overlays verbunden". */
export function clientsText(n: number): string {
  if (n <= 0) return t("settings.server.clientsNone");
  return t("settings.server.clients", { count: n });
}

export type Tone = "ok" | "warn" | "off" | "err" | "info";

/** The status line under the switch. */
export function statusLine(s: ServerStatus | null, nowMs: number): { tone: Tone; text: string } {
  if (!s) return { tone: "info", text: t("settings.server.status.reading") };
  if (!s.enabled) return { tone: "off", text: t("settings.server.status.off") };
  if (s.error) return { tone: "err", text: s.error };
  if (!s.running) return { tone: "warn", text: t("settings.server.status.starting") };
  const where = s.lan ? t("settings.server.status.lan") : t("settings.server.status.local");
  const vars = { port: String(s.port), where, clients: clientsText(s.clients) };
  const text = s.sinceMs
    ? t("settings.server.status.runningSince", { ...vars, since: fmtClock(s.sinceMs), duration: fmtDuration(nowMs - s.sinceMs, { seconds: false }) })
    : t("settings.server.status.running", vars);
  return { tone: "ok", text };
}

/** Port field → number, or an error text. Empty = default port. */
export function parsePortInput(raw: string): { port: number } | { error: string } {
  const v = raw.trim();
  if (!v) return { port: DEFAULT_PORT };
  if (!/^\d+$/.test(v)) return { error: t("settings.server.port.notNumber") };
  const n = Number(v);
  if (n < PORT_MIN || n > PORT_MAX) return { error: t("settings.server.port.range", { min: String(PORT_MIN), max: String(PORT_MAX) }) };
  return { port: n };
}

/** "Breite 1920 · Höhe 120" for the OBS hint. */
export function obsSize(o: OverlayLink): string | null {
  return o.size ? t("settings.server.obsSize", { width: String(o.size.width), height: String(o.size.height) }) : null;
}
