// The one modal module (logic part; the hook and the component are in Modal.tsx). Every
// dialog – landing debrief, review lightbox, CSV import, runway editor – registers here:
//
// - a stack of open modals (a counter, not a flag): the shell behind (`.shell-body`) is inert
//   and <body> carries `modal-open` while at least one modal is open, and every modal below
//   the topmost one is inert as well, so closing the debrief opened over the lightbox does not
//   make the background usable again and Tab never reaches the lightbox under the debrief;
// - one window keydown listener that hands each key to the topmost modal only (Esc closes the
//   innermost layer, Tab cycles inside it, its own extras such as the lightbox arrows);
// - the pure focus rules: tab order, wrap-around, where focus goes back after closing;
// - the backdrop rule: a click closes only when it both started and ended on the backdrop.
//
// The global view shortcuts (Ctrl+1…4, App.tsx) stay off while `isModalOpen()`.

export interface ModalHandle {
  /** True while this modal is the topmost one. */
  isTop: () => boolean;
  /** Close bookkeeping; idempotent and order-independent. */
  release: () => void;
}

export interface ModalEntryOptions {
  /** Outermost element of the modal (made inert while another modal is above it). */
  root?: () => HTMLElement | null;
  /** Keys while this modal is the topmost one. */
  onKey?: (e: KeyboardEvent) => void;
}

interface Entry {
  id: symbol;
  root?: () => HTMLElement | null;
  onKey?: (e: KeyboardEvent) => void;
  /** The root element this module made inert (only that one is cleared again). */
  inerted: HTMLElement | null;
}

const stack: Entry[] = [];
/** Scroll position of the background when the first modal opened, and the view it belongs to. */
let scrollSnapshot: Array<{ el: Element; top: number; left: number }> = [];
let snapshotView: string | null = null;
/** The view (App's scroll key) the background shows now. */
let currentView: string | null = null;

/**
 * App reports the view behind the modals (its scroll key, in a layout effect). A modal that
 * switched the view ("Im Logbuch" in the debrief) does not write the old view's scroll position
 * into the new one when it closes.
 */
export function noteScrollView(view: string | null): void {
  currentView = view;
}

const hasDom = () => typeof document !== "undefined";
const hasWindow = () => typeof window !== "undefined" && typeof window.addEventListener === "function";

/** The single listener: only the topmost modal sees a key. Exported for the tests. */
export function dispatchModalKey(e: KeyboardEvent): void {
  stack[stack.length - 1]?.onKey?.(e);
}

function snapshotScroll() {
  scrollSnapshot = [];
  snapshotView = currentView;
  const els = [document.scrollingElement, document.querySelector?.("main.layout")];
  for (const el of els) if (el) scrollSnapshot.push({ el, top: el.scrollTop, left: el.scrollLeft });
}

function restoreScroll() {
  const sameView = snapshotView === currentView;
  snapshotView = null;
  if (!sameView) {
    scrollSnapshot = [];
    return;
  }
  for (const s of scrollSnapshot) {
    if (s.el.scrollTop !== s.top) s.el.scrollTop = s.top;
    if (s.el.scrollLeft !== s.left) s.el.scrollLeft = s.left;
  }
  scrollSnapshot = [];
}

function sync() {
  if (!hasDom()) return;
  const open = stack.length > 0;
  const behind = document.querySelector<HTMLElement>(".shell-body");
  if (open) behind?.setAttribute("inert", "");
  else behind?.removeAttribute("inert");
  document.body.classList.toggle("modal-open", open);
  stack.forEach((entry, i) => {
    const top = i === stack.length - 1;
    const el = entry.root?.() ?? null;
    if (!top && el && entry.inerted !== el) {
      el.setAttribute("inert", "");
      entry.inerted = el;
    } else if (top && entry.inerted) {
      entry.inerted.removeAttribute("inert");
      entry.inerted = null;
    }
  });
}

export function acquireModal(options: ModalEntryOptions = {}): ModalHandle {
  const entry: Entry = { id: Symbol("modal"), root: options.root, onKey: options.onKey, inerted: null };
  if (stack.length === 0) {
    if (hasDom()) snapshotScroll();
    if (hasWindow()) window.addEventListener("keydown", dispatchModalKey);
  }
  stack.push(entry);
  sync();
  return {
    isTop: () => stack[stack.length - 1] === entry,
    release: () => {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      entry.inerted?.removeAttribute("inert");
      entry.inerted = null;
      sync();
      if (stack.length === 0) {
        if (hasWindow()) window.removeEventListener("keydown", dispatchModalKey);
        if (hasDom()) restoreScroll();
      }
    },
  };
}

