import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FlightDetail as Detail, Ofp, TouchdownReport, TrackSample } from "./types";
import type { ApproachAnalysis } from "./landing/approachTypes";
import { PHASE_LABEL, fmt, fmtClock, fmtCoord, fmtDate, fmtDuration, fmtWeightNum, getWeightUnit } from "./format";
import { actualFromRow, buildPirep, fmtPunctuality, fmtPvaDelta, fmtPvaValue, integrityIssues, parseOfp, pirepFileName, planFromRow, planVsActual, type PirepApproach } from "./pirep";
import { usePrefs } from "./prefs";
import TrackMap from "./map/TrackMap";
import ProfileChart from "./ProfileChart";
import ReplayBar from "./landing/ReplayBar";
import { logbookReplay, type ReplayMarker } from "./landing/replayStore";
import Stat from "./ui/Stat";
import { showToast } from "./ui/Toast";
import { userMessage } from "./errors";
import { useAirport } from "./live/hooks";
import { TRASH_DAYS, callsignOf, effectiveAircraftTitle, effectiveArr, effectiveDep, effectiveRegistration, originalTitle, recordedCallsignOf, trashDaysLeft } from "./logbookFilter";
import NotesEditor from "./NotesEditor";
import { importSourceLabel, isDemoRow } from "./totals";
import LandingSummary from "./landing/LandingSummary";
import { openDebrief } from "./landing/debriefStore";
import { BAND_LABEL, BAND_VAR, G_HARD, vsBandOf } from "./landing/facts";
import HistoryPanel, { useHistoryFacts } from "./landing/HistoryPanel";
import { patternSeries } from "./landing/history";
import { linear } from "./landing/dispersionStats";
import AirframeCard from "./airframes/AirframeCard";
import { navigate } from "./airframes/navigation";

export function stateLabel(state: string): string {
  switch (state) {
    case "completed":
      return "abgeschlossen";
    case "active":
      return "Aufzeichnung läuft";
    case "interrupted":
      return "unvollständig";
    default:
      return state;
  }
}

