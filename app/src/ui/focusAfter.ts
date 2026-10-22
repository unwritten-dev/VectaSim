// Inline confirmations ("Löschen? Ja / Nein") replace the focused button: without a target the
// focus falls to <body> and a keyboard user starts again at the top of the page.

import { flushSync } from "react-dom";

/** Applies `update` synchronously (the pressed control is gone afterwards), then focuses `target()`. Event handlers only. */
export function focusAfter(update: () => void, target: () => HTMLElement | null | undefined): void {
  flushSync(update);
  target()?.focus();
}
