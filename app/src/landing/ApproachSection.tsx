import { useMemo } from "react";
import { NNBSP, fmt, fmtNum, fmtSigned } from "../format";
import type { ApproachAnalysis, ApproachBand, ConfigEvent, GoAroundSource, VappSource } from "./approachTypes";
import {
  APPROACH_BAND_LABEL,
  APPROACH_BAND_VAR,
  CRITERION_LABEL,
  approachKeySentence,
  approachProvenance,
  exceedanceRange,
  gateMark,
  lateralFactText,
  lateralSubLine,
  lateralUnmeasurableReason,
  valueText,
} from "./facts";
import { Hero } from "./Hero";

/** What the debrief knows about the approach of the shown landing. */
export type ApproachStatus = { kind: "loading" } | { kind: "error"; reason: string } | { kind: "ok"; approach: ApproachAnalysis };

export const VAPP_SOURCE_LABEL: Record<VappSource, string> = {
  // the pilot's value from the fleet (Flugzeuge → Vapp)
  user: "eingetragen",
  flown: "geflogener Median",
  unavailable: "nicht messbar",
};

const GA_SOURCE_LABEL: Record<GoAroundSource, string> = {
  track: "Track (Sinken → Steigen)",
  phase: "Phasen-Erkennung",
  both: "Track und Phasen-Erkennung",
};

/** Badge with the four-step band (ok / warn / err tokens). */
export function ApproachBandBadge({ band }: { band: ApproachBand }) {
  return (
    <span className="approach-band" style={{ borderColor: APPROACH_BAND_VAR[band], color: APPROACH_BAND_VAR[band] }}>
      <span className="band-dot" style={{ background: APPROACH_BAND_VAR[band] }} aria-hidden="true" />
      {APPROACH_BAND_LABEL[band]}
    </span>
  );
}

function configEventText(e: ConfigEvent): string {
  const at = fmt(e.hatFt, 0, "ft");
  switch (e.kind) {
    case "gearDown":
      return `Fahrwerk aus ${at}`;
    case "gearUp":
      return `Fahrwerk ein ${at}`;
    case "flaps":
      return `Klappen ${fmtNum(e.flapsFrom)}→${fmtNum(e.flapsTo)} ${at}`;
  }
}

/**
 * Section "Anflug": key sentence, band, four hero values (stable from, glidepath RMS, lateral
 * RMS on the extended centreline, speed spread), established point, lateral band, configuration events and the exceedances 1000 → 50 ft. For a
 * go-around also the lowest point.
 */
export default function ApproachSection({ status, title = "Anflug" }: { status: ApproachStatus; title?: string }) {
  if (status.kind === "loading") {
    return (
      <section className="debrief-section approach-section">
        <h3>{title}</h3>
        <p className="detail">Anflug wird ausgewertet …</p>
      </section>
    );
  }
  if (status.kind === "error") {
    return (
      <section className="debrief-section approach-section">
        <h3>{title}</h3>
        <p className="approach-error">
          <strong>Anflug nicht auswertbar</strong>
          <span className="detail"> – {status.reason}</span>
        </p>
      </section>
    );
  }
  return <ApproachBody a={status.approach} title={title} />;
}

