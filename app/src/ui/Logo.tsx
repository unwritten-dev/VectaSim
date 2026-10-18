import { useId } from "react";
import { WORDMARK_GLYPHS, WORDMARK_LOCKUP, WORDMARK_VECTA } from "./wordmark";

/** Brand trace colour: fixed cyan per scheme (docs/brand/README.md), never the theme accent. */
export const BRAND_TRACE = { dark: "#5ab8f0", light: "#1f86c4" } as const;
const DOT = "#ffd54a";

/** Below this size only the small variant may be used (docs/brand/README.md "Mindestgröße"). */
const SMALL_BELOW = 24;

interface MarkColors {
  runway: string;
  trace: string;
  /** Outline around the yellow point (light backgrounds: ink), none on dark. */
  ring?: string;
}

/**
 * The mark in its 64-unit grid (generated with the brand tooling, see docs/brand/README.md): full version, or the
 * small variant for 16–23 px (stroke 7, larger point and cut-out, one continuous runway
 * bar without the centreline dash).
 */
function Mark({ id, small, c }: { id: string; small: boolean; c: MarkColors }) {
  const sw = small ? 7 : 6;
  const r = small ? 5.8 : 5.2;
  const kr = small ? 8 : 7.4;
  return (
    <>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <circle cx="47" cy="43" r={kr} fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${id})`}>
        <path d="M4 13.5 H14 C26 13.5 30 41 47 41" fill="none" stroke={c.trace} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        {small ? (
          <rect x="4" y="48" width="56" height="6.5" rx="1.4" fill={c.runway} />
        ) : (
          <>
            <rect x="2" y="48.5" width="8" height="5.5" rx="1.2" fill={c.runway} />
            <rect x="14" y="48.5" width="48" height="5.5" rx="1.2" fill={c.runway} />
          </>
        )}
      </g>
      <circle cx="47" cy="43" r={c.ring ? r - 0.7 : r} fill={DOT} stroke={c.ring} strokeWidth={c.ring ? 1.4 : undefined} />
    </>
  );
}

/**
 * VectaSim mark ("Trace"): one approach trace — level, calm descent, flare —
 * ending in the touchdown point (own-aircraft yellow) on a runway baseline.
 * No letterforms. Source of truth: docs/brand/logo.svg. 64-unit grid.
 *
 * Runway uses currentColor; the trace is the fixed brand cyan (`--brand-trace`, set per
 * light/dark scheme by themes.ts) or currentColor with `mono`; the point is always yellow.
 * Below 24 px the small variant is drawn automatically.
 */
export function Logo({ size = 24, mono = false, title }: { size?: number; mono?: boolean; title?: string }) {
  const mask = `vs-logo-${useId().replace(/:/g, "")}`;
  const trace = mono ? "currentColor" : `var(--brand-trace, ${BRAND_TRACE.dark})`;
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
      <Mark id={mask} small={size < SMALL_BELOW} c={{ runway: "currentColor", trace }} />
    </svg>
  );
}

/**
 * Mark + wordmark "VectaSim" (outlines, docs/brand/logo-wordmark*.svg) as an SVG group for
 * images that leave the app (landing card). `height` is the lockup height in px; the
 * width follows (270 : 64). "Sim" is never lighter than "Vecta".
 */
export function LogoLockup({
  x,
  y,
  height,
  text,
  muted,
  scheme,
  id,
}: {
  x: number;
  y: number;
  height: number;
  text: string;
  muted: string;
  scheme: "dark" | "light";
  id: string;
}) {
  const s = height / WORDMARK_LOCKUP.height;
  const L = WORDMARK_LOCKUP;
  return (
    <g transform={`translate(${x} ${y}) scale(${s.toFixed(5)})`}>
      <Mark id={id} small={false} c={{ runway: text, trace: BRAND_TRACE[scheme], ring: scheme === "light" ? text : undefined }} />
      <g transform={`translate(${L.x} ${L.y}) scale(${L.scale})`}>
        {WORDMARK_GLYPHS.map((d, i) => (
          <path key={i} d={d} fill={i < WORDMARK_VECTA ? text : muted} />
        ))}
      </g>
    </g>
  );
}

/** Width in px of a LogoLockup of the given height. */
export const lockupWidth = (height: number) => (height / WORDMARK_LOCKUP.height) * WORDMARK_LOCKUP.width;
