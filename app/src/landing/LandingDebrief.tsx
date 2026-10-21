import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NNBSP, fmt, fmtClock, fmtDateTime, fmtNum, fmtSigned, fmtWind } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import { usePrivacy } from "../prefs";
import { rawText, userMessage } from "../errors";
import { TrackMap } from "../lazyMaps";
import Panel from "../ui/Panel";
import { KV } from "../ui/Stat";
import type { FlightRow, TrackSample } from "../types";
import ApproachChart from "./ApproachChart";
import ApproachSection, { VAPP_SOURCE_LABEL, type ApproachStatus } from "./ApproachSection";
import RunwayDiagram from "./RunwayDiagram";
import RunwayEditor from "./RunwayEditor";
import StabilisedTable from "./StabilisedTable";
import { closeDebrief, useDebrief, type DebriefTarget } from "./debriefStore";
import ReplayBar, { ReplayValues } from "./ReplayBar";
import { ReplayContext, debriefReplay, debriefReplayPlan, useReplayStore } from "./replayStore";
import {
  APPROACH_BAND_LABEL,
  G_BAND_REASON,
  G_BANDS,
  INDEX_LABEL,
  RUNWAY_ACCURACY_NOTE,
  SPEED_REF_LABEL,
  VS_BANDS,
  approachHints,
  approachLabel,
  automationText,
  buildHints,
  degNum,
  ilsProtocolText,
  indexFormulaLines,
  indexText,
  isDerivedRunway,
  isRated,
  keySentence,
  landingIndex,
  lateralMeasurable,
  METAR_MAX_AGE_MIN,
  metarAgeNote,
  provenance,
  recordedProtocolText,
  runwaySourceNote,
  runwaySourceOf,
  sampleRateHz,
  simWindComponentsText,
  simWindText,
  widthText,
  windComponentsText,
  windProtocolText,
  zoneText,
  type Hint,
} from "./facts";
import { Fact, Hero } from "./Hero";
import { providerLabel } from "../status";
import { sideLabel } from "./geometry";
import { copyCardPng, saveCardPng } from "./exportCard";
import { navigate } from "../airframes/navigation";
import type { ApproachAnalysis } from "./approachTypes";
import type { LandingAnalysis, LandingDebriefData } from "./types";
import HistoryPanel from "./HistoryPanel";
import "./landing.css";
import { gLoadProtocol } from "../gload";
import { Modal } from "../ui/Modal";
import { keepStepFocus } from "../ui/modalStack";
import { Segmented } from "../ui/Segmented";

/** "0,3 Dots" / "0.3 dots", "1 Dot" / "1 dot". */
function dotsText(t: TFunction, v: number, digits = 0): string {
  return t("debrief.unit.dots", { count: v, n: fmtNum(v, digits) });
}

/** Side of the runway centreline at touchdown, as a phrase ("9 m rechts der Mittellinie"). */
function sideOfCentreline(t: TFunction, lateralM: number): string {
  const a = Math.abs(lateralM);
  if (a < 0.5) return t("debrief.hero.onCentreline");
  const dist = `${fmtNum(a, 0)}${NNBSP}m`;
  return lateralM > 0 ? t("debrief.hero.rightOfCentreline", { dist }) : t("debrief.hero.leftOfCentreline", { dist });
}

/** Full-window landing debrief for one touchdown; rendered once by App, outside `.shell`. */
export default function LandingDebrief() {
  const target = useDebrief();
  if (!target) return null;
  return (
    <ReplayContext.Provider value={debriefReplay}>
      <DebriefModal key={`${target.flightId}:${target.touchdownIndex}:${target.approachIndex}`} target={target} />
    </ReplayContext.Provider>
  );
}

/** Playback span of what is shown (the store clamps the cursor into it). */
function useReplayPlan(a: LandingAnalysis | null, apr: ApproachAnalysis | null) {
  const store = useReplayStore();
  useEffect(() => {
    const plan = debriefReplayPlan(a, apr);
    store.configure(plan.range, plan.markers);
  }, [store, a, apr]);
}

/** Transport bar and the values at the cursor, under the approach profile. */
function ReplaySection({ a, apr }: { a: LandingAnalysis | null; apr: ApproachAnalysis | null }) {
  useReplayPlan(a, apr);
  return (
    <div className="replay-wrap">
      <ReplayBar />
      <ReplayValues analysis={a} approach={apr} />
    </div>
  );
}

type ApproachList = { list: ApproachAnalysis[] } | { error: string } | null;

/** Text of a failed approach_analysis call, for "Anflug nicht auswertbar – …". */
function approachError(e: unknown): string {
  const raw = String(e).replace(/^Error:\s*/, "");
  if (raw && raw.length <= 200) return raw;
  return userMessage(e, "logbook").title;
}

