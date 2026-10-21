import { useState } from "react";
import { t as tActive, useT, type TFunction } from "../i18n";
import { fmt, fmtNum, fmtSigned } from "../i18n/number";
import type { FlightRow } from "../types";
import type { ApproachAnalysis, ApproachBand, ConfigEvent, GoAroundSource, VappSource } from "./approachTypes";
import {
  APPROACH_BAND_VAR,
  approachBandLabel,
  CRITERION_LABEL,
  approachKeySentence,
  approachProvenance,
  automationText,
  energyBandText,
  exceedanceRange,
  gateMark,
  glidepathLabel,
  isDerivedRunway,
  lateralFactText,
  lateralSubLine,
  simWindComponentsText,
  simWindText,
  valueText,
  vappSourceLabel,
} from "./facts";
import { copyApproachCardPng, saveApproachCardPng } from "./exportApproachCard";
import { Hero } from "./Hero";
import AssessedWith from "./AssessedWith";

/** What the debrief knows about the approach of the shown landing. */
export type ApproachStatus = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ok"; approach: ApproachAnalysis };

/** Factor of the design Vapp (VS0 × 1.3), shown in its source label. */
const DESIGN_VAPP_FACTOR = 1.3;

const VAPP_SOURCE_TEXT: Record<VappSource, () => string> = {
  // the pilot's value from the fleet (Flugzeuge → Vapp)
  user: () => tActive("approach.section.vappSource.user"),
  flown: () => tActive("approach.section.vappSource.flown"),
  design: () => tActive("approach.section.vappSource.design", { factor: fmtNum(DESIGN_VAPP_FACTOR, 1) }),
  unavailable: () => tActive("approach.section.vappSource.unavailable"),
};

/** Source label of the Vapp in the active language (a getter per key; LandingDebrief reads it). */
export const VAPP_SOURCE_LABEL: Record<VappSource, string> = Object.defineProperties(
  {} as Record<VappSource, string>,
  Object.fromEntries(Object.entries(VAPP_SOURCE_TEXT).map(([k, get]) => [k, { get, enumerable: true }])),
);

function gaSourceText(t: TFunction, s: GoAroundSource): string {
  switch (s) {
    case "track":
      return t("approach.section.goAround.sourceTrack");
    case "phase":
      return t("approach.section.goAround.sourcePhase");
    case "both":
      return t("approach.section.goAround.sourceBoth");
  }
}

/** Badge with the four-step band (ok / warn / err tokens). */
export function ApproachBandBadge({ band, hardGateFt }: { band: ApproachBand; hardGateFt?: number | null }) {
  useT(); // re-render on a language switch (the label is a getter)
  return (
    <span className="approach-band" style={{ borderColor: APPROACH_BAND_VAR[band], color: APPROACH_BAND_VAR[band] }}>
      <span className="band-dot" style={{ background: APPROACH_BAND_VAR[band] }} aria-hidden="true" />
      {approachBandLabel(band, hardGateFt)}
    </span>
  );
}

function configEventText(t: TFunction, e: ConfigEvent): string {
  const height = fmt(e.hatFt, 0, "ft");
  switch (e.kind) {
    case "gearDown":
      return t("approach.section.config.gearDown", { height });
    case "gearUp":
      return t("approach.section.config.gearUp", { height });
    case "flaps":
      return t("approach.section.config.flaps", { from: fmtNum(e.flapsFrom), to: fmtNum(e.flapsTo), height });
  }
}

/** Approach card (PNG, 1200×675 at 2×): save to a file or copy to the clipboard. */
function ApproachCardActions({ a, flight }: { a: ApproachAnalysis; flight: FlightRow | null }) {
  const t = useT();
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const run = (kind: "save" | "copy") => {
    setBusy(kind);
    (kind === "save" ? saveApproachCardPng(a, flight) : copyApproachCardPng(a, flight)).finally(() => setBusy(null));
  };
  return (
    <div className="debrief-card-actions approach-card-actions">
      <button className="btn-sm" disabled={busy != null} onClick={() => run("save")} title={t("approach.section.card.saveTitle")}>
        {busy === "save" ? t("approach.section.card.saving") : t("approach.section.card.save")}
      </button>
      <button className="btn-sm" disabled={busy != null} onClick={() => run("copy")} title={t("approach.section.card.copyTitle")}>
        {busy === "copy" ? t("approach.section.card.copying") : t("approach.section.card.copy")}
      </button>
    </div>
  );
}