function ApproachBody({ a, title }: { a: ApproachAnalysis; title: string }) {
  const sentence = useMemo(() => approachKeySentence(a), [a]);
  const src = useMemo(() => approachProvenance(a), [a]);
  const st = a.stability;
  const ref = a.reference;
  const gate = (k: "faf" | "ft1000" | "ft500") => a.gates.find((g) => g.kind === k) ?? null;
  const isGa = a.outcome.kind === "goAround";
  const sf = st.stableFromFt;
  const stableValue = sf != null ? fmt(sf, 0) : a.band == null ? "–" : "nie";

  const gpValue = st.gpRmsDots != null ? fmtNum(st.gpRmsDots, 2) : st.gpRmsFt != null ? fmt(st.gpRmsFt, 0) : "–";
  const gpUnit = st.gpRmsDots != null ? "Dots" : st.gpRmsFt != null ? "ft" : undefined;
  const gpMax =
    st.gpMaxAboveDots != null || st.gpMaxBelowDots != null
      ? `max. ${fmtSigned(st.gpMaxAboveDots ?? 0, 1)} / ${fmtSigned(st.gpMaxBelowDots ?? 0, 1)}${NNBSP}Dots`
      : null;

  // lateral guidance: dots, metres as the fallback; nothing with a derived runway / without one
  const latWhy = lateralUnmeasurableReason(a);
  const latShown = latWhy == null || latWhy === "zu wenige Samples";
  const latValue = !latShown ? "–" : st.locRmsDots != null ? fmtNum(st.locRmsDots, 2) : st.latRmsM != null ? fmt(st.latRmsM, 0) : "–";
  const latUnit = !latShown ? undefined : st.locRmsDots != null ? "Dots" : st.latRmsM != null ? "m" : undefined;
  const latRmsM = latShown && st.locRmsDots != null && st.latRmsM != null ? `RMS ${fmt(st.latRmsM, 0, "m")}` : null;

  const speedSub2 =
    ref.vappSource === "flown"
      ? `geflogene Referenz ≈ ${fmt(ref.vappKt, 0, "kt")} – misst die Stabilität, nicht den Absolutwert`
      : ref.vappSource === "user"
        ? `Vapp ${fmt(ref.vappKt, 0, "kt")} (eingetragen) · geflogen ${fmt(ref.flownVappKt, 0, "kt")}`
        : "keine Referenz-Geschwindigkeit messbar";

  const est = a.established;
  const e = a.energy;
  const outside = st.timeOutside.filter((t) => t.seconds > 0);
  const g = a.goAround;

  return (
    <section className="debrief-section approach-section">
      <h3>
        {title}
        {a.runway ? ` · RWY ${a.runway.ident}` : ""}
      </h3>
      <div className="approach-head">
        <p className="approach-sentence">{sentence}</p>
        <div className="approach-badges">
          {a.band ? <ApproachBandBadge band={a.band} /> : <span className="approach-band muted">kein Band (nie unter 1{NNBSP}000 ft)</span>}
          {isGa && <span className="approach-band ga">Durchstarten</span>}
        </div>
      </div>

      <div className="hero-row approach-heroes">
        <Hero
          label="Stabil ab"
          value={stableValue}
          unit={sf != null ? "ft" : undefined}
          source={src.stable}
          sub={`FAF ${gateMark(gate("faf"))} · 1000 ${gateMark(gate("ft1000"))} · 500 ${gateMark(gate("ft500"))}`}
        />
        <Hero
          label="Gleitpfad (RMS)"
          value={gpValue}
          unit={gpUnit}
          source={src.glidepath}
          sub={
            <>
              <div>{[gpMax, st.gpRmsFt != null && st.gpRmsDots != null ? `RMS ${fmt(st.gpRmsFt, 0, "ft")}` : null].filter(Boolean).join(" · ") || "ohne Piste nicht messbar"}</div>
              {ref.glidepathSource === "assumed" && <div>{fmt(ref.glidepathDeg, 0, "°")}-Annahme</div>}
            </>
          }
        />
        <Hero
          label="Grundlinie (RMS)"
          value={latValue}
          unit={latUnit}
          source={src.lateral}
          sub={
            <>
              <div>{lateralSubLine(a)}</div>
              {latRmsM && <div>{latRmsM}</div>}
            </>
          }
        />
        <Hero
          label="Speed (MAD)"
          value={st.iasMadKt != null ? fmtNum(st.iasMadKt, 1) : "–"}
          unit="kt"
          source={src.speed}
          sub={
            <>
              <div>
                {st.iasP95AbsDevKt != null ? `P95 ${fmt(st.iasP95AbsDevKt, 0, "kt")} · Median ${fmtSigned(st.iasMedianDevKt, 0, "kt")} zur Referenz` : "zu wenige Samples"}
              </div>
              <div>{speedSub2}</div>
            </>
          }
        />
      </div>

      <dl className="approach-facts">
        <dt>Eingedreht ab</dt>
        <dd className="num">{est ? `${fmt(est.distNm, 1, "nm")} · ${fmt(est.hatFt, 0, "ft")}` : a.runway ? "nicht stabil eingedreht" : "ohne Piste nicht bestimmbar"}</dd>
        <dt>Grundlinie</dt>
        <dd className="num">{lateralFactText(a)}</dd>
        <dt>Konfiguration</dt>
        <dd className="num">{a.configEvents.length ? a.configEvents.map(configEventText).join(" · ") : "keine Änderung im Anflug"}</dd>
        <dt>Referenz</dt>
        <dd className="num">
          {fmt(ref.glidepathDeg, 1, "°")} {ref.glidepathSource === "assumed" ? "(Annahme)" : ""} · Schwelle {fmt(ref.tchFt, 0, "ft")} · Vapp {fmt(ref.vappKt, 0, "kt")} ({VAPP_SOURCE_LABEL[ref.vappSource]})
        </dd>
        {e && (
          <>
            <dt>Energie zum Profil</dt>
            <dd className="num">
              10{NNBSP}nm {fmtSigned(e.atTenNm?.totalFt, 0, "ft")} · FAF {fmtSigned(e.atFaf?.totalFt, 0, "ft")} · 1000{NNBSP}ft {fmtSigned(e.at1000?.totalFt, 0, "ft")}
              {e.maxExcessFt != null && ` · max. ${fmtSigned(e.maxExcessFt, 0, "ft")} bei ${fmt(e.maxExcessHatFt, 0, "ft")}`}
            </dd>
          </>
        )}
        <dt>Zeit außerhalb Toleranz</dt>
        <dd className="num">{outside.length ? outside.map((t) => `${CRITERION_LABEL[t.kind]} ${fmt(t.seconds, 0, "s")}`).join(" · ") : "keine"}</dd>
      </dl>

      {isGa && g && (
        <dl className="approach-facts approach-lowest">
          <dt>Tiefster Punkt</dt>
          <dd className="num">
            {fmt(g.lowestHatFt, 0, "ft")} über {a.elevationSource === "database" ? "Platzhöhe" : "Grund"} ({fmt(g.lowestMslFt, 0, "ft")} MSL)
            {g.lowestXM != null && ` · ${fmt(Math.abs(g.lowestXM) / 1852, 1, "nm")} ${g.lowestXM < 0 ? "vor" : "hinter"} der Schwelle`}
          </dd>
          <dt>Danach</dt>
          <dd className="num">
            {fmtSigned(g.climbFt, 0, "ft")} in {fmt(a.config.gaWindowS, 0, "s")} · IAS min. {fmt(g.minIasKt, 0, "kt")} · Pitch max. {fmt(g.maxPitchDeg, 0, "°")}
          </dd>
          <dt>Erkannt über</dt>
          <dd>{GA_SOURCE_LABEL[g.detectedBy]}</dd>
        </dl>
      )}

      {a.exceedances.length > 0 ? (
        <table className="mini-table approach-exceedances">
          <thead>
            <tr>
              <th>Überschreitung</th>
              <th>Stufe</th>
              <th>Höhe</th>
              <th>Dauer</th>
              <th>Spitze (Grenze)</th>
            </tr>
          </thead>
          <tbody>
            {a.exceedances.map((x, i) => (
              <tr key={i} className={x.level === "s2" ? "ex-s2" : "ex-s1"}>
                <td>
                  {CRITERION_LABEL[x.kind]}
                  {x.below500 && <span className="detail"> · unter 500{NNBSP}ft</span>}
                </td>
                <td className="num">{x.level.toUpperCase()}</td>
                <td className="num">{exceedanceRange(x)}</td>
                <td className="num">{x.kind === "flapChange" ? "Ereignis" : fmt(x.durationS, 0, "s")}</td>
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
            Keine Überschreitung zwischen {fmtNum(a.config.windowTopFt)} und {fmt(a.config.windowBottomFt, 0, "ft")}
            {isGa ? " bzw. bis zum Durchstarten" : ""}.
          </p>
        )
      )}
    </section>
  );
}
