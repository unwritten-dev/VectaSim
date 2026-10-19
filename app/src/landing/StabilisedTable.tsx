import { Fragment } from "react";
import { fmt, fmtNum } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import type { ApproachAnalysis, ApproachCriterion, ApproachCriterionKind, ApproachGate, ApproachGateSample } from "./approachTypes";
import {
  APPROACH_CRITERION_ORDER,
  CRITERION_LABEL,
  CRITERION_ORDER,
  GATE_LABEL,
  STATUS_ICON,
  limitText,
  measuredText,
  unavailableReason,
  valueText,
} from "./facts";
import { nearestIndex, useReplaySelect } from "./replayStore";
import type { Criterion, GateCheck } from "./types";

type Status = Criterion["status"];
function statusText(t: TFunction, s: Status): string {
  return s === "pass" ? t("approach.stabilised.statusPass") : s === "fail" ? t("approach.stabilised.statusFail") : t("approach.stabilised.statusUnavailable");
}

/** Column of the gate nearest (in time) to the shared cursor; null without a cursor. */
function useCursorGate(times: Array<number | null | undefined>): number | null {
  return useReplaySelect((t) => nearestIndex(times, t));
}

const cur = (on: boolean) => (on ? " sa-cursor" : "");

function Cell({ c, hot = false }: { c?: Criterion; hot?: boolean }) {
  const t = useT();
  if (!c) return <td className={`sa-cell sa-unavailable${cur(hot)}`}>–</td>;
  return (
    <td className={`sa-cell sa-${c.status}${cur(hot)}`} title={statusText(t, c.status)}>
      <span className="sa-icon" aria-label={statusText(t, c.status)}>
        {STATUS_ICON[c.status]}
      </span>
      <span className="num">{measuredText(c)}</span>
    </td>
  );
}

/**
 * Stabilised-approach criteria at the gates: ✓/✗, measured value, limit. With an approach
 * analysis the five approach gates (10 nm, FAF, 1000, 500, 50 ft values only); otherwise the
 * landing's 1000/500 ft gates.
 */
export default function StabilisedTable({ gates = [], approach }: { gates?: GateCheck[]; approach?: ApproachAnalysis | null }) {
  if (approach) return <ApproachGateTable a={approach} />;
  return <LandingGateTable gates={gates} />;
}

