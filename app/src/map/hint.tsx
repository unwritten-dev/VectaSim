// Map toolbar explanations for keyboard and screen-reader users. The toolbars explained their
// buttons only in `title`, which shows on mouse hover and is not reliably read by screen readers
// (nor shown on keyboard focus). Each explained control now also points at a hidden description
// via aria-describedby; `title` stays for the mouse tooltip. A hidden element is a valid
// description source and takes no space in the toolbar's flex layout.

import { useId, type ReactNode } from "react";

export interface Hint {
  /** For the control: `aria-describedby` (undefined without a text). */
  describedBy: string | undefined;
  /** Render next to the control (null without a text). */
  node: ReactNode;
}

/** A description for one control. */
export function hintFor(id: string, text: string | null | undefined): Hint {
  if (!text) return { describedBy: undefined, node: null };
  return {
    describedBy: id,
    node: (
      <span id={id} hidden>
        {text}
      </span>
    ),
  };
}

/** Hook form of hintFor with a stable id. */
export function useHint(text: string | null | undefined): Hint {
  return hintFor(`hint-${useId()}`, text);
}

/** Several descriptions (menu items) under one stable id prefix. */
export function useHintIds(): (key: string, text: string | null | undefined) => Hint {
  const base = `hint-${useId()}`;
  return (key, text) => hintFor(`${base}-${key}`, text);
}
