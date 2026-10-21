// Jahresrückblick export: a story card (ReviewCards.tsx, SVG) → PNG like the landing card
// (landing/exportCard.ts): fonts inlined (cardFonts.ts), drawn from a data: URL so the canvas
// is never tainted, written via `save_image`. One card per save dialog, all cards of a format
// into a folder (dialog defaults to the card folder `get_card_dir`, Bilder\VectaSim), or the
// portrait cards as one tall „Stapel“. Registrations follow cardHidesReg() (Streamer-Modus or
// „Landekarte ohne Kennzeichen“).

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { revealPath } from "../revealPath";
import { showToast } from "../ui/Toast";
import { t } from "../i18n";
import { userMessage } from "../errors";
import { saveImage } from "../saveImage";
import { copyErrorToast, errorToast, NoClipboardError } from "../ui/errorToast";
import { readCardTheme, type CardTheme } from "../landing/LandingCard";
import { cardFontCss } from "../landing/cardFonts";
import { cardHidesReg } from "../landing/exportCard";
import type { CardDirInfo } from "../types";
import ReviewCard, { cardHasData, type CardProps } from "./ReviewCards";
import { CARDS, FORMAT_SCALE, FORMAT_SIZE, reviewFileName, stackFileName, type CardFormat, type CardId } from "./text";
import type { YearReview } from "./stats";

/** What every card of one review needs besides id and format. */
export interface CardSource {
  review: YearReview;
  outlines: GeoJSON.FeatureCollection | null;
  countryNames: Map<string, string>;
}

/** The card as standalone SVG markup. */
export function renderReviewSvg(id: CardId, format: CardFormat, src: CardSource, colors: CardTheme = readCardTheme(), fontCss: string | null = null, hideReg: boolean = cardHidesReg()): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    const props: CardProps = { id, format, review: src.review, colors, fontCss, hideReg, outlines: src.outlines, countryNames: src.countryNames, idPrefix: "x" };
    flushSync(() => root.render(createElement(ReviewCard, props)));
    const svg = host.querySelector("svg");
    if (!svg) throw new Error(t("review.export.drawFailed"));
    return new XMLSerializer().serializeToString(svg);
  } finally {
    root.unmount();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("review.export.loadFailed")));
    img.src = src;
  });
}

async function cardImage(id: CardId, format: CardFormat, src: CardSource, colors: CardTheme, fontCss: string | null): Promise<HTMLImageElement> {
  const svg = renderReviewSvg(id, format, src, colors, fontCss);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  await img.decode?.().catch(() => undefined);
  return img;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("review.export.noPng")))), "image/png"));
}

async function themeAndFonts(): Promise<{ colors: CardTheme; fontCss: string | null }> {
  const colors = readCardTheme();
  const fontCss = await cardFontCss(colors.fontSans, colors.fontNum).catch(() => "");
  return { colors, fontCss: fontCss || null };
}

/** PNG of one card: 1080×1920 (portrait) or 2400×1350 (landscape, 2× like the landing card). */
export async function renderReviewPng(id: CardId, format: CardFormat, src: CardSource): Promise<Blob> {
  const { colors, fontCss } = await themeAndFonts();
  const img = await cardImage(id, format, src, colors, fontCss);
  const { w, h } = FORMAT_SIZE[format];
  const k = FORMAT_SCALE[format];
  const canvas = document.createElement("canvas");
  canvas.width = w * k;
  canvas.height = h * k;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("review.export.noCanvas"));
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas);
}

/** Cards with data, in order. */
export const cardsWithData = (r: YearReview): CardId[] => CARDS.map((c) => c.id).filter((id) => cardHasData(id, r));

/** Every portrait card with data below each other: 1080 × (1920 · n). */
export async function renderStackPng(src: CardSource): Promise<Blob> {
  const ids = cardsWithData(src.review);
  if (!ids.length) throw new Error(t("review.export.noCard"));
  const { colors, fontCss } = await themeAndFonts();
  const { w, h } = FORMAT_SIZE.portrait;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h * ids.length;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("review.export.noCanvas"));
  for (let i = 0; i < ids.length; i++) ctx.drawImage(await cardImage(ids[i], "portrait", src, colors, fontCss), 0, h * i, w, h);
  return toBlob(canvas);
}

