import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** Small count/indicator after the label. */
  badge?: ReactNode;
}

interface Props<T extends string> {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Prefix for tab/panel ids (aria-controls / aria-labelledby). */
  idBase: string;
  label: string;
  className?: string;
}

/** WAI-ARIA tablist: roving tabindex, ←/→/Home/End move and activate. */
export function Tabs<T extends string>({ tabs, active, onChange, idBase, label, className }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div ref={ref} className={`tabs${className ? ` ${className}` : ""}`} role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          id={`${idBase}-tab-${t.id}`}
          aria-selected={t.id === active}
          aria-controls={`${idBase}-panel-${t.id}`}
          tabIndex={t.id === active ? 0 : -1}
          className={`tab${t.id === active ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge != null && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idBase, id, children, className }: { idBase: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className={`tab-panel${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
