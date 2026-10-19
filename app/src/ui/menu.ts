// Keyboard model of the small dropdown menus (role="menu": logbook tag filter, export menu):
// opening focuses the first item, ↑/↓ wrap, Home/End jump, Esc closes and returns the focus to
// the trigger, Tab closes (the focus moves on as usual).

import type { KeyboardEvent } from "react";

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** Index of the item to focus for `key`, or null when the key is not a menu movement. */
export function menuKeyIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function menuItems(list: HTMLElement | null): HTMLElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLElement>(ITEM)) : [];
}

/** onKeyDown of the menu's wrapper (trigger + list). Returns true when it handled the key. */
export function handleMenuKey(e: KeyboardEvent, open: boolean, list: HTMLElement | null, trigger: HTMLElement | null, close: () => void): boolean {
  if (!open) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
    trigger?.focus();
    return true;
  }
  if (e.key === "Tab") {
    close();
    return false;
  }
  const items = menuItems(list);
  const next = menuKeyIndex(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
  if (next == null) return false;
  e.preventDefault();
  items[next]?.focus();
  return true;
}
