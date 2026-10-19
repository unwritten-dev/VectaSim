// Shared stack of open modals (landing debrief, review lightbox, CSV import). The shell behind
// is inert and <body> carries `modal-open` while at least one modal is open – a counter, so
// closing a modal opened on top of another (debrief over the lightbox via Alt+T) does not make
// the background usable again. Only the topmost modal handles keys (Esc, Tab, arrows), and the
// global view shortcuts (Ctrl+1…4) stay off while any modal is open.

export interface ModalHandle {
  /** True while this modal is the topmost one. */
  isTop: () => boolean;
  /** Close bookkeeping; idempotent. */
  release: () => void;
}

const stack: symbol[] = [];

function sync() {
  const open = stack.length > 0;
  const behind = document.querySelector<HTMLElement>(".shell-body");
  if (open) behind?.setAttribute("inert", "");
  else behind?.removeAttribute("inert");
  document.body.classList.toggle("modal-open", open);
}

export function acquireModal(): ModalHandle {
  const id = Symbol("modal");
  stack.push(id);
  sync();
  return {
    isTop: () => stack[stack.length - 1] === id,
    release: () => {
      const i = stack.indexOf(id);
      if (i < 0) return;
      stack.splice(i, 1);
      sync();
    },
  };
}

/** Any modal open (global shortcuts stay off). */
export function isModalOpen(): boolean {
  return stack.length > 0;
}
