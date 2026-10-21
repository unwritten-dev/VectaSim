import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RecStatus } from "../status";
import { Logo } from "./Logo";
import { useT } from "../i18n";

/**
 * Custom window title bar (tauri.conf.json: `decorations: false`). The bar and the brand
 * group are drag regions (Tauri's drag script also maximises on double-click); the window
 * controls are buttons and therefore never drag. Glyphs follow Windows 11 (Segoe Fluent).
 */
export default function TitleBar({ rec }: { rec: RecStatus }) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return; // browser preview without Tauri: the bar still renders
    }
    let alive = true;
    const sync = () =>
      win
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => {});
    sync();
    // resize events arrive dozens of times per second while dragging: one isMaximized() IPC
    // per 100 ms is enough for the maximise/restore icon (trailing call keeps the end state)
    let timer: number | undefined;
    const throttled = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        sync();
      }, 100);
    };
    const un = win.onResized(throttled).catch(() => () => {});
    return () => {
      alive = false;
      window.clearTimeout(timer);
      un.then((f) => f());
    };
  }, []);

  const act = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => () => {
    try {
      fn(getCurrentWindow()).catch((e) => console.warn("[titlebar] window action failed", e));
    } catch {
      /* no Tauri window (browser preview) */
    }
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region="deep">
        <Logo size={16} />
        <span className="titlebar-title">VectaSim</span>
        <span className={`badge titlebar-status badge-${rec.kind}`} title={rec.hint}>
          <span className="badge-dot" aria-hidden="true" />
          {rec.label}
        </span>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-controls">
        <button type="button" className="titlebar-btn" aria-label={t("shell.titleBar.minimize")} title={t("shell.titleBar.minimize")} onClick={act((w) => w.minimize())}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? t("shell.titleBar.restore") : t("shell.titleBar.maximize")}
          title={maximized ? t("shell.titleBar.restore") : t("shell.titleBar.maximize")}
          onClick={act((w) => w.toggleMaximize())}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
              <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            </svg>
          )}
        </button>
        <button type="button" className="titlebar-btn titlebar-close" aria-label={t("shell.action.close")} title={t("shell.action.close")} onClick={act((w) => w.close())}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" stroke="currentColor" strokeWidth="1">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </header>
  );
}
