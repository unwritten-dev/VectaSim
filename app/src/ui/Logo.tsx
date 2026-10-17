import { useId } from "react";

/**
 * VectaSim mark ("Trace"): one approach trace — level, calm descent, flare —
 * ending in the touchdown point (own-aircraft yellow) on a runway baseline.
 * No letterforms. Source of truth: docs/brand/logo.svg. 64-unit grid.
 *
 * Runway uses currentColor; the trace uses the UI accent (or currentColor
 * with `mono`); the touchdown point is always yellow.
 */
export function Logo({
  size = 24,
  mono = false,
  title,
}: {
  size?: number;
  mono?: boolean;
  title?: string;
}) {
  const mask = `vs-logo-${useId().replace(/:/g, "")}`;
  const trace = mono ? "currentColor" : "var(--accent, #5ab8f0)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <circle cx="47" cy="43" r="7.4" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <path
          d="M4 13.5 H14 C26 13.5 30 41 47 41"
          fill="none"
          stroke={trace}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="2" y="48.5" width="8" height="5.5" rx="1.2" fill="currentColor" />
        <rect x="14" y="48.5" width="48" height="5.5" rx="1.2" fill="currentColor" />
      </g>
      <circle cx="47" cy="43" r="5.2" fill="#ffd54a" />
    </svg>
  );
}
