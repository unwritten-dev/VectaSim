import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fmt } from "../i18n/number";
import { useT } from "../i18n";
import { openDebrief } from "./debriefStore";
import { APPROACH_BAND_LABEL, APPROACH_BAND_VAR, BAND_LABEL, BAND_VAR, isRated, lateralMeasurable, rateText, runwaySourceOf, touchdownDistanceText } from "./facts";
import { sideLabel } from "./geometry";
import type { LandingDebriefData } from "./types";
import type { ApproachAnalysis } from "./approachTypes";

/**
 * Compact debrief of a flight's last landing for the logbook detail, loaded automatically;
 * the button opens the full debrief.
 */
export default function LandingSummary({ flightId, touchdowns, updatedMs }: { flightId: string; touchdowns: number; updatedMs: number }) {
  const t = useT();
  const [data, setData] = useState<LandingDebriefData | null>(null);
  const [approaches, setApproaches] = useState<ApproachAnalysis[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setApproaches(null);
    setFailed(false);
    invoke<LandingDebriefData>("landing_analysis", { flightId, touchdownIndex: null })
      .then((d) => alive && setData(d))
      .catch(() => alive && setFailed(true));
    // the approach is an extra line; the summary works without it
    invoke<ApproachAnalysis[]>("approach_analysis", { flightId })
      .then((a) => alive && setApproaches(a))
      .catch(() => alive && setApproaches([]));
    return () => {
      alive = false;
    };
  }, [flightId, touchdowns, updatedMs]);
  const goArounds = approaches?.filter((x) => x.outcome.kind === "goAround").length ?? 0;
  const last = (xs: ApproachAnalysis[] | null | undefined): ApproachAnalysis | null => (xs && xs.length ? xs[xs.length - 1] : null);
  const landedApproach = last(approaches?.filter((x) => x.outcome.kind === "landed")) ?? last(approaches);

  if (failed) return null;
  const a = data?.analysis;
  const rwy = a?.runway;
  const tp = a?.touchdownPoint;
  const fails = a ? a.gates.reduce((n, g) => n + g.criteria.filter((c) => c.status === "fail").length, 0) : 0;
  const reached = a ? a.gates.filter((g) => g.reached).length : 0;
  return (
    <div className="landing-summary" style={a && isRated(a.touchdown) ? { borderLeftColor: BAND_VAR[a.vsBand] } : undefined}>
      <div>
        <div className="landing-summary-title num">
          {a
            ? rwy
              ? `${rwy.airport} RWY ${rwy.ident}`
              : t("debrief.header.titleNoRunway", { place: data?.airport?.ident ?? t("debrief.summary.lastLanding") })
            : t("debrief.summary.loading")}
        </div>
        {a && (
          <div className="facts num detail">
            <span>
              {t("debrief.summary.rate")}{" "}
              <button className="rate-link" onClick={() => openDebrief(flightId, null)} title={t("debrief.summary.openTitle")}>
                {rateText(a.touchdown)}
              </button>
              {isRated(a.touchdown) && (
                <>
                  {" "}
                  <span className="band-dot inline" style={{ background: BAND_VAR[a.vsBand] }} aria-hidden="true" /> {BAND_LABEL[a.vsBand]}
                </>
              )}
            </span>
            {tp && (
              <span>
                {t("debrief.summary.pastThreshold", { distance: touchdownDistanceText(tp) })} · {lateralMeasurable(tp) ? sideLabel(tp.lateralM) : t("debrief.hero.lateralNotMeasurable")}
                {rwy && runwaySourceOf(rwy) !== "database" && ` · ${runwaySourceOf(rwy) === "user" ? t("debrief.summary.runwayUser") : t("debrief.summary.runwayDerived")}`}
              </span>
            )}
            {landedApproach?.band ? (
              <span>
                {t("debrief.summary.approach")} <span className="band-dot inline" style={{ background: APPROACH_BAND_VAR[landedApproach.band] }} aria-hidden="true" /> {APPROACH_BAND_LABEL[landedApproach.band]}
                {landedApproach.stability.stableFromFt != null
                  ? ` · ${t("debrief.summary.stableFrom", { alt: fmt(landedApproach.stability.stableFromFt, 0, "ft") })}`
                  : ` · ${t("debrief.summary.neverStable")}`}
                {goArounds > 0 && ` · ${t("debrief.summary.goArounds", { count: goArounds })}`}
              </span>
            ) : (
              <span>
                {t("debrief.summary.stabilised", {
                  result: reached === 0 ? t("debrief.summary.notApplicable") : fails === 0 ? t("debrief.summary.allMet") : t("debrief.summary.failed", { count: fails }),
                })}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="spacer" />
      <button className="btn-sm" onClick={() => openDebrief(flightId, null)} disabled={!a}>
        {t("debrief.summary.open")}
      </button>
    </div>
  );
}
