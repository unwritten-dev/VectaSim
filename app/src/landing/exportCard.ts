// Touchdown Card export: LandingCard (SVG) → PNG at 2× (2400×1350), saved via the dialog
// plugin + `save_image` command, copied to the clipboard, or saved automatically after a
// landing into the card folder (`card_autosave`, `get_card_dir`; autoSaveCard – together with
// the approach card of that landing, exportApproachCard.ts). With the
// Streamer-Modus or „Landekarte ohne Kennzeichen“ the registration is masked (D-••••).

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { revealPath } from "../revealPath";
import { getPrefs } from "../prefs";
import { t } from "../i18n";
import { showToast } from "../ui/Toast";
import { userMessage } from "../errors";
import { saveImage } from "../saveImage";
import { copyErrorToast, errorToast, NoClipboardError } from "../ui/errorToast";
import LandingCard, { CARD_H, CARD_W, readCardTheme, type CardTheme } from "./LandingCard";
import { cardFontCss } from "./cardFonts";
import type { ApproachAnalysis } from "./approachTypes";
import type { LandingDebriefData } from "./types";
import type { CardDirInfo } from "../types";
import { autoApproachCardFileName, renderApproachCardPng } from "./exportApproachCard";

const SCALE = 2;

const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "");

/** "VectaSim_EDFE_26_2026-10-17.png" (UTC date of the touchdown); parts without data are left out. */
export function cardFileName(d: LandingDebriefData): string {
  const a = d.analysis;
  const icao = safe(a.runway?.airport ?? d.airport?.ident ?? "");
  const rwy = safe(a.runway?.ident ?? "");
  const ms = a.touchdown.timestampMs;
  const date = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return ["VectaSim", icao || safe(t("landingCard.landing")), rwy, date].filter(Boolean).join("_") + ".png";
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "VectaSim_EDFE_26_2026-10-17_1403.png" (UTC time of the touchdown) for the automatic save. */
export function autoCardFileName(d: LandingDebriefData, nowMs: number = Date.now()): string {
  const a = d.analysis;
  const icao = safe(a.runway?.airport ?? d.airport?.ident ?? "");
  const rwy = safe(a.runway?.ident ?? "");
  const ms = a.touchdown.timestampMs;
  const at = new Date(Number.isFinite(ms) && ms > 0 ? ms : nowMs);
  const stamp = `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}_${p2(at.getUTCHours())}${p2(at.getUTCMinutes())}`;
  return ["VectaSim", icao || safe(t("landingCard.landing")), rwy, stamp].filter(Boolean).join("_") + ".png";
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
    if (!svg) throw new Error(t("landingCard.export.notDrawn"));
    return new XMLSerializer().serializeToString(svg);
  } finally {
    root.unmount();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("landingCard.export.notLoaded")));
    img.src = src;
  });
}

/** A 1200×675 card SVG as PNG at 2× (2400×1350); shared with the approach card. */
export async function rasterizeCardSvg(svg: string): Promise<Blob> {
  // data: URL (not blob:) so the canvas is never tainted in WebView2
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  // embedded fonts are decoded with the image; decode() makes sure before drawing
  await img.decode?.().catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * SCALE;
  canvas.height = CARD_H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("landingCard.export.noCanvas"));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("landingCard.export.noPng")))), "image/png"));
}

/** PNG of the card, 2400×1350. */
export async function renderCardPng(d: LandingDebriefData, approach: ApproachAnalysis | null = null): Promise<Blob> {
  const colors = readCardTheme();
  // fonts first (cached after the first export); without them the system fallback renders
  const fontCss = await cardFontCss(colors.fontSans, colors.fontNum).catch(() => "");
  return rasterizeCardSvg(renderCardSvg(d, colors, approach, fontCss || null));
}

/** Save dialog, then write the PNG via `save_image`. Returns the path or null (cancelled). */
export async function saveCardPng(d: LandingDebriefData, approach: ApproachAnalysis | null = null): Promise<string | null> {
  try {
    const path = await save({ defaultPath: cardFileName(d), filters: [{ name: t("landingCard.export.pngFilter"), extensions: ["png"] }] });
    if (!path) return null;
    const blob = await renderCardPng(d, approach);
    await saveImage(path, blob);
    showToast({ tone: "ok", title: t("landingCard.export.saved"), body: path, durationMs: 3000 });
    return path;
  } catch (e) {
    // the reason behind "Details" (errorToast), never the raw text in the body
    showToast({ id: "card-export", tone: "err", ...errorToast(t("landingCard.export.notSaved", { title: userMessage(e, "export").title }), e, "export") });
    return null;
  }
}

/** Copy the PNG to the clipboard. */
export async function copyCardPng(d: LandingDebriefData, approach: ApproachAnalysis | null = null): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new NoClipboardError(t("landingCard.export.noClipboardImages"));
    // the promise keeps the click's user activation while the PNG renders
    await navigator.clipboard.write([new ClipboardItem({ "image/png": renderCardPng(d, approach) })]);
    showToast({ tone: "ok", title: t("landingCard.export.copied"), durationMs: 2500 });
    return true;
  } catch (e) {
    showToast({ id: "card-copy", tone: "err", ...copyErrorToast(t("landingCard.export.notCopied"), e) });
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
    const approach = landedApproach(approaches);
    const blob = await renderCardPng(d, approach);
    await saveImage(path, blob);
    // the approach card of the same landing next to it (best effort: the landing card counts)
    let approachName: string | null = null;
    if (approach) {
      try {
        approachName = autoApproachCardFileName(approach);
        const apPath = await join(dir.dir, approachName);
        const apBlob = await renderApproachCardPng(approach, d.flight);
        await saveImage(apPath, apBlob);
      } catch {
        approachName = null;
      }
    }
    showToast({
      id: "card-autosave",
      tone: "ok",
      title: approachName ? t("landingCard.export.bothSaved") : t("landingCard.export.saved"),
      body: [autoCardFileName(d), approachName].filter(Boolean).join(" · "),
      durationMs: 4000,
      actions: [{ label: t("landingCard.export.openFolder"), onClick: () => void revealPath(path).catch(() => {}) }],
    });
    return path;
  } catch (e) {
    const m = userMessage(e, "export");
    showToast({ id: "card-autosave", tone: "warn", title: t("landingCard.export.notAutoSaved", { title: m.title }), body: m.hint, durationMs: 8000 });
    return null;
  }
}
