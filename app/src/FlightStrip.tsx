import type { MouseEvent } from "react";
import { fmt, fmtClock, fmtDate, fmtDuration } from "./i18n/number";
import { t as globalT, useT, type TFunction, type TKey } from "./i18n";
import { stateLabel } from "./FlightDetail";
import { callsignOf, effectiveAircraftTitle, effectiveArr, effectiveDep, notesFirstLine } from "./logbookFilter";
import { BAND_VAR, vsBandOf } from "./landing/facts";
import { isDemoRow, isImportedRow } from "./totals";
import type { FlightRow } from "./types";
import type { ApproachBand } from "./landing/approachTypes";
import { gapTitle } from "./resume";

/** What the strip needs from the landing and approach analyses (see stripFacts.ts). */
export interface StripFact {
  /** Missing when the flight has approach facts but no landing on a known runway. */
  touchdownDistanceM?: number | null;
  centerlineOffsetM?: number | null;
  runwayIdent?: string | null;
  inTouchdownZone?: boolean;
  /** "stabil ab" of the landed approach, ft; null = never stable / not measurable. */
  stableFromFt?: number | null;
  /** Band of the landed approach; null = never below 1000 ft. */
  band?: ApproachBand | null;
  /** Hard gate of the assessment profile, ft ("unstable below …"; null = 500 ft). */
  hardGateFt?: number | null;
  /** Go-arounds flown on this flight. */
  goArounds?: number;
}

/** Strip colour per approach band: neutral when stable, amber with deviations, red when unstable. */
const STRIP_BAND_CLASS: Record<ApproachBand, string> = {
  stable: "band-stable",
  deviations: "band-deviations",
  unstable: "band-unstable",
  unstableBelow500: "band-unstable",
};
const STRIP_BAND_TITLE: Record<ApproachBand, TKey> = {
  stable: "logbook.strip.bandStable",
  deviations: "logbook.strip.bandDeviations",
  unstable: "logbook.strip.bandUnstable",
  unstableBelow500: "logbook.strip.bandUnstableBelow500",
};
/** Landing rate from which a landing counts as hard (strip marks, tooltips). */
const HARD_FPM = 600;

interface Props {
  flight: FlightRow;
  fact?: StripFact | null;
  selected: boolean;
  tabIndex: number;
  onSelect: () => void;
  onDebrief: () => void;
  /** Id of the hint "Enter opens the landing debrief" (strips with a landing). */
  describedBy?: string;
  /** Interrupted flight: time until the flight that seems to continue it (merge hint). */
  gapToNextMs?: number | null;
}

/** Normalised runway for the glyph: 3000 m with the 300–900 m touchdown zone. */
const GLYPH_LEN_M = 3000;
const TDZ_M: [number, number] = [300, 900];

