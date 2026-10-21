import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FlightDetail as Detail, FlightRow, Ofp, TouchdownReport, TrackSample } from "./types";
import type { ApproachAnalysis } from "./landing/approachTypes";
import { PHASE_LABEL, getWeightUnit } from "./format";
import { fmt, fmtClock, fmtCoord, fmtDate, fmtDuration, fmtWeightNum } from "./i18n/number";
import { t as tr, useLanguage, useT, type TFunction, type TKey } from "./i18n";
import { handleMenuKey, menuItems } from "./ui/menu";
import { ON_TIME_THRESHOLD_MIN, actualFromRow, buildPirep, fmtPunctuality, fmtPvaDelta, fmtPvaValue, integrityIssues, parseOfp, pirepFileName, planFromRow, planVsActual, type PirepApproach } from "./pirep";
import { usePrefs } from "./prefs";
import { TrackMap } from "./lazyMaps";
import ProfileChart from "./ProfileChart";
import ReplayBar from "./landing/ReplayBar";
import { logbookReplay, type ReplayMarker } from "./landing/replayStore";
import Collapsible from "./ui/Collapsible";
import Stat from "./ui/Stat";
import { showToast } from "./ui/Toast";
import { userMessage } from "./errors";
import { useAirport } from "./live/hooks";
import { TRASH_DAYS, callsignOf, effectiveAircraftTitle, effectiveArr, effectiveDep, effectiveRegistration, originalTitle, recordedCallsignOf, trashDaysLeft } from "./logbookFilter";
import NotesEditor from "./NotesEditor";
import { importSourceLabel, isDemoRow } from "./totals";
import LandingSummary from "./landing/LandingSummary";
import { openDebrief } from "./landing/debriefStore";
import { BAND_VAR, G_HARD, vsBandOf } from "./landing/facts";
import { isRated, rateText } from "./landing/rated";
import { gLoadSummary, gLoadTitle } from "./gload";
import HistoryPanel, { useHistoryFacts } from "./landing/HistoryPanel";
import { patternSeries } from "./landing/history";
import { linear } from "./landing/dispersionStats";
import AirframeCard from "./airframes/AirframeCard";
import { navigate } from "./airframes/navigation";
import { Modal } from "./ui/Modal";
import { ROTATION_FAST_DEG_S, ROTATION_SLOW_DEG_S, flightMetrics, fmtDegS, rotationBand, trackEvents, type FlightMetrics } from "./trackEvents";

/** The flight is the one being recorded (state active, not in the Papierkorb): it cannot be deleted. */
export const isRecording = (f: Pick<FlightRow, "state">, trashed = false): boolean => f.state === "active" && !trashed;

/** State of a flight in words; `t` defaults to the UI language. */
export function stateLabel(state: string, t: TFunction = tr): string {
  switch (state) {
    case "completed":
      return t("logbook.state.completed");
    case "active":
      return t("logbook.state.active");
    case "interrupted":
      return t("logbook.state.interrupted");
    case "discarded":
      return t("logbook.state.discarded");
    default:
      return state;
  }
}

function simulatorLabel(provider: string | null | undefined, simName: string | null | undefined): string {
  if (provider === "mock") return tr("logbook.detail.simDemo");
  if (simName) return simName;
  return provider === "simconnect" ? "MSFS" : provider || tr("logbook.detail.simUnknown");
}

/** Landing rate from which a landing counts as hard (marks and tooltips). */
const HARD_FPM = 600;

interface Props {
  detail: Detail;
  track: TrackSample[];
  /** Move to the Papierkorb – or, for a flight already in it, delete for good. */
  onDelete: () => void;
  /** Bumped by the list's Delete key: opens the inline confirmation. */
  deleteRequest?: number;
  /** The confirmation was cancelled (focus goes back to the list). */
  onCancelDelete?: () => void;
  /** Set: the flight is in the Papierkorb (deleted at this time). */
  deletedMs?: number | null;
  /** Take it out of the Papierkorb. */
  onRestore?: () => void;
}

