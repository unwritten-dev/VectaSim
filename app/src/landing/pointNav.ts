// Keyboard model for the points of a scatter plot (Streubild, Anflüge): one tab stop for
// the whole plot (roving tabindex), arrows move between the points in time order, Home/End
// jump to the oldest/newest, Enter or Space opens the landing. Without it every point was
// its own tab stop (20 in a row).

import { useState, type KeyboardEvent } from "react";

/** Data attribute that carries the point's index (time order) for focusing. */
export const POINT_ATTR = "data-pt";

export function usePointNav(count: number) {
  const [current, setCurrent] = useState<number | null>(null);
  // the newest point (last in time order) is the default tab stop
  const active = current != null && current < count ? current : count - 1;

  /** Props of point `i` (time order); `onFocus` runs in addition (hover highlight). */
  const props = (i: number, open: () => void, onFocus?: () => void) => ({
    [POINT_ATTR]: i,
    tabIndex: i === active ? 0 : -1,
    onFocus: () => {
      setCurrent(i);
      onFocus?.();
    },
    onKeyDown: (e: KeyboardEvent<SVGElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
        return;
      }
      const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -1e9, End: 1e9 };
      if (!(e.key in step)) return;
      e.preventDefault();
      const next = Math.max(0, Math.min(count - 1, i + step[e.key]));
      const root = e.currentTarget.ownerSVGElement ?? e.currentTarget.closest("svg");
      root?.querySelector<SVGElement>(`[${POINT_ATTR}="${next}"]`)?.focus();
      setCurrent(next);
    },
  });

  return { props };
}
