// "F" toggles the flight detail's full-screen track view. The full-screen dialog listens at the
// window (Modal onKeyDown), so the key must be left alone while the pilot types or picks
// something, and while the focus is outside the dialog (a toast focused with Alt+T).

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

type TargetLike = { tagName?: string; isContentEditable?: boolean };

/** Text fields, selects and editable content keep their keys. */
function editable(target: EventTarget | null): boolean {
  const el = target as TargetLike | null;
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** Plain "F" (no modifier) on a target that is no editable control – and inside `within` when given. */
export function isFullscreenKey(e: KeyLike, within?: { contains(node: Node | null): boolean } | null): boolean {
  if (e.key.toLowerCase() !== "f" || e.ctrlKey || e.altKey || e.metaKey || editable(e.target)) return false;
  return within == null || within.contains(e.target as Node | null);
}
