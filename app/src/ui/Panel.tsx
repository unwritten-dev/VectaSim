import { useId, useState, type ReactNode } from "react";

interface Props {
  title: ReactNode;
  /** Short line under the title (what this card is for). */
  description?: ReactNode;
  /** Buttons/badges on the right of the title row. */
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  /** Heading level for the title (default h2). */
  level?: 2 | 3;
  children?: ReactNode;
}

/** Card with a title row, optional actions and an optional collapse toggle (aria-expanded). */
export default function Panel({ title, description, actions, collapsible, defaultOpen = true, className, level = 2, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const H = level === 3 ? "h3" : "h2";
  const expanded = !collapsible || open;
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      <header className="panel-head">
        <H className="panel-title">
          {collapsible ? (
            // aria-controls only while the body exists (folded, it is not rendered)
            <button className="panel-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
              <Chevron open={open} />
              {title}
            </button>
          ) : (
            title
          )}
        </H>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {description && <p className="panel-desc">{description}</p>}
      {expanded && (
        <div className="panel-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

export function Chevron({ open, dir }: { open?: boolean; dir?: "left" | "right" }) {
  const rot = dir === "left" ? 90 : dir === "right" ? -90 : open ? 0 : -90;
  return (
    <svg className="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
