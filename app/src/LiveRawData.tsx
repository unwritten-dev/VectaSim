import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DefDiag, DiagSnapshot, FlightDebug } from "./types";
import { fmtClock, fmtNum } from "./format";
import { KV } from "./ui/Stat";
import { eventTone, fmtAge, fmtBytes, fmtConverted, fmtHz, fmtRaw } from "./rawDiag";

const yesNo = (b: boolean | null | undefined) => (b ? "ja" : "nein");
const secs = (ms: number | null | undefined) => (ms == null ? "–" : `${fmtNum(ms / 1000, 1)} s`);

/**
 * Einstellungen → Diagnose → Live-Rohdaten: every SimConnect definition with raw and converted
 * values, the event log, engine internals and connection info. Mounted only while the section
 * is open; the backend streams `diag:raw` at 2 Hz only for as long as this view exists.
 */
export default function LiveRawData() {
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

  if (!snap) return <div className="detail">Lade Rohdaten …</div>;
  const raw = snap.raw;
  const conn = raw?.connection;
  return (
    <div className="raw-diag">
      <KV
        rows={[
          ["Quelle", `${snap.provider} (${snap.state})`],
          [raw?.source === "replay" ? "Datei" : "SimConnect.dll", conn?.dll ? <span className="mono">{conn.dll}</span> : "–"],
          ["Simulator (RECV_OPEN)", conn?.simName ? `${conn.simName} ${conn.simVersion ?? ""}` : "–"],
          ["SimConnect-Version", conn?.simconnectVersion ?? "–"],
          ["Sitzungen / Reconnects", conn ? `${conn.sessions} / ${conn.reconnects}` : "–"],
          ["Sim-Status", conn?.simState == null ? "–" : conn.simState ? "Flug läuft (Sim=1)" : "Menü (Sim=0)"],
          [
            "Letzte HRESULTs",
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
              "keine"
            ),
          ],
          [
            "Roh-Puffer (RAM)",
            snap.dump.ringLines ? `${fmtNum(snap.dump.ringSeconds / 60, 1)} min · ${fmtBytes(snap.dump.ringBytes)} · ${fmtNum(snap.dump.ringLines)} Zeilen` : "leer",
          ],
        ]}
      />

      <EngineView engine={snap.engine ?? null} />

      {raw ? (
        raw.defs.map((d) => <DefTable key={d.label} def={d} />)
      ) : (
        <div className="detail">– Dieser Simulator liefert keine Rohdefinitionen (Demo-Flug). Rohwerte gibt es mit MSFS oder einem Replay.</div>
      )}

      {raw && (
        <>
          <h4 className="raw-diag-title">
            Ereignisse <span className="detail">(letzte {raw.events.length} von {fmtNum(raw.eventsTotal)})</span>
          </h4>
          {raw.events.length ? (
            <div className="raw-scroll">
              <table className="flights raw-table">
                <thead>
                  <tr>
                    <th>Zeit</th>
                    <th>Art</th>
                    <th>Name</th>
                    <th>dwData</th>
                    <th>Detail</th>
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
            <div className="detail">noch keine</div>
          )}
        </>
      )}
    </div>
  );
}

function EngineView({ engine }: { engine: FlightDebug | null }) {
  if (!engine) return <div className="detail">Engine: noch keine Daten</div>;
  const c = engine.candidate;
  const det = engine.detector;
  return (
    <>
      <h4 className="raw-diag-title">Engine</h4>
      <KV
        rows={[
          ["Phase", `${engine.phase} · Flug ${engine.state}`],
          ["Kandidat", c ? `${c.phase} · noch ${secs(c.remainingMs)} von ${secs(c.dwellMs)}` : "–"],
          ["airborne_qualified", yesNo(engine.airborneQualified)],
          ["In der Luft seit", engine.airborneSinceMs ? fmtClock(engine.airborneSinceMs, { seconds: true }) : "–"],
          ["Letzter Skip", engine.lastSkip ?? "–"],
          [
            "Touchdown-Detektor",
            `${det.state}${det.state !== "ground" ? ` · qualifiziert ${yesNo(det.qualified)}` : ""}${
              det.state === "settling" ? ` · Bodensamples ${det.groundSamples} · bestätigt ${yesNo(det.confirmed)} · Bounces ${det.bounces}` : ""
            }`,
          ],
          ["stale_sim / letzter Sim-Wert", `${det.staleSim == null ? "–" : fmtNum(det.staleSim, 1)} / ${fmtNum(det.lastAirSim, 1)} fpm`],
          ["Menü / Pause / Reset in der Luft", `${yesNo(engine.simStopped)} / ${yesNo(engine.eventPaused)} / ${yesNo(engine.resumedAirborne)}`],
          ["Touchdowns", String(engine.touchdowns)],
          ["Ausgang offen (Touchdown)", engine.pendingTouchdown == null ? "–" : `#${engine.pendingTouchdown + 1}`],
        ]}
      />
    </>
  );
}

function DefTable({ def }: { def: DefDiag }) {
  return (
    <>
      <h4 className="raw-diag-title">
        {def.label} <span className="detail">· Request {def.req} · {def.period} · {fmtHz(def.rateHz)} · Alter {fmtAge(def.ageMs)} · {fmtNum(def.updates)} Updates</span>
      </h4>
      <table className="flights raw-table">
        <thead>
          <tr>
            <th>SimVar</th>
            <th>Unit</th>
            <th className="right">Rohwert</th>
            <th className="right">Wert</th>
          </tr>
        </thead>
        <tbody>
          {def.vars.map((v) => (
            <tr key={v.name} className={`static${v.active ? "" : " raw-inactive"}`} title={v.active ? undefined : "vom Simulator abgelehnt – nicht mehr registriert"}>
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
