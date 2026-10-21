// The shared modal: `useModal` (stack, keys, focus in and back, backdrop) and `<Modal>` (portal,
// backdrop, role="dialog" + aria-modal). The rules themselves live in ./modalStack.ts. Each dialog
// keeps its own look (class names) and keyboard extras (`onKeyDown`, called first and only
// while the dialog is the topmost one).

import { useEffect, useLayoutEffect, useRef, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { acquireModal, flushReturnFocus, isBackdropClick, modalKeyAction, requestReturnFocus, tabbables, trapTab, type ModalHandle } from "./modalStack";

type ElementSource = HTMLElement | null | RefObject<HTMLElement | null> | (() => HTMLElement | null);

export interface UseModalOptions {
  open: boolean;
  onClose: () => void;
  /** First focus inside; default: the first tab stop of the dialog, else the dialog itself. */
  initialFocus?: ElementSource;
  /** Where focus goes after closing; default: the element focused when the modal opened. */
  returnFocus?: ElementSource;
  /** Esc closes (default true); false swallows Esc (e.g. while an import runs). */
  closeOnEscape?: boolean;
  /** A click on the backdrop closes (default false); a function tells backdrop from content. */
  closeOnBackdrop?: boolean | ((target: Element) => boolean);
  /** Extra keys (window, topmost modal only), before Esc/Tab; `preventDefault` skips those. */
  onKeyDown?: (e: KeyboardEvent) => void;
}

export interface ModalBindings {
  /** Outermost element (backdrop, or the dialog when there is none). */
  rootRef: RefObject<HTMLDivElement | null>;
  /** The role="dialog" element (Tab cycles inside it). */
  dialogRef: RefObject<HTMLDivElement | null>;
  /** Handlers for the root element (backdrop click). */
  rootProps: { onMouseDown: (e: ReactMouseEvent) => void; onClick: (e: ReactMouseEvent) => void };
  isTop: () => boolean;
}

function resolve(src: ElementSource | undefined): HTMLElement | null {
  if (src == null) return null;
  if (typeof src === "function") return src();
  if ("current" in src) return src.current;
  return src;
}

/**
 * One opening of a modal (the body of useModal's effect, outside React so the tests can run it
 * – including StrictMode's setup → cleanup → setup – against a fake document): stack entry,
 * keys, focus in; the cleanup releases the entry and asks for the focus to go back.
 */
export function openModalSession(
  options: () => UseModalOptions,
  refs: { root: () => HTMLElement | null; dialog: () => HTMLElement | null },
  onHandle?: (h: ModalHandle | null) => void,
): () => void {
  // a modal that closed in this same commit gives its focus back first (StrictMode's re-run,
  // one dialog replacing another), so the opener seen here is the real one
  flushReturnFocus();
  const opener = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    const o = options();
    o.onKeyDown?.(e);
    const action = modalKeyAction(e, o.closeOnEscape !== false);
    if (action === "close" || action === "block") {
      e.preventDefault();
      if (action === "close") o.onClose();
    } else if (action === "tab") trapTab(e, refs.dialog());
  };
  const handle = acquireModal({ root: refs.root, onKey });
  onHandle?.(handle);
  const dialog = refs.dialog();
  const first = resolve(options().initialFocus) ?? (dialog ? tabbables(dialog)[0] : null) ?? dialog;
  first?.focus({ preventScroll: true });
  return () => {
    handle.release();
    onHandle?.(null);
    // after every cleanup of this commit (nested modals closing together)
    requestReturnFocus([resolve(options().returnFocus), opener]);
  };
}

export function useModal(options: UseModalOptions): ModalBindings {
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ModalHandle | null>(null);
  const downRef = useRef<EventTarget | null>(null);
  // latest options for the one key listener and the cleanup, so the setup runs once per opening
  const opts = useRef(options);
  useLayoutEffect(() => {
    opts.current = options;
  });

  const { open } = options;
  useEffect(() => {
    if (!open) return;
    return openModalSession(
      () => opts.current,
      { root: () => rootRef.current, dialog: () => dialogRef.current },
      (h) => (handleRef.current = h),
    );
  }, [open]);

  const isBackdrop = (t: EventTarget | null): boolean => {
    const rule = opts.current.closeOnBackdrop;
    if (!rule || !(t instanceof Element)) return false;
    return t === rootRef.current || (typeof rule === "function" && rule(t));
  };

  return {
    rootRef,
    dialogRef,
    rootProps: {
      onMouseDown: (e) => {
        downRef.current = e.target;
      },
      onClick: (e) => {
        const down = downRef.current;
        downRef.current = null;
        if (handleRef.current?.isTop() && isBackdropClick(down, e.target, isBackdrop)) opts.current.onClose();
      },
    },
    isTop: () => handleRef.current?.isTop() ?? false,
  };
}

export interface ModalProps extends Omit<UseModalOptions, "open">, Omit<HTMLAttributes<HTMLDivElement>, "onKeyDown" | "role"> {
  /** Default true: callers that mount the modal only while it is open can leave it out. */
  open?: boolean;
  /** Class of the backdrop around the dialog; without it the dialog is the full overlay. */
  backdropClassName?: string;
  /** Id(s) of the title (aria-labelledby); `aria-label` works as well. */
  labelledBy?: string;
  /** Id(s) of the description (aria-describedby). */
  describedBy?: string;
  /** The role="dialog" element, for callers that need it (e.g. focus rules of their own). */
  dialogRef?: Ref<HTMLDivElement>;
  /** Portal target; default <body>. Without a DOM (static render in tests) it renders inline. */
  container?: Element;
  children: ReactNode;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/** A modal dialog: portal, optional backdrop, focus trap, Esc on the topmost only, focus back. */
export function Modal({
  open = true,
  onClose,
  initialFocus,
  returnFocus,
  closeOnEscape,
  closeOnBackdrop,
  onKeyDown,
  backdropClassName,
  labelledBy,
  describedBy,
  dialogRef: outerDialogRef,
  container,
  className,
  children,
  ...rest
}: ModalProps) {
  const m = useModal({ open, onClose, initialFocus, returnFocus, closeOnEscape, closeOnBackdrop, onKeyDown });
  if (!open) return null;
  const dialogRefCb = (el: HTMLDivElement | null) => {
    m.dialogRef.current = el;
    setRef(outerDialogRef, el);
    if (!backdropClassName) m.rootRef.current = el;
  };
  const dialog = (
    <div
      {...rest}
      ref={dialogRefCb}
      className={backdropClassName ? className : `modal-root${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
      {...(backdropClassName ? {} : m.rootProps)}
    >
      {children}
    </div>
  );
  const tree = backdropClassName ? (
    <div ref={m.rootRef} className={`modal-root ${backdropClassName}`} {...m.rootProps}>
      {dialog}
    </div>
  ) : (
    dialog
  );
  if (typeof document === "undefined") return tree;
  return createPortal(tree, container ?? document.body);
}
