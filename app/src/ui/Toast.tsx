// Non-blocking notices. A tiny external store (like prefs.ts) so any module can call
// showToast() without a provider; <ToastViewport> renders the toasts of its regions.
//   region "app": bottom right of the window (export saved, OFP loaded, background errors)
//   region "map": top centre of the live map (landing notice); shown in the app region
//                 while the map is not on screen.
// Screen readers: <ToastAnnouncer> keeps two live regions permanently in the DOM and copies
// the text of each new toast into them (a container that only appears with its first toast
// is not a live region for NVDA/JAWS). Keyboard: Alt+T (App) focuses the newest toast,
// Esc in a toast closes it and returns to where the focus was.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../i18n";
import { toastTimer, type ToastTimer } from "./toastTimer";

export type ToastTone = "info" | "ok" | "warn" | "err";
export type ToastRegion = "app" | "map";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Keep the toast open after the click (default: close). */
  keepOpen?: boolean;
}

export interface ToastOptions {
  /** Same id replaces an existing toast (e.g. repeated errors). */
  id?: string;
  tone?: ToastTone;
  title: string;
  body?: ReactNode;
  actions?: ToastAction[];
  /** Auto-dismiss after this many ms; null = stays (default: 5 s, errors stay). */
  durationMs?: number | null;
  region?: ToastRegion;
  /** Extra class for custom layouts (landing card). */
  className?: string;
  /** Text for screen readers when `body` is not plain text (default: title, plus body if a string). */
  announce?: string;
  /**
   * Hold the timer while the window has no focus (the pilot is in the sim): the toast
   * stays until the window is focused again and then runs its full duration.
   */
  holdWhileUnfocused?: boolean;
}

export interface ToastItem extends ToastOptions {
  id: string;
  createdMs: number;
}

const MAX_PER_REGION = 3;
let toasts: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(o: ToastOptions): string {
  const id = o.id ?? `t${++seq}`;
  const item: ToastItem = { durationMs: o.tone === "err" ? null : 5000, region: "app", tone: "info", ...o, id, createdMs: Date.now() + ++seq / 1000 };
  const rest = toasts.filter((t) => t.id !== id);
  const same = rest.filter((t) => t.region === item.region);
  // the oldest of the region goes when the stack is full
  const drop = same.length >= MAX_PER_REGION ? same[0].id : null;
  toasts = [...rest.filter((t) => t.id !== drop), item];
  emit();
  return id;
}

/** Whether the toast `id` is on screen (not dismissed, not timed out). */
export function hasToast(id: string): boolean {
  return toasts.some((t) => t.id === id);
}

export function dismissToast(id: string) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getToasts = () => toasts;

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getToasts);
}

/**
 * Renders the toasts of the given regions. Always in the DOM (also when empty); the
 * announcement is <ToastAnnouncer>'s job, so the viewport itself is no live region.
 */