function simulatorLabel(provider: string | null | undefined, simName: string | null | undefined): string {
  if (provider === "mock") return "Demo-Flug (simuliert)";
  if (simName) return simName;
  return provider === "simconnect" ? "MSFS" : provider || "unbekannt";
}

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
  // the profile chart and the track map share the logbook replay cursor; the bar needs a range
  useEffect(() => {
    if (track.length < 2) {
      logbookReplay.configure(null);
      return;
    }
    const markers: ReplayMarker[] = [
      ...detail.phases.map((p) => ({ key: `${p.to}-${p.timestampMs}`, label: PHASE_LABEL[p.to], tMs: p.timestampMs })),
      ...detail.touchdowns.map((td, i) => ({ key: `td-${i}`, label: td.touchAndGo ? "Touch-and-go" : "Aufsetzen", tMs: td.timestampMs })),
    ].sort((a, b) => a.tMs - b.tMs);
    logbookReplay.configure({ startMs: track[0].tMs, endMs: track[track.length - 1].tMs }, markers);
    return () => logbookReplay.reset();
  }, [track, detail.phases, detail.touchdowns]);
  const f = detail.flight;
  const { weightUnit } = usePrefs();
  const [confirming, setConfirming] = useState(false);
  // the pilot's corrections (Notizen & Tags → Korrigieren) over the recorded values
  const dep = effectiveDep(f);
  const arr = effectiveArr(f);
  const depAirport = useAirport(dep);
  const arrAirport = useAirport(arr);
  useEffect(() => setConfirming(false), [f.id]);
  const seenDelete = useRef(deleteRequest);
  useEffect(() => {
    if (deleteRequest === seenDelete.current) return;
    seenDelete.current = deleteRequest;
    setConfirming(true);
  }, [deleteRequest]);

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
    return plan || ofp ? planVsActual(actualFromRow(f, track), plan, ofp) : null;
  }, [f, track, ofp]);

  return (
    <article className="flight-detail" aria-label={`Flug ${dep ?? "····"} nach ${arr ?? "····"}`}>
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
                [effectiveAircraftTitle(f) || "Unbekanntes Flugzeug", originalTitle(f.userAircraftTitle, f.aircraft.title)],
                [effectiveRegistration(f), originalTitle(f.userRegistration, f.aircraft.atcId)],
                [callsign, originalTitle(f.userCallsign, recordedCallsignOf(f))],
                [fmtDate(f.offBlockMs ?? f.createdMs), null],
                [blockMs != null ? `${fmtDuration(blockMs, { seconds: false })} Blockzeit` : null, null],
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
            <span className={`badge state-${f.state}`}>{stateLabel(f.state)}</span>
            {trashed && (
              <span className="badge badge-trash" title={`Wird ${TRASH_DAYS} Tage nach dem Löschen endgültig entfernt`}>
                Im Papierkorb · noch {trashDaysLeft(deletedMs, Date.now())} Tage
              </span>
            )}
            {isDemoRow(f) && (
              <span className="badge badge-demo" title="Simulierter Demo-Flug – zählt nicht in den Summen">
                Demo
              </span>
            )}
            {importedFrom && (
              <span className="badge badge-imported" title="Aus einer Importdatei übernommen – ohne Aufzeichnung (kein Track, keine Landungen, keine Integritätsprüfung)">
                importiert aus {importedFrom}
              </span>
            )}
            {f.hasOfp && (
              <span className="badge badge-connecting" title="SimBrief-OFP">
                Flugplan
              </span>
            )}
            <span className="detail">Simulator: {simulatorLabel(f.provider, f.simName)}</span>
          </div>
        </div>
        <div className="detail-actions">
          {!trashed && <ExportMenu detail={detail} ofp={ofp} track={track} />}
          {trashed && onRestore && !confirming && (
            <button className="btn-primary" onClick={onRestore} title="Zurück ins Logbuch">
              Wiederherstellen
            </button>
          )}
          {confirming ? (
            <span
              className="confirm-delete"
              role="group"
              aria-label="Löschen bestätigen"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  cancelDelete();
                }
              }}
            >
              <span className="detail">{trashed ? "Endgültig löschen? Das lässt sich nicht rückgängig machen." : `In den Papierkorb (${TRASH_DAYS} Tage wiederherstellbar)?`}</span>
              <button className="btn-sm danger" onClick={onDelete}>
                {trashed ? "Endgültig löschen" : "In den Papierkorb"}
              </button>
              {/* focus on the safe choice: Enter right after Entf cancels */}
              <button className="btn-sm" onClick={cancelDelete} autoFocus>
                Abbrechen
              </button>
            </span>
          ) : (
            <button className="danger" onClick={() => setConfirming(true)} title={trashed ? "Endgültig löschen (Entf)" : "In den Papierkorb legen (Entf)"}>
              {trashed ? "Endgültig löschen" : "Löschen"}
            </button>
          )}
        </div>
      </header>

      <NotesEditor flight={f} readOnly={trashed} />

      {detail.hasTrack || track.length > 0 ? (
        <>
          <TrackMap samples={track} touchdowns={detail.touchdowns} departure={departure} arrival={arrival} />
          <ProfileChart samples={track} phases={detail.phases} touchdowns={detail.touchdowns} />
          {track.length > 1 && <ReplayBar />}
        </>
      ) : (
        <div className="detail">{importedFrom ? "Ohne Aufzeichnung – aus Importdatei." : "Für diesen Flug wurde kein Track aufgezeichnet."}</div>
      )}

      <div className="detail-section">
        <h3>{detail.touchdowns.length > 1 ? "Landungen" : "Landung"}</h3>
        {detail.touchdowns.length === 0 ? (
          <div className="detail">
            {importedFrom ? "– · ohne Aufzeichnung – aus Importdatei. Eine Landerate aus der Datei steht, falls vorhanden, in den Notizen." : "Keine Landung aufgezeichnet."}
          </div>
        ) : (
          <>
          <LandingSummary flightId={f.id} touchdowns={detail.touchdowns.length} updatedMs={f.updatedMs} />
          <HistoryPanel flightId={f.id} />
          <details className="fold">
            <summary>Alle Landungen dieses Flugs ({detail.touchdowns.length})</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Zeit</th>
                <th className="right">Landerate</th>
                <th className="right">Messwert</th>
                <th className="right">Sim-Wert</th>
                <th className="right">g-Last</th>
                <th className="right">Bounces</th>
                <th className="right">GS</th>
                <th>Art</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.touchdowns.map((t, i) => (
                <tr key={i}>
                  <td className="num">{fmtClock(t.timestampMs, { seconds: true })}</td>
                  <td
                    className={`num right strong${t.landingRateFpm <= -600 ? " warn-text" : ""}`}
                    title={`${t.landingRateFpm <= -600 ? "Harte Landung (ab 600 fpm). " : ""}Herkunft: ${t.landingRateSource === "sim" ? "Sim-Touchdown-Wert" : "letztes V/S-Sample in der Luft"}${t.bounces ? ", härtester Kontakt" : ""}. Klick: Landeauswertung`}
                  >
                    <button className="rate-link" onClick={() => openDebrief(f.id, i)} aria-label={`Landeauswertung: ${fmt(t.landingRateFpm, 0, "fpm")}`}>
                      {t.landingRateFpm <= -600 && (
                        <span className="warn-icon" aria-hidden="true">
                          !
                        </span>
                      )}
                      {fmt(t.landingRateFpm, 0, "fpm")}
                    </button>
                  </td>
                  <td className="num right">{fmt(t.vsFpmMeasured, 0, "fpm")}</td>
                  <td className="num right">{t.vsFpmSim ? fmt(t.vsFpmSim, 0, "fpm") : "n. v."}</td>
                  <td className={`num right${t.peakG >= G_HARD ? " warn-text" : ""}`}>{fmt(t.peakG, 2)}</td>
                  <td className="num right">{t.bounces}</td>
                  <td className="num right">{fmt(t.groundSpeedKt, 0, "kt")}</td>
                  <td>{t.touchAndGo ? "Touch-and-go" : "Full Stop"}</td>
                  <td className="right">
                    <button className="btn-sm" onClick={() => openDebrief(f.id, i)} title="Landeauswertung dieser Landung öffnen">
                      Landeauswertung
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </details>
          </>
        )}
      </div>

      {detail.touchdowns.length >= 2 && <Circuits flightId={f.id} touchdowns={detail.touchdowns} />}

      <div className="detail-section">
        <h3>Flugzeug</h3>
        <AirframeCard flight={f} onOpenFleet={(registration) => navigate({ kind: "airframe", registration })} />
      </div>

      <div className="detail-section">
        <h3>Flug</h3>
        <div className="stat-grid detail-grid">
          <Stat
            size="sm"
            label="Abflug"
            title={originalTitle(f.userDepIcao, f.depIcao) ?? undefined}
            value={dep ?? fmtCoord(f.depLat, f.depLon)}
            sub={depAirport?.name ?? (dep ? fmtCoord(f.depLat, f.depLon) : undefined)}
          />
          <Stat
            size="sm"
            label="Ankunft"
            title={originalTitle(f.userArrIcao, f.arrIcao) ?? undefined}
            value={arr ?? fmtCoord(f.arrLat, f.arrLon)}
            sub={arrAirport?.name ?? (arr ? fmtCoord(f.arrLat, f.arrLon) : undefined)}
          />
          <Stat size="sm" label="Off-Block" value={fmtClock(f.offBlockMs)} />
          <Stat size="sm" label="Start" value={fmtClock(f.takeoffMs)} />
          <Stat size="sm" label="Landung" value={fmtClock(f.landingMs)} />
          <Stat size="sm" label="On-Block" value={fmtClock(f.onBlockMs)} />
          <Stat size="sm" label="Blockzeit" value={fmtDuration(blockMs)} />
          <Stat size="sm" label="Luftzeit" title="Abheben bis Aufsetzen – für das Flugbuch zählt die Blockzeit" value={fmtDuration(airMs)} />
          <Stat size="sm" label="Distanz" value={fmt(f.distanceNm, 1)} unit="nm" />
          <Stat size="sm" label="Max. Höhe" value={fmt(f.maxAltMslFt, 0)} unit="ft" />
          <Stat size="sm" label="Verbrauch" value={fmtWeightNum(fuelUsed)} unit={weightUnit} />
        </div>
      </div>

      {pva && (
        <div className="detail-section">
          <h3 className="pva-head">
            Plan gegen Ist
            {pva.headline && (
              <span
                className={`badge ${pva.headline.status === "late" ? "state-interrupted" : "state-completed"}`}
                title={`${pva.headline.event === "in" ? "On-Block" : "Off-Block"} gegen Flugplan; bis 15 min nach Plan gilt als pünktlich`}
              >
                {fmtPunctuality(pva.headline)}
              </span>
            )}
            <span className="detail">
              {ofp
                ? `SimBrief ${ofp.originIcao || f.plannedDep || "–"} → ${ofp.destinationIcao || f.plannedArr || "–"}${ofp.alternateIcao ? ` · ALTN ${ofp.alternateIcao}` : ""}`
                : `Plan ${f.plannedDep ?? "–"} → ${f.plannedArr ?? "–"}`}
            </span>
          </h3>
          <table className="mini-table pva-table">
            <thead>
              <tr>
                <th />
                <th className="right">Plan</th>
                <th className="right">Ist</th>
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
        </div>
      )}

      <div className="detail-section">
        <h3>Phasen</h3>
        {detail.phases.length === 0 ? (
          <div className="detail">Keine Phasenwechsel aufgezeichnet.</div>
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
      </div>

      {issues.length > 0 && (
        <div className="detail-section">
          <h3>Integrität</h3>
          <div className="detail-badges">
            {issues.map((s) => (
              <span key={String(s)} className="badge state-interrupted">
                ▲ {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

const SPARK_W = 160;
const SPARK_H = 36;

/**
 * "Platzrunden": every ground contact of the flight as a series (touch-and-goes and the full
 * stop) with a landing-rate sparkline. Touchdown point and "stabil ab" come from the facts,
 * which exist for the full stop (and approaches ending in a touch-and-go).
 */
function Circuits({ flightId, touchdowns }: { flightId: string; touchdowns: TouchdownReport[] }) {
  const { landings, approaches } = useHistoryFacts();
  const s = useMemo(() => patternSeries(touchdowns, landings ?? [], flightId, approaches ?? []), [touchdowns, landings, approaches, flightId]);
  const maxFpm = Math.max(300, ...s.rows.map((r) => Math.abs(r.landingRateFpm)));
  const X = linear(0, Math.max(s.rows.length - 1, 1), 6, SPARK_W - 6);
  const Y = linear(0, maxFpm, SPARK_H - 5, 5);
  const line = s.rows.map((r, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(Math.abs(r.landingRateFpm)).toFixed(1)}`).join("");
  const hasPoint = s.rows.some((r) => r.distanceM != null);
  const hasStable = s.rows.some((r) => r.stableFromFt != null);
  return (
    <div className="detail-section">
      <h3>Platzrunden</h3>
      <div className="circuits-head">
        <span className="detail num">
          {s.rows.length} Bodenkontakte · {s.touchAndGos} Touch-and-go · {s.fullStops} Full Stop · Median {fmt(s.medianRateFpm, 0, "fpm")}
          {s.bestIndex != null && ` · weichster Kontakt #${s.bestIndex + 1}`}
        </span>
        {/* the same values as the table below: for the mouse only */}
        <svg className="circuits-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} aria-hidden="true">
          <path d={line} className="tr-line" />
          {s.rows.map((r, i) => {
            const band = vsBandOf(r.landingRateFpm);
            return (
              <g key={i} className="circuits-pt" onClick={() => openDebrief(flightId, r.touchdownIndex)}>
                <title>{`#${i + 1} ${r.touchAndGo ? "Touch-and-go" : "Full Stop"}: ${fmt(r.landingRateFpm, 0, "fpm")}`}</title>
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
        <span className="detail">gefüllt = Full Stop, Ring = Touch-and-go</span>
      </div>
      <table className="mini-table">
        <caption className="sr-only">Bodenkontakte dieses Flugs in zeitlicher Reihenfolge</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Zeit</th>
            <th scope="col">Art</th>
            <th scope="col" className="right">
              Landerate
            </th>
            <th scope="col" className="right">
              g-Last
            </th>
            <th scope="col" className="right">
              Bounces
            </th>
            {hasPoint && (
              <th scope="col" className="right">
                Aufsetzpunkt
              </th>
            )}
            {hasStable && (
              <th scope="col" className="right">
                Stabil ab
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
                <td>{r.touchAndGo ? "Touch-and-go" : "Full Stop"}</td>
                <td className={`num right strong${r.landingRateFpm <= -600 ? " warn-text" : ""}`}>
                  <button
                    className="rate-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDebrief(flightId, r.touchdownIndex);
                    }}
                    aria-label={`Landeauswertung Kontakt ${i + 1}: ${fmt(r.landingRateFpm, 0, "fpm")}, ${BAND_LABEL[band]}`}
                  >
                    <span className="band-dot inline" style={{ background: BAND_VAR[band] }} aria-hidden="true" /> {fmt(r.landingRateFpm, 0, "fpm")}
                  </button>
                </td>
                <td className={`num right${r.peakG >= G_HARD ? " warn-text" : ""}`}>{fmt(r.peakG, 2)}</td>
                <td className="num right">{r.bounces}</td>
                {hasPoint && (
                  <td className="num right" title={r.inTdz == null ? undefined : r.inTdz ? "in der Aufsetzzone" : "außerhalb der Aufsetzzone"}>
                    {r.distanceM != null ? fmt(r.distanceM, 0, "m") : "–"}
                  </td>
                )}
                {hasStable && <td className="num right">{r.stableFromFt != null ? fmt(r.stableFromFt, 0, "ft") : "–"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const EXPORT_FORMATS = [
  { id: "kml", label: "KML", title: "Für Google Earth (KML)", hint: "3D-Track" },
  { id: "gpx", label: "GPX", title: "Für Garmin/Strava (GPX)", hint: "Track mit Zeitstempeln" },
  { id: "csv", label: "CSV", title: "Rohdaten (CSV)", hint: "alle Trackpunkte" },
  { id: "json", label: "JSON", title: "Rohdaten (JSON)", hint: "Flug, Landungen, Phasen, Track" },
] as const;

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
  const flightId = detail.flight.id;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const fail = (e: unknown) => {
    const m = userMessage(e, "export");
    showToast({ tone: "err", title: m.title, body: m.hint });
  };

  const copyPirep = async () => {
    setOpen(false);
    try {
      const { text } = await pirepOf(detail, ofp, track);
      if (!navigator.clipboard?.writeText) throw new Error("Die Zwischenablage ist hier nicht verfügbar");
      await navigator.clipboard.writeText(text);
      showToast({ tone: "ok", title: "PIREP kopiert", body: "Als Text in der Zwischenablage – zum Einfügen ins VA-Formular." });
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
      showToast({ tone: "ok", title: "PIREP gespeichert", body: path });
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
      showToast({ tone: "ok", title: `Flug exportiert (${format.label})`, body: path });
    } catch (e) {
      const m = userMessage(e, "export");
      showToast({ tone: "err", title: m.title, body: m.hint });
    }
  };

  return (
    <div className="export-menu" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        Flug exportieren ▾
      </button>
      {open && (
        <div className="export-menu-list" role="menu">
          {EXPORT_FORMATS.map((f) => (
            <button key={f.id} role="menuitem" onClick={() => run(f)}>
              {f.title}
              <span className="detail">{f.hint}</span>
            </button>
          ))}
          <div className="export-menu-sep" role="separator" />
          <button role="menuitem" onClick={copyPirep}>
            PIREP als Text kopieren
            <span className="detail">für VA-Formulare</span>
          </button>
          <button role="menuitem" onClick={savePirep}>
            PIREP als JSON speichern …
            <span className="detail">pirep/v1</span>
          </button>
        </div>
      )}
    </div>
  );
}