/** What a screen reader says for a strip (the visible text has "····", glyphs and symbols). `t` defaults to the UI language. */
export function stripLabel(f: FlightRow, fact: StripFact | null | undefined, flags: string[], t: TFunction = globalT): string {
  const type = f.aircraft.atcModel?.replace(/^TT:ATCCOM\.(AC_MODEL|ATC_NAME)[ _]?/i, "").split(".")[0] || effectiveAircraftTitle(f) || "";
  const callsign = callsignOf(f) || f.aircraft.atcId || "";
  const dep = effectiveDep(f) ?? t("logbook.strip.depUnknown");
  const arr = effectiveArr(f) ?? (f.state === "active" ? t("logbook.strip.destOpen") : t("logbook.strip.destUnknown"));
  const block = f.onBlockMs && f.offBlockMs ? t("logbook.strip.block", { duration: fmtDuration(f.onBlockMs - f.offBlockMs, { seconds: false }) }) : null;
  const rate = f.landingVsFpm;
  const landing =
    rate != null
      ? [t("logbook.strip.landing", { rate: fmt(rate, 0, "fpm") }), rate <= -HARD_FPM ? t("logbook.strip.hardLanding") : null, stableText(fact, t)].filter(Boolean).join(", ")
      : t("logbook.strip.noLanding");
  return [
    callsign,
    type,
    `${t("logbook.strip.route", { dep, arr })}${fact?.runwayIdent ? ` ${fact.runwayIdent}` : ""}`,
    fmtDate(f.offBlockMs ?? f.createdMs),
    block,
    landing,
    fact?.goArounds ? t("logbook.strip.goArounds", { count: fact.goArounds }) : null,
    f.state !== "completed" ? stateLabel(f.state, t) : null,
    isDemoRow(f) ? t("logbook.strip.demo") : null,
    isImportedRow(f) ? t("logbook.strip.imported") : null,
    ...flags,
    f.rating ? t("logbook.strip.rating", { rating: f.rating }) : null,
    f.tags?.length ? t("logbook.strip.tags", { tags: f.tags.join(", ") }) : null,
    f.notes?.trim() ? t("logbook.strip.withNote") : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * A logbook row in the shape of an ATC flight strip: identity on the left, route and
 * block times in the middle, the landing on the right – with a small runway glyph that
 * shows where the aircraft touched down, so a column of strips reads as a pattern.
 *
 * The row holds the listbox option (identity + route) and, as its sibling, the landing-rate
 * button – an option must not contain interactive children. The button is a mouse shortcut
 * (hidden from screen readers); with the keyboard, Enter on the option opens the debrief.
 */
export default function FlightStrip({ flight: f, fact, selected, tabIndex, onSelect, onDebrief, describedBy, gapToNextMs }: Props) {
  const tr = useT();
  const rate = f.landingVsFpm;
  const hard = (rate ?? 0) <= -HARD_FPM;
  const block = f.onBlockMs && f.offBlockMs ? f.onBlockMs - f.offBlockMs : null;
  const type = f.aircraft.atcModel?.replace(/^TT:ATCCOM\.(AC_MODEL|ATC_NAME)[ _]?/i, "").split(".")[0] || "";
  const callsign = callsignOf(f) || f.aircraft.atcId || "";
  const imported = isImportedRow(f);
  // an imported flight has no recording, so no integrity marks – the "importiert" badge instead
  const flags = (imported ? [] : [
    f.integrity.pauseCount > 0 && { mark: "⏸", title: tr("logbook.integrity.pause", { n: f.integrity.pauseCount, duration: fmtDuration(f.integrity.pausedMs) }) },
    f.integrity.slewDetected && { mark: "⇢", title: tr("logbook.integrity.slewDetected") },
    f.integrity.timeAccelerationDetected && { mark: `×${fmt(f.integrity.maxSimRate, 0)}`, title: tr("logbook.integrity.timeAccel", { rate: fmt(f.integrity.maxSimRate, 0) }) },
    f.integrity.crashed && { mark: "✕", title: tr("logbook.integrity.crash") },
    f.integrity.teleportDetected && { mark: "⇝", title: tr("logbook.integrity.teleport") },
    // a flight resumed or merged after a crash: the recording has a hole
    f.state !== "interrupted" && (f.integrity.gapMs ?? 0) > 0 && { mark: "⋯", title: gapTitle(f) ?? tr("logbook.integrity.gap") },
  ]).filter(Boolean) as Array<{ mark: string; title: string }>;
  const discarded = f.state === "discarded";
  const stateTitle = discarded ? tr("logbook.state.discardedTitle") : (gapTitle(f, gapToNextMs) ?? undefined);
  const dep = effectiveDep(f);
  const arr = effectiveArr(f);
  const tags = f.tags ?? [];
  const note = notesFirstLine(f.notes);

  const stable = <StableLine fact={fact} />;
  const ga = fact?.goArounds ? <GoAroundBadge n={fact.goArounds} /> : null;
  const debrief = (e: MouseEvent) => {
    e.stopPropagation();
    onSelect();
    onDebrief();
  };

  return (
    <div className={`strip${selected ? " selected" : ""}${discarded ? " strip-discarded" : ""}`} role="none" onClick={onSelect}>
      <div
        data-id={f.id}
        role="option"
        aria-selected={selected}
        aria-label={stripLabel(f, fact, flags.map((x) => x.title), tr)}
        aria-describedby={describedBy}
        tabIndex={tabIndex}
        className="strip-option"
        onFocus={() => !selected && onSelect()}
      >
        <div className="strip-id">
          <strong className="num">{callsign || "–"}</strong>
          <span className="detail num">{type || effectiveAircraftTitle(f) || "–"}</span>
        </div>
        <div className="strip-route">
          {/* one line: route with runway; the clock times only where the list is wide enough (flows.css) */}
          <div className="strip-legs num" title={`${dep ?? "····"} ${fmtClock(f.offBlockMs)} → ${arr ?? "····"}${fact?.runwayIdent ? ` ${fact.runwayIdent}` : ""}${f.onBlockMs ? ` ${fmtClock(f.onBlockMs)}` : ""}`}>
            <span>
              <strong>{dep ?? "····"}</strong>
              {f.offBlockMs ? <span className="detail strip-time"> {fmtClock(f.offBlockMs)}</span> : null}
            </span>
            <span className="strip-arrow" aria-hidden="true">
              →
            </span>
            <span>
              <strong>{arr ?? (f.state === "active" ? "…" : "····")}</strong>
              {fact?.runwayIdent && <span className="detail"> {fact.runwayIdent}</span>}
              {f.onBlockMs ? <span className="detail strip-time"> {fmtClock(f.onBlockMs)}</span> : null}
            </span>
          </div>
          {/* second line: date, block time, then the badges */}
          <div className="strip-meta detail">
            <span className="num">{fmtDate(f.offBlockMs ?? f.createdMs)}</span>
            {block != null && <span className="num">{fmtDuration(block, { seconds: false })}</span>}
            {isDemoRow(f) && <span className="badge badge-demo badge-inline">{tr("logbook.strip.demo")}</span>}
            {imported && (
              <span className="badge badge-imported badge-inline" title={tr("logbook.strip.importedTitle")}>
                {tr("logbook.strip.imported")}
              </span>
            )}
            {f.state !== "completed" && (
              <span className={`badge badge-inline state-${f.state}`} title={stateTitle}>
                {f.state === "interrupted" ? tr("logbook.state.interruptedShort") : discarded ? tr("logbook.state.discardedShort") : stateLabel(f.state, tr)}
              </span>
            )}
            {flags.map((x) => (
              <span key={x.mark} className="strip-flag" title={x.title}>
                {x.mark}
              </span>
            ))}
            {/* Notizen & Tags: up to two tags, the rating, a note symbol with the first line */}
            {tags.slice(0, 2).map((t, i) => (
              <span key={t} className={`strip-tag${i ? " strip-tag-2" : ""}`} title={tags.length > 2 ? tr("logbook.strip.tags", { tags: tags.join(", ") }) : tr("logbook.strip.tag", { tag: t })}>
                {t}
              </span>
            ))}
            {tags.length > 2 && (
              <span className="strip-tag strip-tag-more" title={tr("logbook.strip.tags", { tags: tags.join(", ") })}>
                +{tags.length - 2}
              </span>
            )}
            {f.rating ? (
              <span className="strip-rating num" title={tr("logbook.strip.ratingTitle", { rating: f.rating })}>
                ★{f.rating}
              </span>
            ) : null}
            {note && (
              <span className="strip-note" title={tr("logbook.strip.note", { note })}>
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 2h7l3 3v9H3zM5.5 7h5M5.5 10h3.5" />
                </svg>
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="strip-landing">
        {rate != null ? (
          <button
            className={`strip-rate num${hard ? " warn-text" : ""}`}
            tabIndex={-1}
            aria-hidden="true"
            title={`${hard ? `${tr("logbook.detail.hardLanding", { limit: fmt(HARD_FPM, 0, "fpm") })} ` : ""}${stableText(fact, tr) ? `${stableText(fact, tr)}. ` : ""}${tr("logbook.strip.openDebrief")}`}
            onClick={debrief}
          >
            <RunwayGlyph fact={fact} rate={rate} />
            <span className="strip-rate-text">
              <span>
                {ga}
                {hard && <span className="warn-icon">!</span>}
                {fmt(rate, 0)}
                <span className="unit">fpm</span>
              </span>
              {stable}
            </span>
          </button>
        ) : (
          <span className="strip-rate num detail" aria-hidden="true">
            <span className="strip-rate-text">
              <span>
                {ga}–
              </span>
              {stable}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Second small line under the fpm value: "stabil ab 1 500 ft" / "nie stabil", coloured by band (read only). */
function stableText(fact: StripFact | null | undefined, t: TFunction): string | null {
  if (!fact?.band) return null;
  return fact.stableFromFt != null ? t("logbook.strip.stableFrom", { alt: fmt(fact.stableFromFt, 0, "ft") }) : t("logbook.strip.neverStable");
}

/** Shown only where the strip has room (container query in flows.css); the button title always has it. */
function StableLine({ fact }: { fact?: StripFact | null }) {
  const tr = useT();
  const band = fact?.band ?? null;
  const text = stableText(fact, tr);
  if (!band || !text) return null;
  return (
    <span className={`strip-stable ${STRIP_BAND_CLASS[band]}`} title={tr(STRIP_BAND_TITLE[band], { ft: fmt(fact?.hardGateFt ?? 500, 0, "ft") })}>
      {text}
    </span>
  );
}

/** "GA ×n" in front of the landing rate. */
function GoAroundBadge({ n }: { n: number }) {
  const tr = useT();
  const label = tr("logbook.strip.goArounds", { count: n });
  return (
    <span className="strip-ga" title={label}>
      GA×{n}
    </span>
  );
}

/** 80×14 runway seen from above; the dot is the touchdown, coloured by landing-rate band. */
export function RunwayGlyph({ fact, rate }: { fact?: StripFact | null; rate: number }) {
  const w = 80;
  const h = 14;
  const x = (m: number) => 4 + (Math.min(Math.max(m, 0), GLYPH_LEN_M) / GLYPH_LEN_M) * (w - 8);
  const dot = fact?.touchdownDistanceM != null ? x(fact.touchdownDistanceM) : null;
  const off = fact?.centerlineOffsetM ?? 0;
  // ±15 m across the band is the full height – strongly exaggerated on purpose
  const y = h / 2 + Math.max(-1, Math.min(1, off / 15)) * (h / 2 - 2.5);
  const color = BAND_VAR[vsBandOf(rate)];
  return (
    <svg className="rwy-glyph" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <rect x="1" y="1" width={w - 2} height={h - 2} rx="1.5" className="rwy-glyph-band" />
      <rect x={x(TDZ_M[0])} y="1" width={x(TDZ_M[1]) - x(TDZ_M[0])} height={h - 2} className="rwy-glyph-tdz" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x="2" y={2.5 + i * 3.5} width="2" height="2" className="rwy-glyph-stripe" />
      ))}
      <line x1="4" x2={w - 4} y1={h / 2} y2={h / 2} className="rwy-glyph-cl" />
      {dot != null ? <circle cx={dot} cy={y} r="2.6" fill={color} /> : <circle cx={w / 2} cy={h / 2} r="2" fill={color} opacity="0.45" />}
    </svg>
  );
}
