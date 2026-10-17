import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { FlightDetail as Detail, TrackSample } from "./types";
import { PHASE_LABEL, fmt, fmtClock, fmtCoord, fmtDate, fmtDeltaKg, fmtDeltaMin, fmtDuration } from "./format";
import TrackMap from "./map/TrackMap";
import ProfileChart from "./ProfileChart";
import Stat from "./ui/Stat";
import { showToast } from "./ui/Toast";
import { userMessage } from "./errors";
import { useAirport } from "./live/hooks";
import { callsignOf } from "./logbookFilter";
import { isDemoRow } from "./totals";
import LandingSummary from "./landing/LandingSummary";
import { openDebrief } from "./landing/debriefStore";
import AirframeCard from "./airframes/AirframeCard";
import { navigate } from "./airframes/navigation";

export function stateLabel(state: string): string {
  switch (state) {
    case "completed":
      return "gespeichert";
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
  onDelete: () => void;
  /** Bumped by the list's Delete key: opens the inline confirmation. */
  deleteRequest?: number;
}

/** Right-hand side of the logbook: one flight with map, profile, landings and phases. */
export default function FlightDetail({ detail, track, onDelete, deleteRequest }: Props) {
  const f = detail.flight;
  const [confirming, setConfirming] = useState(false);
  const depAirport = useAirport(f.depIcao ?? null);
  const arrAirport = useAirport(f.arrIcao ?? null);
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
  const issues = [
    integrity.slewDetected && "Slew",
    integrity.timeAccelerationDetected && `Zeitraffer (max. ${fmt(integrity.maxSimRate, 0)}×)`,
    integrity.crashed && "Absturz",
    integrity.fuelIncreasedAirborne && "Treibstoff in der Luft erhöht",
    integrity.pauseCount > 0 && `${integrity.pauseCount}× Pause (${fmtDuration(integrity.pausedMs)})`,
  ].filter(Boolean);

  return (
    <article className="flight-detail" aria-label={`Flug ${f.depIcao ?? "····"} nach ${f.arrIcao ?? "····"}`}>
      <header className="detail-head">
        <div className="detail-title">
          <h2 className="num">
            {f.depIcao ?? "····"} → {f.arrIcao ?? (f.state === "active" ? "…" : "····")}
          </h2>
          <div className="detail">
            {[f.aircraft.title || "Unbekanntes Flugzeug", f.airframeReg ?? f.aircraft.atcId, callsign, fmtDate(f.offBlockMs ?? f.createdMs), blockMs != null ? `${fmtDuration(blockMs, { seconds: false })} Blockzeit` : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className="detail-badges">
            <span className={`badge state-${f.state}`}>{stateLabel(f.state)}</span>
            {isDemoRow(f) && (
              <span className="badge badge-demo" title="Simulierter Demo-Flug – zählt nicht in den Summen">
                Demo
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
          <ExportMenu flightId={f.id} />
          {confirming ? (
            <span className="confirm-delete" role="group" aria-label="Löschen bestätigen">
              <span className="detail">Endgültig löschen?</span>
              <button className="btn-sm danger" onClick={onDelete} autoFocus>
                Ja, löschen
              </button>
              <button className="btn-sm" onClick={() => setConfirming(false)}>
                Abbrechen
              </button>
            </span>
          ) : (
            <button className="danger" onClick={() => setConfirming(true)} title="Flug löschen (Entf)">
              Löschen
            </button>
          )}
        </div>
      </header>

      {detail.hasTrack || track.length > 0 ? (
        <>
          <TrackMap samples={track} touchdowns={detail.touchdowns} departure={departure} arrival={arrival} />
          <ProfileChart samples={track} phases={detail.phases} touchdowns={detail.touchdowns} />
        </>
      ) : (
        <div className="detail">Für diesen Flug wurde kein Track aufgezeichnet.</div>
      )}

      <div className="detail-section">
        <h3>{detail.touchdowns.length > 1 ? "Landungen" : "Landung"}</h3>
        {detail.touchdowns.length === 0 ? (
          <div className="detail">Keine Landung aufgezeichnet.</div>
        ) : (
          <>
          <LandingSummary flightId={f.id} touchdowns={detail.touchdowns.length} updatedMs={f.updatedMs} />
          <details className="fold">
            <summary>Alle Landungen dieses Flugs ({detail.touchdowns.length})</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Zeit</th>
                <th className="right">Landerate</th>
                <th className="right">Messwert</th>
                <th className="right">Sim-Wert</th>
                <th className="right">G-Last</th>
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
                  <td className={`num right${t.peakG > 1.75 ? " warn-text" : ""}`}>{fmt(t.peakG, 2)}</td>
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

      <div className="detail-section">
        <h3>Flugzeug</h3>
        <AirframeCard flight={f} onOpenFleet={(registration) => navigate({ kind: "airframe", registration })} />
      </div>

      <div className="detail-section">
        <h3>Flug</h3>
        <div className="stat-grid detail-grid">
          <Stat size="sm" label="Abflug" value={f.depIcao ?? fmtCoord(f.depLat, f.depLon)} sub={depAirport?.name ?? (f.depIcao ? fmtCoord(f.depLat, f.depLon) : undefined)} />
          <Stat size="sm" label="Ankunft" value={f.arrIcao ?? fmtCoord(f.arrLat, f.arrLon)} sub={arrAirport?.name ?? (f.arrIcao ? fmtCoord(f.arrLat, f.arrLon) : undefined)} />
          <Stat size="sm" label="Off-Block" value={fmtClock(f.offBlockMs)} />
          <Stat size="sm" label="Start" value={fmtClock(f.takeoffMs)} />
          <Stat size="sm" label="Landung" value={fmtClock(f.landingMs)} />
          <Stat size="sm" label="On-Block" value={fmtClock(f.onBlockMs)} />
          <Stat size="sm" label="Blockzeit" value={fmtDuration(blockMs)} />
          <Stat size="sm" label="Flugzeit" value={fmtDuration(airMs)} />
          <Stat size="sm" label="Distanz" value={fmt(f.distanceNm, 1)} unit="nm" />
          <Stat size="sm" label="Max. Höhe" value={fmt(f.maxAltMslFt, 0)} unit="ft" />
          <Stat size="sm" label="Verbrauch" value={fmt(fuelUsed, 0)} unit="kg" />
        </div>
      </div>

      {f.hasOfp && (
        <div className="detail-section">
          <h3>Ist gegen Plan (SimBrief)</h3>
          <div className="stat-grid detail-grid">
            <Stat size="sm" label="Route (Plan)" value={`${f.plannedDep ?? "–"} → ${f.plannedArr ?? "–"}`} />
            <Stat
              size="sm"
              label="Blockzeit"
              value={blockMs != null ? fmtDuration(blockMs) : "–"}
              sub={`Plan ${fmtDuration((f.plannedBlockS ?? 0) * 1000)}${blockMs != null && f.plannedBlockS != null ? ` · ${fmtDeltaMin(blockMs, f.plannedBlockS * 1000)}` : ""}`}
            />
            <Stat
              size="sm"
              label="Treibstoff bei Landung"
              value={fmt(f.fuelEndKg, 0)}
              unit="kg"
              sub={`Plan ${fmt(f.plannedFuelLandingKg, 0, "kg")}${f.fuelEndKg != null && f.plannedFuelLandingKg != null ? ` · ${fmtDeltaKg(f.fuelEndKg, f.plannedFuelLandingKg)}` : ""}`}
              warn={f.fuelEndKg != null && f.plannedFuelLandingKg != null && f.fuelEndKg < f.plannedFuelLandingKg - 0.5 ? "Weniger Treibstoff bei der Landung als geplant" : null}
            />
          </div>
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

const EXPORT_FORMATS = [
  { id: "kml", label: "KML", title: "Für Google Earth (KML)", hint: "3D-Track" },
  { id: "gpx", label: "GPX", title: "Für Garmin/Strava (GPX)", hint: "Track mit Zeitstempeln" },
  { id: "csv", label: "CSV", title: "Rohdaten (CSV)", hint: "alle Trackpunkte" },
  { id: "json", label: "JSON", title: "Rohdaten (JSON)", hint: "Flug, Landungen, Phasen, Track" },
] as const;

function ExportMenu({ flightId }: { flightId: string }) {
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
        </div>
      )}
    </div>
  );
}