/**
 * Section "Anflug": key sentence, band, four hero values (stable from, glidepath RMS, lateral
 * RMS on the extended centreline, speed spread) with one explaining line for RMS / MAD,
 * established point, lateral band, configuration events and the exceedances 1000 → 50 ft. For a
 * go-around also the lowest point. Track v2: sim wind, energy band, automation; the buttons
 * for the approach card (`flight` names aircraft and registration on it, masked in the Streamer-Modus).
 */
export default function ApproachSection({ status, title: titleProp, flight = null }: { status: ApproachStatus; title?: string; flight?: FlightRow | null }) {
  const t = useT();
  const title = titleProp ?? t("approach.section.title");
  if (status.kind === "loading") {
    return (
      <section className="debrief-section approach-section">
        <h3>{title}</h3>
        <p className="detail">{t("approach.section.loading")}</p>
      </section>
    );
  }
  if (status.kind === "error") {
    return (
      <section className="debrief-section approach-section">
        <h3>{title}</h3>
        <p className="approach-error">
          <strong>{t("approach.section.errorTitle")}</strong>
          <span className="detail"> – {status.reason}</span>
        </p>
      </section>
    );
  }
  return <ApproachBody a={status.approach} title={title} flight={flight} />;
}

function ApproachBody({ a, title, flight }: { a: ApproachAnalysis; title: string; flight: FlightRow | null }) {
  const t = useT();
  // facts.ts texts follow the active language: computed per render (cheap), so a switch re-renders them
  const sentence = approachKeySentence(a);
  const src = approachProvenance(a);
  const st = a.stability;
  const ref = a.reference;
  const gate = (k: "faf" | "ft1000" | "ft500") => a.gates.find((g) => g.kind === k) ?? null;
  const isGa = a.outcome.kind === "goAround";
  const sf = st.stableFromFt;
  const stableValue = sf != null ? fmt(sf, 0) : a.band == null ? "–" : t("approach.common.never");
  const dots = t("approach.common.dots");

  const gpValue = st.gpRmsDots != null ? fmtNum(st.gpRmsDots, 2) : st.gpRmsFt != null ? fmt(st.gpRmsFt, 0) : "–";
  const gpUnit = st.gpRmsDots != null ? dots : st.gpRmsFt != null ? "ft" : undefined;
  const gpMax =
    st.gpMaxAboveDots != null || st.gpMaxBelowDots != null
      ? t("approach.section.hero.glidepathMax", { above: fmtSigned(st.gpMaxAboveDots ?? 0, 1), below: fmtSigned(st.gpMaxBelowDots ?? 0, 1) })
      : null;

  // lateral guidance: dots, metres as the fallback; nothing with a derived runway / without one
  // (same rule as lateralUnmeasurableReason: "too few samples" still shows what there is)
  const latShown = !!a.runway && !isDerivedRunway(a.runway) && a.lateral?.measurable !== false;
  const latValue = !latShown ? "–" : st.locRmsDots != null ? fmtNum(st.locRmsDots, 2) : st.latRmsM != null ? fmt(st.latRmsM, 0) : "–";
  const latUnit = !latShown ? undefined : st.locRmsDots != null ? dots : st.latRmsM != null ? "m" : undefined;
  const latRmsM = latShown && st.locRmsDots != null && st.latRmsM != null ? `RMS ${fmt(st.latRmsM, 0, "m")}` : null;

  const vapp = fmt(ref.vappKt, 0, "kt");
  const speedSub2 =
    ref.vappSource === "flown"
      ? t("approach.section.hero.speedFlown", { vapp })
      : ref.vappSource === "user"
        ? t("approach.section.hero.speedUser", { vapp, flown: fmt(ref.flownVappKt, 0, "kt") })
        : ref.vappSource === "design"
          ? t("approach.section.hero.speedDesign", { vapp, source: vappSourceLabel(a) })
          : t("approach.section.hero.speedNoReference");

  const est = a.established;
  const e = a.energy;
  const outside = st.timeOutside.filter((x) => x.seconds > 0);
  const g = a.goAround;
  const simWind = simWindText(a.wind);
  const simWindComp = simWindComponentsText(a.wind);
  const energyBand = energyBandText(a);
  const automation = automationText(a);

  return (
    <section className="debrief-section approach-section">
      <h3>
        {title}
        {a.runway ? ` · RWY ${a.runway.ident}` : ""}
      </h3>
      <div className="approach-head">
        <p className="approach-sentence">{sentence}</p>
        <div className="approach-badges">
          {a.band ? (
            <ApproachBandBadge band={a.band} hardGateFt={a.config.hardGateFt} />
          ) : (
            <span className="approach-band muted">{t("approach.common.noBand", { height: fmt(1000, 0, "ft") })}</span>
          )}
          {isGa && <span className="approach-band ga">{t("approach.common.goAround")}</span>}
        </div>
        <AssessedWith profileId={a.config.profileId} className="approach-profile" />
      </div>

      <div className="hero-row approach-heroes">
        <Hero
          label={t("approach.section.hero.stableLabel")}
          labelTitle={t("approach.section.hero.stableTitle")}
          value={stableValue}
          unit={sf != null ? "ft" : undefined}
          source={src.stable}
          sub={`FAF ${gateMark(gate("faf"))} · 1000 ${gateMark(gate("ft1000"))} · 500 ${gateMark(gate("ft500"))}`}
        />
        <Hero
          label={t("approach.section.hero.glidepathLabel")}
          labelTitle={t("approach.section.hero.glidepathTitle")}
          value={gpValue}
          unit={gpUnit}
          source={src.glidepath}
          sub={
            <>
              <div>
                {[gpMax, st.gpRmsFt != null && st.gpRmsDots != null ? `RMS ${fmt(st.gpRmsFt, 0, "ft")}` : null].filter(Boolean).join(" · ") ||
                  t("approach.common.noRunwayNotMeasurable")}
              </div>
              <div>{glidepathLabel(ref)}</div>
            </>
          }
        />
        <Hero
          label={t("approach.section.hero.lateralLabel")}
          labelTitle={t("approach.section.hero.lateralTitle")}
          value={latValue}
          unit={latUnit}
          source={src.lateral}
          sub={
            <>
              <div className="hero-caption">{t("approach.section.hero.lateralCaption")}</div>
              <div>{lateralSubLine(a)}</div>
              {latRmsM && <div>{latRmsM}</div>}
            </>
          }
        />
        <Hero
          label={t("approach.section.hero.speedLabel")}
          labelTitle={t("approach.section.hero.speedTitle")}
          value={st.iasMadKt != null ? fmtNum(st.iasMadKt, 1) : "–"}
          unit="kt"
          source={src.speed}
          sub={
            <>
              {st.iasP95AbsDevKt != null ? (
                <div title={t("approach.section.hero.speedP95Title")}>
                  {t("approach.section.hero.speedP95", { p95: fmt(st.iasP95AbsDevKt, 0, "kt"), median: fmtSigned(st.iasMedianDevKt, 0, "kt") })}
                </div>
              ) : (
                <div>{t("approach.common.tooFewSamples")}</div>
              )}
              <div>{speedSub2}</div>
            </>
          }
        />
      </div>
      <p className="detail approach-hero-legend">{t("approach.section.explainer")}</p>

      <dl className="approach-facts">
        <dt>{t("approach.section.facts.established")}</dt>
        <dd className="num">
          {est
            ? `${fmt(est.distNm, 1, "nm")} · ${fmt(est.hatFt, 0, "ft")}`
            : a.runway
              ? t("approach.section.facts.notEstablished")
              : t("approach.section.facts.noRunwayUndetermined")}
        </dd>
        <dt>{t("approach.section.facts.lateral")}</dt>
        <dd className="num">{lateralFactText(a)}</dd>
        <dt>{t("approach.section.facts.configuration")}</dt>
        <dd className="num">{a.configEvents.length ? a.configEvents.map((c) => configEventText(t, c)).join(" · ") : t("approach.section.facts.noConfigChange")}</dd>
        <dt>{t("approach.section.facts.reference")}</dt>
        <dd className="num">
          {t("approach.section.facts.referenceLine", {
            glidepath: ref.glidepathSource === "ils" ? glidepathLabel(ref) : t("approach.section.facts.glidepathAssumed", { deg: fmt(ref.glidepathDeg, 1, "°") }),
            course: ref.localizerSource === "ils" ? t("approach.section.facts.courseIls") : t("approach.common.geometric"),
            tch: fmt(ref.tchFt, 0, "ft"),
            vapp,
            source: vappSourceLabel(a),
          })}
          {ref.landingFlapsIndex != null &&
            ` · ${t(ref.landingFlapsSource === "user" ? "approach.section.facts.landingFlapsUser" : "approach.section.facts.landingFlaps", { n: fmtNum(ref.landingFlapsIndex) })}`}
        </dd>
        {simWind && (
          <>
            <dt>{t("approach.section.facts.simWind")}</dt>
            <dd className="num">
              {simWind}
              {simWindComp && ` · ${simWindComp}`}
              <span className="detail"> · {t("approach.section.facts.simWindDetail", { top: fmtNum(a.config.windowTopFt), bottom: fmt(a.config.windowBottomFt, 0, "ft") })}</span>
            </dd>
          </>
        )}
        {e && (
          <>
            <dt>{t("approach.section.facts.energy")}</dt>
            <dd className="num">
              {fmt(10, 0, "nm")} {fmtSigned(e.atTenNm?.totalFt, 0, "ft")} · FAF {fmtSigned(e.atFaf?.totalFt, 0, "ft")} · {fmt(1000, 0, "ft")} {fmtSigned(e.at1000?.totalFt, 0, "ft")}
              {e.maxExcessFt != null && ` · ${t("approach.section.facts.energyMax", { excess: fmtSigned(e.maxExcessFt, 0, "ft"), height: fmt(e.maxExcessHatFt, 0, "ft") })}`}
            </dd>
          </>
        )}
        {energyBand && (
          <>
            <dt>{t("approach.section.facts.energyBand", { from: fmt(10, 0, "nm"), to: fmt(1000, 0, "ft") })}</dt>
            <dd className="num">{energyBand}</dd>
          </>
        )}
        {automation && (
          <>
            <dt>{t("approach.section.facts.automation")}</dt>
            <dd className="num">
              {automation}
              <span className="detail"> · {t("approach.section.facts.infoOnly")}</span>
            </dd>
          </>
        )}
        <dt>{t("approach.common.timeOutside")}</dt>
        <dd className="num">{outside.length ? outside.map((x) => `${CRITERION_LABEL[x.kind]} ${fmt(x.seconds, 0, "s")}`).join(" · ") : t("approach.common.none")}</dd>
      </dl>

      {isGa && g && (
        <dl className="approach-facts approach-lowest">
          <dt>{t("approach.section.goAround.lowest")}</dt>
          <dd className="num">
            {t(a.elevationSource === "database" ? "approach.section.goAround.lowestAboveAirport" : "approach.section.goAround.lowestAboveGround", {
              hat: fmt(g.lowestHatFt, 0, "ft"),
              msl: fmt(g.lowestMslFt, 0, "ft"),
            })}
            {g.lowestXM != null &&
              ` · ${t(g.lowestXM < 0 ? "approach.section.goAround.beforeThreshold" : "approach.section.goAround.pastThreshold", { dist: fmt(Math.abs(g.lowestXM) / 1852, 1, "nm") })}`}
          </dd>
          <dt>{t("approach.section.goAround.after")}</dt>
          <dd className="num">
            {t("approach.section.goAround.afterLine", {
              climb: fmtSigned(g.climbFt, 0, "ft"),
              window: fmt(a.config.gaWindowS, 0, "s"),
              ias: fmt(g.minIasKt, 0, "kt"),
              pitch: fmt(g.maxPitchDeg, 0, "°"),
            })}
          </dd>
          <dt>{t("approach.section.goAround.detectedBy")}</dt>
          <dd>{gaSourceText(t, g.detectedBy)}</dd>
        </dl>
      )}

      {a.exceedances.length > 0 ? (
        <table className="mini-table approach-exceedances">
          <thead>
            <tr>
              <th>{t("approach.section.exceedances.kind")}</th>
              <th>{t("approach.section.exceedances.level")}</th>
              <th>{t("approach.section.exceedances.height")}</th>
              <th>{t("approach.section.exceedances.duration")}</th>
              <th>{t("approach.section.exceedances.peak")}</th>
            </tr>
          </thead>
          <tbody>
            {a.exceedances.map((x, i) => (
              <tr key={i} className={x.level === "s2" ? "ex-s2" : "ex-s1"}>
                <td>
                  {CRITERION_LABEL[x.kind]}
                  {x.below500 && <span className="detail"> · {t("approach.section.exceedances.below", { height: fmt(a.config.hardGateFt ?? 500, 0, "ft") })}</span>}
                </td>
                <td className="num">{x.level.toUpperCase()}</td>
                <td className="num">{exceedanceRange(x)}</td>
                <td className="num">{x.kind === "flapChange" ? t("approach.section.exceedances.event") : fmt(x.durationS, 0, "s")}</td>
                <td className="num">
                  {x.kind === "flapChange" ? "–" : `${valueText(x.kind, x.peak)} (${valueText(x.kind, x.limit)})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        a.band != null && (
          <p className="detail approach-none">
            {t(isGa ? "approach.section.exceedances.noneGoAround" : "approach.section.exceedances.none", {
              top: fmtNum(a.config.windowTopFt),
              bottom: fmt(a.config.windowBottomFt, 0, "ft"),
            })}
          </p>
        )
      )}
      <ApproachCardActions a={a} flight={flight} />
    </section>
  );
}