/** Any modal open (global shortcuts stay off). */
export function isModalOpen(): boolean {
  return stack.length > 0;
}

/** Outermost element of the topmost modal, if any. */
export function topModalRoot(): HTMLElement | null {
  return stack[stack.length - 1]?.root?.() ?? null;
}

// ---- focus ---------------------------------------------------------------------------------

/** Candidates for keyboard focus; `tabIndex >= 0`, visibility and inertness are checked after. */
export const TABBABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [contenteditable]:not([contenteditable="false"]), [tabindex]';

/**
 * Sequential focus order: positive tabindex first (ascending, ties in DOM order), then the
 * tabindex-0 elements in DOM order; negative ones are not tab stops.
 */
export function tabOrder<T extends { tabIndex: number }>(items: readonly T[]): T[] {
  const positive = items
    .map((el, i) => ({ el, i }))
    .filter(({ el }) => el.tabIndex > 0)
    .sort((a, b) => a.el.tabIndex - b.el.tabIndex || a.i - b.i)
    .map(({ el }) => el);
  return [...positive, ...items.filter((el) => el.tabIndex === 0)];
}

/**
 * Where Tab / Shift+Tab goes inside a dialog with `count` tab stops when focus is on stop
 * `current` (-1: on none of them, e.g. the dialog itself or a toast-free body). Returns the
 * index to focus, -1 when there is nothing to focus (keep focus, swallow the key), or null to
 * leave the step to the browser (it stays inside: not at either end).
 */
export function nextTabStop(count: number, current: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}

/** Visible, not inert tab stops inside `root`, in tab order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.getClientRects().length === 0 || el.closest("[inert]")) return false;
    // visibility:hidden keeps its box but is no tab stop
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) return false;
    // a radio group is one tab stop: the checked radio (native radios only; Segmented roves itself)
    const input = el.tagName === "INPUT" ? (el as HTMLInputElement) : null;
    if (input && input.type === "radio" && input.name && !input.checked) {
      const group = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(input.name)}"]`));
      return !group.some((r) => r.checked) && group[0] === input;
    }
    return true;
  });
  return tabOrder(all);
}

/**
 * Tab / Shift+Tab from stop `index` of a group of `count` stops (a toast reached with Alt+T)
 * leaves the group: past its last stop, or before its first. Not on a stop (the toast card
 * itself): the browser steps to the card's own buttons, unless there are none.
 */
export function leavesGroup(count: number, index: number, shift: boolean): boolean {
  if (index < 0) return count === 0;
  return shift ? index === 0 : index === count - 1;
}

/** The toast viewport stays usable above every modal (Alt+T). */
const TOAST_VIEWPORT = ".toast-viewport";

/**
 * Tab / Shift+Tab cycle inside `root`. Focus in a toast (the toast viewport stays usable above
 * every modal) keeps the normal order among the toasts; leaving them goes back into the dialog
 * instead of on to the title bar (not inert, for the window controls). Focus anywhere else
 * outside that is not <body> is left alone.
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && root.contains(active);
  if (active && !inside && active !== document.body) {
    const viewport = active.closest<HTMLElement>(TOAST_VIEWPORT);
    if (!viewport) return;
    const own = tabbables(viewport);
    if (!leavesGroup(own.length, own.indexOf(active), e.shiftKey)) return;
    const items = tabbables(root);
    e.preventDefault();
    if (items.length) items[e.shiftKey ? items.length - 1 : 0].focus();
    else root.focus({ preventScroll: true });
    return;
  }
  const items = tabbables(root);
  const to = nextTabStop(items.length, inside && active ? items.indexOf(active) : -1, e.shiftKey);
  if (to == null) return;
  e.preventDefault();
  if (to >= 0) items[to].focus();
  else root.focus({ preventScroll: true });
}

type Focusable = { focus: (o?: FocusOptions) => void };

/**
 * After a step in a dialog with ‹/› buttons (review lightbox, debrief pager): when the focused
 * arrow just got disabled (first/last item), Chromium drops the focus to <body> and a screen
 * reader loses its place – move it to the arrow that is still enabled (`enabledArrow`, a
 * selector inside `root`), else to `fallback` ("Schließen"). A focus elsewhere (a toast via
 * Alt+T, another control) stays. Returns the element focused, null when nothing moved.
 */