/** Right-hand side of the logbook: one flight with map, profile, landings and phases. */
export default function FlightDetail({ detail, track, onDelete, deleteRequest, onCancelDelete, deletedMs, onRestore }: Props) {
  const t = useT();
  const lang = useLanguage();
  // the profile chart and the track map share the logbook replay cursor; the bar needs a range
  useEffect(() => {
    if (track.length < 2) {
      logbookReplay.configure(null);
      return;
    }
    const markers: ReplayMarker[] = [
      ...detail.phases.map((p) => ({ key: `${p.to}-${p.timestampMs}`, label: PHASE_LABEL[p.to], tMs: p.timestampMs })),
      ...detail.touchdowns.map((td, i) => ({ key: `td-${i}`, label: td.touchAndGo ? t("logbook.detail.touchAndGo") : t("logbook.detail.touchdown"), tMs: td.timestampMs })),
    ].sort((a, b) => a.tMs - b.tMs);
    logbookReplay.configure({ startMs: track[0].tMs, endMs: track[track.length - 1].tMs }, markers);
    return () => logbookReplay.reset();
  }, [track, detail.phases, detail.touchdowns, t]);
  const f = detail.flight;
  const { weightUnit } = usePrefs();
  const [confirming, setConfirming] = useState(false);
  // the pilot's corrections (Notizen & Tags → Korrigieren) over the recorded values
  const dep = effectiveDep(f);
  const arr = effectiveArr(f);
  const depAirport = useAirport(dep);
  const arrAirport = useAirport(arr);
  useEffect(() => setConfirming(false), [f.id]);
  /** The flight being recorded right now: no delete (Entf neither). */
  const recording = isRecording(f, deletedMs != null);
  const seenDelete = useRef(deleteRequest);
  useEffect(() => {
    if (deleteRequest === seenDelete.current) return;
    seenDelete.current = deleteRequest;
    if (!recording) setConfirming(true);
  }, [deleteRequest, recording]);

  // stable objects so the track map does not refit on every re-render
  const departure = useMemo(() => (f.depLat != null && f.depLon != null ? { latitude: f.depLat, longitude: f.depLon } : null), [f.depLat, f.depLon]);
  const arrival = useMemo(() => (f.arrLat != null && f.arrLon != null ? { latitude: f.arrLat, longitude: f.arrLon } : null), [f.arrLat, f.arrLon]);

  const blockMs = f.onBlockMs && f.offBlockMs ? f.onBlockMs - f.offBlockMs : null;
  const airMs = f.landingMs && f.takeoffMs ? f.landingMs - f.takeoffMs : null;
  const fuelUsed = f.fuelStartKg != null && f.fuelEndKg != null ? f.fuelStartKg - f.fuelEndKg : null;
  const callsign = callsignOf(f);
  const integrity = f.integrity;
  const trashed = deletedMs != null;
  const cancelDelete = () => {
    setConfirming(false);
    onCancelDelete?.();
  };
  // imported (CSV): nothing was recorded, so no integrity findings and no landing tiles
  const importedFrom = importSourceLabel(f);
  const issues = importedFrom ? [] : integrityIssues(integrity);
  const ofp = useMemo(() => parseOfp(detail.ofpJson), [detail.ofpJson]);
  const pva = useMemo(() => {
    const plan = planFromRow(f);
    // keyed on the language: the logbook stays mounted and `f` keeps its reference on a switch
    return plan || ofp ? planVsActual(actualFromRow(f, track), plan, ofp, lang) : null;
  }, [f, track, ofp, lang]);

  return (
    <article className="flight-detail" aria-label={t("logbook.detail.ariaLabel", { dep: dep ?? "····", arr: arr ?? "····" })}>
      <header className="detail-head">
        <div className="detail-title">
          <h2 className="num">
            <span className={f.userDepIcao ? "corrected" : undefined} title={originalTitle(f.userDepIcao, f.depIcao) ?? undefined}>
              {dep ?? "····"}
            </span>{" "}
            →{" "}
            <span className={f.userArrIcao ? "corrected" : undefined} title={originalTitle(f.userArrIcao, f.arrIcao) ?? undefined}>
              {arr ?? (f.state === "active" ? "…" : "····")}
            </span>
          </h2>
          <div className="detail">
            {(
              [
                [effectiveAircraftTitle(f) || t("logbook.detail.unknownAircraft"), originalTitle(f.userAircraftTitle, f.aircraft.title)],
                [effectiveRegistration(f), originalTitle(f.userRegistration, f.aircraft.atcId)],
                [callsign, originalTitle(f.userCallsign, recordedCallsignOf(f))],
                [fmtDate(f.offBlockMs ?? f.createdMs), null],
                [blockMs != null ? t("logbook.detail.blockTime", { duration: fmtDuration(blockMs, { seconds: false }) }) : null, null],
              ] as Array<[string | null, string | null]>
            )
              .filter(([text]) => !!text)
              .map(([text, orig], i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  <span className={orig ? "corrected" : undefined} title={orig ?? undefined}>
                    {text}
                  </span>
                </span>
              ))}
          </div>
          <div className="detail-badges">
            <span className={`badge state-${f.state}`} title={f.state === "discarded" ? t("logbook.state.discardedTitle") : undefined}>
              {stateLabel(f.state, t)}
            </span>
            {trashed && (
              <span className="badge badge-trash" title={t("logbook.detail.trashTitle", { days: TRASH_DAYS })}>
                {t("logbook.detail.trashBadge", { count: trashDaysLeft(deletedMs, Date.now()) })}
              </span>
            )}
            {isDemoRow(f) && (
              <span className="badge badge-demo" title={t("logbook.detail.demoTitle")}>
                {t("logbook.detail.demo")}
              </span>
            )}
            {importedFrom && (
              <span className="badge badge-imported" title={t("logbook.detail.importedTitle")}>
                {t("logbook.detail.imported", { source: importedFrom })}
              </span>
            )}
            {f.hasOfp && (
              <span className="badge badge-connecting" title={t("logbook.detail.ofpTitle")}>
                {t("logbook.detail.ofp")}
              </span>
            )}
            <span className="detail">{t("logbook.detail.simulator", { name: simulatorLabel(f.provider, f.simName) })}</span>
          </div>
        </div>
        <div className="detail-actions">
          {!trashed && <ExportMenu detail={detail} ofp={ofp} track={track} />}
          {trashed && onRestore && !confirming && (
            <button className="btn-primary" onClick={onRestore} title={t("logbook.detail.restoreTitle")}>
              {t("logbook.detail.restore")}
            </button>
          )}
          {confirming ? (
            <span
              className="confirm-delete"
              role="group"
              aria-label={t("logbook.detail.confirmLabel")}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  cancelDelete();
                }
              }}
            >
              <span className="detail">{trashed ? t("logbook.detail.confirmPermanent") : t("logbook.detail.confirmTrash", { days: TRASH_DAYS })}</span>
              <button className="btn-sm danger" onClick={onDelete}>
                {trashed ? t("logbook.detail.deletePermanent") : t("logbook.detail.moveToTrash")}
              </button>
              {/* focus on the safe choice: Enter right after Entf cancels */}
              <button className="btn-sm" onClick={cancelDelete} autoFocus>
                {t("logbook.detail.cancel")}
              </button>
            </span>
          ) : (
            <button
              className="danger"
              onClick={() => setConfirming(true)}
              // the running recording cannot be deleted (the backend refuses it too)
              disabled={recording}
              title={recording ? t("logbook.detail.deleteRecording") : trashed ? t("logbook.detail.deletePermanentTitle") : t("logbook.detail.deleteTitle")}
            >
              {trashed ? t("logbook.detail.deletePermanent") : t("logbook.detail.delete")}
            </button>
          )}
        </div>
      </header>

      <NotesEditor flight={f} readOnly={trashed} />

      {detail.hasTrack || track.length > 0 ? (
        <FlightTrackView detail={detail} track={track} departure={departure} arrival={arrival} route={`${dep ?? "····"} → ${arr ?? "····"}`} />
      ) : (
        <div className="detail">{importedFrom ? t("logbook.detail.noTrackImported") : t("logbook.detail.noTrack")}</div>
      )}

      <Collapsible
        id="logbook.detail.landings"
        className="detail-section"
        level={3}
        title={detail.touchdowns.length > 1 ? t("logbook.detail.headingLandings") : t("logbook.detail.headingLanding")}
        summary={detail.touchdowns.length ? detail.touchdowns.map((td) => rateText(td)).join(" · ") : undefined}
      >
        {detail.touchdowns.length === 0 ? (
          <div className="detail">
            {importedFrom ? t("logbook.detail.noLandingImported") : t("logbook.detail.noLanding")}
          </div>
        ) : (
          <>
          <LandingSummary flightId={f.id} touchdowns={detail.touchdowns.length} updatedMs={f.updatedMs} />
          <HistoryPanel flightId={f.id} />
          <details className="fold">
            <summary>{t("logbook.detail.allLandings", { count: detail.touchdowns.length })}</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>{t("logbook.detail.colTime")}</th>
                <th className="right">{t("logbook.detail.colRate")}</th>
                <th className="right">{t("logbook.detail.colMeasured")}</th>
                <th className="right">{t("logbook.detail.colSim")}</th>
                <th className="right">{t("logbook.detail.colG")}</th>
                <th className="right">{t("logbook.detail.colBounces")}</th>
                <th className="right">{t("logbook.detail.colGs")}</th>
                <th>{t("logbook.detail.colKind")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.touchdowns.map((td, i) => (
                <tr key={i}>
                  <td className="num">{fmtClock(td.timestampMs, { seconds: true })}</td>
                  <td
                    className={`num right strong${isRated(td) && td.landingRateFpm <= -HARD_FPM ? " warn-text" : ""}`}
                    title={rateTitle(t, td)}
                  >
                    <button className="rate-link" onClick={() => openDebrief(f.id, i)} aria-label={t("logbook.detail.rateAria", { rate: rateText(td) })}>
                      {isRated(td) && td.landingRateFpm <= -HARD_FPM && (
                        <span className="warn-icon" aria-hidden="true">
                          !
                        </span>
                      )}
                      {rateText(td)}
                    </button>
                  </td>
                  <td className="num right">{fmt(td.vsFpmMeasured, 0, "fpm")}</td>
                  <td className="num right">{td.vsFpmSim ? fmt(td.vsFpmSim, 0, "fpm") : t("logbook.detail.notAvailable")}</td>
                  <td className={`num right${td.peakG >= G_HARD ? " warn-text" : ""}`}>{fmt(td.peakG, 2)}</td>
                  <td className="num right">{td.bounces}</td>
                  <td className="num right">{fmt(td.groundSpeedKt, 0, "kt")}</td>
                  <td>{td.touchAndGo ? t("logbook.detail.touchAndGo") : t("logbook.detail.fullStop")}</td>
                  <td className="right">
                    <button className="btn-sm" onClick={() => openDebrief(f.id, i)} title={t("logbook.detail.openDebriefTitle")}>
                      {t("logbook.detail.openDebrief")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </details>
          </>
        )}
      </Collapsible>

      {detail.touchdowns.length >= 2 && <Circuits flightId={f.id} touchdowns={detail.touchdowns} />}

      <Collapsible id="logbook.detail.aircraft" className="detail-section" level={3} title={t("logbook.detail.aircraft")} summary={effectiveAircraftTitle(f) || undefined}>
        <AirframeCard flight={f} onOpenFleet={(registration) => navigate({ kind: "airframe", registration })} />
      </Collapsible>

      <Collapsible
        id="logbook.detail.flight"
        className="detail-section"
        level={3}
        title={t("logbook.detail.flight")}
        summary={`${dep ?? "–"} → ${arr ?? "–"} · ${fmtDuration(blockMs)}`}
      >
        <div className="stat-grid detail-grid">
          <Stat
            size="sm"
            label={t("logbook.detail.statDep")}
            title={originalTitle(f.userDepIcao, f.depIcao) ?? undefined}
            value={dep ?? fmtCoord(f.depLat, f.depLon)}
            sub={depAirport?.name ?? (dep ? fmtCoord(f.depLat, f.depLon) : undefined)}
          />
          <Stat
            size="sm"
            label={t("logbook.detail.statArr")}
            title={originalTitle(f.userArrIcao, f.arrIcao) ?? undefined}
            value={arr ?? fmtCoord(f.arrLat, f.arrLon)}
            sub={arrAirport?.name ?? (arr ? fmtCoord(f.arrLat, f.arrLon) : undefined)}
          />
          <Stat size="sm" label={t("logbook.detail.statOffBlock")} value={fmtClock(f.offBlockMs)} />
          <Stat size="sm" label={t("logbook.detail.statTakeoff")} value={fmtClock(f.takeoffMs)} />
          <Stat size="sm" label={t("logbook.detail.statLanding")} value={fmtClock(f.landingMs)} />
          <Stat size="sm" label={t("logbook.detail.statOnBlock")} value={fmtClock(f.onBlockMs)} />
          <Stat size="sm" label={t("logbook.list.statBlockTime")} value={fmtDuration(blockMs)} />
          <Stat size="sm" label={t("logbook.list.statAirTime")} title={t("logbook.list.statAirTimeTitle")} value={fmtDuration(airMs)} />
          <Stat size="sm" label={t("logbook.list.statDistance")} value={fmt(f.distanceNm, 1)} unit="nm" />
          <Stat size="sm" label={t("logbook.detail.statMaxAlt")} value={fmt(f.maxAltMslFt, 0)} unit="ft" />
          <Stat size="sm" label={t("logbook.detail.statFuel")} value={fmtWeightNum(fuelUsed)} unit={weightUnit} />
          {/* full row: "max 1,42 g (Climb, 3 200 ft) · min 0,71 g (Descent)" */}
          <div style={{ gridColumn: "1 / -1" }}>
            <Stat size="sm" label={t("gload.label")} value={gLoadSummary(f.gLoad)} title={gLoadTitle(f.gLoad)} />
          </div>
        </div>
      </Collapsible>

      {pva && (
        <Collapsible
          id="logbook.detail.pva"
          className="detail-section"
          headClassName="pva-head"
          level={3}
          title={
            <>
              {t("logbook.detail.pvaHeading")}
              {pva.headline && (
                <span
                  className={`badge ${pva.headline.status === "late" ? "state-interrupted" : "state-completed"}`}
                  title={t(pva.headline.event === "in" ? "logbook.detail.punctualityTitleIn" : "logbook.detail.punctualityTitleOut", { min: ON_TIME_THRESHOLD_MIN })}
                >
                  {fmtPunctuality(pva.headline)}
                </span>
              )}
            </>
          }
          actions={
            <span className="detail">
              {ofp
                ? `SimBrief ${ofp.originIcao || f.plannedDep || "–"} → ${ofp.destinationIcao || f.plannedArr || "–"}${ofp.alternateIcao ? ` · ALTN ${ofp.alternateIcao}` : ""}`
                : t("logbook.detail.pvaPlanRoute", { dep: f.plannedDep ?? "–", arr: f.plannedArr ?? "–" })}
            </span>
          }
        >
          <table className="mini-table pva-table">
            <thead>
              <tr>
                <th />
                <th className="right">{t("logbook.detail.colPlan")}</th>
                <th className="right">{t("logbook.detail.colActual")}</th>
                <th className="right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {pva.lines.map((l) => (
                <tr key={l.key} className={l.key === "taxiOut" || l.key === "fuelStart" || l.key === "distance" ? "pva-group" : undefined}>
                  <th scope="row" title={l.note}>
                    {l.label}
                  </th>
                  <td className="num right">{fmtPvaValue(l.kind, l.plan)}</td>
                  <td className="num right" title={l.approx ? l.note : undefined}>
                    {l.approx && l.actual != null ? "≈ " : ""}
                    {fmtPvaValue(l.kind, l.actual)}
                  </td>
                  <td className={`num right${l.warn ? " warn-text" : ""}`} title={l.warn ?? undefined}>
                    {fmtPvaDelta(l)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapsible>
      )}

      <Collapsible
        id="logbook.detail.phases"
        className="detail-section"
        level={3}
        title={t("logbook.detail.phases")}
        summary={detail.phases.length ? detail.phases.map((p) => PHASE_LABEL[p.to]).slice(-1)[0] : undefined}
      >
        {detail.phases.length === 0 ? (
          <div className="detail">{t("logbook.detail.noPhases")}</div>
        ) : (
          <ol className="phase-timeline">
            {detail.phases.map((p, i) => (
              <li key={i}>
                <span className="num detail">{fmtClock(p.timestampMs, { seconds: true })}</span>
                <span>
                  {PHASE_LABEL[p.from]} → <strong>{PHASE_LABEL[p.to]}</strong>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Collapsible>

      {issues.length > 0 && (
        <Collapsible id="logbook.detail.integrity" className="detail-section" level={3} title={t("logbook.detail.integrity")} summary={String(issues.length)}>
          <div className="detail-badges">
            {issues.map((s) => (
              <span key={String(s)} className="badge state-interrupted">
                ▲ {s}
              </span>
            ))}
          </div>
        </Collapsible>
      )}
    </article>
  );
}

/** Tooltip of a landing-rate cell: hard mark, where the value comes from, the click hint. */
function rateTitle(t: TFunction, td: TouchdownReport): string {
  if (!isRated(td)) return [t("band.unratedTitle"), t("logbook.detail.clickDebrief")].join(" ");
  const source: TKey =
    td.landingRateSource === "sim"
      ? td.bounces
        ? "logbook.detail.sourceSimBounces"
        : "logbook.detail.sourceSim"
      : td.bounces
        ? "logbook.detail.sourceMeasuredBounces"
        : "logbook.detail.sourceMeasured";
  const hard = isRated(td) && td.landingRateFpm <= -HARD_FPM ? t("logbook.detail.hardLanding", { limit: fmt(HARD_FPM, 0, "fpm") }) : null;
  return [hard, t(source), t("logbook.detail.clickDebrief")].filter(Boolean).join(" ");
}

const SPARK_W = 160;
const SPARK_H = 36;

/**
 * "Platzrunden": every ground contact of the flight as a series (touch-and-goes and the full
 * stop) with a landing-rate sparkline. Touchdown point and "stabil ab" come from the facts,
 * which exist for the full stop (and approaches ending in a touch-and-go).
 */
function Circuits({ flightId, touchdowns }: { flightId: string; touchdowns: TouchdownReport[] }) {
  const t = useT();
  const { landings, approaches } = useHistoryFacts();
  const s = useMemo(() => patternSeries(touchdowns, landings ?? [], flightId, approaches ?? []), [touchdowns, landings, approaches, flightId]);
  const maxFpm = Math.max(300, ...s.rows.filter((r) => r.rated).map((r) => Math.abs(r.landingRateFpm)));
  const X = linear(0, Math.max(s.rows.length - 1, 1), 6, SPARK_W - 6);
  const Y = linear(0, maxFpm, SPARK_H - 5, 5);
  // unrated contacts (slewed down) have no rate: no point, the line skips them
  const line = s.rows
    .map((r, i) => (r.rated ? { i, y: Y(Math.abs(r.landingRateFpm)) } : null))
    .filter((p): p is { i: number; y: number } => p != null)
    .map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)},${p.y.toFixed(1)}`)
    .join("");
  const hasPoint = s.rows.some((r) => r.distanceM != null);
  const hasStable = s.rows.some((r) => r.stableFromFt != null);
  return (
    <Collapsible id="logbook.detail.circuits" className="detail-section" level={3} title={t("logbook.circuits.heading")} summary={String(s.rows.length)}>
      <div className="circuits-head">
        <span className="detail num">
          {t("logbook.circuits.summary", { contacts: s.rows.length, tgs: s.touchAndGos, stops: s.fullStops, median: fmt(s.medianRateFpm, 0, "fpm") })}
          {s.bestIndex != null && ` · ${t("logbook.circuits.best", { n: s.bestIndex + 1 })}`}
        </span>
        {/* the same values as the table below: for the mouse only */}
        <svg className="circuits-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} aria-hidden="true">
          <path d={line} className="tr-line" />
          {s.rows.map((r, i) => {
            if (!r.rated) return null;
            const band = vsBandOf(r.landingRateFpm);
            return (
              <g key={i} className="circuits-pt" onClick={() => openDebrief(flightId, r.touchdownIndex)}>
                <title>{`#${i + 1} ${r.touchAndGo ? t("logbook.detail.touchAndGo") : t("logbook.detail.fullStop")}: ${fmt(r.landingRateFpm, 0, "fpm")}`}</title>
                <circle cx={X(i)} cy={Y(Math.abs(r.landingRateFpm))} r={9} fill="transparent" />
                <circle
                  cx={X(i)}
                  cy={Y(Math.abs(r.landingRateFpm))}
                  r={3.5}
                  className={r.touchAndGo ? "tg" : undefined}
                  style={r.touchAndGo ? { stroke: BAND_VAR[band] } : { fill: BAND_VAR[band] }}
                />
              </g>
            );
          })}
        </svg>
        <span className="detail">{t("logbook.circuits.legend")}</span>
      </div>
      <table className="mini-table">
        <caption className="sr-only">{t("logbook.circuits.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{t("logbook.detail.colTime")}</th>
            <th scope="col">{t("logbook.detail.colKind")}</th>
            <th scope="col" className="right">
              {t("logbook.detail.colRate")}
            </th>
            <th scope="col" className="right">
              {t("logbook.detail.colG")}
            </th>
            <th scope="col" className="right">
              {t("logbook.detail.colBounces")}
            </th>
            {hasPoint && (
              <th scope="col" className="right">
                {t("logbook.circuits.colTouchdownPoint")}
              </th>
            )}
            {hasStable && (
              <th scope="col" className="right">
                {t("logbook.circuits.colStable")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {s.rows.map((r, i) => {
            const band = vsBandOf(r.landingRateFpm);
            return (
              <tr key={i} className={`clickable${r.touchdownIndex === s.bestIndex ? " circuits-best" : ""}`} onClick={() => openDebrief(flightId, r.touchdownIndex)}>
                <td className="num">{i + 1}</td>
                <td className="num">{fmtClock(r.timestampMs, { seconds: true })}</td>
                <td>{r.touchAndGo ? t("logbook.detail.touchAndGo") : t("logbook.detail.fullStop")}</td>
                <td className={`num right strong${r.rated && r.landingRateFpm <= -HARD_FPM ? " warn-text" : ""}`} title={r.rated ? undefined : t("band.unratedTitle")}>
                  <button
                    className="rate-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDebrief(flightId, r.touchdownIndex);
                    }}
                    aria-label={t("logbook.circuits.rateAria", { n: i + 1, rate: rateText(r), band: r.rated ? t(`band.${band}`) : t("band.unrated") })}
                  >
                    {r.rated ? (
                      <>
                        <span className="band-dot inline" style={{ background: BAND_VAR[band] }} aria-hidden="true" /> {fmt(r.landingRateFpm, 0, "fpm")}
                      </>
                    ) : (
                      rateText(r)
                    )}
                  </button>
                </td>
                <td className={`num right${r.peakG >= G_HARD ? " warn-text" : ""}`}>{fmt(r.peakG, 2)}</td>
                <td className="num right">{r.bounces}</td>
                {hasPoint && (
                  <td className="num right" title={r.inTdz == null ? undefined : r.inTdz ? t("logbook.circuits.inTdz") : t("logbook.circuits.outTdz")}>
                    {r.distanceM != null ? fmt(r.distanceM, 0, "m") : "–"}
                  </td>
                )}
                {hasStable && <td className="num right">{r.stableFromFt != null ? fmt(r.stableFromFt, 0, "ft") : "–"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Collapsible>
  );
}

/** `title` and `hint` are i18n keys. */
const EXPORT_FORMATS = [
  { id: "kml", label: "KML", title: "logbook.export.kmlTitle", hint: "logbook.export.kmlHint" },
  { id: "gpx", label: "GPX", title: "logbook.export.gpxTitle", hint: "logbook.export.gpxHint" },
  { id: "csv", label: "CSV", title: "logbook.export.csvTitle", hint: "logbook.export.csvHint" },
  { id: "json", label: "JSON", title: "logbook.export.jsonTitle", hint: "logbook.export.jsonHint" },
] as const satisfies ReadonlyArray<{ id: string; label: string; title: TKey; hint: TKey }>;

type Pos = { latitude: number; longitude: number } | null;

/** The flight's approaches (approach_analysis) for the path markers; [] while recording or when unavailable. */
function useApproaches(flightId: string, settled: boolean, hasTrack: boolean): ApproachAnalysis[] {
  const [list, setList] = useState<{ id: string; list: ApproachAnalysis[] } | null>(null);
  useEffect(() => {
    if (!settled || !hasTrack) return;
    let live = true;
    invoke<ApproachAnalysis[]>("approach_analysis", { flightId })
      .then((l) => live && setList({ id: flightId, list: l }))
      .catch(() => live && setList({ id: flightId, list: [] }));
    return () => {
      live = false;
    };
  }, [flightId, settled, hasTrack]);
  return list?.id === flightId ? list.list : EMPTY_APPROACHES;
}
const EMPTY_APPROACHES: ApproachAnalysis[] = [];

/**
 * Track map, profile chart and replay bar of a flight; "Vollbild" moves the same block (same
 * map instance – the portal target node is re-parented, MapLibre's ResizeObserver resizes it)
 * into a full-window modal and back. F toggles while the focus is inside, Esc closes.
 */
function FlightTrackView({ detail, track, departure, arrival, route }: { detail: Detail; track: TrackSample[]; departure: Pos; arrival: Pos; route: string }) {
  const t = useT();
  const f = detail.flight;
  const approaches = useApproaches(f.id, f.state !== "active", track.length > 1);
  const events = useMemo(() => trackEvents(track, approaches, detail.touchdowns), [track, approaches, detail.touchdowns]);
  const metrics = useMemo(() => flightMetrics(track, approaches, detail.touchdowns), [track, approaches, detail.touchdowns]);
  const [full, setFull] = useState(false);
  const [host] = useState(() => (typeof document === "undefined" ? null : Object.assign(document.createElement("div"), { className: "flight-track-view" })));
  const inlineRef = useRef<HTMLDivElement>(null);
  const [fullSlot, setFullSlot] = useState<HTMLDivElement | null>(null);
  const returnFocus = () => host?.querySelector<HTMLElement>("[data-track-fullscreen]") ?? null;
  useLayoutEffect(() => {
    const target = full ? fullSlot : inlineRef.current;
    if (host && target && host.parentElement !== target) target.appendChild(host);
    // MapLibre and the chart measure on resize; the new parent's size arrives with this event too
    window.dispatchEvent(new Event("resize"));
  }, [full, fullSlot, host]);
  useEffect(() => setFull(false), [f.id]);
  const toggle = () => setFull((v) => !v);
  const isF = (e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; target: EventTarget | null }) =>
    e.key.toLowerCase() === "f" && !e.ctrlKey && !e.altKey && !e.metaKey && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement);
  const body = (
    <div
      className="flight-track-body"
      onKeyDown={(e) => {
        if (!full && isF(e)) {
          e.preventDefault();
          setFull(true);
        }
      }}
    >
      <TrackMap samples={track} touchdowns={detail.touchdowns} departure={departure} arrival={arrival} aircraft={f.aircraft} events={events} onFullscreen={toggle} fullscreen={full} />
      <ProfileChart samples={track} phases={detail.phases} touchdowns={detail.touchdowns} events={events} />
      {track.length > 1 && <ReplayBar />}
    </div>
  );
  return (
    <>
      <div ref={inlineRef} className="flight-track-slot" />
      <FlightMetricsRow m={metrics} />
      {full && (
        <Modal
          className="track-fullscreen"
          aria-label={t("map.toolbar.fullscreenDialog", { route })}
          onClose={() => setFull(false)}
          returnFocus={returnFocus}
          onKeyDown={(e) => {
            if (isF(e)) {
              e.preventDefault();
              setFull(false);
            }
          }}
        >
          <div className="track-fullscreen-head">
            <h2 className="num">{route}</h2>
            <button className="btn-sm" onClick={() => setFull(false)} title={t("map.toolbar.fullscreenExitTitle")}>
              {t("map.toolbar.fullscreenClose")}
            </button>
          </div>
          <div ref={setFullSlot} className="track-fullscreen-body" />
        </Modal>
      )}
      {host ? createPortal(body, host) : body}
    </>
  );
}

/**
 * The flight's metrics in one compact row under the track (the same derivation the backend
 * stores for the comparisons): rotation, gear down, landing flaps, exceedances, gates. Hidden
 * when nothing is determinable (no take-off and no landing in the track).
 */
function FlightMetricsRow({ m }: { m: FlightMetrics }) {
  const t = useT();
  const degS = fmtDegS;
  const band = m.rotationRateDegS != null ? rotationBand(m.rotationRateDegS) : "normal";
  const gate = (v: boolean | null) => (v == null ? "–" : t(v ? "landingHistory.metrics.stable" : "landingHistory.metrics.unstable"));
  const any = [m.rotationRateDegS, m.gearDownAglFt, m.landingFlapsAglFt, m.exceedances, m.stable1000, m.stable500].some((v) => v != null);
  if (!any) return null;
  return (
    <div className="stat-grid detail-grid flight-metrics" role="group" aria-label={t("flightMetrics.aria")}>
      <Stat
        size="sm"
        label={t("flightMetrics.rotation")}
        value={fmt(m.rotationRateDegS, 1)}
        unit="°/s"
        sub={m.rotationRateDegS != null ? t("flightMetrics.rotationSub", { peak: degS(m.rotationPeakDegS), duration: fmt(m.rotationDurationS, 0, "s") }) : undefined}
        warn={band === "slow" ? t("flightMetrics.rotationSlow", { limit: degS(ROTATION_SLOW_DEG_S) }) : band === "fast" ? t("flightMetrics.rotationFast", { limit: degS(ROTATION_FAST_DEG_S) }) : null}
      />
      <Stat
        size="sm"
        label={t("flightMetrics.gearDown")}
        value={fmt(m.gearDownAglFt, 0)}
        unit="ft AGL"
        sub={m.gearDownDistNm != null ? t("flightMetrics.gearDownSub", { dist: fmt(m.gearDownDistNm, 1, "nm") }) : undefined}
      />
      <Stat size="sm" label={t("flightMetrics.landingFlaps")} value={fmt(m.landingFlapsAglFt, 0)} unit="ft AGL" />
      <Stat size="sm" label={t("flightMetrics.exceedances")} value={fmt(m.exceedances, 0)} sub={m.exceedances != null ? t("flightMetrics.exceedancesSub") : undefined} />
      <Stat size="sm" label={t("flightMetrics.gate1000")} value={gate(m.stable1000)} warn={m.stable1000 === false ? t("flightMetrics.gateUnstable") : null} />
      <Stat size="sm" label={t("flightMetrics.gate500")} value={gate(m.stable500)} warn={m.stable500 === false ? t("flightMetrics.gateUnstable") : null} />
    </div>
  );
}

/** Landed approach for the PIREP ("stabil ab"); null when the analysis is unavailable. */
async function landedApproach(flightId: string): Promise<PirepApproach | null> {
  try {
    const list = await invoke<ApproachAnalysis[]>("approach_analysis", { flightId });
    const landed = [...list].reverse().find((a) => a.outcome.kind === "landed");
    return landed ? { stableFromFt: landed.stability.stableFromFt ?? null, band: landed.band } : null;
  } catch {
    return null;
  }
}

async function pirepOf(detail: Detail, ofp: Ofp | null, track: TrackSample[]) {
  const [landing, version] = await Promise.all([
    landedApproach(detail.flight.id),
    invoke<{ version: string }>("app_info")
      .then((i) => i.version)
      .catch(() => null),
  ]);
  return buildPirep(detail, ofp, landing, { appVersion: version, track, weightUnit: getWeightUnit() });
}

function ExportMenu({ detail, ofp, track }: { detail: Detail; ofp: Ofp | null; track: TrackSample[] }) {
  const t = useT();
  const flightId = detail.flight.id;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    // menu pattern: the focus moves into the menu; keys in handleMenuKey (ui/menu.ts)
    menuItems(listRef.current)[0]?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const fail = (e: unknown) => {
    const m = userMessage(e, "export");
    showToast({ tone: "err", title: m.title, body: m.hint });
  };

  const copyPirep = async () => {
    setOpen(false);
    try {
      const { text } = await pirepOf(detail, ofp, track);
      if (!navigator.clipboard?.writeText) throw new Error(t("logbook.export.noClipboard"));
      await navigator.clipboard.writeText(text);
      showToast({ tone: "ok", title: t("logbook.export.pirepCopied"), body: t("logbook.export.pirepCopiedBody") });
    } catch (e) {
      fail(e);
    }
  };

  const savePirep = async () => {
    setOpen(false);
    try {
      const { json } = await pirepOf(detail, ofp, track);
      const path = await save({ defaultPath: pirepFileName(json), filters: [{ name: "PIREP (JSON)", extensions: ["json"] }] });
      if (!path) return;
      await invoke("save_pirep_json", { path, json: JSON.stringify(json, null, 2) });
      showToast({ tone: "ok", title: t("logbook.export.pirepSaved"), body: path });
    } catch (e) {
      fail(e);
    }
  };

  const run = async (format: (typeof EXPORT_FORMATS)[number]) => {
    setOpen(false);
    try {
      const defaultPath = await invoke<string>("export_file_name", { id: flightId, format: format.id });
      const path = await save({ defaultPath, filters: [{ name: format.label, extensions: [format.id] }] });
      if (!path) return;
      await invoke("save_export", { id: flightId, format: format.id, path });
      showToast({ tone: "ok", title: t("logbook.export.exported", { format: format.label }), body: path });
    } catch (e) {
      const m = userMessage(e, "export");
      showToast({ tone: "err", title: m.title, body: m.hint });
    }
  };

  return (
    <div className="export-menu" ref={ref} onKeyDown={(e) => handleMenuKey(e, open, listRef.current, triggerRef.current, () => setOpen(false))}>
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {t("logbook.export.button")} ▾
      </button>
      {open && (
        <div ref={listRef} className="export-menu-list" role="menu">
          {EXPORT_FORMATS.map((f) => (
            <button key={f.id} role="menuitem" onClick={() => run(f)}>
              {t(f.title)}
              <span className="detail">{t(f.hint)}</span>
            </button>
          ))}
          <div className="export-menu-sep" role="separator" />
          <button role="menuitem" onClick={copyPirep}>
            {t("logbook.export.copyPirep")}
            <span className="detail">{t("logbook.export.copyPirepHint")}</span>
          </button>
          <button role="menuitem" onClick={savePirep}>
            {t("logbook.export.savePirep")}
            <span className="detail">pirep/v1</span>
          </button>
        </div>
      )}
    </div>
  );
}
