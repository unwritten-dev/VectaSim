// A section of an information stack (live side panel, flight detail, traffic card) that the
// pilot can fold away: a header row with chevron, title and – while folded – a one-line
// summary; the choice is remembered per section id in localStorage. Default open.
//
// The toggle is a native <button type="button">: click, Enter and Space toggle it (the browser
// fires click for both keys), aria-expanded / aria-controls describe it. Folding is instant (no
// height animation); only the chevron turns, and the global reduced-motion rule stops that too.

import { useCallback, useId, useState, type ReactNode } from "react";
import { Chevron } from "./Panel";

/** localStorage key of a section's open state ("1" open, "0" folded). */
export const sectionKey = (id: string) => `vectasim.section.${id}`;

/** The stored open state of a section, `fallback` when nothing (or nothing readable) is stored. */
export function readSectionOpen(id: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(sectionKey(id));
    return raw === "1" ? true : raw === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}

export function writeSectionOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(sectionKey(id), open ? "1" : "0");
  } catch {
    /* storage unavailable: the section still folds for this session */
  }
}

/** Open state of a section, remembered per id. */
export function useSectionOpen(id: string, defaultOpen = true): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => readSectionOpen(id, defaultOpen));
  const setOpen = useCallback(
    (v: boolean) => {
      setOpenState(v);
      writeSectionOpen(id, v);
    },
    [id],
  );
  return [open, setOpen];
}

interface ViewProps {
  title: ReactNode;
  /** One line shown next to the title while the section is folded (e.g. the key value). */
  summary?: ReactNode;
  /** Controls on the right of the header row (links, small buttons); never inside the toggle. */
  actions?: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Base of the header / body element ids (useId in Collapsible). */
  uid: string;
  /** Extra class of the section (e.g. "side-group"). */
  className?: string;
  /** Extra class of the header row (e.g. "side-group-title"). */
  headClassName?: string;
  /** The header row as a heading of this level (h3 in the flight detail); a plain row by default. */
  level?: 2 | 3 | 4;
  /** Extra class of the body. */
  bodyClassName?: string;
  /** Section attributes passed through (e.g. aria-live). */
  "aria-live"?: "polite" | "off";
  children?: ReactNode;
}

/** The stateless part: no hooks, so tests can call it and click its toggle directly. */
export function CollapsibleView({ title, summary, actions, open, onToggle, uid, className, headClassName, level, bodyClassName, children, ...rest }: ViewProps) {
  const bodyId = `${uid}-body`;
  const headId = `${uid}-head`;
  const Head = level ? (`h${level}` as const) : "div";
  return (
    <section className={`collapsible${className ? ` ${className}` : ""}${open ? "" : " is-collapsed"}`} aria-live={rest["aria-live"]}>
      <Head className={`collapsible-head${headClassName ? ` ${headClassName}` : ""}`}>
        <button type="button" id={headId} className="collapsible-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <Chevron open={open} />
          <span className="collapsible-title">{title}</span>
          {!open && summary != null && summary !== "" && <span className="collapsible-summary">{summary}</span>}
        </button>
        {actions && <span className="collapsible-actions">{actions}</span>}
      </Head>
      {open && (
        <div id={bodyId} className={`collapsible-body${bodyClassName ? ` ${bodyClassName}` : ""}`} role="region" aria-labelledby={headId}>
          {children}
        </div>
      )}
    </section>
  );
}

interface Props extends Omit<ViewProps, "open" | "onToggle" | "uid"> {
  /** Stable id: the open state is stored under vectasim.section.<id>. */
  id: string;
  defaultOpen?: boolean;
}

/** A foldable section whose state survives restarts (per id). */
export default function Collapsible({ id, defaultOpen = true, ...view }: Props) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen);
  const uid = useId();
  return <CollapsibleView {...view} uid={uid} open={open} onToggle={() => setOpen(!open)} />;
}
