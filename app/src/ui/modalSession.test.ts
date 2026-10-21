import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openModalSession, type UseModalOptions } from "./Modal";
import { isModalOpen, leavesGroup, modalKeyAction, noteScrollView, resetReturnFocusForTests } from "./modalStack";

// node environment: a minimal document – the shell (made inert while a modal is open), its
// main.layout, and elements that know whether they are connected and whether an inert
// ancestor hides them. Enough to run useModal's effect body (openModalSession) for real.

interface FakeEl {
  name: string;
  isConnected: boolean;
  tabIndex: number;
  scrollTop: number;
  scrollLeft: number;
  inert: boolean;
  parent: FakeEl | null;
  focus: (o?: FocusOptions) => void;
  closest: (sel: string) => FakeEl | null;
  setAttribute: (n: string) => void;
  removeAttribute: (n: string) => void;
  querySelectorAll: () => FakeEl[];
  contains: (n: unknown) => boolean;
  getClientRects: () => unknown[];
}

const doc = {
  activeElement: null as FakeEl | null,
  body: null as unknown as FakeEl,
  scrollingElement: null as FakeEl | null,
  querySelector: (sel: string): FakeEl | null => (sel === ".shell-body" ? shell : sel === "main.layout" ? main : null),
};

function el(name: string, parent: FakeEl | null = null): FakeEl {
  const e: FakeEl = {
    name,
    isConnected: true,
    tabIndex: 0,
    scrollTop: 0,
    scrollLeft: 0,
    inert: false,
    parent,
    focus: () => {
      doc.activeElement = e;
    },
    closest: (sel) => {
      if (sel !== "[inert]") return null;
      for (let c: FakeEl | null = e; c; c = c.parent) if (c.inert) return c;
      return null;
    },
    setAttribute: (n) => void (n === "inert" && (e.inert = true)),
    removeAttribute: (n) => void (n === "inert" && (e.inert = false)),
    querySelectorAll: () => [],
    contains: (n) => {
      for (let c = n as FakeEl | null; c; c = c.parent) if (c === e) return true;
      return false;
    },
    getClientRects: () => [{}],
  };
  return e;
}

/** Detach an element and everything below it (React removed the modal's DOM). */
const detach = (...els: FakeEl[]) => els.forEach((e) => (e.isConnected = false));

let shell: FakeEl;
let main: FakeEl;
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

function session(o: Partial<UseModalOptions> & { root: FakeEl; dialog?: FakeEl }) {
  const options: UseModalOptions = { open: true, onClose: () => {}, ...o };
  return () => openModalSession(() => options, { root: () => o.root as unknown as HTMLElement, dialog: () => (o.dialog ?? o.root) as unknown as HTMLElement });
}

beforeEach(() => {
  resetReturnFocusForTests();
  shell = el("shell");
  main = el("main", shell);
  doc.body = Object.assign(el("body"), { classList: { toggle: () => {} } });
  doc.activeElement = doc.body;
  doc.scrollingElement = null;
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  noteScrollView(null);
});
afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

describe("useModal session (openModalSession)", () => {
  it("focus goes in (initialFocus) and back to the opener once the shell is usable again", async () => {
    const opener = el("debrief button", main);
    opener.focus();
    const root = el("debrief");
    const close = el("close", root);
    const stop = session({ root, initialFocus: close as unknown as HTMLElement })();
    expect(doc.activeElement).toBe(close);
    expect(shell.inert).toBe(true);
    stop();
    detach(root, close);
    expect(isModalOpen()).toBe(false);
    await flushMicrotasks();
    expect(doc.activeElement).toBe(opener);
  });

  it("StrictMode (setup → cleanup → setup): ends inside the dialog, and the opener is still the real one", async () => {
    const opener = el("toast button", main);
    opener.focus();
    const root = el("lightbox");
    const close = el("close", root);
    const run = session({ root, initialFocus: close as unknown as HTMLElement });
    const first = run();
    first();
    const second = run();
    expect(doc.activeElement).toBe(close);
    await flushMicrotasks();
    // the first cleanup's focus return does not land after the second setup
    expect(doc.activeElement).toBe(close);
    expect(isModalOpen()).toBe(true);
    second();
    detach(root, close);
    await flushMicrotasks();
    expect(doc.activeElement).toBe(opener);
  });

  it.each([
    ["outer cleanup first", true],
    ["inner cleanup first", false],
  ])("nested modals closing in one commit (%s): focus goes to the outer modal's opener", async (_label, outerFirst) => {
    const opener = el("logbook button", main);
    opener.focus();
    const debrief = el("debrief");
    const debriefClose = el("debrief close", debrief);
    const stopDebrief = session({ root: debrief, initialFocus: debriefClose as unknown as HTMLElement })();
    const editButton = el("correct runway", debrief);
    editButton.focus();
    const editor = el("runway editor");
    const stopEditor = session({ root: editor })();
    expect(debrief.inert).toBe(true);
    // closeDebrief() from outside: React removes both trees, then runs both cleanups
    detach(debrief, debriefClose, editButton, editor);
    if (outerFirst) {
      stopDebrief();
      stopEditor();
    } else {
      stopEditor();
      stopDebrief();
    }
    await flushMicrotasks();
    expect(doc.activeElement).toBe(opener);
  });

  it("only the inner modal closes: focus back to its opener inside the outer one", async () => {
    const debrief = el("debrief");
    const stopDebrief = session({ root: debrief })();
    const editButton = el("correct runway", debrief);
    editButton.focus();
    const editor = el("runway editor");
    const stopEditor = session({ root: editor })();
    stopEditor();
    detach(editor);
    await flushMicrotasks();
    expect(debrief.inert).toBe(false);
    expect(doc.activeElement).toBe(editButton);
    stopDebrief();
  });

  it("falls back to main.layout when the opener is gone", async () => {
    const opener = el("toast button");
    opener.focus();
    const root = el("dialog");
    const stop = session({ root })();
    detach(opener, root);
    stop();
    await flushMicrotasks();
    expect(doc.activeElement).toBe(main);
  });

  it("restores the background scroll only into the view it was taken from", () => {
    const page = el("scrolling element");
    doc.scrollingElement = page;
    noteScrollView("logbook:landings");
    main.scrollTop = 420;
    const root = el("debrief");
    const stop = session({ root })();
    main.scrollTop = 0;
    stop();
    expect(main.scrollTop).toBe(420);

    // "Im Logbuch" switched the view while the debrief was open
    const stop2 = session({ root })();
    noteScrollView("logbook:flights");
    main.scrollTop = 0;
    stop2();
    expect(main.scrollTop).toBe(0);
  });
});

describe("modal keys", () => {
  it("Esc during an IME composition does not close", () => {
    expect(modalKeyAction({ key: "Escape", defaultPrevented: false, isComposing: true }, true)).toBeNull();
    expect(modalKeyAction({ key: "Escape", defaultPrevented: false, isComposing: false }, true)).toBe("close");
  });

  it("Tab out of the toasts (Alt+T) goes back into the dialog, not on to the title bar", () => {
    expect(leavesGroup(2, 1, false)).toBe(true);
    expect(leavesGroup(2, 0, false)).toBe(false);
    expect(leavesGroup(2, 0, true)).toBe(true);
    expect(leavesGroup(2, 1, true)).toBe(false);
    // on the card itself: the browser steps to its buttons
    expect(leavesGroup(2, -1, false)).toBe(false);
    expect(leavesGroup(0, -1, false)).toBe(true);
  });
});