export function keepStepFocus(
  root: { contains: (n: Node | null) => boolean; querySelector: (sel: string) => Focusable | null },
  active: (Element & { disabled?: boolean }) | null,
  body: Element | null,
  enabledArrow: string,
  fallback: Focusable | null,
): Focusable | null {
  const lost = !active || active === body || (root.contains(active) && active.disabled === true);
  if (!lost) return null;
  const target = root.querySelector(enabledArrow) ?? fallback;
  target?.focus({ preventScroll: true });
  return target;
}

/** First candidate that can take focus (`usable`), else null. */
export function chooseReturnFocus<T>(candidates: ReadonlyArray<T | null | undefined>, usable: (el: T) => boolean): T | null {
  for (const c of candidates) if (c != null && usable(c)) return c;
  return null;
}

/** An element focus can go back to: still in the document, not <body>, not behind a modal. */
export function isFocusTarget(el: HTMLElement): boolean {
  return el.isConnected && el !== document.body && !el.closest("[inert]");
}

/** Fallback when neither the given element nor the opener can take focus back. */
export const FALLBACK_FOCUS = "main.layout";

/**
 * Where focus goes after one or more modals closed together: the first request (each one the
 * closed modal's `returnFocus` and opener) with a usable candidate, else `fallbacks` (the modal
 * now on top, main.layout). Nested modals closing in one commit (debrief with the runway editor
 * open, closed from outside): the editor's opener went with the debrief, the debrief's opener
 * is the one that counts – whatever order the cleanups ran in.
 */
export function pickReturnFocus<T>(
  requests: ReadonlyArray<ReadonlyArray<T | null | undefined>>,
  usable: (el: T) => boolean,
  fallbacks: ReadonlyArray<T | null | undefined>,
): T | null {
  for (const r of requests) {
    const hit = chooseReturnFocus(r, usable);
    if (hit) return hit;
  }
  return chooseReturnFocus(fallbacks, usable);
}

let pendingReturns: Array<ReadonlyArray<HTMLElement | null | undefined>> = [];

/**
 * A modal closed: give focus back once every cleanup of this commit has run (a microtask), so a
 * modal closed together with the one below it does not see that one's opener still inert.
 * A modal opening first (`flushReturnFocus` in its setup – StrictMode's re-run, one dialog
 * replacing another) takes the focus over right away.
 */
export function requestReturnFocus(candidates: ReadonlyArray<HTMLElement | null | undefined>, schedule: (cb: () => void) => void = queueMicrotask): void {
  pendingReturns.push(candidates);
  if (pendingReturns.length === 1) schedule(() => void flushReturnFocus());
}

/** Run a pending focus return now; returns the element focused (null: none pending or usable). */
export function flushReturnFocus(usable: (el: HTMLElement) => boolean = isFocusTarget): HTMLElement | null {
  const requests = pendingReturns;
  pendingReturns = [];
  if (requests.length === 0 || !hasDom()) return null;
  const top = topModalRoot();
  const target = pickReturnFocus(requests, usable, [top ? (tabbables(top)[0] ?? top) : null, document.querySelector<HTMLElement>(FALLBACK_FOCUS)]);
  target?.focus({ preventScroll: true });
  return target;
}

/** Tests: drop pending focus returns. */
export function resetReturnFocusForTests(): void {
  pendingReturns = [];
}

// ---- keys and backdrop --------------------------------------------------------------------

export type ModalKeyAction = "close" | "block" | "tab" | null;

/**
 * What the topmost modal does with a key: Esc closes (or is swallowed while closing is off,
 * e.g. during the CSV import), Tab is trapped; a key some inner layer already handled
 * (a popover's Esc, the airframe picker) is left alone, and so is a key of an IME composition.
 */
export function modalKeyAction(e: Pick<KeyboardEvent, "key" | "defaultPrevented"> & { isComposing?: boolean }, closeOnEscape: boolean): ModalKeyAction {
  // Esc during an IME composition cancels the composition, not the dialog
  if (e.defaultPrevented || e.isComposing) return null;
  if (e.key === "Escape") return closeOnEscape ? "close" : "block";
  if (e.key === "Tab") return "tab";
  return null;
}

/**
 * A click closes on the backdrop only when the press started there too (a text selection
 * dragged out of the dialog does not close it). `isBackdrop` tells backdrop from content.
 */
export function isBackdropClick<T>(down: T | null, up: T | null, isBackdrop: (t: T) => boolean): boolean {
  return down != null && up != null && isBackdrop(down) && isBackdrop(up);
}