function DebriefModal({ target }: { target: DebriefTarget }) {
  const t = useT();
  const [index, setIndex] = useState<number | null>(target.touchdownIndex);
  /** Approach chosen in the picker (or by the caller); null = the one of the shown touchdown. */
  const [approachPick, setApproachPick] = useState<number | null>(target.approachIndex);
  const [data, setData] = useState<LandingDebriefData | null>(null);
  /** `final`: retrying cannot help (the flight has no landing). */
  const [error, setError] = useState<DebriefError | null>(null);
  const [approaches, setApproaches] = useState<ApproachList>(null);
  /** "Erneut versuchen" after a failed analysis re-runs both loads. */
  const [attempt, setAttempt] = useState(0);
  /** Bumped after the runway was corrected: reload both without clearing what is shown. */
  const [runwayRev, setRunwayRev] = useState(0);
  const runwayChanged = useCallback(() => setRunwayRev((n) => n + 1), []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const kickerId = useId();
  const titleId = useId();
  const replay = useReplayStore();

  // closing the debrief (or switching to another landing) stops the playback and clears the cursor
  useEffect(() => () => replay.reset(), [replay]);

  useEffect(() => {
    let alive = true;
    setError(null);
    invoke<LandingDebriefData>("landing_analysis", { flightId: target.flightId, touchdownIndex: index })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(debriefErrorOf(e)));
    return () => {
      alive = false;
    };
  }, [target.flightId, index, attempt, runwayRev]);

  // all approaches of the flight, in parallel to the landing analysis
  useEffect(() => {
    let alive = true;
    invoke<ApproachAnalysis[]>("approach_analysis", { flightId: target.flightId })
      .then((list) => alive && setApproaches({ list: Array.isArray(list) ? list : [] }))
      .catch((e) => alive && setApproaches({ error: approachError(e) }));
    return () => {
      alive = false;
    };
  }, [target.flightId, attempt, runwayRev]);

  const list = approaches && "list" in approaches ? approaches.list : null;
  const shownIndex = data?.analysis.touchdownIndex ?? index ?? 0;
  const count = data?.touchdownCount ?? 0;
  const selected = useMemo(
    () => selectApproach(list, approachPick, data?.analysis.touchdownIndex ?? index, data != null || error != null),
    [list, approachPick, data, index, error],
  );
  const isGoAround = selected?.outcome.kind === "goAround";
  // the landing's approach: only one whose touchdown is the shown one
  const landingApproach: ApproachStatus =
    approaches == null
      ? { kind: "loading" }
      : "error" in approaches
        ? { kind: "error", reason: approaches.error }
        : selected && selected.outcome.kind !== "goAround" && data && selected.outcome.touchdownIndex === data.analysis.touchdownIndex
          ? { kind: "ok", approach: selected }
          : { kind: "error", reason: t("debrief.state.noApproachForLanding") };

  const pickApproach = (a: ApproachAnalysis) => {
    setApproachPick(a.index);
    if (a.outcome.kind !== "goAround" && a.outcome.touchdownIndex !== shownIndex) setIndex(a.outcome.touchdownIndex);
  };
  const pickTouchdown = (i: number) => {
    setApproachPick(null);
    setIndex(i);
  };
  const showPicker = list != null && list.length > 1;
  // ‹/› at the first/last landing: the arrow under the focus is disabled now – keep the focus
  // on the other arrow (or Close) instead of losing it to <body>
  useEffect(() => {
    const root = dialogRef.current;
    if (root) keepStepFocus(root, document.activeElement, document.body, ".debrief-pager-btn:not(:disabled)", closeRef.current);
  }, [shownIndex]);

  return (
    // A real modal (ui/Modal): everything behind it is inert (the title bar stays usable for the
    // window controls), Tab cycles inside, Esc closes, focus moves in and back to where it came
    // from (main.layout when that is gone, e.g. a toast button). An open popover inside (source
    // chip) gets Esc first and stops it, so Esc closes the innermost layer only.
    <Modal className="debrief-overlay" labelledBy={`${kickerId} ${titleId}`} onClose={closeDebrief} initialFocus={closeRef} dialogRef={dialogRef}>
      <div className="debrief">
        <div className="debrief-bar">
          <span className="debrief-kicker" id={kickerId}>{isGoAround ? t("debrief.bar.kickerApproach") : t("debrief.bar.kickerLanding")}</span>
          {showPicker ? (
            <Segmented
              inline
              className="approach-picker"
              aria-label={t("debrief.bar.pickApproach")}
              options={list.map((a) => ({ value: a.index, label: approachLabel(a) }))}
              value={selected?.index ?? -1}
              onChange={(i) => {
                const a = list.find((x) => x.index === i);
                if (a) pickApproach(a);
              }}
            />
          ) : (
            count > 1 && (
              <span className="debrief-pager" role="group" aria-label={t("debrief.bar.pickLanding")}>
                <button className="btn-sm debrief-pager-btn" disabled={shownIndex <= 0} onClick={() => pickTouchdown(shownIndex - 1)} aria-label={t("debrief.bar.prevLanding")}>
                  ‹
                </button>
                <span className="detail num">{t("debrief.bar.landingOf", { n: shownIndex + 1, count })}</span>
                <button className="btn-sm debrief-pager-btn" disabled={shownIndex >= count - 1} onClick={() => pickTouchdown(shownIndex + 1)} aria-label={t("debrief.bar.nextLanding")}>
                  ›
                </button>
              </span>
            )
          )}
          <span className="spacer" />
          <button
            className="btn-sm"
            onClick={() => {
              navigate({ kind: "flight", id: target.flightId });
              closeDebrief();
            }}
            title={t("debrief.bar.inLogbookTitle")}
          >
            {t("debrief.bar.inLogbook")}
          </button>
          <button ref={closeRef} className="btn-sm" onClick={closeDebrief} title={t("debrief.bar.closeTitle")}>
            {t("debrief.bar.close")}
          </button>
        </div>
        {isGoAround && selected ? (
          <GoAroundBody a={selected} flight={data?.flight ?? null} titleId={titleId} />
        ) : error ? (
          <div className="debrief-state">
            <strong>{error.kind === "noLanding" ? t("debrief.state.noLanding") : error.title}</strong>
            {error.kind === "failed" && error.hint && <div className="detail">{error.hint}</div>}
            {error.kind === "failed" && (
              <div>
                <button
                  className="btn-sm"
                  onClick={() => {
                    setError(null);
                    setData(null);
                    setApproaches(null);
                    setAttempt((n) => n + 1);
                  }}
                >
                  {t("debrief.state.retry")}
                </button>
              </div>
            )}
          </div>
        ) : !data ? (
          <div className="debrief-state detail">{t("debrief.state.loading")}</div>
        ) : (
          <DebriefBody d={data} approach={landingApproach} titleId={titleId} onRunwayChanged={runwayChanged} />
        )}
      </div>
    </Modal>
  );
}

/**
 * Why the analysis could not be shown. "No landing" is a state, not an error (no retry); the
 * backend says so in German (landing.rs → landing_analysis), so it is recognised here and the
 * text comes from i18n – the raw sentence is never shown.
 */
export type DebriefError = { kind: "noLanding" } | { kind: "failed"; title: string; hint: string };

export function debriefErrorOf(e: unknown): DebriefError {
  if (/keine Landung|no landing/i.test(rawText(e))) return { kind: "noLanding" };
  const m = userMessage(e, "logbook");
  return { kind: "failed", title: m.title, hint: m.hint };
}

/**
 * The approach to show: the picked one; else the one ending in the shown touchdown, else the
 * last. Without a pick it waits for the landing analysis (`landingSettled`), so a flight
 * ending with a go-around does not flash the go-around before the landing is known.
 */
export function selectApproach(list: ApproachAnalysis[] | null, pick: number | null, touchdownIndex: number | null, landingSettled: boolean): ApproachAnalysis | null {
  if (!list || !list.length) return null;
  if (pick != null) return list.find((a) => a.index === pick) ?? null;
  if (!landingSettled) return null;
  const m = touchdownIndex != null ? list.find((a) => a.outcome.kind !== "goAround" && a.outcome.touchdownIndex === touchdownIndex) : undefined;
  return m ?? list[list.length - 1];
}

