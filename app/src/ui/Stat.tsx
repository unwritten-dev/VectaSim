import type { ReactNode } from "react";

interface Props {
  label: ReactNode;
  /** Formatted value without unit ("35 000"); "–" for no value. */
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  /** Warning reason: adds colour, an icon and the text as tooltip / screen-reader text. */
  warn?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
  title?: string;
}

/** Labelled value with a small muted unit; warnings never colour-only. */
export default function Stat({ label, value, unit, sub, warn, size = "md", className, title }: Props) {
  const empty = value === "–" || value == null;
  return (
    <div className={`stat stat-${size}${warn ? " warn" : ""}${className ? ` ${className}` : ""}`} title={warn ?? title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num" aria-label={empty ? "kein Wert" : undefined}>
        {warn && (
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
        )}
        {empty ? "–" : value}
        {!empty && unit && <span className={`unit${/^[°×%]/.test(unit) ? " tight" : ""}`}>{unit}</span>}
      </div>
      {warn && <span className="sr-only">Warnung: {warn}</span>}
      {sub != null && sub !== "" && <div className="stat-sub num">{sub}</div>}
    </div>
  );
}

/** Compact key/value list for secondary data (Systeme, Diagnose). */
export function KV({ rows }: { rows: Array<[ReactNode, ReactNode, (string | null)?]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v, warn], i) => (
        <div key={i} className={`kv-row${warn ? " warn" : ""}`} title={warn ?? undefined}>
          <dt>{k}</dt>
          <dd className="num">
            {warn && (
              <span className="warn-icon" aria-hidden="true">
                !
              </span>
            )}
            {v}
            {warn && <span className="sr-only"> Warnung: {warn}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
