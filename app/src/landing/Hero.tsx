import type { ReactNode } from "react";
import SourceChip from "../ui/SourceChip";
import { BAND_LABEL, BAND_VAR, type Provenance } from "./facts";
import type { Band } from "./types";

/** One hero value: label, big number with unit, provenance chip, one line of context. */
export function Hero({
  label,
  value,
  unit,
  source,
  band,
  sub,
  size = "md",
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  source: Provenance;
  band?: Band | null;
  sub?: ReactNode;
  size?: "xl" | "md";
  title?: string;
}) {
  return (
    <div className={`hero hero-${size}`} title={title}>
      <div className="hero-label">
        <span>{label}</span>
        <SourceChip kind={source.kind} detail={source.detail} warn={source.warn} />
      </div>
      <div className="hero-value">
        {value}
        {unit && value !== "–" && <span className="unit">{unit}</span>}
      </div>
      {band && (
        <div className="hero-band">
          <span className="band-dot" style={{ background: BAND_VAR[band] }} aria-hidden="true" />
          {BAND_LABEL[band]}
        </div>
      )}
      {sub != null && <div className="hero-sub">{sub}</div>}
    </div>
  );
}

/** Small secondary value in the line under the heroes (no box). */
export function Fact({ label, value, warn }: { label: string; value: ReactNode; warn?: string | null }) {
  return (
    <div className={`fact${warn ? " warn" : ""}`} title={warn ?? undefined}>
      <div className="fact-value">
        {warn && (
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
        )}
        {value}
      </div>
      <div className="fact-label">{label}</div>
    </div>
  );
}
