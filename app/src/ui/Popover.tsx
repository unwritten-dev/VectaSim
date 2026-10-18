import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name of the dialog. */
  label: string;
  /** "right-end": right of the anchor, bottom-aligned (sidebar footer); "bottom-end": below, right-aligned. */
  placement?: "right-end" | "bottom-end";
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Non-modal popover dialog anchored to a button. Focus moves into it on open,
 * Escape / outside click / tabbing out close it; Escape returns focus to the anchor.
 * Escape is handled on `document` (bubble) and stopped there, so a modal around it (the
 * debrief listens on `window`) stays open: the innermost layer closes first.
 */
export default function Popover({ open, onClose, anchorRef, label, placement = "right-end", id, className, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      if (placement === "right-end") setPos({ left: a.right + 8, bottom: Math.max(8, window.innerHeight - a.bottom) });
      else setPos({ right: Math.max(8, window.innerWidth - a.right), top: a.bottom + 6 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchorRef, placement]);

  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
    (first ?? ref.current)?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    // focus left popover and anchor (Tab past the last item): close instead of covering content;
    // no related target = the window lost focus (pilot back in the sim), keep it open
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (!next || ref.current?.contains(next) || anchorRef.current?.contains(next)) return;
      onCloseRef.current();
    };
    const el = ref.current;
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    el?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      el?.removeEventListener("focusout", onFocusOut);
    };
  }, [open, anchorRef]);

  if (!open) return null;
  return (
    <div ref={ref} id={id} className={`popover${className ? ` ${className}` : ""}`} role="dialog" aria-label={label} tabIndex={-1} style={pos}>
      {children}
    </div>
  );
}
