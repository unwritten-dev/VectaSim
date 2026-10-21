import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { useT } from "../i18n";
import { FORMAT_SIZE, type CardFormat } from "./text";
import { lightboxKey } from "./layout";
import { Modal } from "../ui/Modal";
import { keepStepFocus } from "../ui/modalStack";

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

/** keepStepFocus (ui/modalStack) for the lightbox arrows. */
export function keepLightboxFocus(
  root: Parameters<typeof keepStepFocus>[0],
  active: Parameters<typeof keepStepFocus>[1],
  body: Element | null,
  close: Parameters<typeof keepStepFocus>[4],
) {
  return keepStepFocus(root, active, body, ".review-lightbox-nav:not(:disabled)", close);
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
 * One story card large, fitted to the window height: a modal over the app (ui/Modal: the shell
 * behind it is inert, the title bar stays usable, Tab stays inside, Esc closes, focus returns to
 * the opening card). Arrow keys step through the cards, a click next to the card closes.
 */
export default function ReviewLightbox(props: LightboxProps) {
  const { index, titles, onIndex, onClose } = props;
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // the modal's extra keys: arrows / Page / Home / End (Esc and Tab are the modal's own)
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.key === "Escape") return;
    const r = lightboxKey(e.key, index, titles.length);
    if (r == null || r === "close") return;
    e.preventDefault();
    onIndex(r.index);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (root) keepLightboxFocus(root, document.activeElement, document.body, closeRef.current);
  }, [index]);

  return (
    <Modal
      className="review-lightbox"
      labelledBy={titleId}
      dialogRef={rootRef}
      onClose={onClose}
      initialFocus={closeRef}
      onKeyDown={onKey}
      // a click next to the card (backdrop, empty stage) closes; the card and the buttons do not
      closeOnBackdrop={(el) => el.classList.contains("review-lightbox-stage") || el.classList.contains("review-lightbox-inner")}
    >
      <LightboxBody {...props} titleId={titleId} closeRef={closeRef} />
    </Modal>
  );
}
