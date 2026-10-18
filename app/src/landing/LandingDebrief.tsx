import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NNBSP, fmt, fmtClock, fmtDateTime, fmtNum, fmtSigned, fmtWind } from "../format";
import { usePrivacy } from "../prefs";
import { userMessage } from "../errors";
import TrackMap from "../map/TrackMap";
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
  buildHints,
  degNum,
  indexFormulaLines,
  indexText,
  isDerivedRunway,
  keySentence,
  landingIndex,
  lateralMeasurable,
  metarAgeNote,
  provenance,
  runwaySourceNote,
  runwaySourceOf,
  sampleRateHz,
  widthText,
  windComponentsText,
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

/** Everything that can take keyboard focus inside the dialog, in DOM order and visible. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]"));
}

/**
 * Tab / Shift+Tab cycle inside the dialog. Focus outside of it (a toast: the toast viewport
 * stays usable above the debrief) keeps the normal order.
 */
function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const active = document.activeElement;
  const inside = !!active && root.contains(active);
  if (active && !inside && active !== document.body) return;
  const items = focusables(root);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

/** Back to where the debrief was opened from; that element may be gone (a toast button). */
function restoreFocus(before: HTMLElement | null) {
  const target = before && before.isConnected && before !== document.body && !before.closest("[inert]") ? before : document.querySelector<HTMLElement>("main.layout");
  target?.focus({ preventScroll: true });
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
  const [index, setIndex] = useState<number | null>(target.touchdownIndex);
  /** Approach chosen in the picker (or by the caller); null = the one of the shown touchdown. */
  const [approachPick, setApproachPick] = useState<number | null>(target.approachIndex);
  const [data, setData] = useState<LandingDebriefData | null>(null);
  /** `final`: retrying cannot help (the flight has no landing). */
  const [error, setError] = useState<{ title: string; hint?: string; final?: boolean } | null>(null);
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
      .catch((e) => {
        if (!alive) return;
        const raw = String(e);
        if (/keine Landung/i.test(raw)) setError({ title: raw, final: true });
        else {
          const m = userMessage(e, "logbook");
          setError({ title: m.title, hint: m.hint });
        }
      });
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

  // A real modal: everything behind it is inert (the title bar stays usable for the window
  // controls), Tab cycles inside, Esc closes, focus moves in and back to where it came from.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const behind = document.querySelector<HTMLElement>(".shell-body");
    behind?.setAttribute("inert", "");
    document.body.classList.add("modal-open");
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // bubble phase on window: an open popover inside (source chip) gets Esc first on
      // document and stops it there, so Esc closes the innermost layer only
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        closeDebrief();
      } else if (e.key === "Tab") trapTab(e, dialogRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      behind?.removeAttribute("inert");
      document.body.classList.remove("modal-open");
      restoreFocus(before);
    };
  }, []);

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
          : { kind: "error", reason: "zu dieser Landung wurde im Track kein Anflug gefunden" };

  const pickApproach = (a: ApproachAnalysis) => {
    setApproachPick(a.index);
    if (a.outcome.kind !== "goAround" && a.outcome.touchdownIndex !== shownIndex) setIndex(a.outcome.touchdownIndex);
  };
  const pickTouchdown = (i: number) => {
    setApproachPick(null);
    setIndex(i);
  };
  const showPicker = list != null && list.length > 1;

  return (
    <div ref={dialogRef} className="debrief-overlay" role="dialog" aria-modal="true" aria-labelledby={`${kickerId} ${titleId}`}>
      <div className="debrief">
        <div className="debrief-bar">
          <span className="debrief-kicker" id={kickerId}>{isGoAround ? "Anflugauswertung" : "Landeauswertung"}</span>
          {showPicker ? (
            <span className="segmented approach-picker" role="radiogroup" aria-label="Anflug wählen">
              {list.map((a) => (
                <button key={a.index} role="radio" aria-checked={selected?.index === a.index} className={selected?.index === a.index ? "active" : ""} onClick={() => pickApproach(a)}>
                  {approachLabel(a)}
                </button>
              ))}
            </span>
          ) : (
            count > 1 && (
              <span className="debrief-pager" role="group" aria-label="Landung wählen">
                <button className="btn-sm" disabled={shownIndex <= 0} onClick={() => pickTouchdown(shownIndex - 1)} aria-label="Vorherige Landung">
                  ‹
                </button>
                <span className="detail num">
                  Landung {shownIndex + 1} von {count}
                </span>
                <button className="btn-sm" disabled={shownIndex >= count - 1} onClick={() => pickTouchdown(shownIndex + 1)} aria-label="Nächste Landung">
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
            title="Diesen Flug im Logbuch öffnen"
          >
            Im Logbuch
          </button>
          <button ref={closeRef} className="btn-sm" onClick={closeDebrief} title="Schließen (Esc)">
            Schließen
          </button>
        </div>
        {isGoAround && selected ? (
          <GoAroundBody a={selected} flight={data?.flight ?? null} titleId={titleId} />
        ) : error ? (
          <div className="debrief-state">
            <strong>{error.title}</strong>
            {error.hint && <div className="detail">{error.hint}</div>}
            {!error.final && (
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
                  Erneut versuchen
                </button>
              </div>
            )}
          </div>
        ) : !data ? (
          <div className="debrief-state detail">Landung wird ausgewertet …</div>
        ) : (
          <DebriefBody d={data} approach={landingApproach} titleId={titleId} onRunwayChanged={runwayChanged} />
        )}
      </div>
    </div>
  );
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
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const run = (kind: "save" | "copy") => {
    setBusy(kind);
    (kind === "save" ? saveCardPng(d, approach) : copyCardPng(d, approach)).finally(() => setBusy(null));
  };
  return (
    <div className="debrief-card-actions">
      <button className="btn-sm" disabled={busy != null} onClick={() => run("save")} title="Landekarte als PNG speichern (2400 × 1350 px)">
        {busy === "save" ? "Speichert …" : "Landekarte speichern"}
      </button>
      <button className="btn-sm" disabled={busy != null} onClick={() => run("copy")} title="Landekarte als PNG in die Zwischenablage kopieren">
        {busy === "copy" ? "Kopiert …" : "Landekarte kopieren"}
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
  const c = a.config;
  return (
    <>
      <li>
        <strong>Anflug-Referenzen:</strong> Gleitpfad ist ein angenommener {fmt(c.glidepathDeg, 0, "°")}-Pfad über {fmt(c.tchFt, 0, "ft")} Schwellenhöhe – ohne
        Verfahrensdaten, der echte ILS-/RNAV-Winkel kann abweichen („{fmt(c.glidepathDeg, 0, "°")}-Annahme“). 1 Dot Gleitpfad = {fmtNum(c.gsDotDeg, 2)}°. Kurs
        (Lokalizer-Ersatz): Winkel von einer gedachten Antenne {fmt(c.locAntennaBeyondEndM, 0, "m")} hinter dem Pistenende, 1 Dot = {fmt(c.locDotMAtThreshold, 0, "m")}{" "}
        an der Schwelle. „Eingedreht“ ab dem ersten Punkt, ab dem Kurs ≤ {fmt(c.establishedTrackDeg, 0, "°")} zur Bahn und Querablage ≤ max.{" "}
        {fmt(c.establishedMinM, 0, "m")} bzw. {fmtNum(c.establishedRatio * 100)}{NNBSP}% der Distanz blieben.
      </li>
      <li>
        <strong>Referenz-Speed (Vapp):</strong> 1. die beim Flugzeug eingetragene Vapp (Logbuch → Flugzeuge); 2. sonst der Median der eigenen IAS zwischen {fmtNum(c.vappFromFt)} und{" "}
        {fmt(c.vappToFt, 0, "ft")} dieses Anflugs – das bewertet die Konstanz der Geschwindigkeit, nicht ob sie für das Muster richtig war; 3. ohne messbare IAS
        entfallen Speed- und Energiekriterien. Sobald VS0 bekannt ist, wird die Referenz gegen {fmtNum(c.vappMinVs0, 1)}–{fmtNum(c.vappMaxVs0, 1)} × VS0 geprüft. Dieser
        Anflug: {fmt(a.reference.vappKt, 0, "kt")} ({VAPP_SOURCE_LABEL[a.reference.vappSource]}).
      </li>
      <li>
        <strong>Gates:</strong> 10{NNBSP}nm – Höhe ±{fmt(c.tenNmAltToleranceFt, 0, "ft")} zum Pfad und Energie ≤ {fmtSigned(c.tenNmMaxEnergyFt, 0, "ft")} (nur wenn
        eingedreht), IAS ≤ {fmt(c.tenNmMaxIasKt, 0, "kt")}; FAF ({fmt(c.fafDistNm, 0, "nm")} vor der Schwelle oder {fmt(c.fafHatFt, 0, "ft")}, was zuerst kommt) –
        Fahrwerk, Klappen ≥ 1, Höhe ±{fmt(c.fafAltToleranceFt, 0, "ft")}, Speed {fmtSigned(-c.fafSpeedBelowKt, 0)}/{fmtSigned(c.fafSpeedAboveKt, 0, "kt")}; 1000 und
        500{NNBSP}ft – Fahrwerk ≥ {fmtNum(c.gearDownPct)}{NNBSP}%, Landeklappen, |V/S| ≤ {fmt(c.gateMaxVsFpm, 0, "fpm")}, Speed {fmtSigned(-c.gateSpeedBelowKt, 0)}/
        {fmtSigned(c.gateSpeedAboveKt, 0, "kt")}, Gleitpfad und Kurs ±{fmtNum(c.gateDots)}{NNBSP}Dot, Querneigung ≤ {fmt(c.gateMaxBankDeg, 0, "°")}; 50{NNBSP}ft nur
        Werte. Werte sind beim letzten Durchflug interpoliert. „Nicht messbar“ zählt nie als „nicht erfüllt“.
      </li>
      <li>
        <strong>Stabilität und 3-s-Regel:</strong> Bewertet wird das Fenster {fmtNum(c.windowTopFt)} → {fmt(c.windowBottomFt, 0, "ft")} (Gleitpfad bis{" "}
        {fmt(c.gsFloorFt, 0, "ft")}). Eine Abweichung zählt erst, wenn sie ununterbrochen ihre Mindestdauer anhält – Speed {fmt(c.speedDurationS, 0, "s")}, Querneigung{" "}
        {fmt(c.bankDurationS, 0, "s")}, Sinkrate {fmt(c.vsS1DurationS, 0, "s")} (S2 {fmt(c.vsS2DurationS, 0, "s")}), Gleitpfad und Kurs {fmt(c.gsDurationS, 0, "s")};
        kürzere Ausreißer unter {fmt(c.momentaryS, 0, "s")} gelten als Momentanwerte. Stufe S1/S2: Speed {fmtSigned(-c.speedS1BelowKt, 0)}/{fmtSigned(c.speedS1AboveKt, 0)} bzw.{" "}
        {fmtSigned(-c.speedS2BelowKt, 0)}/{fmtSigned(c.speedS2AboveKt, 0, "kt")}, Sinkrate {fmtNum(c.vsS1Fpm)}/{fmt(c.vsS2Fpm, 0, "fpm")}, Gleitpfad {fmtNum(c.gsS1Dots)}/
        {fmtNum(c.gsS2Dots)}{NNBSP}Dots, Kurs {fmtNum(c.locS1Dots)}/{fmtNum(c.locS2Dots, 1)}{NNBSP}Dots, Querneigung {fmtNum(c.bankS1Deg)}/{fmt(c.bankS2Deg, 0, "°")}. „Stabil ab“ ist
        die höchste Höhe (bis {fmt(c.stableFromMaxFt, 0, "ft")}, auf {fmtNum(c.stableRoundFt)}{NNBSP}ft abgerundet), ab der bis {fmt(c.windowBottomFt, 0, "ft")} nichts
        mehr überschritten wurde.
      </li>
      <li>
        <strong>Bänder:</strong> {APPROACH_BAND_LABEL.stable} – keine Überschreitung; {APPROACH_BAND_LABEL.deviations} – 1–2 Kriterien über 500{NNBSP}ft, keine darunter;{" "}
        {APPROACH_BAND_LABEL.unstable} – 3 oder mehr Kriterien über 500{NNBSP}ft; {APPROACH_BAND_LABEL.unstableBelow500} – mindestens eine Überschreitung unter 500{NNBSP}ft
        (nach EASA / Data4Safety). Ein Durchstarten ist kein Band, sondern das Ergebnis des Anflugs.
      </li>
      <li>
        <strong>Auflösung:</strong> Grundlage ist der gespeicherte Track mit 1 Sample pro Sekunde (über {fmt(c.profileDenseBelowFt, 0, "ft")} auf eines je{" "}
        {fmt(c.profileSparseS, 0, "s")} ausgedünnt). Dauern sind ganze Sekunden; Spitzen zwischen zwei Samples sieht die Auswertung nicht. Höhen sind über dem
        Aufsetzpunkt (HAT); beim Durchstarten über der Platzhöhe aus der Datenbank.
      </li>
    </>
  );
}

/** Debrief of a go-around: only the approach (with the lowest point), no landing part, no card. */
function GoAroundBody({ a, flight, titleId }: { a: ApproachAnalysis; flight: FlightRow | null; titleId: string }) {
  const priv = usePrivacy();
  const hints = useMemo(() => approachHints(a), [a]);
  const rwy = a.runway;
  const title = rwy ? `${rwy.airport} RWY ${rwy.ident}` : "Anflug ohne zugeordnete Piste";
  const when = a.goAround?.lowestTMs ?? a.endTMs;
  return (
    <div className="debrief-body">
      <header className="debrief-head">
        <div>
          <h2 className="debrief-title" id={titleId}>
            {title} <span className="detail">· Durchstarten</span>
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

      <ApproachSection status={{ kind: "ok", approach: a }} />

      <section className="debrief-section">
        <h3>Anflugprofil</h3>
        <ApproachChart approach={a} />
        <ReplaySection a={null} apr={a} />
      </section>

      <section className="debrief-section">
        <h3>Hinweise</h3>
        <HintList hints={hints} />
      </section>

      <Panel title="Stabilisierter Anflug – Gates" collapsible defaultOpen={false} level={3} className="debrief-fold">
        <StabilisedTable approach={a} />
      </Panel>

      <Panel title="Methodik" collapsible defaultOpen={false} level={3} className="debrief-fold debrief-method">
        <ul className="method">
          <li>
            <strong>Durchstarten:</strong> erkannt, wenn nach einem Sinkflug unter {fmt(a.config.gaMaxAglFt, 0, "ft")} innerhalb von {fmt(a.config.gaWindowS, 0, "s")}{" "}
            mindestens {fmt(a.config.gaMinClimbFt, 0, "ft")} gestiegen wird (bzw. die Phasen-Erkennung Approach/Final → Climb meldet). Der tiefste Punkt ist der
            Entscheidungspunkt; es gibt keine Landekarte.
          </li>
          <ApproachMethodItems a={a} />
        </ul>
      </Panel>
    </div>
  );
}

function DebriefBody({ d, approach, titleId, onRunwayChanged }: { d: LandingDebriefData; approach: ApproachStatus; titleId: string; onRunwayChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const priv = usePrivacy();
  const closeEditor = useCallback(() => setEditing(false), []);
  const apr = approach.kind === "ok" ? approach.approach : null;
  const a = d.analysis;
  const td = a.touchdown;
  const rwy = a.runway;
  const tp = a.touchdownPoint;
  const f = d.flight;
  const hints = useMemo(() => buildHints(d, apr), [d, apr]);
  const sentence = useMemo(() => keySentence(d), [d]);
  const src = useMemo(() => provenance(d), [d]);
  const index = useMemo(() => landingIndex(a, apr), [a, apr]);
  const place = d.airport?.ident ?? rwy?.airport ?? null;
  const title = rwy ? `${rwy.airport} RWY ${rwy.ident}` : place ? `${place} · keine Piste zugeordnet` : "Landung ohne Flugplatz";
  const metarAge = metarAgeNote(d);
  const declaredLengthM = d.runwayData?.lengthFt ? d.runwayData.lengthFt * 0.3048 : rwy?.lengthM;
  const trackHz = sampleRateHz(a.samples);
  const rwySource = runwaySourceOf(rwy);
  const derived = isDerivedRunway(rwy);
  const measurable = tp ? lateralMeasurable(tp) : false;
  const uncertainty = tp?.distanceUncertaintyM ?? null;
  // the editor needs an airport: the matched runway's, else the nearest one
  const editIcao = rwy?.airport ?? d.airport?.ident ?? null;

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
  const ap = a.approach;
  const halfW = rwy?.widthM != null ? rwy.widthM / 2 : null;
  const integrity = f.integrity;
  const flags = integrity
    ? [
        integrity.slewDetected && "Slew",
        integrity.timeAccelerationDetected && `Zeitraffer (max. ${fmt(integrity.maxSimRate, 0)}×)`,
        integrity.crashed && "Absturz",
        integrity.fuelIncreasedAirborne && "Treibstoff in der Luft erhöht",
        integrity.pauseCount > 0 && `${integrity.pauseCount}× Pause`,
      ].filter(Boolean)
    : [];

  return (
    <div className="debrief-body">
      <header className="debrief-head">
        <div>
          <h2 className="debrief-title" id={titleId}>
            {title}
          </h2>
          {(rwy || editIcao) && (
            <div className={`debrief-rwy-source src-${rwySource}`}>
              <span>{rwy ? runwaySourceNote(rwy) : "Keine Piste zugeordnet"}</span>
              {editIcao && (
                <button className="btn-sm" onClick={() => setEditing(true)} title="Schwelle und Ende der Piste selbst festlegen">
                  Piste korrigieren …
                </button>
              )}
            </div>
          )}
          <div className="detail">
            {[
              d.airport?.name,
              fmtDateTime(td.timestampMs),
              priv.title(f.aircraft.title, { registration: f.aircraft.atcId, airline: f.aircraft.atcAirline, callsign: f.callsign }) || "Unbekanntes Flugzeug",
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
          <div className="hero-label">Wind (METAR{d.metar ? ` ${d.metar.station}` : ""}{d.metar?.time ? ` ${d.metar.time}` : ""})</div>
          {d.metar ? (
            <>
              <div className={`debrief-wind-source${d.metarAtLanding && !metarAge ? "" : " is-current"}`}>
                {metarAge ?? (d.metarAtLanding ? "Wetter zum Zeitpunkt der Landung" : "aktuelles Wetter")}
              </div>
              <div className="debrief-wind-main num">{metarWind ?? "keine Windangabe"}</div>
              {w && <div className="detail num">{windComponentsText(a)}{w.relativeToRunway ? "" : " (zum Steuerkurs)"}</div>}
              {d.metarNote && <div className="detail">{d.metarNote}</div>}
            </>
          ) : (
            <div className="detail">{d.metarNote ?? "keine METAR"}</div>
          )}
        </div>
      </header>

      <p className="debrief-sentence">{sentence}</p>

      <div className="hero-row">
        <Hero
          size="xl"
          label="Landerate"
          value={fmt(td.landingRateFpm, 0)}
          unit="fpm"
          band={a.vsBand}
          source={src.rate}
          title={`Bänder: ${VS_BANDS}`}
          sub={td.landingRateSource === "sim" ? `Messwert ${fmt(td.vsFpmMeasured, 0, "fpm")} · letztes Sample in der Luft` : "Sim lieferte keinen Wert – Messwert"}
        />
        <Hero
          label="Aufsetzpunkt"
          value={tp ? fmt(tp.distanceM, 0) : "–"}
          unit={uncertainty != null && uncertainty > 0 ? `± ${fmtNum(uncertainty, 0)}${NNBSP}m` : "m"}
          source={src.point}
          sub={
            tp
              ? `${tp.inTdz ? "in der Aufsetzzone" : "außerhalb der Aufsetzzone"}${rwy?.lengthEstimated ? " (angenommen)" : ""} · ` +
                (measurable ? `${sideLabel(tp.lateralM)}${sideLabel(tp.lateralM).startsWith("auf") ? "" : " der Mittellinie"}` : "Querablage nicht messbar")
              : "keine Piste zugeordnet"
          }
        />
        <Hero label="g-Last" value={fmt(td.peakG, 2)} unit="g" band={a.gBand} source={src.g} title={`Bänder: ${G_BANDS}`} sub="Spitze 0,5 s nach dem Kontakt" />
      </div>
      {/* the band definitions as text, not only in the heroes' tooltips (keyboard, screen reader) */}
      <p className="detail debrief-bands">
        Bänder – Landerate: {VS_BANDS} · g-Last: {G_BANDS}
      </p>

      <div className="fact-row">
        <Fact label={td.bounces ? `härtester Kontakt ${fmt(td.vsFpmHardest, 0, "fpm")}` : td.touchAndGo ? "Touch-and-go" : "Full Stop"} value={`${td.bounces} ${td.bounces === 1 ? "Bounce" : "Bounces"}`} warn={td.bounces ? "Bounce nach dem ersten Aufsetzen" : null} />
        {tp && !measurable ? (
          <div className="fact fact-na" title="Die Piste wurde aus deiner Rollspur abgeleitet: ihre Achse ist deine eigene Linie, die Abweichung von der echten Mittellinie lässt sich daraus nicht bestimmen.">
            <div className="fact-value">nicht messbar</div>
            <div className="fact-label">Mittellinie · Piste aus deiner Rollspur abgeleitet</div>
          </div>
        ) : (
          <Fact
            label={rwy ? (rwy.widthM != null ? `Mittellinie · Piste ${fmt(rwy.widthM, 0, "m")} breit` : "Mittellinie · Breite unbekannt") : "Mittellinie"}
            value={tp ? sideLabel(tp.lateralM) : "–"}
            warn={tp && halfW != null && Math.abs(tp.lateralM) > halfW / 2 ? "Mehr als ein Viertel der Pistenbreite neben der Mittellinie" : null}
          />
        )}
        <Fact
          label={a.rollout ? `Rollout bis ${fmt(a.config.rolloutEndKt, 0, "kt")}${rwy && a.rollout.remainingM != null ? ` · Rest ${fmt(a.rollout.remainingM, 0, "m")}` : ""}` : "Rollout"}
          value={a.rollout ? fmt(a.rollout.distanceM, 0, "m") : td.touchAndGo ? "Touch-and-go" : "–"}
          warn={a.rollout?.remainingM != null && a.rollout.remainingM < 0 ? "Rollout endete hinter dem Pistenende" : null}
        />
        <div className="index-line" title="Zusammenfassung der Rohwerte – Formel unter „Methodik“">
          <span className="detail">VectaSim-Index</span>{" "}
          {index.value != null ? (
            <>
              <strong className="num">{index.value}</strong>
              <span className="detail"> / 100 · Formel unter „Methodik“</span>
            </>
          ) : (
            <span className="detail">{indexText(index)} · nur mit allen Teilen messbar, siehe „Methodik“</span>
          )}
        </div>
      </div>

      <ApproachSection status={approach} />

      <HistoryPanel flightId={f.id} touchdownIndex={a.touchdownIndex} approachIndex={apr?.index ?? null} />

      <section className="debrief-section">
        <h3>{rwy ? `Piste ${rwy.ident} von oben` : "Aufsetzpunkt auf der Karte"}</h3>
        {rwy && tp ? (
          <RunwayDiagram analysis={a} />
        ) : (
          <>
            <p className="detail">
              Keine Piste zugeordnet: Im Umkreis von {fmt(a.config.matchLateralM / 1852, 0, "nm")} um den Aufsetzpunkt liegt keine Piste, deren Richtung bis auf ±
              {fmtNum(a.config.matchHeadingDeg)}° zum Steuerkurs passt. Aufsetzpunkt, Abweichung von der Mittellinie und Gleitpfad entfallen.
            </p>
            {mapSamples.length > 1 && <TrackMap samples={mapSamples} touchdowns={tdList} />}
          </>
        )}
      </section>

      <section className="debrief-section">
        <h3>Anflugprofil</h3>
        <ApproachChart analysis={a} approach={apr} />
        <ReplaySection a={a} apr={apr} />
      </section>

      <section className="debrief-section">
        <h3>Hinweise</h3>
        <HintList hints={hints} />
      </section>

      <Panel title={apr ? "Stabilisierter Anflug – Gates" : "Stabilisierter Anflug"} collapsible defaultOpen={false} level={3} className="debrief-fold">
        {apr ? (
          <>
            <StabilisedTable approach={apr} />
            <p className="detail sa-note">
              Speed gegen die Referenz {fmt(apr.reference.vappKt, 0, "kt")} ({VAPP_SOURCE_LABEL[apr.reference.vappSource]}); Gleitpfad gegen den{" "}
              {fmt(apr.reference.glidepathDeg, 0, "°")}-Pfad{apr.reference.glidepathSource === "assumed" ? " (Annahme)" : ""}.
            </p>
          </>
        ) : (
          <>
            <StabilisedTable gates={a.gates} />
            <p className="detail sa-note">
              Speed gegen die Referenz {fmt(a.referenceSpeedKt, 0, "kt")} ({SPEED_REF_LABEL[a.referenceSpeedSource]}); Gleitpfad ±{degNum(a.config.glidepathToleranceDeg)}° = 1{NNBSP}Dot,
              mehr als {degNum(a.config.glidepathFullScaleDeg)}° (2 Dots, Vollausschlag) ist Stufe S2.
            </p>
          </>
        )}
      </Panel>

      <Panel title="Abfangen & Rollout" collapsible defaultOpen={false} level={3} className="debrief-fold">
        <KV
          rows={[
            ["Abfangen ab", a.flare ? fmt(a.flare.startHatFt, 0, "ft") : "nicht erkennbar"],
            ["Dauer bis Aufsetzen", a.flare ? fmt(a.flare.durationS, 0, "s") : "–"],
            ["Sinkrate vor / nach Abfangen", a.flare ? `${fmt(a.flare.approachVsFpm, 0)} / ${fmt(a.flare.finalVsFpm, 0, "fpm")}` : "–"],
            ["Schwellenüberflug", a.threshold ? `${fmt(a.threshold.heightFt, 0, "ft")} · ${fmt(a.threshold.iasKt, 0, "kt")}` : "–"],
            ["Zeit Schwelle → Aufsetzen", a.threshold ? fmt(a.threshold.airborneS, 0, "s") : "–"],
            ["IAS min / max", `${fmt(ap.iasMinKt, 0)} / ${fmt(ap.iasMaxKt, 0, "kt")}`],
            ["IAS bei 500 ft / 50 ft / Aufsetzen", `${fmt(ap.iasAt500Kt, 0)} / ${fmt(ap.iasAt50Kt, 0)} / ${fmt(ap.iasAtTouchdownKt, 0, "kt")}`],
            ["V/S unter 1000 ft", `${fmt(ap.vsMin1000Fpm, 0)} … ${fmt(ap.vsMax1000Fpm, 0, "fpm")}`],
            ["V/S unter 500 ft", `${fmt(ap.vsMin500Fpm, 0)} … ${fmt(ap.vsMax500Fpm, 0, "fpm")}`],
            ["Querneigung max. unter 500 ft", fmt(ap.bankMaxBelow500Deg, 0, "°")],
            [
              "Gleitpfad max. über / unter",
              rwy ? `${fmtSigned(ap.glidepathDevMaxAboveDeg ?? 0, 2, "°")} / ${fmtSigned(ap.glidepathDevMaxBelowDeg ?? 0, 2, "°")}` : "ohne Piste n. v.",
            ],
            ["Pitch / Bank beim Aufsetzen", `${fmt(td.pitchDeg, 1, "°")} / ${fmt(td.bankDeg, 1, "°")}`],
            ["GS beim Aufsetzen", fmt(td.groundSpeedKt, 0, "kt")],
            ["Rollout", a.rollout ? `${fmt(a.rollout.distanceM, 0, "m")} in ${fmt(a.rollout.durationS, 0, "s")}` : "–"],
            [
              rwySource === "database" ? "Piste (Datenbank)" : rwySource === "user" ? "Piste (von dir festgelegt)" : "Piste (abgeleitet)",
              rwy ? `${rwy.lengthEstimated ? `mind. ${fmt(rwy.lengthM, 0, "m")} (Länge unbekannt)` : fmt(rwySource === "user" ? rwy.lengthM : declaredLengthM, 0, "m")} × ${widthText(rwy.widthM)}` : "–",
            ],
          ]}
        />
      </Panel>

      <Panel title="Methodik" collapsible defaultOpen={false} level={3} className="debrief-fold debrief-method">
        <ul className="method">
          <li>
            <strong>Landerate:</strong> Wert des Simulators (PLANE TOUCHDOWN NORMAL VELOCITY, ×60 in fpm, negativ = sinkend). Liefert der Sim keinen neuen Wert
            (unter 1 fpm oder unverändert), gilt die Vertikalgeschwindigkeit des letzten Samples in der Luft. Bei Bounces zählt der härteste Kontakt dieses
            Landeereignisses, nie ein Spitzenwert über den ganzen Flug; zwei Bodenkontakte mit weniger als 0,3{NNBSP}s Luft dazwischen gelten als ein Kontakt. Die
            Flug-Landerate im Logbuch ist die letzte Landung mit Full Stop.
          </li>
          <li>
            <strong>Messwert:</strong> letztes Sample vor dem Bodenkontakt aus dem Telemetriestrom (in der Bildrate des Simulators). Weil V/S am Boden bedeutungslos ist
            und auch eine hohe Abtastrate den Kontaktmoment verfehlen kann, weicht er vom Sim-Wert ab. „Am Boden“ zählt nur, wenn die Höhe über Grund höchstens 50 ft
            beträgt; die Landung gilt erst nach drei aufeinanderfolgenden Boden-Samples (≥ 2 s) als bestätigt.
          </li>
          <li>
            <strong>g-Last:</strong> höchstes Lastvielfaches in der halben Sekunde nach jedem Kontakt (Bugrad-Aufsetzen danach nicht enthalten); unplausible Werte
            (über 5 g, negativ) werden verworfen. {G_BAND_REASON}
          </li>
          <li>
            <strong>Track:</strong> Anflug, Abfangen und Rollout stammen aus dem gespeicherten Track mit 1 Sample pro Sekunde. Höhen sind „über Aufsetzpunkt“: Höhe MSL minus
            MSL des ersten Boden-Samples – unabhängig von Gelände unter dem Anflug und von der Flugplatzhöhe in der Datenbank. Der Anflug beginnt beim letzten Sinken
            durch 1000 ft, sonst 3 nm vor dem Aufsetzen.
          </li>
          <li>
            <strong>Piste:</strong> OurAirports (Public Domain); Koordinaten beider Pistenenden, Breite aus der Datenbank (fehlt sie: „Breite unbekannt“). Eine
            versetzte Schwelle aus der Datenbank verschiebt die Schwelle entlang der Achse
            {d.thresholdDisplacedM ? ` (hier ${fmt(d.thresholdDisplacedM, 0, "m")})` : ""}. Zugeordnet wird die nächste Piste innerhalb{" "}
            {fmt(a.config.matchLateralM / 1852, 0, "nm")}, deren Richtung bis auf ±{fmtNum(a.config.matchHeadingDeg)}° zum Steuerkurs beim Aufsetzen passt.{" "}
            {RUNWAY_ACCURACY_NOTE} <strong>Aufsetzzone</strong> (ICAO/FAA): ab der Schwelle bis {fmt(a.config.tdzEndM, 0, "m")}, auf Pisten unter{" "}
            {fmt(a.config.tdzEndM * 3, 0, "m")} das erste Drittel. Der Zielpunkt (Markierung nach ICAO Annex 14: 150/250/300/400{NNBSP}m je nach Pistenlänge
            {tp ? `, hier ${fmt(tp.aimingPointM, 0, "m")}` : ""}) liegt in der Zone und ist nur eine Marke.{" "}
            <strong>Ohne Koordinaten in OurAirports</strong> leitet VectaSim die Piste aus deiner Rollspur ab: Achse = Linie deines Rollouts, Schwelle{" "}
            {fmt(300, 0, "m")} vor dem Aufsetzpunkt (bzw. am Zielpunkt der Datenbank-Länge) angenommen, ±50{NNBSP}m entlang. Die Querablage ist dann nicht
            messbar; ohne bekannte Länge ist die Aufsetzzone die feste Annahme 0–{fmt(a.config.tdzEndM, 0, "m")} und der Rest der Piste entfällt. Jede weitere
            Landung dort verfeinert die gemerkte Piste. Mit „Piste korrigieren …“ legst du Schwelle und Ende selbst fest – deine Piste hat Vorrang vor OurAirports.
            {derived ? " Diese Landung: abgeleitete Piste." : ""}
          </li>
          <li>
            <strong>Gleitpfad:</strong> Winkel vom Aufsetzpunkt der {fmt(a.config.glidepathDeg, 0, "°")}-Referenz ({fmt(a.config.tchFt, 0, "ft")} über der Schwelle) zum
            Flugzeug, erst ab 0,25 nm davor. Toleranz ±{degNum(a.config.glidepathToleranceDeg)}° = 1{NNBSP}Dot (FSF: „within one dot“); ±
            {degNum(a.config.glidepathFullScaleDeg)}° ist der Vollausschlag (2 Dots) und wird nur als Stufe S2 genannt. Ohne zugeordnete Piste entfällt er.
          </li>
          {apr ? (
            <ApproachMethodItems a={apr} />
          ) : (
          <li>
            <strong>Stabilisierter Anflug</strong> bei 1000 ft und 500 ft (interpoliert): Fahrwerk unten, Klappen gesetzt, |V/S| ≤ {fmt(a.config.maxVsFpm, 0, "fpm")},
            IAS {fmtSigned(-a.config.speedBelowKt, 0)}/{fmtSigned(a.config.speedAboveKt, 0, "kt")} zur Referenz-Geschwindigkeit, Gleitpfad ±1{NNBSP}Dot, Querneigung
            ≤ {fmt(a.config.maxBankDeg, 0, "°")}. Referenz: 1. die beim Flugzeug eingetragene Vapp (Logbuch → Flugzeuge); 2. sonst der Median der geflogenen IAS zwischen {fmtNum(a.config.vappFromFt)}{" "}
            und {fmt(a.config.vappToFt, 0, "ft")} – das misst die Konstanz, nicht ob die Geschwindigkeit für das Muster richtig war; 3. sonst{" "}
            {fmtNum(a.config.vs0Factor, 1)} × VS0. Diese Landung: {fmt(a.referenceSpeedKt, 0, "kt")} ({SPEED_REF_LABEL[a.referenceSpeedSource]}).
          </li>
          )}
          <li>
            <strong>Abfangen:</strong> ab dem Sample, nach dem die Sinkrate bis zum Aufsetzen unter {fmtNum(a.config.flareVsFraction * 100)}{NNBSP}% der mittleren Anflug-Sinkrate
            (500–200 ft) blieb; Auflösung 1 s. <strong>Rollout:</strong> vom Aufsetzen bis GS unter {fmt(a.config.rolloutEndKt, 0, "kt")}.
          </li>
          <li>
            <strong>Wind:</strong> METAR des Flugplatzes zum Zeitpunkt der Landung (bei der Landung gespeichert), sonst die aktuelle – ohne eigene METAR die der nächsten
            Station im Umkreis von 25 nm (aviationweather.gov bzw. VATSIM), nur für Landungen der letzten 2 Stunden. Liegt die Beobachtungszeit der Meldung mehr als
            1{NNBSP}h vor oder nach dem Aufsetzen, steht das beim Wind. Gegen-/Seitenwind sind auf die Pistenrichtung (rechtweisend) bezogen; bei VRB oder einer
            Richtungs-Spanne (dddVddd) zeigt VectaSim zusätzlich den ungünstigsten Seitenwind darin.
          </li>
          <li>Bänder: Landerate {VS_BANDS}; g-Last {G_BANDS}.</li>
          <li>
            <strong>VectaSim-Index</strong> (klein unter den Rohwerten, nie als Urteil gedacht):
            <ul className="method-sub">
              {indexFormulaLines().map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <div className="index-parts num">
              Diese Landung:{" "}
              {index.parts
                .map((p) => `${INDEX_LABEL[p.key]} ${p.points == null ? "entfällt" : `${fmtNum(p.points, 2)} × ${p.weight}`}`)
                .join(" · ")}{" "}
              → {index.value ?? indexText(index)}
            </div>
          </li>
        </ul>
      </Panel>

      <Panel title="Messprotokoll" collapsible defaultOpen={false} level={3} className="debrief-fold debrief-protocol">
        <KV
          rows={[
            ["Simulator", `${providerLabel(f.provider)}${f.simName ? ` · ${f.simName}` : ""}`],
            ["Abtastrate", `Landeerkennung im Telemetriestrom (Bildrate des Simulators) · gespeicherter Track ${trackHz != null ? fmt(trackHz, trackHz < 2 ? 1 : 0, "Hz") : "–"} (${fmtNum(a.samples.length)} Samples im Anflug)`],
            ["Landerate", td.landingRateSource === "sim" ? `Sim-Wert (PLANE TOUCHDOWN NORMAL VELOCITY) ${fmt(td.vsFpmSim, 0, "fpm")} · Messwert ${fmt(td.vsFpmMeasured, 0, "fpm")}` : `Messwert ${fmt(td.vsFpmMeasured, 0, "fpm")} (Sim lieferte keinen Wert)`],
            [
              "Pistendaten",
              !rwy
                ? "keine Piste zugeordnet"
                : rwySource === "database"
                  ? `OurAirports (Public Domain) · RWY ${rwy.ident}/${rwy.oppositeIdent}, ${rwy.surface || "Belag unbekannt"}, Richtung ±${fmt(rwy.headingDiffDeg, 0, "°")} zum Steuerkurs` +
                    (d.thresholdDisplacedM ? ` · Schwelle ${fmt(d.thresholdDisplacedM, 0, "m")} versetzt (DB)` : "") +
                    " · Genauigkeit ca. ±5 m"
                  : rwySource === "user"
                    ? `von dir festgelegt · RWY ${rwy.ident}/${rwy.oppositeIdent}, Richtung ±${fmt(rwy.headingDiffDeg, 0, "°")} zum Steuerkurs`
                    : `${runwaySourceNote(rwy)} · Schwelle ±${fmt(rwy.alongUncertaintyM ?? uncertainty ?? 50, 0, "m")} entlang, Achse ±${fmt(rwy.crossUncertaintyM ?? 5, 0, "m")} quer (deine Linie) · Querablage nicht messbar` +
                      (rwy.lengthEstimated ? " · Länge unbekannt" : ""),
            ],
            [
              "Wind",
              d.metar
                ? `METAR ${d.metar.station}${d.metar.time ? ` ${d.metar.time}` : ""}${d.metarObservedMs ? ` (beobachtet ${fmtClock(d.metarObservedMs, { local: false })})` : ""} · ${d.metarAtLanding ? "bei der Landung gespeichert" : "aktuell (Näherung)"}${metarAge ? ` · ${metarAge}` : ""}`
                : d.metarNote ?? "keine METAR",
            ],
            ["Anflugbeginn", ap.startReason === "altitude" ? `letztes Sinken durch ${fmtNum(a.config.approachStartFt)} ft` : ap.startReason === "distance" ? `${fmt(a.config.approachFallbackM / 1852, 0, "nm")} vor dem Aufsetzen` : ap.startReason === "trackStart" ? "Beginn des Tracks" : "–"],
            ["Integrität", flags.length ? flags.join(" · ") : "keine Auffälligkeiten (kein Slew, kein Zeitraffer, keine Pause)"],
            [
              "Schwellwerte",
              `Aufsetzzone ${tp ? zoneText(tp, rwy) : `0–${fmt(a.config.tdzEndM, 0, "m")}`} · Gleitpfad ${fmt(a.config.glidepathDeg, 1, "°")} ±${degNum(a.config.glidepathToleranceDeg)}° (1 Dot) · |V/S| ≤ ${fmt(a.config.maxVsFpm, 0, "fpm")} · Speed ${fmtSigned(-a.config.speedBelowKt, 0)}/${fmtSigned(a.config.speedAboveKt, 0, "kt")} zur Referenz · Bank ≤ ${fmt(a.config.maxBankDeg, 0, "°")}`,
            ],
          ]}
        />
      </Panel>
    </div>
  );
}