/** Touchdown Card (PNG, 1200×675 at 2×): save to a file or copy to the clipboard. */
function CardActions({ d, approach }: { d: LandingDebriefData; approach: ApproachAnalysis | null }) {
  const t = useT();
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const run = (kind: "save" | "copy") => {
    setBusy(kind);
    (kind === "save" ? saveCardPng(d, approach) : copyCardPng(d, approach)).finally(() => setBusy(null));
  };
  return (
    <div className="debrief-card-actions">
      <button className="btn-sm" disabled={busy != null} onClick={() => run("save")} title={t("debrief.card.saveTitle", { size: "2400 × 1350 px" })}>
        {busy === "save" ? t("debrief.card.saving") : t("debrief.card.save")}
      </button>
      <button className="btn-sm" disabled={busy != null} onClick={() => run("copy")} title={t("debrief.card.copyTitle")}>
        {busy === "copy" ? t("debrief.card.copying") : t("debrief.card.copy")}
      </button>
    </div>
  );
}

function HintList({ hints }: { hints: Hint[] }) {
  return (
    <ul className="hints">
      {hints.map((h, i) => (
        <li key={i} className={`hint hint-${h.tone}`}>
          <span className="hint-icon" aria-hidden="true">
            {h.tone === "ok" ? "✓" : h.tone === "warn" ? "▲" : "i"}
          </span>
          {h.text}
        </li>
      ))}
    </ul>
  );
}

