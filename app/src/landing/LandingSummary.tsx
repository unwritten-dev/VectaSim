import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fmt } from "../format";
import { openDebrief } from "./debriefStore";
import { BAND_LABEL, BAND_VAR } from "./facts";
import { sideLabel } from "./geometry";
import type { LandingDebriefData } from "./types";

/**
 * Compact debrief of a flight's last landing for the logbook detail, loaded automatically;
 * the button opens the full debrief.
 */
export default function LandingSummary({ flightId, touchdowns, updatedMs }: { flightId: string; touchdowns: number; updatedMs: number }) {
  const [data, setData] = useState<LandingDebriefData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    invoke<LandingDebriefData>("landing_analysis", { flightId, touchdownIndex: null })
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [flightId, touchdowns, updatedMs]);

  if (failed) return null;
  const a = data?.analysis;
  const rwy = a?.runway;
  const tp = a?.touchdownPoint;
  const fails = a ? a.gates.reduce((n, g) => n + g.criteria.filter((c) => c.status === "fail").length, 0) : 0;
  const reached = a ? a.gates.filter((g) => g.reached).length : 0;
  return (
    <div className="landing-summary" style={a ? { borderLeftColor: BAND_VAR[a.vsBand] } : undefined}>
      <div>
        <div className="landing-summary-title num">
          {a ? (rwy ? `${rwy.airport} RWY ${rwy.ident}` : `${data?.airport?.ident ?? "Letzte Landung"} · keine Runway zugeordnet`) : "Letzte Landung wird ausgewertet …"}
        </div>
        {a && (
          <div className="facts num detail">
            <span>
              Landerate{" "}
              <button className="rate-link" onClick={() => openDebrief(flightId, null)} title="Landeauswertung öffnen">
                {fmt(a.touchdown.landingRateFpm, 0, "fpm")}
              </button>{" "}
              <span className="band-dot inline" style={{ background: BAND_VAR[a.vsBand] }} aria-hidden="true" /> {BAND_LABEL[a.vsBand]}
            </span>
            {tp && (
              <span>
                {fmt(tp.distanceM, 0, "m")} hinter der Schwelle · {sideLabel(tp.lateralM)}
              </span>
            )}
            <span>
              Stabilisierter Anflug: {reached === 0 ? "nicht anwendbar" : fails === 0 ? "alle Kriterien erfüllt" : `${fails} ${fails === 1 ? "Kriterium" : "Kriterien"} nicht erfüllt`}
            </span>
          </div>
        )}
      </div>
      <span className="spacer" />
      <button className="btn-sm" onClick={() => openDebrief(flightId, null)} disabled={!a}>
        Landeauswertung
      </button>
    </div>
  );
}