function LandingGateTable({ gates }: { gates: GateCheck[] }) {
  const t = useT();
  const limitSource = gates.find((g) => g.criteria.length > 0);
  const hot = useCursorGate(gates.map((g) => (g.reached ? g.sample?.tMs : null)));
  return (
    <table className="mini-table sa-table">
      <thead>
        <tr>
          <th>{t("approach.stabilised.criterion")}</th>
          <th>{t("approach.stabilised.limit")}</th>
          {gates.map((g, gi) => (
            <th key={g.gateFt} className={hot === gi ? "sa-cursor" : undefined}>
              {t("approach.stabilised.atGate", { height: fmt(g.gateFt, 0, "ft") })}
              {g.sample && <span className="detail"> · {fmt(g.sample.distM / 1852, 1, "nm")}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CRITERION_ORDER.map((kind) => {
          const ref = limitSource?.criteria.find((c) => c.kind === kind);
          return (
            <tr key={kind}>
              <td>{CRITERION_LABEL[kind]}</td>
              <td className="detail num">{ref ? limitText(ref) : "–"}</td>
              {gates.map((g, gi) =>
                g.reached ? (
                  <Cell key={g.gateFt} c={g.criteria.find((c) => c.kind === kind)} hot={hot === gi} />
                ) : (
                  <td key={g.gateFt} className="sa-cell sa-unavailable detail">
                    {t("approach.stabilised.notReached")}
                  </td>
                ),
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Plain value of a kind at a gate sample (the 50 ft column has no criteria). */
function sampleValue(t: TFunction, kind: ApproachCriterionKind, s: ApproachGateSample, vapp: number | null): string {
  const v = (n: number | null) => (n == null ? t("approach.stabilised.notAvailable") : valueText(kind, n, "approach", kind === "speed" ? vapp : null));
  switch (kind) {
    case "gear":
      return v(s.gearPct);
    case "flaps":
    case "landingFlaps":
      return v(s.flapsIndex);
    case "thrust":
      return v(s.n1Pct ?? null);
    case "spoilers":
      return v(s.spoilersPct ?? null);
    case "verticalSpeed":
      return v(s.vsFpm);
    case "speed":
      return v(s.iasDevKt);
    case "speedLimit":
      return fmt(s.iasKt, 0, "kt");
    case "altitudeDeviation":
      return v(s.altDevFt);
    case "glidepath":
      return v(s.gsDots);
    case "localizer":
      return v(s.locDots);
    case "energy":
      return v(s.energyDevFt);
    case "bank":
      return v(s.bankDeg);
    default:
      return "–";
  }
}

function ApproachCell({ a, g, c, hot }: { a: ApproachAnalysis; g: ApproachGate; c: ApproachCriterion | undefined; hot: boolean }) {
  const t = useT();
  if (!c) return <td className={`sa-cell sa-na detail${cur(hot)}`}>–</td>;
  if (c.status === "unavailable") {
    return (
      <td className={`sa-cell sa-unavailable${cur(hot)}`} title={statusText(t, "unavailable")}>
        <span className="sa-icon" aria-hidden="true">
          {STATUS_ICON.unavailable}
        </span>
        {statusText(t, "unavailable")}
        <div className="sa-sub">{unavailableReason(a, g, c)}</div>
      </td>
    );
  }
  return (
    <td className={`sa-cell sa-${c.status}${cur(hot)}`} title={statusText(t, c.status)}>
      <span className="sa-icon" aria-label={statusText(t, c.status)}>
        {STATUS_ICON[c.status]}
      </span>
      <span className="num">{measuredText(c, "approach")}</span>
      <div className="sa-sub num">{limitText(c, "approach")}</div>
    </td>
  );
}

function gateHead(t: TFunction, a: ApproachAnalysis, g: ApproachGate): string | null {
  const s = g.sample;
  if (!s) return null;
  const nm = fmt(s.trackDistM / 1852, 1, "nm");
  if (g.kind === "tenNm") return fmt(s.hatFt, 0, "ft");
  if (g.kind === "faf") {
    const first = g.fafReason === "height" ? fmt(a.config.fafHatFt, 0, "ft") : fmt(a.config.fafDistNm, 0, "nm");
    return t("approach.stabilised.fafFirst", { first, dist: nm, height: fmt(s.hatFt, 0, "ft") });
  }
  return nm;
}

function ApproachGateTable({ a }: { a: ApproachAnalysis }) {
  const t = useT();
  const gates = a.gates;
  const present = new Set(gates.flatMap((g) => g.criteria.map((c) => c.kind)));
  const kinds = APPROACH_CRITERION_ORDER.filter((k) => present.has(k));
  const rows = kinds.length ? kinds : APPROACH_CRITERION_ORDER;
  const outside = a.stability.timeOutside.filter((x) => x.seconds > 0);
  const hot = useCursorGate(gates.map((g) => (g.reached ? g.sample?.tMs : null)));
  return (
    <table className="mini-table sa-table sa-approach">
      <thead>
        <tr>
          <th>{t("approach.stabilised.criterion")}</th>
          {gates.map((g, gi) => (
            <th key={g.kind} className={hot === gi ? "sa-cursor" : undefined}>
              {GATE_LABEL[g.kind]}
              {gateHead(t, a, g) && <div className="detail sa-sub">{gateHead(t, a, g)}</div>}
              {g.kind === "ft50" && <div className="detail sa-sub">{t("approach.stabilised.valuesOnly")}</div>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((kind, row) => (
          <tr key={kind}>
            <td>{CRITERION_LABEL[kind]}</td>
            {gates.map((g, gi) => {
              if (!g.reached) {
                return row === 0 ? (
                  <td key={g.kind} rowSpan={rows.length} className="sa-cell sa-unavailable sa-unreached detail">
                    {t("approach.stabilised.notReached")}
                  </td>
                ) : (
                  <Fragment key={g.kind} />
                );
              }
              if (g.kind === "ft50") {
                return (
                  <td key={g.kind} className={`sa-cell sa-value num${cur(hot === gi)}`}>
                    {g.sample ? sampleValue(t, kind, g.sample, a.reference.vappKt) : "–"}
                  </td>
                );
              }
              return <ApproachCell key={g.kind} a={a} g={g} c={g.criteria.find((c) => c.kind === kind)} hot={hot === gi} />;
            })}
          </tr>
        ))}
        <tr className="sa-outside">
          <td>{t("approach.common.timeOutside")}</td>
          <td colSpan={gates.length} className="num">
            {outside.length ? outside.map((x) => `${CRITERION_LABEL[x.kind]} ${fmt(x.seconds, 0, "s")}`).join(" · ") : t("approach.common.none")}
            <span className="detail">
              {" "}
              · {t("approach.stabilised.windowNote", { top: fmtNum(a.config.windowTopFt), bottom: fmt(a.config.windowBottomFt, 0, "ft") })}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
