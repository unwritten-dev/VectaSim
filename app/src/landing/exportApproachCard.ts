// Approach card export: ApproachCard (SVG) → PNG at 2× (2400×1350), like the landing card
// (exportCard.ts): save dialog + `save_image`, clipboard, and the automatic save after a
// landing (autoSaveCard saves it next to the landing card). Streamer-Modus / „Landekarte ohne
// Kennzeichen“ mask the registration (cardHidesReg). Card, file name and toasts in the UI language.

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { showToast } from "../ui/Toast";
import { userMessage } from "../errors";
import { saveImage } from "../saveImage";
import { copyErrorToast, errorToast, NoClipboardError } from "../ui/errorToast";
import { getLanguage, t, tIn, type Language } from "../i18n";
import ApproachCard, { type ApproachCardProps } from "./ApproachCard";
import { readCardTheme, type CardTheme } from "./LandingCard";
import { cardFontCss } from "./cardFonts";
import { cardHidesReg, rasterizeCardSvg } from "./exportCard";
import type { ApproachAnalysis } from "./approachTypes";

type CardFlight = ApproachCardProps["flight"];

const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "");
const p2 = (n: number) => String(n).padStart(2, "0");

function stamp(a: ApproachAnalysis, nowMs: number, withTime: boolean): string {
  const ms = a.goAround?.lowestTMs ?? a.endTMs;
  const t = new Date(Number.isFinite(ms) && ms > 0 ? ms : nowMs);
  const date = `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
  return withTime ? `${date}_${p2(t.getUTCHours())}${p2(t.getUTCMinutes())}` : date;
}

/** "VectaSim_Anflug_EDDF_25C_2026-10-18.png" (en "VectaSim_Approach_…"; UTC date of the touchdown / lowest point). */
export function approachCardFileName(a: ApproachAnalysis, nowMs: number = Date.now(), lang: Language = getLanguage()): string {
  const parts = ["VectaSim", tIn(lang, "approach.export.fileWord"), safe(a.runway?.airport ?? ""), safe(a.runway?.ident ?? ""), a.outcome.kind === "goAround" ? "GA" : "", stamp(a, nowMs, false)];
  return parts.filter(Boolean).join("_") + ".png";
}

/** "VectaSim_Anflug_EDDF_25C_2026-10-18_1403.png" for the automatic save. */
export function autoApproachCardFileName(a: ApproachAnalysis, nowMs: number = Date.now(), lang: Language = getLanguage()): string {
  const parts = ["VectaSim", tIn(lang, "approach.export.fileWord"), safe(a.runway?.airport ?? ""), safe(a.runway?.ident ?? ""), a.outcome.kind === "goAround" ? "GA" : "", stamp(a, nowMs, true)];
  return parts.filter(Boolean).join("_") + ".png";
}

/** The card as standalone SVG markup with concrete colours (see LandingCard). */
export function renderApproachCardSvg(
  approach: ApproachAnalysis,
  flight: CardFlight = null,
  colors: CardTheme = readCardTheme(),
  fontCss: string | null = null,
  hideReg: boolean = cardHidesReg(),
  lang: Language = getLanguage(),
): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(ApproachCard, { approach, flight, colors, fontCss, hideReg, lang })));
    const svg = host.querySelector("svg");
    if (!svg) throw new Error(tIn(lang, "approach.export.notDrawn"));
    return new XMLSerializer().serializeToString(svg);
  } finally {
    root.unmount();
  }
}

/** PNG of the approach card, 2400×1350. */
export async function renderApproachCardPng(approach: ApproachAnalysis, flight: CardFlight = null): Promise<Blob> {
  const colors = readCardTheme();
  const fontCss = await cardFontCss(colors.fontSans, colors.fontNum).catch(() => "");
  return rasterizeCardSvg(renderApproachCardSvg(approach, flight, colors, fontCss || null));
}

/** Save dialog, then write the PNG via `save_image`. Returns the path or null (cancelled / failed). */
export async function saveApproachCardPng(approach: ApproachAnalysis, flight: CardFlight = null): Promise<string | null> {
  try {
    const path = await save({ defaultPath: approachCardFileName(approach), filters: [{ name: t("approach.export.pngFilter"), extensions: ["png"] }] });
    if (!path) return null;
    const blob = await renderApproachCardPng(approach, flight);
    await saveImage(path, blob);
    showToast({ tone: "ok", title: t("approach.export.saved"), body: path, durationMs: 3000 });
    return path;
  } catch (e) {
    // the reason behind "Details" (errorToast), never the raw text in the body
    showToast({ id: "approach-card-export", tone: "err", ...errorToast(t("approach.export.saveFailed", { reason: userMessage(e, "export").title }), e, "export") });
    return null;
  }
}

/** Copy the PNG to the clipboard. */
export async function copyApproachCardPng(approach: ApproachAnalysis, flight: CardFlight = null): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new NoClipboardError(t("approach.export.clipboardNoImages"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": renderApproachCardPng(approach, flight) })]);
    showToast({ tone: "ok", title: t("approach.export.copied"), durationMs: 2500 });
    return true;
  } catch (e) {
    showToast({ id: "approach-card-copy", tone: "err", ...copyErrorToast(t("approach.export.copyFailed"), e) });
    return false;
  }
}