export function ToastViewport({ regions, placement }: { regions: ToastRegion[]; placement: "top" | "bottom-right" }) {
  const list = useToasts().filter((t) => regions.includes(t.region ?? "app"));
  return (
    <div className={`toast-viewport toast-${placement}`} data-regions={regions.join(" ")}>
      {list.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
}

const TONE_ICON: Record<ToastTone, string> = { info: "i", ok: "✓", warn: "▲", err: "!" };

function announcement(t: ToastItem): string {
  if (t.announce) return t.announce;
  return typeof t.body === "string" || typeof t.body === "number" ? `${t.title}. ${t.body}` : t.title;
}

/**
 * Two live regions that are always there: polite for notices, assertive for errors. Each new
 * (or replaced) toast is announced once; rendered once by App, outside the inert shell.
 */
export function ToastAnnouncer() {
  const list = useToasts();
  const seen = useRef(new Set<string>());
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  useEffect(() => {
    const fresh = list.filter((t) => !seen.current.has(`${t.id}@${t.createdMs}`));
    seen.current = new Set(list.map((t) => `${t.id}@${t.createdMs}`));
    if (!fresh.length) return;
    const errs = fresh.filter((t) => t.tone === "err").map(announcement);
    const rest = fresh.filter((t) => t.tone !== "err").map(announcement);
    // cleared first, so the same text twice in a row is announced again
    if (errs.length) setAssertive("");
    if (rest.length) setPolite("");
    const id = window.setTimeout(() => {
      if (errs.length) setAssertive(errs.join(" "));
      if (rest.length) setPolite(rest.join(" "));
    }, 60);
    return () => window.clearTimeout(id);
  }, [list]);
  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </div>
  );
}

/** Where the focus was before Alt+T; Esc in a toast (or its close) goes back there. */
let returnFocus: HTMLElement | null = null;

function restoreFocus() {
  const el = returnFocus;
  returnFocus = null;
  if (el && el.isConnected && !el.closest("[inert]")) el.focus({ preventScroll: true });
}

/**
 * Keyboard access to the toasts (Alt+T): focuses the newest visible toast – its first action,
 * else the toast itself. Returns false when there is none.
 */
export function focusNewestToast(): boolean {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".toast-viewport .toast[data-created]")).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
  if (!cards.length) return false;
  const newest = cards.reduce((a, b) => (Number(b.dataset.created) > Number(a.dataset.created) ? b : a));
  const active = document.activeElement as HTMLElement | null;
  if (!active || !active.closest(".toast")) returnFocus = active;
  (newest.querySelector<HTMLElement>(".toast-actions button") ?? newest).focus();
  return true;
}

function ToastCard({ item }: { item: ToastItem }) {
  const t = useT();
  const timer = useRef<ToastTimer | null>(null);

  useEffect(() => {
    const windowAway = () => document.hidden || !document.hasFocus();
    const tm = toastTimer({ durationMs: item.durationMs ?? null, holdWhileUnfocused: item.holdWhileUnfocused, windowAway, onExpire: () => dismissToast(item.id) });
    timer.current = tm;
    tm.start();
    if (!item.holdWhileUnfocused) return () => tm.dispose();
    const away = () => tm.away();
    const back = () => tm.back();
    const vis = () => (document.hidden ? away() : back());
    window.addEventListener("blur", away);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", vis);
    return () => {
      tm.dispose();
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", vis);
    };
    // restart only when the toast is replaced (same id, new content: new createdMs); id,
    // duration and hold flag belong to that same toast item
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on createdMs on purpose
  }, [item.createdMs]);
  const hover = () => timer.current?.pause("hover");
  const unhover = () => timer.current?.resume("hover");
  const focus = () => timer.current?.pause("focus");
  // focus moving between the toast's own buttons, or the window losing focus (the element stays
  // focused and gets its focus back on return), does not release the hold
  const blur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null) || !document.hasFocus()) return;
    timer.current?.resume("focus");
  };

  const tone = item.tone ?? "info";
  const titleId = useId();
  const close = () => {
    const hadFocus = !!document.activeElement?.closest(".toast");
    dismissToast(item.id);
    if (hadFocus) restoreFocus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // the toast only: an open debrief behind it stays open
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  return (
    <div
      className={`toast toast-${tone}${item.className ? ` ${item.className}` : ""}`}
      role="group"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-created={item.createdMs}
      onMouseEnter={hover}
      onMouseLeave={unhover}
      onFocus={focus}
      onBlur={blur}
      onKeyDown={onKeyDown}
    >
      <span className="toast-icon" aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      <div className="toast-main">
        <div className="toast-title" id={titleId}>
          {item.title}
        </div>
        {item.body != null && <div className="toast-body">{item.body}</div>}
        {item.actions && item.actions.length > 0 && (
          <div className="toast-actions">
            {item.actions.map((a) => (
              <button
                key={a.label}
                className="btn btn-sm"
                onClick={() => {
                  a.onClick();
                  if (a.keepOpen) return;
                  dismissToast(item.id);
                  // the button is gone: back to where the focus was, unless the action moved it (debrief)
                  requestAnimationFrame(() => {
                    if (!document.activeElement || document.activeElement === document.body) restoreFocus();
                  });
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="toast-close btn-ghost" onClick={close} aria-label={t("shell.errorNotice.dismiss")} title={t("shell.toast.closeTitle")}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
