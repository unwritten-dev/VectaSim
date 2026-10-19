import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Collapsible, { CollapsibleView, readSectionOpen, sectionKey, writeSectionOpen } from "./Collapsible";

/** In-memory localStorage for the node test environment. */
function memoryStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

/** Depth-first search of an element tree (CollapsibleView has no hooks, so it can be called directly). */
function find(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (pred(node)) return node;
  return find(node.props.children as ReactNode, pred);
}

const toggleOf = (tree: ReactNode) => find(tree, (el) => el.type === "button")!;

describe("Collapsible", () => {
  let store: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    store = memoryStorage();
    vi.stubGlobal("localStorage", store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is open by default: aria-expanded, body linked by aria-controls, no summary", () => {
    const html = renderToStaticMarkup(
      <Collapsible id="t.open" title="Zeiten" summary="10:00">
        <p>Inhalt</p>
      </Collapsible>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("<p>Inhalt</p>");
    expect(html).not.toContain("10:00");
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });

  it("a stored fold wins over the default; folded it shows the summary and no body", () => {
    store.m.set(sectionKey("t.folded"), "0");
    const html = renderToStaticMarkup(
      <Collapsible id="t.folded" title="Zeiten" summary="10:00">
        <p>Inhalt</p>
      </Collapsible>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("10:00");
    expect(html).not.toContain("Inhalt");
    expect(html).toContain("is-collapsed");
    // defaultOpen=false without a stored choice: folded too
    expect(renderToStaticMarkup(<Collapsible id="t.closedDefault" defaultOpen={false} title="X" />)).toContain('aria-expanded="false"');
  });

  it("clicking the toggle calls onToggle; the choice persists per section id", () => {
    const onToggle = vi.fn();
    const tree = CollapsibleView({ uid: "u", title: "Zeiten", open: true, onToggle, children: "x" });
    (toggleOf(tree).props.onClick as () => void)();
    expect(onToggle).toHaveBeenCalledTimes(1);

    expect(readSectionOpen("live.times")).toBe(true);
    writeSectionOpen("live.times", false);
    expect(store.m.get("vectasim.section.live.times")).toBe("0");
    expect(readSectionOpen("live.times")).toBe(false);
    // another section is not affected
    expect(readSectionOpen("live.weather")).toBe(true);
    writeSectionOpen("live.times", true);
    expect(readSectionOpen("live.times")).toBe(true);
  });

  it("keyboard: the toggle is a native button (Enter and Space activate it), never a submit", () => {
    const tree = CollapsibleView({ uid: "u", title: "Zeiten", open: false, onToggle: () => {}, actions: <a href="#x">Logbuch</a> });
    const btn = toggleOf(tree);
    expect(btn.props.type).toBe("button");
    expect(btn.props["aria-expanded"]).toBe(false);
    expect(btn.props.tabIndex).toBeUndefined();
    // header actions stay outside the toggle (no nested interactive content)
    expect(find(btn.props.children as ReactNode, (el) => el.type === "a")).toBeNull();
    expect(find(tree, (el) => el.type === "a")).not.toBeNull();
  });

  it("works without storage (private mode, blocked site data)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readSectionOpen("t.x")).toBe(true);
    expect(readSectionOpen("t.x", false)).toBe(false);
    expect(() => writeSectionOpen("t.x", false)).not.toThrow();
    expect(renderToStaticMarkup(<Collapsible id="t.x" title="X" />)).toContain('aria-expanded="true"');
  });
});
