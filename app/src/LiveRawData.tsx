import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DefDiag, DiagSnapshot, FlightDebug } from "./types";
import { fmt, fmtClock, fmtNum } from "./i18n/number";
import { t as tNow, useT } from "./i18n";
import { useTelemetrySelector } from "./telemetryStore";
import { KV } from "./ui/Stat";
import { approachRows, connLabels, eventTone, fmtAge, fmtBytes, fmtConverted, fmtHz, fmtRaw, hasApproachData } from "./rawDiag";

const yesNo = (b: boolean | null | undefined) => (b ? tNow("live.raw.yes") : tNow("live.raw.no"));
const secs = (ms: number | null | undefined) => (ms == null ? "–" : `${fmtNum(ms / 1000, 1)} s`);

/**
 * Einstellungen → Diagnose → Live-Rohdaten: every raw definition (SimConnect, X-Plane) with raw and converted
 * values, the event log, engine internals and connection info. Mounted only while the section
 * is open; the backend streams `diag:raw` at 2 Hz only for as long as this view exists.
 */
export default function LiveRawData() {
  const t = useT();
  const [snap, setSnap] = useState<DiagSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    invoke("set_diag_stream", { on: true }).catch(() => {});
    invoke<DiagSnapshot>("diagnostics_snapshot")
      .then((s) => alive && setSnap(s))
      .catch(() => {});
    const un = listen<DiagSnapshot>("diag:raw", (e) => alive && setSnap(e.payload));
    return () => {
      alive = false;
      invoke("set_diag_stream", { on: false }).catch(() => {});
      void un.then((f) => f());
    };
  }, []);

  if (!snap) return <div className="detail">{t("live.raw.loading")}</div>;
  const raw = snap.raw;
  const conn = raw?.connection;
  const labels = connLabels(raw?.source);
  return (
    <div className="raw-diag">
      <KV
        rows={[
          [t("live.raw.source"), `${snap.provider} (${snap.state})`],
          [labels.origin, conn?.dll ? <span className="mono">{conn.dll}</span> : "–"],
          [labels.sim, conn?.simName ? `${conn.simName} ${conn.simVersion ?? ""}` : "–"],
          [labels.api, conn?.simconnectVersion ?? "–"],
          [t("live.raw.sessions"), conn ? `${conn.sessions} / ${conn.reconnects}` : "–"],
          [
            t("live.raw.simState"),
            conn?.simState == null
              ? "–"
              : conn.simState
                ? labels.simconnect
                  ? t("live.raw.flyingSim")
                  : t("live.raw.flying")
                : labels.simconnect
                  ? t("live.raw.menuSim")
                  : t("live.raw.menu"),
          ],
          [
            labels.simconnect ? t("live.raw.lastHresults") : t("live.raw.lastErrorCodes"),
            conn?.lastHresults.length ? (
              <span className="diag-paths">
                {conn.lastHresults
                  .slice()
                  .reverse()
                  .map((h, i) => (
                    <span key={i} className="mono">
                      {fmtClock(h.wallMs, { seconds: true })} {h.call} {h.hr}
                    </span>
                  ))}
              </span>
            ) : (
              t("live.raw.none")
            ),
          ],
          [
            t("live.raw.ringBuffer"),
            snap.dump.ringLines
              ? t("live.raw.ringValue", { minutes: fmtNum(snap.dump.ringSeconds / 60, 1), size: fmtBytes(snap.dump.ringBytes), lines: snap.dump.ringLines })
              : t("live.raw.empty"),
          ],
        ]}
      />

      <EngineView engine={snap.engine ?? null} />

      <ApproachDataView />

      {raw ? (
        raw.defs.map((d) => <DefTable key={d.label} def={d} />)
      ) : (
        <div className="detail">{t("live.raw.noDefs")}</div>
      )}

      {raw && (
        <>
          <h4 className="raw-diag-title">
            {t("live.raw.events")} <span className="detail">{t("live.raw.eventsCount", { shown: raw.events.length, total: raw.eventsTotal })}</span>
          </h4>
          {raw.events.length ? (
            <div className="raw-scroll">
              <table className="flights raw-table">
                <thead>
                  <tr>
                    <th>{t("live.raw.time")}</th>
                    <th>{t("live.raw.kind")}</th>
                    <th>{t("live.raw.name")}</th>
                    <th>dwData</th>
                    <th>{t("live.raw.detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {raw.events
                    .slice()
                    .reverse()
                    .map((e, i) => (
                      <tr key={i} className={`static raw-ev-${eventTone(e)}`}>
                        <td className="num">{fmtClock(e.wallMs, { seconds: true })}</td>
                        <td>{e.kind}</td>
                        <td>{e.name}</td>
                        <td className="mono">{e.dataHex ?? ""}</td>
                        <td className="raw-detail mono">{e.detail}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="detail">{t("live.raw.noneYet")}</div>
          )}
        </>
      )}
    </div>
  );
}

function EngineView({ engine }: { engine: FlightDebug | null }) {
  const t = useT();
  if (!engine) return <div className="detail">{t("live.raw.engineNone")}</div>;
  const c = engine.candidate;
  const det = engine.detector;
  const detector = [
    det.state,
    det.state !== "ground" ? t("live.raw.detectorQualified", { value: yesNo(det.qualified) }) : null,
    det.state === "settling" ? t("live.raw.detectorSettling", { samples: det.groundSamples, confirmed: yesNo(det.confirmed), bounces: det.bounces }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <h4 className="raw-diag-title">{t("live.raw.engine")}</h4>
      <KV
        rows={[
          [t("live.raw.phase"), t("live.raw.phaseValue", { phase: engine.phase, state: engine.state })],
          [t("live.raw.candidate"), c ? t("live.raw.candidateValue", { phase: c.phase, remaining: secs(c.remainingMs), dwell: secs(c.dwellMs) }) : "–"],
          ["airborne_qualified", yesNo(engine.airborneQualified)],
          [t("live.raw.airborneSince"), engine.airborneSinceMs ? fmtClock(engine.airborneSinceMs, { seconds: true }) : "–"],
          [t("live.raw.lastSkip"), engine.lastSkip ?? "–"],
          [t("live.raw.detector"), detector],
          [t("live.raw.staleSim"), `${det.staleSim == null ? "–" : fmtNum(det.staleSim, 1)} / ${fmtNum(det.lastAirSim, 1)} fpm`],
          [t("live.raw.stopPauseReset"), `${yesNo(engine.simStopped)} / ${yesNo(engine.eventPaused)} / ${yesNo(engine.resumedAirborne)}`],
          [t("live.raw.touchdowns"), String(engine.touchdowns)],
          [t("live.raw.pendingTouchdown"), engine.pendingTouchdown == null ? "–" : `#${engine.pendingTouchdown + 1}`],
        ]}
      />
    </>
  );
}

/**
 * The converted approach values (track v2) of the latest telemetry: what the recorder stores
 * at 1 Hz. Also for the demo flight, which has no raw definitions. Own component, so the 10 Hz
 * telemetry re-renders only this table.
 */
function ApproachDataView() {
  const t = useT();
  const tel = useTelemetrySelector((s) => s.telemetry);
  return (
    <>
      <h4 className="raw-diag-title">
        {t("live.raw.approach")} <span className="detail">{t("live.raw.approachSub")}</span>
      </h4>
      {!tel ? (
        <div className="detail">{t("live.raw.noTelemetry")}</div>
      ) : hasApproachData(tel) ? (
        <KV rows={approachRows(tel)} />
      ) : (
        <div className="detail">{t("live.raw.noApproach", { tas: fmt(tel.tasKt, 0, "kt") })}</div>
      )}
    </>
  );
}

function DefTable({ def }: { def: DefDiag }) {
  const t = useT();
  return (
    <>
      <h4 className="raw-diag-title">
        {def.label}{" "}
        <span className="detail">
          {t("live.raw.defSub", { req: String(def.req), period: def.period, rate: fmtHz(def.rateHz), age: fmtAge(def.ageMs), updates: def.updates })}
        </span>
      </h4>
      <table className="flights raw-table">
        <thead>
          <tr>
            <th>{t("live.raw.simVar")}</th>
            <th>{t("live.raw.unit")}</th>
            <th className="right">{t("live.raw.rawValue")}</th>
            <th className="right">{t("live.raw.value")}</th>
          </tr>
        </thead>
        <tbody>
          {def.vars.map((v) => (
            <tr key={v.name} className={`static${v.active ? "" : " raw-inactive"}`} title={v.active ? undefined : t("live.raw.rejected")}>
              <td className="mono">
                {v.active ? "" : "✗ "}
                {v.name}
              </td>
              <td className="detail">{v.unit ?? "STRING256"}</td>
              <td className="right mono">{fmtRaw(v)}</td>
              <td className="right num">{fmtConverted(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
