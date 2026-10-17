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
 * Escape / outside click close it; Escape returns focus to the anchor.
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
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef]);

  if (!open) return null;
  return (
    <div ref={ref} id={id} className={`popover${className ? ` ${className}` : ""}`} role="dialog" aria-label={label} tabIndex={-1} style={pos}>
      {children}
    </div>
  );
}