async function writePng(path: string, blob: Blob): Promise<void> {
  await saveImage(path, blob);
}

/** The card folder (Bilder\VectaSim by default) as the dialogs' starting point. */
async function cardDir(): Promise<string | null> {
  try {
    return (await invoke<CardDirInfo>("get_card_dir", { create: true })).dir;
  } catch {
    return null;
  }
}

function failed(what: string, e: unknown) {
  // the reason behind "Details" (errorToast), never the raw text in the body
  showToast({ id: "review-export", tone: "err", ...errorToast(`${what}: ${userMessage(e, "export").title}`, e, "export") });
}

function savedToast(title: string, path: string, body: string) {
  showToast({
    id: "review-export",
    tone: "ok",
    title,
    body,
    durationMs: 4000,
    actions: [{ label: t("review.export.openFolder"), onClick: () => void revealPath(path).catch(() => {}) }],
  });
}

/** Save dialog for one card. Returns the path or null (cancelled / failed). */
export async function saveReviewCard(id: CardId, format: CardFormat, src: CardSource): Promise<string | null> {
  try {
    const name = reviewFileName(id, format, src.review.period);
    const dir = await cardDir();
    const path = await save({ defaultPath: dir ? await join(dir, name) : name, filters: [{ name: t("review.export.pngFilter"), extensions: ["png"] }] });
    if (!path) return null;
    await writePng(path, await renderReviewPng(id, format, src));
    savedToast(t("review.export.cardSaved"), path, path);
    return path;
  } catch (e) {
    failed(t("review.export.cardFailed"), e);
    return null;
  }
}

/** Copy one card to the clipboard. */
export async function copyReviewCard(id: CardId, format: CardFormat, src: CardSource): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new NoClipboardError(t("review.export.noClipboard"));
    // the promise keeps the click's user activation while the PNG renders
    await navigator.clipboard.write([new ClipboardItem({ "image/png": renderReviewPng(id, format, src) })]);
    showToast({ id: "review-export", tone: "ok", title: t("review.export.copied"), durationMs: 2500 });
    return true;
  } catch (e) {
    showToast({ id: "review-export", tone: "err", ...copyErrorToast(t("review.export.copyFailed"), e) });
    return false;
  }
}

/** „Alle speichern“: folder dialog, then every card with data of the format into it. */
export async function saveAllReviewCards(format: CardFormat, src: CardSource): Promise<number> {
  try {
    const picked = await open({ title: t("review.export.pickFolder"), directory: true, multiple: false, defaultPath: (await cardDir()) ?? undefined });
    const dir = typeof picked === "string" ? picked : null;
    if (!dir) return 0;
    const ids = cardsWithData(src.review);
    let last = dir;
    for (const id of ids) {
      last = await join(dir, reviewFileName(id, format, src.review.period));
      await writePng(last, await renderReviewPng(id, format, src));
    }
    savedToast(t("review.export.cardsSaved", { count: ids.length }), last, dir);
    return ids.length;
  } catch (e) {
    failed(t("review.export.cardsFailed"), e);
    return 0;
  }
}

/** „Stapel speichern“: save dialog, then every portrait card in one tall PNG. */
export async function saveReviewStack(src: CardSource): Promise<string | null> {
  try {
    const name = stackFileName(src.review.period);
    const dir = await cardDir();
    const path = await save({ defaultPath: dir ? await join(dir, name) : name, filters: [{ name: t("review.export.pngFilter"), extensions: ["png"] }] });
    if (!path) return null;
    await writePng(path, await renderStackPng(src));
    savedToast(t("review.export.stackSaved"), path, path);
    return path;
  } catch (e) {
    failed(t("review.export.stackFailed"), e);
    return null;
  }
}
