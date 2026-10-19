import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { FORMAT_SIZE, type CardFormat } from "./text";
import { lightboxKey } from "./layout";
import { acquireModal } from "../ui/modalStack";

const FOCUSABLE = "button:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export interface LightboxProps {
  /** Card titles in display order. */
  titles: string[];
  index: number;
  format: CardFormat;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** The card itself (SVG scaled by its viewBox). */
  children: ReactNode;
  /** Save/Copy buttons for the shown card. */
  actions: ReactNode;
}

type Focusable = { focus: (o?: FocusOptions) => void };

/**
 * After a step: when ‹/› just got disabled under the focus (first/last card), Chromium drops the
 * focus to <body> and a screen reader loses its place – move it to the arrow that is still
 * enabled, else to "Schließen". Focus elsewhere (a toast via Alt+T, another control) stays.
 */
export function keepLightboxFocus(
  root: { contains: (n: Node | null) => boolean; querySelector: (sel: string) => Focusable | null },
  active: (Element & { disabled?: boolean }) | null,
  body: Element | null,
  close: Focusable | null,
): Focusable | null {
  const lost = !active || active === body || (root.contains(active) && active.disabled === true);
  if (!lost) return null;
  const target = root.querySelector(".review-lightbox-nav:not(:disabled)") ?? close;
  target?.focus({ preventScroll: true });
  return target;
}

/** Inner part of the single-card view, without portal and effects (also rendered by the tests). */
export function LightboxBody({ titles, index, format, onIndex, onClose, children, actions, titleId, closeRef }: LightboxProps & { titleId: string; closeRef?: Ref<HTMLButtonElement> }) {
  const t = useT();
  const { w, h } = FORMAT_SIZE[format];
  const count = titles.length;
  return (
    <div className="review-lightbox-inner">
      <div className="review-lightbox-bar">
        <h2 id={titleId} className="review-lightbox-title">
          {titles[index]}
        </h2>
        <span className="detail num">{t("review.lightbox.position", { n: index + 1, total: count })}</span>
        <span className="detail review-lightbox-hint">{t("review.lightbox.hint")}</span>
        <div className="spacer" />
        {actions}
        <button ref={closeRef} className="btn btn-sm" onClick={onClose}>
          {t("review.lightbox.close")}
        </button>
      </div>
      <div className="review-lightbox-stage">
        <button className="btn review-lightbox-nav" disabled={index <= 0} aria-label={t("review.lightbox.prev")} title={t("review.lightbox.prev")} onClick={() => onIndex(index - 1)}>
          ‹
        </button>
        <div className={`review-lightbox-card review-lightbox-${format}`} style={{ "--review-ar": w / h } as CSSProperties}>
          {children}
        </div>
        <button className="btn review-lightbox-nav" disabled={index >= count - 1} aria-label={t("review.lightbox.next")} title={t("review.lightbox.next")} onClick={() => onIndex(index + 1)}>
          ›
        </button>
      </div>
    </div>
  );
}

/**
 * One story card large, fitted to the window height: a modal over the app (the shell behind
 * it is inert, the title bar stays usable). Arrow keys step through the cards, Esc or a click
 * next to the card closes, Tab stays inside; focus returns to the opening card afterwards.
 */
export default function ReviewLightbox(props: LightboxProps) {
  const { index, titles, onIndex, onClose } = props;
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // latest values for the one window listener
  const state = useRef({ index, count: titles.length, onIndex, onClose });
  state.current = { index, count: titles.length, onIndex, onClose };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const modal = acquireModal();
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!modal.isTop()) return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Tab") {
        const root = rootRef.current;
        if (!root) return;
        const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const active = document.activeElement;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (active === first || !root.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.contains(active))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      const s = state.current;
      const r = lightboxKey(e.key, s.index, s.count);
      if (r == null) return;
      e.preventDefault();
      if (r === "close") s.onClose();
      else s.onIndex(r.index);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      modal.release();
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (root) keepLightboxFocus(root, document.activeElement, document.body, closeRef.current);
  }, [index]);

  return createPortal(
    <div
      ref={rootRef}
      className="review-lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        // a click next to the card (backdrop, empty stage) closes; the card and the buttons do not
        const el = e.target as HTMLElement;
        if (el === e.currentTarget || el.classList.contains("review-lightbox-stage") || el.classList.contains("review-lightbox-inner")) onClose();
      }}
    >
      <LightboxBody {...props} titleId={titleId} closeRef={closeRef} />
    </div>,
    document.body,
  );
}