/** Methodik items of the approach assessment (references, bands, minimum durations, 1 Hz). */
function ApproachMethodItems({ a }: { a: ApproachAnalysis }) {
  const t = useT();
  const c = a.config;
  const pct = (v: number) => `${fmtNum(v)}${NNBSP}%`;
  return (
    <>
      <li>
        <strong>{t("debrief.approachMethod.references.title")}</strong>{" "}
        {t("debrief.approachMethod.references.text", {
          deg: fmt(c.glidepathDeg, 0, "°"),
          tch: fmt(c.tchFt, 0, "ft"),
          gsDot: `${fmtNum(c.gsDotDeg, 2)}°`,
          antenna: fmt(c.locAntennaBeyondEndM, 0, "m"),
          locDot: fmt(c.locDotMAtThreshold, 0, "m"),
          track: fmt(c.establishedTrackDeg, 0, "°"),
          minM: fmt(c.establishedMinM, 0, "m"),
          ratio: pct(c.establishedRatio * 100),
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.ils.title")}</strong>{" "}
        {t("debrief.approachMethod.ils.text", {
          share: pct((c.ilsMinShare ?? 0.6) * 100),
          top: fmtNum(c.windowTopFt),
          floor: fmt(c.gsFloorFt, 0, "ft"),
          deg: fmt(c.glidepathDeg, 1, "°"),
          fullScale: dotsText(t, c.locFullScaleDots ?? 2),
          mismatch: dotsText(t, c.ilsMismatchDots ?? 0.5, 1),
          rejectGs: `${fmtNum(c.ilsRejectGsDeg ?? 1, 1)}°`,
          rejectLoc: dotsText(t, c.ilsRejectLocDots ?? 1.5, 1),
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.vapp.title")}</strong>{" "}
        {t("debrief.approachMethod.vapp.text", {
          from: fmtNum(c.vappFromFt),
          to: fmt(c.vappToFt, 0, "ft"),
          factor: fmtNum(c.vappVs0Factor ?? 1.3, 1),
          min: fmtNum(c.vappMinVs0, 1),
          max: fmtNum(c.vappMaxVs0, 1),
          speed: fmt(a.reference.vappKt, 0, "kt"),
          source: VAPP_SOURCE_LABEL[a.reference.vappSource],
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.config.title")}</strong>{" "}
        {t("debrief.approachMethod.config.text", {
          n1: fmt(c.thrustMinN1Pct ?? 40, 0, "%"),
          gate: fmt(c.configGateFt, 0, "ft"),
          idle: fmt(c.thrustDurationS ?? 5, 0, "s"),
          floor: fmt(c.thrustFloorFt ?? 50, 0, "ft"),
          spoilers: fmt(c.spoilersMaxPct ?? 2, 0, "%"),
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.windEnergy.title")}</strong>{" "}
        {t("debrief.approachMethod.windEnergy.text", {
          top: fmtNum(c.windowTopFt),
          bottom: fmt(c.windowBottomFt, 0, "ft"),
          tail: fmt(c.windTailwindKt ?? 5, 0, "kt"),
          cross: fmt(c.windCrosswindKt ?? 15, 0, "kt"),
          shear: fmt(c.windShearKt ?? 15, 0, "kt"),
          topFt: fmt(c.windowTopFt, 0, "ft"),
          high: fmtSigned(c.energyBandHighFt ?? 500, 0, "ft"),
          low: fmtSigned(-(c.energyBandLowFt ?? 300), 0, "ft"),
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.gates.title")}</strong>{" "}
        {t("debrief.approachMethod.gates.text", {
          tenAlt: fmt(c.tenNmAltToleranceFt, 0, "ft"),
          tenEnergy: fmtSigned(c.tenNmMaxEnergyFt, 0, "ft"),
          tenIas: fmt(c.tenNmMaxIasKt, 0, "kt"),
          fafDist: fmt(c.fafDistNm, 0, "nm"),
          fafHat: fmt(c.fafHatFt, 0, "ft"),
          fafAlt: fmt(c.fafAltToleranceFt, 0, "ft"),
          fafBelow: fmtSigned(-c.fafSpeedBelowKt, 0),
          fafAbove: fmtSigned(c.fafSpeedAboveKt, 0, "kt"),
          gear: pct(c.gearDownPct),
          vs: fmt(c.gateMaxVsFpm, 0, "fpm"),
          below: fmtSigned(-c.gateSpeedBelowKt, 0),
          above: fmtSigned(c.gateSpeedAboveKt, 0, "kt"),
          dots: dotsText(t, c.gateDots),
          bank: fmt(c.gateMaxBankDeg, 0, "°"),
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.stability.title")}</strong>{" "}
        {t("debrief.approachMethod.stability.text", {
          top: fmtNum(c.windowTopFt),
          bottom: fmt(c.windowBottomFt, 0, "ft"),
          gsFloor: fmt(c.gsFloorFt, 0, "ft"),
          speedS: fmt(c.speedDurationS, 0, "s"),
          bankS: fmt(c.bankDurationS, 0, "s"),
          vsS1: fmt(c.vsS1DurationS, 0, "s"),
          vsS2: fmt(c.vsS2DurationS, 0, "s"),
          gsS: fmt(c.gsDurationS, 0, "s"),
          momentary: fmt(c.momentaryS, 0, "s"),
          speed1: `${fmtSigned(-c.speedS1BelowKt, 0)}/${fmtSigned(c.speedS1AboveKt, 0)}`,
          speed2: `${fmtSigned(-c.speedS2BelowKt, 0)}/${fmtSigned(c.speedS2AboveKt, 0, "kt")}`,
          vs: `${fmtNum(c.vsS1Fpm)}/${fmt(c.vsS2Fpm, 0, "fpm")}`,
          gs: `${fmtNum(c.gsS1Dots)}/${dotsText(t, c.gsS2Dots)}`,
          loc: `${fmtNum(c.locS1Dots)}/${dotsText(t, c.locS2Dots, 1)}`,
          bank: `${fmtNum(c.bankS1Deg)}/${fmt(c.bankS2Deg, 0, "°")}`,
          stableMax: fmt(c.stableFromMaxFt, 0, "ft"),
          round: fmt(c.stableRoundFt, 0, "ft"),
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.bands.title")}</strong>{" "}
        {t("debrief.approachMethod.bands.text", {
          stable: APPROACH_BAND_LABEL.stable,
          deviations: APPROACH_BAND_LABEL.deviations,
          unstable: APPROACH_BAND_LABEL.unstable,
          unstableBelow500: APPROACH_BAND_LABEL.unstableBelow500,
        })}
      </li>
      <li>
        <strong>{t("debrief.approachMethod.resolution.title")}</strong>{" "}
        {t("debrief.approachMethod.resolution.text", { dense: fmt(c.profileDenseBelowFt, 0, "ft"), sparse: fmt(c.profileSparseS, 0, "s") })}
      </li>
    </>
  );
}

/** Debrief of a go-around: only the approach (with the lowest point), no landing part, no card. */
function GoAroundBody({ a, flight, titleId }: { a: ApproachAnalysis; flight: FlightRow | null; titleId: string }) {
  const t = useT();
  const priv = usePrivacy();
  const hints = useMemo(() => approachHints(a), [a]);
  const rwy = a.runway;
  const title = rwy ? `${rwy.airport} RWY ${rwy.ident}` : t("debrief.goAround.noRunway");
  const when = a.goAround?.lowestTMs ?? a.endTMs;
  return (
    <div className="debrief-body">
      <header className="debrief-head">
        <div>
          <h2 className="debrief-title" id={titleId}>
            {title} <span className="detail">· {t("debrief.goAround.suffix")}</span>
          </h2>
          <div className="detail">
            {[
              fmtDateTime(when),
              priv.title(flight?.aircraft.title, { registration: flight?.aircraft.atcId, airline: flight?.aircraft.atcAirline, callsign: flight?.callsign }) || null,
              priv.mask(flight?.aircraft.atcId, "registration"),
              priv.mask(flight?.callsign, "callsign"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </header>

      <ApproachSection status={{ kind: "ok", approach: a }} flight={flight} />

      <section className="debrief-section">
        <h3>{t("debrief.section.approachProfile")}</h3>
        <ApproachChart approach={a} />
        <ReplaySection a={null} apr={a} />
      </section>

      <section className="debrief-section">
        <h3>{t("debrief.section.hints")}</h3>
        <HintList hints={hints} />
      </section>

      <Panel title={t("debrief.section.gates")} collapsible defaultOpen={false} level={3} className="debrief-fold">
        <StabilisedTable approach={a} />
      </Panel>

      <Panel title={t("debrief.section.methodology")} collapsible defaultOpen={false} level={3} className="debrief-fold debrief-method">
        <ul className="method">
          <li>
            <strong>{t("debrief.goAround.methodTitle")}</strong>{" "}
            {t("debrief.goAround.methodText", { agl: fmt(a.config.gaMaxAglFt, 0, "ft"), window: fmt(a.config.gaWindowS, 0, "s"), climb: fmt(a.config.gaMinClimbFt, 0, "ft") })}
          </li>
          <ApproachMethodItems a={a} />
        </ul>
      </Panel>
    </div>
  );
}

/** Landing debrief body (exported for the i18n render test). */
export function DebriefBody({ d, approach, titleId, onRunwayChanged }: { d: LandingDebriefData; approach: ApproachStatus; titleId: string; onRunwayChanged: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const priv = usePrivacy();
  const closeEditor = useCallback(() => setEditing(false), []);
  const apr = approach.kind === "ok" ? approach.approach : null;
  const a = d.analysis;
  const c = a.config;
  const td = a.touchdown;
  const rwy = a.runway;
  const tp = a.touchdownPoint;
  const f = d.flight;
  const hints = useMemo(() => buildHints(d, apr), [d, apr]);
  const sentence = useMemo(() => keySentence(d), [d]);
  // slewed / fast-forwarded down: no landing rate (never "0 fpm", no band)
  const rated = isRated(d.analysis.touchdown);
  const src = useMemo(() => provenance(d), [d]);
  const index = useMemo(() => landingIndex(a, apr), [a, apr]);
  const place = d.airport?.ident ?? rwy?.airport ?? null;
  const title = rwy ? `${rwy.airport} RWY ${rwy.ident}` : place ? t("debrief.header.titleNoRunway", { place }) : t("debrief.header.titleNoAirport");
  const metarAge = metarAgeNote(d);
  const declaredLengthM = d.runwayData?.lengthFt ? d.runwayData.lengthFt * 0.3048 : rwy?.lengthM;
  const trackHz = sampleRateHz(a.samples);
  const rwySource = runwaySourceOf(rwy);
  const derived = isDerivedRunway(rwy);
  const measurable = tp ? lateralMeasurable(tp) : false;
  const uncertainty = tp?.distanceUncertaintyM ?? null;
  // the editor needs an airport: the matched runway's, else the nearest one
  const editIcao = rwy?.airport ?? d.airport?.ident ?? null;
  const oneDot = dotsText(t, 1);
  const twoDots = dotsText(t, 2);
  const matchRadius = fmt(c.matchLateralM / 1852, 0, "nm");
  const matchHeading = `${fmtNum(c.matchHeadingDeg)}°`;

  // the track map needs track samples; rebuild them from the approach points
  const mapSamples: TrackSample[] = useMemo(
    () =>
      a.samples.map((s) => ({
        tMs: s.tMs,
        latitude: s.latitude,
        longitude: s.longitude,
        altitudeMslFt: s.hatFt + (a.touchdownElevationFt ?? 0),
        altitudeAglFt: s.hatFt,
        groundSpeedKt: s.groundSpeedKt,
        iasKt: s.iasKt,
        verticalSpeedFpm: s.vsFpm,
        headingTrueDeg: 0,
        pitchDeg: s.pitchDeg,
        bankDeg: s.bankDeg,
        gForce: 1,
        onGround: s.onGround,
        flapsIndex: s.flapsIndex,
        gearPct: s.gearPct,
        fuelTotalKg: 0,
      })),
    [a.samples, a.touchdownElevationFt],
  );
  const tdList = useMemo(() => [td], [td]);

  const w = a.wind;
  const metarWind = d.metar?.wind ? fmtWind(d.metar.wind) : null;
  const metarId = d.metar ? ["METAR", d.metar.station, d.metar.time].filter(Boolean).join(" ") : "METAR";
  const ap = a.approach;
  const halfW = rwy?.widthM != null ? rwy.widthM / 2 : null;
  const integrity = f.integrity;
  const flags = integrity
    ? [
        integrity.slewDetected && t("debrief.integrity.slew"),
        integrity.timeAccelerationDetected && t("debrief.integrity.timeAccel", { rate: `${fmt(integrity.maxSimRate, 0)}×` }),
        integrity.crashed && t("debrief.integrity.crashed"),
        integrity.fuelIncreasedAirborne && t("debrief.integrity.fuelIncreased"),
        integrity.pauseCount > 0 && t("debrief.integrity.pauses", { count: integrity.pauseCount }),
      ].filter(Boolean)
    : [];
  const zone = tp ? t(tp.inTdz ? (rwy?.lengthEstimated ? "debrief.hero.inTdzAssumed" : "debrief.hero.inTdz") : rwy?.lengthEstimated ? "debrief.hero.outsideTdzAssumed" : "debrief.hero.outsideTdz") : null;

  const runwayProtocol = (): string => {
    if (!rwy) return t("debrief.protocol.noRunway");
    const diff = fmt(rwy.headingDiffDeg, 0, "°");
    if (rwySource === "database")
      return [
        t("debrief.protocol.runwayDb", { ident: rwy.ident, opposite: rwy.oppositeIdent, surface: rwy.surface || t("debrief.protocol.surfaceUnknown"), diff }),
        d.thresholdDisplacedM ? t("debrief.protocol.displaced", { dist: fmt(d.thresholdDisplacedM, 0, "m") }) : null,
        t("debrief.protocol.accuracy", { acc: fmt(5, 0, "m") }),
      ]
        .filter(Boolean)
        .join(" · ");
    if (rwySource === "user") return t("debrief.protocol.runwayUser", { ident: rwy.ident, opposite: rwy.oppositeIdent, diff });
    return [
      runwaySourceNote(rwy),
      t("debrief.protocol.derivedUncertainty", { along: fmt(rwy.alongUncertaintyM ?? uncertainty ?? 50, 0, "m"), cross: fmt(rwy.crossUncertaintyM ?? 5, 0, "m") }),
      t("debrief.protocol.lateralNotMeasurable"),
      rwy.lengthEstimated ? t("debrief.protocol.lengthUnknown") : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const windProtocol = (): string => {
    if (!d.metar) return d.metarNote ?? t("debrief.protocol.noMetar");
    const id = d.metarObservedMs ? t("debrief.protocol.observed", { metar: metarId, time: fmtClock(d.metarObservedMs, { local: false }) }) : metarId;
    return [id, d.metarAtLanding ? t("debrief.protocol.storedAtLanding") : t("debrief.protocol.currentApprox"), metarAge].filter(Boolean).join(" · ");
  };

  return (
    <div className="debrief-body">
      <header className="debrief-head">
        <div>
          <h2 className="debrief-title" id={titleId}>
            {title}
          </h2>
          {(rwy || editIcao) && (
            <div className={`debrief-rwy-source src-${rwySource}`}>
              <span>{rwy ? runwaySourceNote(rwy) : t("debrief.header.noRunway")}</span>
              {editIcao && (
                <button className="btn-sm" onClick={() => setEditing(true)} title={t("debrief.header.correctRunwayTitle")}>
                  {t("debrief.header.correctRunway")}
                </button>
              )}
            </div>
          )}
          <div className="detail">
            {[
              d.airport?.name,
              fmtDateTime(td.timestampMs),
              priv.title(f.aircraft.title, { registration: f.aircraft.atcId, airline: f.aircraft.atcAirline, callsign: f.callsign }) || t("debrief.header.unknownAircraft"),
              priv.mask(f.aircraft.atcId, "registration"),
              priv.mask(f.callsign, "callsign"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <CardActions d={d} approach={apr} />
          {editing && editIcao && <RunwayEditor analysis={a} airportIcao={editIcao} onClose={closeEditor} onChanged={onRunwayChanged} />}
        </div>
        <div className="debrief-wind">
          <div className="hero-label">{t("debrief.wind.label", { source: metarId })}</div>
          {d.metar ? (
            <>
              <div className={`debrief-wind-source${d.metarAtLanding && !metarAge ? "" : " is-current"}`}>
                {metarAge ?? (d.metarAtLanding ? t("debrief.wind.atLanding") : t("debrief.wind.current"))}
              </div>
              <div className="debrief-wind-main num">{metarWind ?? t("debrief.wind.noWind")}</div>
              {w && (
                <div className="detail num">
                  {w.relativeToRunway ? windComponentsText(a) : t("debrief.wind.componentsToHeading", { components: windComponentsText(a) })}
                </div>
              )}
              {d.metarNote && <div className="detail">{d.metarNote}</div>}
            </>
          ) : (
            <div className="detail">{d.metarNote ?? t("debrief.wind.noMetar")}</div>
          )}
          {apr?.wind && simWindText(apr.wind) && (
            <div className="debrief-sim-wind" title={t("debrief.wind.simTitle", { top: fmtNum(apr.config.windowTopFt), bottom: fmt(apr.config.windowBottomFt, 0, "ft") })}>
              <span className="hero-label">{t("debrief.wind.simLabel")}</span> <span className="num">{simWindText(apr.wind)}</span>
              {simWindComponentsText(apr.wind) && <div className="detail num">{simWindComponentsText(apr.wind)}</div>}
            </div>
          )}
        </div>
      </header>

      <p className="debrief-sentence">{sentence}</p>

      <div className="hero-row">
        <Hero
          size="xl"
          label={t("debrief.hero.rate")}
          value={rated ? fmt(td.landingRateFpm, 0) : t("band.unrated")}
          unit={rated ? "fpm" : undefined}
          band={rated ? a.vsBand : null}
          source={src.rate}
          title={rated ? t("debrief.hero.bandsTitle", { bands: VS_BANDS }) : t("band.unratedTitle")}
          sub={
            !rated
              ? t("band.unratedTitle")
              : td.landingRateSource === "sim"
                ? t("debrief.hero.rateSubSim", { measured: fmt(td.vsFpmMeasured, 0, "fpm") })
                : t("debrief.hero.rateSubMeasured")
          }
        />
        <Hero
          label={t("debrief.hero.point")}
          value={tp ? fmt(tp.distanceM, 0) : "–"}
          unit={uncertainty != null && uncertainty > 0 ? `± ${fmtNum(uncertainty, 0)}${NNBSP}m` : "m"}
          source={src.point}
          sub={tp ? `${zone} · ${measurable ? sideOfCentreline(t, tp.lateralM) : t("debrief.hero.lateralNotMeasurable")}` : t("debrief.hero.noRunway")}
        />
        <Hero
          label={t("debrief.hero.g")}
          value={fmt(td.peakG, 2)}
          unit="g"
          band={a.gBand}
          source={src.g}
          title={t("debrief.hero.bandsTitle", { bands: G_BANDS })}
          sub={t("debrief.hero.gSub", { window: fmt(0.5, 1, "s") })}
        />
      </div>
      {/* the band definitions as text, not only in the heroes' tooltips (keyboard, screen reader) */}
      <p className="detail debrief-bands">{t("debrief.hero.bandsLine", { vs: VS_BANDS, g: G_BANDS })}</p>

      <div className="fact-row">
        <Fact
          label={td.bounces ? t("debrief.facts.hardestContact", { vs: fmt(td.vsFpmHardest, 0, "fpm") }) : td.touchAndGo ? t("debrief.facts.touchAndGo") : t("debrief.facts.fullStop")}
          value={t("count.bounces", { count: td.bounces })}
          warn={td.bounces ? t("debrief.facts.bounceWarn") : null}
        />
        {tp && !measurable ? (
          <div className="fact fact-na" title={t("debrief.facts.derivedTitle")}>
            <div className="fact-value">{t("debrief.facts.notMeasurable")}</div>
            <div className="fact-label">{t("debrief.facts.derivedLabel")}</div>
          </div>
        ) : (
          <Fact
            label={
              rwy
                ? rwy.widthM != null
                  ? t("debrief.facts.centrelineWidth", { width: fmt(rwy.widthM, 0, "m") })
                  : t("debrief.facts.centrelineWidthUnknown")
                : t("debrief.facts.centreline")
            }
            value={tp ? sideLabel(tp.lateralM) : "–"}
            warn={tp && halfW != null && Math.abs(tp.lateralM) > halfW / 2 ? t("debrief.facts.centrelineWarn") : null}
          />
        )}
        <Fact
          label={
            a.rollout
              ? rwy && a.rollout.remainingM != null
                ? t("debrief.facts.rolloutToRest", { speed: fmt(c.rolloutEndKt, 0, "kt"), rest: fmt(a.rollout.remainingM, 0, "m") })
                : t("debrief.facts.rolloutTo", { speed: fmt(c.rolloutEndKt, 0, "kt") })
              : t("debrief.facts.rollout")
          }
          value={a.rollout ? fmt(a.rollout.distanceM, 0, "m") : td.touchAndGo ? t("debrief.facts.touchAndGo") : "–"}
          warn={a.rollout?.remainingM != null && a.rollout.remainingM < 0 ? t("debrief.facts.rolloutWarn") : null}
        />
        <div className="index-line" title={t("debrief.facts.indexTitle")}>
          <span className="detail">{t("debrief.facts.index")}</span>{" "}
          {index.value != null ? (
            <>
              <strong className="num">{index.value}</strong>
              <span className="detail"> {t("debrief.facts.indexOutOf")}</span>
            </>
          ) : (
            <span className="detail">{t("debrief.facts.indexNa", { reason: indexText(index) })}</span>
          )}
        </div>
      </div>

      <ApproachSection status={approach} flight={f} />

      <HistoryPanel flightId={f.id} touchdownIndex={a.touchdownIndex} approachIndex={apr?.index ?? null} />

      <section className="debrief-section">
        <h3>{rwy ? t("debrief.section.runwayFromAbove", { ident: rwy.ident }) : t("debrief.section.touchdownOnMap")}</h3>
        {rwy && tp ? (
          <RunwayDiagram analysis={a} />
        ) : (
          <>
            <p className="detail">{t("debrief.noRunway.text", { radius: matchRadius, heading: matchHeading })}</p>
            {mapSamples.length > 1 && <TrackMap samples={mapSamples} touchdowns={tdList} />}
          </>
        )}
      </section>

      <section className="debrief-section">
        <h3>{t("debrief.section.approachProfile")}</h3>
        <ApproachChart analysis={a} approach={apr} />
        <ReplaySection a={a} apr={apr} />
      </section>

      <section className="debrief-section">
        <h3>{t("debrief.section.hints")}</h3>
        <HintList hints={hints} />
      </section>

      <Panel title={apr ? t("debrief.section.gates") : t("debrief.section.stabilised")} collapsible defaultOpen={false} level={3} className="debrief-fold">
        {apr ? (
          <>
            <StabilisedTable approach={apr} />
            <p className="detail sa-note">
              {t("debrief.stabilised.noteApproach", {
                vapp: fmt(apr.reference.vappKt, 0, "kt"),
                source: VAPP_SOURCE_LABEL[apr.reference.vappSource],
                path:
                  apr.reference.glidepathSource === "ils"
                    ? t("debrief.stabilised.ilsPath", { deg: fmt(apr.reference.glidepathDeg, 1, "°") })
                    : t("debrief.stabilised.assumedPath", { deg: fmt(apr.reference.glidepathDeg, 0, "°") }),
              })}
            </p>
          </>
        ) : (
          <>
            <StabilisedTable gates={a.gates} />
            <p className="detail sa-note">
              {t("debrief.stabilised.noteGates", {
                speed: fmt(a.referenceSpeedKt, 0, "kt"),
                source: SPEED_REF_LABEL[a.referenceSpeedSource],
                tol: `${degNum(c.glidepathToleranceDeg)}°`,
                oneDot,
                full: `${degNum(c.glidepathFullScaleDeg)}°`,
                twoDots,
              })}
            </p>
          </>
        )}
      </Panel>

      <Panel title={t("debrief.section.flareRollout")} collapsible defaultOpen={false} level={3} className="debrief-fold">
        <KV
          rows={[
            [t("debrief.flare.flareFrom"), a.flare ? fmt(a.flare.startHatFt, 0, "ft") : t("debrief.flare.notDetectable")],
            [t("debrief.flare.durationToTd"), a.flare ? fmt(a.flare.durationS, 0, "s") : "–"],
            [t("debrief.flare.vsBeforeAfter"), a.flare ? `${fmt(a.flare.approachVsFpm, 0)} / ${fmt(a.flare.finalVsFpm, 0, "fpm")}` : "–"],
            [t("debrief.flare.thresholdCrossing"), a.threshold ? `${fmt(a.threshold.heightFt, 0, "ft")} · ${fmt(a.threshold.iasKt, 0, "kt")}` : "–"],
            [t("debrief.flare.thresholdToTd"), a.threshold ? fmt(a.threshold.airborneS, 0, "s") : "–"],
            [t("debrief.flare.iasMinMax"), `${fmt(ap.iasMinKt, 0)} / ${fmt(ap.iasMaxKt, 0, "kt")}`],
            [t("debrief.flare.iasAt", { h1: fmt(500, 0, "ft"), h2: fmt(50, 0, "ft") }), `${fmt(ap.iasAt500Kt, 0)} / ${fmt(ap.iasAt50Kt, 0)} / ${fmt(ap.iasAtTouchdownKt, 0, "kt")}`],
            [t("debrief.flare.vsBelow", { alt: fmt(1000, 0, "ft") }), `${fmt(ap.vsMin1000Fpm, 0)} … ${fmt(ap.vsMax1000Fpm, 0, "fpm")}`],
            [t("debrief.flare.vsBelow", { alt: fmt(500, 0, "ft") }), `${fmt(ap.vsMin500Fpm, 0)} … ${fmt(ap.vsMax500Fpm, 0, "fpm")}`],
            [t("debrief.flare.bankMaxBelow", { alt: fmt(500, 0, "ft") }), fmt(ap.bankMaxBelow500Deg, 0, "°")],
            [
              t("debrief.flare.gpMax"),
              rwy ? `${fmtSigned(ap.glidepathDevMaxAboveDeg ?? 0, 2, "°")} / ${fmtSigned(ap.glidepathDevMaxBelowDeg ?? 0, 2, "°")}` : t("debrief.flare.noRunwayNa"),
            ],
            [t("debrief.flare.pitchBank"), `${fmt(td.pitchDeg, 1, "°")} / ${fmt(td.bankDeg, 1, "°")}`],
            [t("debrief.flare.gs"), fmt(td.groundSpeedKt, 0, "kt")],
            [t("debrief.flare.rollout"), a.rollout ? t("debrief.flare.rolloutValue", { dist: fmt(a.rollout.distanceM, 0, "m"), time: fmt(a.rollout.durationS, 0, "s") }) : "–"],
            [
              rwySource === "database" ? t("debrief.flare.runwayDb") : rwySource === "user" ? t("debrief.flare.runwayUser") : t("debrief.flare.runwayDerived"),
              rwy
                ? `${rwy.lengthEstimated ? t("debrief.flare.lengthMin", { len: fmt(rwy.lengthM, 0, "m") }) : fmt(rwySource === "user" ? rwy.lengthM : declaredLengthM, 0, "m")} × ${widthText(rwy.widthM)}`
                : "–",
            ],
          ]}
        />
      </Panel>

      <Panel title={t("debrief.section.methodology")} collapsible defaultOpen={false} level={3} className="debrief-fold debrief-method">
        <ul className="method">
          <li>
            <strong>{t("debrief.method.landingRate.title")}</strong> {t("debrief.method.landingRate.text", { gap: fmt(0.3, 1, "s") })}
          </li>
          <li>
            <strong>{t("debrief.method.measured.title")}</strong> {t("debrief.method.measured.text", { agl: fmt(50, 0, "ft"), confirm: fmt(2, 0, "s") })}
          </li>
          <li>
            <strong>{t("debrief.method.gLoad.title")}</strong> {t("debrief.method.gLoad.text", { max: fmt(5, 0, "g") })} {G_BAND_REASON}
          </li>
          <li>
            <strong>{t("debrief.method.track.title")}</strong>{" "}
            {t("debrief.method.track.text", { start: fmt(c.approachStartFt, 0, "ft"), fallback: fmt(c.approachFallbackM / 1852, 0, "nm") })}
          </li>
          <li>
            <strong>{t("debrief.method.runway.title")}</strong> {t("debrief.method.runway.source")}{" "}
            {d.thresholdDisplacedM ? t("debrief.method.runway.displacedHere", { dist: fmt(d.thresholdDisplacedM, 0, "m") }) : t("debrief.method.runway.displaced")}{" "}
            {t("debrief.method.runway.match", { radius: matchRadius, heading: matchHeading })} {RUNWAY_ACCURACY_NOTE}{" "}
            <strong>{t("debrief.method.runway.tdzTitle")}</strong>{" "}
            {t("debrief.method.runway.tdz", { end: fmt(c.tdzEndM, 0, "m"), short: fmt(c.tdzEndM * 3, 0, "m") })}{" "}
            {tp
              ? t("debrief.method.runway.aimingHere", { marks: `150/250/300/400${NNBSP}m`, here: fmt(tp.aimingPointM, 0, "m") })
              : t("debrief.method.runway.aiming", { marks: `150/250/300/400${NNBSP}m` })}{" "}
            <strong>{t("debrief.method.runway.derivedTitle")}</strong>{" "}
            {t("debrief.method.runway.derived", { offset: fmt(300, 0, "m"), along: fmt(50, 0, "m"), tdzEnd: fmt(c.tdzEndM, 0, "m") })}{" "}
            {t("debrief.method.runway.correct")}
            {derived ? ` ${t("debrief.method.runway.thisDerived")}` : ""}
          </li>
          <li>
            <strong>{t("debrief.method.glidepath.title")}</strong>{" "}
            {t("debrief.method.glidepath.text", {
              deg: fmt(c.glidepathDeg, 0, "°"),
              tch: fmt(c.tchFt, 0, "ft"),
              from: fmt(0.25, 2, "nm"),
              tol: `${degNum(c.glidepathToleranceDeg)}°`,
              oneDot,
              full: `${degNum(c.glidepathFullScaleDeg)}°`,
              twoDots,
            })}
          </li>
          {apr ? (
            <ApproachMethodItems a={apr} />
          ) : (
            <li>
              <strong>{t("debrief.method.stabilised.title")}</strong>{" "}
              {t("debrief.method.stabilised.text", {
                gate1: fmt(1000, 0, "ft"),
                gate2: fmt(500, 0, "ft"),
                vs: fmt(c.maxVsFpm, 0, "fpm"),
                below: fmtSigned(-c.speedBelowKt, 0),
                above: fmtSigned(c.speedAboveKt, 0, "kt"),
                oneDot,
                bank: fmt(c.maxBankDeg, 0, "°"),
                from: fmtNum(c.vappFromFt),
                to: fmt(c.vappToFt, 0, "ft"),
                factor: fmtNum(c.vs0Factor, 1),
                speed: fmt(a.referenceSpeedKt, 0, "kt"),
                source: SPEED_REF_LABEL[a.referenceSpeedSource],
              })}
            </li>
          )}
          <li>
            <strong>{t("debrief.method.flare.title")}</strong> {t("debrief.method.flare.text", { pct: `${fmtNum(c.flareVsFraction * 100)}${NNBSP}%` })}{" "}
            <strong>{t("debrief.method.rollout.title")}</strong> {t("debrief.method.rollout.text", { speed: fmt(c.rolloutEndKt, 0, "kt") })}
          </li>
          <li>
            <strong>{t("debrief.method.wind.title")}</strong>{" "}
            {t("debrief.method.wind.text", {
              radius: fmt(25, 0, "nm"),
              hours: t("debrief.method.wind.hours", { count: 2 }),
              maxAge: fmt(METAR_MAX_AGE_MIN / 60, 0, "h"),
            })}
          </li>
          <li>{t("debrief.method.bands", { vs: VS_BANDS, g: G_BANDS })}</li>
          <li>
            <strong>{t("debrief.method.index.title")}</strong> {t("debrief.method.index.text")}
            <ul className="method-sub">
              {indexFormulaLines().map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <div className="index-parts num">
              {t("debrief.method.index.thisLanding")}{" "}
              {index.parts
                .map((p) =>
                  p.points == null
                    ? t("debrief.method.index.partNa", { label: INDEX_LABEL[p.key] })
                    : t("debrief.method.index.part", { label: INDEX_LABEL[p.key], points: fmtNum(p.points, 2), weight: p.weight }),
                )
                .join(" · ")}{" "}
              → {index.value ?? indexText(index)}
            </div>
          </li>
        </ul>
      </Panel>

      <Panel title={t("debrief.section.protocol")} collapsible defaultOpen={false} level={3} className="debrief-fold debrief-protocol">
        <KV
          rows={[
            [t("debrief.protocol.simulator"), `${providerLabel(f.provider)}${f.simName ? ` · ${f.simName}` : ""}`],
            [
              t("debrief.protocol.sampleRate"),
              t("debrief.protocol.sampleRateValue", { count: a.samples.length, hz: trackHz != null ? fmt(trackHz, trackHz < 2 ? 1 : 0, "Hz") : "–" }),
            ],
            [
              t("debrief.protocol.landingRate"),
              !isRated(td)
                ? `${t("band.unrated")} – ${t("debrief.protocol.rateMeasured", { measured: fmt(td.vsFpmMeasured, 0, "fpm") })}`
                : td.landingRateSource === "sim"
                ? t("debrief.protocol.rateSim", { sim: fmt(td.vsFpmSim, 0, "fpm"), measured: fmt(td.vsFpmMeasured, 0, "fpm") })
                : t("debrief.protocol.rateMeasured", { measured: fmt(td.vsFpmMeasured, 0, "fpm") }),
            ],
            [t("debrief.protocol.runwayData"), runwayProtocol()],
            [t("debrief.protocol.wind"), windProtocol()],
            // what a track-v2 flight recorded from the sim (TAS, wind at the aircraft, ILS); older flights: no row
            ...(recordedProtocolText(d.recorded) ? [[t("debrief.protocol.recorded"), recordedProtocolText(d.recorded)] as [string, string]] : []),
            // approach stage 2: sim ILS next to the geometry, sim wind of the final, automation (informative)
            ...(apr && ilsProtocolText(apr) ? [[t("debrief.protocol.ilsGeometry"), ilsProtocolText(apr)] as [string, string]] : []),
            ...(apr && windProtocolText(apr) ? [[t("debrief.protocol.simWind"), windProtocolText(apr)] as [string, string]] : []),
            ...(apr && automationText(apr) ? [[t("debrief.protocol.automation"), t("debrief.protocol.automationInfo", { text: automationText(apr) ?? "" })] as [string, string]] : []),
            [
              t("debrief.protocol.approachStart"),
              ap.startReason === "altitude"
                ? t("debrief.protocol.startAltitude", { alt: fmt(c.approachStartFt, 0, "ft") })
                : ap.startReason === "distance"
                  ? t("debrief.protocol.startDistance", { dist: fmt(c.approachFallbackM / 1852, 0, "nm") })
                  : ap.startReason === "trackStart"
                    ? t("debrief.protocol.startTrack")
                    : "–",
            ],
            [t("debrief.protocol.integrity"), flags.length ? flags.join(" · ") : t("debrief.protocol.integrityOk")],
            // g-load over the flight (outside the touchdowns); not measured: no row
            ...(gLoadProtocol(f.gLoad) ? [[t("gload.protocol.label"), gLoadProtocol(f.gLoad)] as [string, string]] : []),
            [
              t("debrief.protocol.thresholds"),
              t("debrief.protocol.thresholdsValue", {
                tdz: tp ? zoneText(tp, rwy) : `0–${fmt(c.tdzEndM, 0, "m")}`,
                gp: fmt(c.glidepathDeg, 1, "°"),
                tol: `${degNum(c.glidepathToleranceDeg)}°`,
                oneDot,
                vs: fmt(c.maxVsFpm, 0, "fpm"),
                below: fmtSigned(-c.speedBelowKt, 0),
                above: fmtSigned(c.speedAboveKt, 0, "kt"),
                bank: fmt(c.maxBankDeg, 0, "°"),
              }),
            ],
          ]}
        />
      </Panel>
    </div>
  );
}
