// Touchdown Card export: LandingCard (SVG) → PNG at 2× (2400×1350), saved via the dialog
// plugin + `save_image` command, copied to the clipboard, or saved automatically after a
// landing into the card folder (`card_autosave`, `get_card_dir`; autoSaveCard). With the
// Streamer-Modus or „Landekarte ohne Kennzeichen“ the registration is masked (D-••••).

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getPrefs } from "../prefs";
import { showToast } from "../ui/Toast";
import { userMessage } from "../errors";
import LandingCard, { CARD_H, CARD_W, readCardTheme, type CardTheme } from "./LandingCard";
import { cardFontCss } from "./cardFonts";
import type { ApproachAnalysis } from "./approachTypes";
import type { LandingDebriefData } from "./types";
import type { CardDirInfo } from "../types";

const SCALE = 2;

const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "");

/** "VectaSim_EDFE_26_2026-10-17.png" (UTC date of the touchdown); parts without data are left out. */
export function cardFileName(d: LandingDebriefData): string {
  const a = d.analysis;
  const icao = safe(a.runway?.airport ?? d.airport?.ident ?? "");
  const rwy = safe(a.runway?.ident ?? "");
  const ms = a.touchdown.timestampMs;
  const date = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return ["VectaSim", icao || "Landung", rwy, date].filter(Boolean).join("_") + ".png";
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "VectaSim_EDFE_26_2026-10-17_1403.png" (UTC time of the touchdown) for the automatic save. */
export function autoCardFileName(d: LandingDebriefData, nowMs: number = Date.now()): string {
  const a = d.analysis;
  const icao = safe(a.runway?.airport ?? d.airport?.ident ?? "");
  const rwy = safe(a.runway?.ident ?? "");
  const ms = a.touchdown.timestampMs;
  const t = new Date(Number.isFinite(ms) && ms > 0 ? ms : nowMs);
  const stamp = `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}_${p2(t.getUTCHours())}${p2(t.getUTCMinutes())}`;
  return ["VectaSim", icao || "Landung", rwy, stamp].filter(Boolean).join("_") + ".png";
}

/** Registration masked on the card: Streamer-Modus or „Landekarte ohne Kennzeichen“. */
export function cardHidesReg(): boolean {
  const p = getPrefs();
  return p.privacyMode || p.cardHideReg;
}

/**
 * The card as standalone SVG markup with the given (concrete) colours; `approach` adds its
 * one-line summary, `fontCss` embeds the theme's web fonts (cardFonts.ts).
 */
export function renderCardSvg(
  d: LandingDebriefData,
  colors: CardTheme = readCardTheme(),
  approach: ApproachAnalysis | null = null,
  fontCss: string | null = null,
  hideReg: boolean = cardHidesReg(),
): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(LandingCard, { data: d, colors, approach, fontCss, hideReg })));
    const svg = host.querySelector("svg");
    if (!svg) throw new Error("Landekarte konnte nicht gezeichnet werden");
    return new XMLSerializer().serializeToString(svg);
  } finally {
    root.unmount();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Landekarte konnte nicht als Bild geladen werden"));
    img.src = src;
  });
}

/** PNG of the card, 2400×1350. */
export async function renderCardPng(d: LandingDebriefData, approach: ApproachAnalysis | null = null): Promise<Blob> {
  const colors = readCardTheme();
  // fonts first (cached after the first export); without them the system fallback renders
  const fontCss = await cardFontCss(colors.fontSans, colors.fontNum).catch(() => "");
  const svg = renderCardSvg(d, colors, approach, fontCss || null);
  // data: URL (not blob:) so the canvas is never tainted in WebView2
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  // embedded fonts are decoded with the image; decode() makes sure before drawing
  await img.decode?.().catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas nicht verfügbar");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG konnte nicht erzeugt werden"))), "image/png"));
}

/** Save dialog, then write the PNG via `save_image`. Returns the path or null (cancelled). */
export async function saveCardPng(d: LandingDebriefData, approach: ApproachAnalysis | null = null): Promise<string | null> {
  try {
    const path = await save({ defaultPath: cardFileName(d), filters: [{ name: "PNG-Bild", extensions: ["png"] }] });
    if (!path) return null;
    const blob = await renderCardPng(d, approach);
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke("save_image", { path, bytes });
    showToast({ tone: "ok", title: "Landekarte gespeichert", body: path, durationMs: 3000 });
    return path;
  } catch (e) {
    const m = userMessage(e, "export");
    showToast({ id: "card-export", tone: "err", title: `Landekarte nicht gespeichert: ${m.title}`, body: `${m.hint}${m.detail ? ` (${m.detail.slice(0, 160)})` : ""}` });
    return null;
  }
}

/** Copy the PNG to the clipboard. */
export async function copyCardPng(d: LandingDebriefData, approach: ApproachAnalysis | null = null): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Die Zwischenablage unterstützt hier keine Bilder");
    // the promise keeps the click's user activation while the PNG renders
    await navigator.clipboard.write([new ClipboardItem({ "image/png": renderCardPng(d, approach) })]);
    showToast({ tone: "ok", title: "Landekarte in die Zwischenablage kopiert", durationMs: 2500 });
    return true;
  } catch (e) {
    showToast({ id: "card-copy", tone: "err", title: "Landekarte nicht kopiert", body: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** The approach that ended in this landing (the last landed one), like LandingSummary. */
function landedApproach(xs: ApproachAnalysis[]): ApproachAnalysis | null {
  const landed = xs.filter((x) => x.outcome.kind === "landed");
  return landed.length ? landed[landed.length - 1] : null;
}

/**
 * „Landekarte automatisch speichern“: after a landing, when `card_autosave` is on, renders
 * the flight's last landing as PNG into the card folder (`get_card_dir`, default
 * Bilder\VectaSim) and shows a short toast with „Ordner öffnen“. Returns the path, or null
 * when switched off or nothing could be saved (then a warning toast says why).
 */
export async function autoSaveCard(flightId: string): Promise<string | null> {
  if (!getPrefs().cardAutosave) return null;
  try {
    const [d, approaches, dir] = await Promise.all([
      invoke<LandingDebriefData>("landing_analysis", { flightId, touchdownIndex: null }),
      // the approach line is optional on the card
      invoke<ApproachAnalysis[]>("approach_analysis", { flightId }).catch(() => [] as ApproachAnalysis[]),
      invoke<CardDirInfo>("get_card_dir", { create: true }),
    ]);
    const path = await join(dir.dir, autoCardFileName(d));
    const blob = await renderCardPng(d, landedApproach(approaches));
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke("save_image", { path, bytes });
    showToast({
      id: "card-autosave",
      tone: "ok",
      title: "Landekarte gespeichert",
      body: autoCardFileName(d),
      durationMs: 4000,
      actions: [{ label: "Ordner öffnen", onClick: () => void revealItemInDir(path).catch(() => {}) }],
    });
    return path;
  } catch (e) {
    const m = userMessage(e, "export");
    showToast({ id: "card-autosave", tone: "warn", title: `Landekarte nicht automatisch gespeichert: ${m.title}`, body: m.hint, durationMs: 8000 });
    return null;
  }
}
