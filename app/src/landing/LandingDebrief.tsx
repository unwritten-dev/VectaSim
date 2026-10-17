import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NNBSP, fmt, fmtDateTime, fmtNum, fmtSigned, fmtWind } from "../format";
import { userMessage } from "../errors";
import TrackMap from "../map/TrackMap";
import Panel from "../ui/Panel";
import { KV } from "../ui/Stat";
import type { TrackSample } from "../types";
import ApproachChart from "./ApproachChart";
import RunwayDiagram from "./RunwayDiagram";
import StabilisedTable from "./StabilisedTable";
import { closeDebrief, useDebrief, type DebriefTarget } from "./debriefStore";
import {
  BAND_LABEL,
  BAND_VAR,
  G_BANDS,
  INDEX_LABEL,
  VS_BANDS,
  buildHints,
  indexFormulaLines,
  keySentence,
  landingIndex,
  provenance,
  sampleRateHz,
  windComponentsText,
  type Provenance,
} from "./facts";
import SourceChip from "../ui/SourceChip";
import { providerLabel } from "../status";
import { sideLabel } from "./geometry";
import type { Band, LandingDebriefData } from "./types";
import "./landing.css";

/** Full-window landing debrief for one touchdown; rendered once by App. */
export default function LandingDebrief() {
  const target = useDebrief();
  if (!target) return null;
  return <DebriefModal key={`${target.flightId}:${target.touchdownIndex}`} target={target} />;
}

function DebriefModal({ target }: { target: DebriefTarget }) {
  const [index, setIndex] = useState<number | null>(target.touchdownIndex);
  const [data, setData] = useState<LandingDebriefData | null>(null);
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    invoke<LandingDebriefData>("landing_analysis", { flightId: target.flightId, touchdownIndex: index })
      .then((d) => alive && setData(d))
      .catch((e) => {
        if (!alive) return;
        const raw = String(e);
        if (/keine Landung/i.test(raw)) setError({ title: raw });
        else {
          const m = userMessage(e, "logbook");
          setError({ title: m.title, hint: m.hint });
        }
      });
    return () => {
      alive = false;
    };
  }, [target.flightId, index]);

  // Esc closes, focus moves into the dialog and back to where it came from
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeDebrief();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, []);

  const shownIndex = data?.analysis.touchdownIndex ?? index ?? 0;
  const count = data?.touchdownCount ?? 0;
  return (
    <div className="debrief-overlay" role="dialog" aria-modal="true" aria-label="Landeauswertung">
      <div className="debrief">
        <div className="debrief-bar">
          <span className="debrief-kicker">Landeauswertung</span>
          {count > 1 && (
            <span className="debrief-pager" role="group" aria-label="Landung wählen">
              <button className="btn-sm" disabled={shownIndex <= 0} onClick={() => setIndex(shownIndex - 1)} aria-label="Vorherige Landung">
                ‹
              </button>
              <span className="detail num">
                Landung {shownIndex + 1} von {count}
              </span>
              <button className="btn-sm" disabled={shownIndex >= count - 1} onClick={() => setIndex(shownIndex + 1)} aria-label="Nächste Landung">
                ›
              </button>
            </span>
          )}
          <span className="spacer" />
          <button ref={closeRef} className="btn-sm" onClick={closeDebrief} title="Schließen (Esc)">
            Schließen
          </button>
        </div>
        {error ? (
          <div className="debrief-state">
            <strong>{error.title}</strong>
            {error.hint && <div className="detail">{error.hint}</div>}
          </div>
        ) : !data ? (
          <div className="debrief-state detail">Landung wird ausgewertet …</div>
        ) : (
          <DebriefBody d={data} />
        )}
      </div>
    </div>
  );
}


/** One hero value: label, big number with unit, provenance chip, one line of context. */
function Hero({
  label,
  value,
  unit,
  source,
  band,
  sub,
  size = "md",
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  source: Provenance;
  band?: Band | null;
  sub?: ReactNode;
  size?: "xl" | "md";
  title?: string;
}) {
  return (
    <div className={`hero hero-${size}`} title={title}>
      <div className="hero-label">
        <span>{label}</span>
        <SourceChip kind={source.kind} detail={source.detail} warn={source.warn} />
      </div>
      <div className="hero-value">
        {value}
        {unit && value !== "–" && <span className="unit">{unit}</span>}
      </div>
      {band && (
        <div className="hero-band">
          <span className="band-dot" style={{ background: BAND_VAR[band] }} aria-hidden="true" />
          {BAND_LABEL[band]}
        </div>
      )}
      {sub != null && <div className="hero-sub">{sub}</div>}
    </div>
  );
}

/** Small secondary value in the line under the heroes (no box). */
function Fact({ label, value, warn }: { label: string; value: ReactNode; warn?: string | null }) {
  return (
    <div className={`fact${warn ? " warn" : ""}`} title={warn ?? undefined}>
      <div className="fact-value">
        {warn && (
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
        )}
        {value}
      </div>
      <div className="fact-label">{label}</div>
    </div>
  );
}

function DebriefBody({ d }: { d: LandingDebriefData }) {
  const a = d.analysis;
  const td = a.touchdown;
  const rwy = a.runway;
  const tp = a.touchdownPoint;
  const f = d.flight;
  const hints = useMemo(() => buildHints(d), [d]);
  const sentence = useMemo(() => keySentence(d), [d]);
  const src = useMemo(() => provenance(d), [d]);
  const index = useMemo(() => landingIndex(a), [a]);
  const place = d.airport?.ident ?? rwy?.airport ?? null;
  const title = rwy ? `${rwy.airport} RWY ${rwy.ident}` : place ? `${place} · keine Runway zugeordnet` : "Landung ohne Flugplatz";
  const declaredLengthM = d.runwayData?.lengthFt ? d.runwayData.lengthFt * 0.3048 : rwy?.lengthM;
  const trackHz = sampleRateHz(a.samples);

  // the track map needs track samples; rebuild them from the approach points
  const mapSamples: TrackSample[] = useMemo(
    () =>
      a.samples.map((s) => ({
        tMs: s.tMs,
        latitude: s.latitude,
        longitude: s.longitude,
        altitudeMslFt: s.hatFt + (a.touchdownElevationFt ?? 0),
        altitudeAglFt: s.hatFt,
        groundSpeedKt: s.groundSpeedKt,
        iasKt: s.iasKt,
        verticalSpeedFpm: s.vsFpm,
        headingTrueDeg: 0,
        pitchDeg: s.pitchDeg,
        bankDeg: s.bankDeg,
        gForce: 1,
        onGround: s.onGround,
        flapsIndex: s.flapsIndex,
        gearPct: s.gearPct,
        fuelTotalKg: 0,
      })),
    [a.samples, a.touchdownElevationFt],
  );
  const tdList = useMemo(() => [td], [td]);

  const w = a.wind;
  const metarWind = d.metar?.wind ? fmtWind(d.metar.wind) : null;
  const ap = a.approach;
  const halfW = rwy ? rwy.widthM / 2 : null;
  const integrity = f.integrity;
  const flags = integrity
    ? [
        integrity.slewDetected && "Slew",
        integrity.timeAccelerationDetected && `Zeitraffer (max. ${fmt(integrity.maxSimRate, 0)}×)`,
        integrity.crashed && "Absturz",
        integrity.fuelIncreasedAirborne && "Treibstoff in der Luft erhöht",
        integrity.pauseCount > 0 && `${integrity.pauseCount}× Pause`,
      ].filter(Boolean)
    : [];

  return (
    <div className="debrief-body">
      <header className="debrief-head">
        <div>
          <h2 className="debrief-title">{title}</h2>
          <div className="detail">
            {[d.airport?.name, fmtDateTime(td.timestampMs), f.aircraft.title || "Unbekanntes Flugzeug", f.aircraft.atcId, f.callsign].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="debrief-wind">
          <div className="hero-label">Wind (METAR{d.metar ? ` ${d.metar.station}` : ""}{d.metar?.time ? ` ${d.metar.time}` : ""})</div>
          {d.metar ? (
            <>
              <div className={`debrief-wind-source${d.metarAtLanding ? "" : " is-current"}`}>
                {d.metarAtLanding ? "Wetter zum Zeitpunkt der Landung" : "aktuelles Wetter"}
              </div>
              <div className="debrief-wind-main num">{metarWind ?? "keine Windangabe"}</div>
              {w && <div className="detail num">{windComponentsText(a)}{w.relativeToRunway ? "" : " (zum Steuerkurs)"}</div>}
              {d.metarNote && <div className="detail">{d.metarNote}</div>}
            </>
          ) : (
            <div className="detail">{d.metarNote ?? "keine METAR"}</div>
          )}
        </div>
      </header>

      <p className="debrief-sentence">{sentence}</p>

      <div className="hero-row">
        <Hero
          size="xl"
          label="Landerate"
          value={fmt(td.landingRateFpm, 0)}
          unit="fpm"
          band={a.vsBand}
          source={src.rate}
          title={`Bänder: ${VS_BANDS}`}
          sub={td.landingRateSource === "sim" ? `Messwert ${fmt(td.vsFpmMeasured, 0, "fpm")} · letztes Sample in der Luft` : "Sim lieferte keinen Wert – Messwert"}
        />
        <Hero
          label="Aufsetzpunkt"
          value={tp ? fmt(tp.distanceM, 0) : "–"}
          unit="m"
          source={src.point}
          sub={tp ? `${tp.inTdz ? "in der Touchdown-Zone" : "außerhalb der Touchdown-Zone"} · ${sideLabel(tp.lateralM)}${sideLabel(tp.lateralM).startsWith("auf") ? "" : " der Mittellinie"}` : "keine Runway zugeordnet"}
        />
        <Hero label="G-Last" value={fmt(td.peakG, 2)} unit="G" band={a.gBand} source={src.g} title={`Bänder: ${G_BANDS}`} sub="Spitze 0,5 s nach dem Kontakt" />
      </div>

      <div className="fact-row">
        <Fact label={td.bounces ? `härtester Kontakt ${fmt(td.vsFpmHardest, 0, "fpm")}` : td.touchAndGo ? "Touch-and-go" : "Full Stop"} value={`${td.bounces} ${td.bounces === 1 ? "Bounce" : "Bounces"}`} warn={td.bounces ? "Bounce nach dem ersten Aufsetzen" : null} />
        <Fact
          label={rwy ? `Mittellinie · Runway ${fmt(rwy.widthM, 0, "m")} breit` : "Mittellinie"}
          value={tp ? sideLabel(tp.lateralM) : "–"}
          warn={tp && halfW != null && Math.abs(tp.lateralM) > halfW / 2 ? "Mehr als ein Viertel der Runway-Breite neben der Mittellinie" : null}
        />
        <Fact
          label={a.rollout ? `Rollout bis ${fmt(a.config.rolloutEndKt, 0, "kt")}${rwy && a.rollout.remainingM != null ? ` · Rest ${fmt(a.rollout.remainingM, 0, "m")}` : ""}` : "Rollout"}
          value={a.rollout ? fmt(a.rollout.distanceM, 0, "m") : td.touchAndGo ? "Touch-and-go" : "–"}
          warn={a.rollout?.remainingM != null && a.rollout.remainingM < 0 ? "Rollout endete hinter dem Runway-Ende" : null}
        />
        <div className="index-line" title="Zusammenfassung der Rohwerte – Formel unter „Methodik“">
          <span className="detail">VectaSim-Index</span> <strong className="num">{index.value}</strong>
          <span className="detail"> / 100 · Formel unter „Methodik“</span>
        </div>
      </div>

      <section className="debrief-section">
        <h3>{rwy ? `Runway ${rwy.ident} von oben` : "Aufsetzpunkt auf der Karte"}</h3>
        {rwy && tp ? (
          <RunwayDiagram analysis={a} />
        ) : (
          <>
            <p className="detail">
              Keine Runway zugeordnet: Im Umkreis von {fmt(a.config.matchLateralM / 1852, 0, "nm")} um den Aufsetzpunkt liegt keine Runway, deren Richtung bis auf ±
              {fmtNum(a.config.matchHeadingDeg)}° zum Steuerkurs passt. Aufsetzpunkt, Abweichung von der Mittellinie und Gleitpfad entfallen.
            </p>
            {mapSamples.length > 1 && <TrackMap samples={mapSamples} touchdowns={tdList} />}
          </>
        )}
      </section>

      <section className="debrief-section">
        <h3>Anflugprofil</h3>
        <ApproachChart analysis={a} />
      </section>

      <section className="debrief-section">
        <h3>Hinweise</h3>
        <ul className="hints">
          {hints.map((h, i) => (
            <li key={i} className={`hint hint-${h.tone}`}>
              <span className="hint-icon" aria-hidden="true">
                {h.tone === "ok" ? "✓" : h.tone === "warn" ? "▲" : "i"}
              </span>
              {h.text}
            </li>
          ))}
        </ul>
      </section>

      <Panel title="Stabilisierter Anflug" collapsible defaultOpen={false} level={3} className="debrief-fold">
        <StabilisedTable gates={a.gates} />
        <p className="detail sa-note">Ohne bekannte Vref dient die IAS bei 500{NNBSP}ft als Bezug für die Geschwindigkeit.</p>
      </Panel>

      <Panel title="Abfangen & Rollout" collapsible defaultOpen={false} level={3} className="debrief-fold">
        <KV
          rows={[
            ["Abfangen ab", a.flare ? fmt(a.flare.startHatFt, 0, "ft") : "nicht erkennbar"],
            ["Dauer bis Aufsetzen", a.flare ? fmt(a.flare.durationS, 0, "s") : "–"],
            ["Sinkrate vor / nach Abfangen", a.flare ? `${fmt(a.flare.approachVsFpm, 0)} / ${fmt(a.flare.finalVsFpm, 0, "fpm")}` : "–"],
            ["Schwellenüberflug", a.threshold ? `${fmt(a.threshold.heightFt, 0, "ft")} · ${fmt(a.threshold.iasKt, 0, "kt")}` : "–"],
            ["Zeit Schwelle → Aufsetzen", a.threshold ? fmt(a.threshold.airborneS, 0, "s") : "–"],
            ["IAS min / max", `${fmt(ap.iasMinKt, 0)} / ${fmt(ap.iasMaxKt, 0, "kt")}`],
            ["IAS bei 500 ft / 50 ft / Aufsetzen", `${fmt(ap.iasAt500Kt, 0)} / ${fmt(ap.iasAt50Kt, 0)} / ${fmt(ap.iasAtTouchdownKt, 0, "kt")}`],
            ["V/S unter 1000 ft", `${fmt(ap.vsMin1000Fpm, 0)} … ${fmt(ap.vsMax1000Fpm, 0, "fpm")}`],
            ["V/S unter 500 ft", `${fmt(ap.vsMin500Fpm, 0)} … ${fmt(ap.vsMax500Fpm, 0, "fpm")}`],
            ["Querneigung max. unter 500 ft", fmt(ap.bankMaxBelow500Deg, 0, "°")],
            [
              "Gleitpfad max. über / unter",
              rwy ? `${fmtSigned(ap.glidepathDevMaxAboveDeg ?? 0, 1, "°")} / ${fmtSigned(ap.glidepathDevMaxBelowDeg ?? 0, 1, "°")}` : "ohne Runway n. v.",
            ],
            ["Pitch / Bank beim Aufsetzen", `${fmt(td.pitchDeg, 1, "°")} / ${fmt(td.bankDeg, 1, "°")}`],
            ["GS beim Aufsetzen", fmt(td.groundSpeedKt, 0, "kt")],
            ["Rollout", a.rollout ? `${fmt(a.rollout.distanceM, 0, "m")} in ${fmt(a.rollout.durationS, 0, "s")}` : "–"],
            ["Runway (Datenbank)", rwy ? `${fmt(declaredLengthM, 0, "m")} × ${fmt(rwy.widthM, 0, "m")}` : "–"],
          ]}
        />
      </Panel>

      <Panel title="Methodik" collapsible defaultOpen={false} level={3} className="debrief-fold debrief-method">
        <ul className="method">
          <li>
            <strong>Landerate:</strong> Wert des Simulators (PLANE TOUCHDOWN NORMAL VELOCITY, ×60 in fpm, negativ = sinkend). Liefert der Sim weniger als 1 fpm (z. B.
            abseits registrierter Runways), gilt die Vertikalgeschwindigkeit des letzten Samples in der Luft. Bei Bounces zählt der härteste Kontakt dieses
            Landeereignisses, nie ein Spitzenwert über den ganzen Flug. Die Flug-Landerate im Logbuch ist die letzte Landung mit Full Stop.
          </li>
          <li>
            <strong>Messwert:</strong> letztes Sample vor dem Bodenkontakt aus dem Telemetriestrom (rund 20 Hz). Weil V/S am Boden bedeutungslos ist und auch 20 Hz den
            Kontaktmoment verfehlen können, weicht er vom Sim-Wert ab. „Am Boden“ zählt nur, wenn die Höhe über Grund höchstens 50 ft beträgt; die Landung gilt erst
            nach drei aufeinanderfolgenden Boden-Samples (≥ 2 s) als bestätigt.
          </li>
          <li>
            <strong>G-Last:</strong> höchster Lastfaktor in der halben Sekunde nach jedem Kontakt; unplausible Werte (über 5 G, negativ) werden verworfen.
          </li>
          <li>
            <strong>Track:</strong> Anflug, Abfangen und Rollout stammen aus dem gespeicherten Track mit 1 Sample pro Sekunde. Höhen sind „über Aufsetzpunkt“: Höhe MSL minus
            MSL des ersten Boden-Samples – unabhängig von Gelände unter dem Anflug und von der Flugplatzhöhe in der Datenbank. Der Anflug beginnt beim letzten Sinken
            durch 1000 ft, sonst 3 nm vor dem Aufsetzen.
          </li>
          <li>
            <strong>Runway:</strong> OurAirports (Public Domain); Schwellen-Koordinaten beider Enden, Breite aus der Datenbank. Zugeordnet wird die nächste Runway innerhalb{" "}
            {fmt(a.config.matchLateralM / 1852, 0, "nm")}, deren Richtung bis auf ±{fmtNum(a.config.matchHeadingDeg)}° zum Steuerkurs beim Aufsetzen passt. Versetzte
            Schwellen sind nicht berücksichtigt. Touchdown-Zone: {fmtNum(a.config.tdzStartM)}–{fmt(a.config.tdzEndM, 0, "m")} hinter der Schwelle, auf Runways unter{" "}
            {fmt(a.config.tdzEndM * 3, 0, "m")} das erste Drittel.
          </li>
          <li>
            <strong>Gleitpfad:</strong> Winkel vom Aufsetzpunkt der {fmt(a.config.glidepathDeg, 0, "°")}-Referenz ({fmt(a.config.tchFt, 0, "ft")} über der Schwelle) zum
            Flugzeug, erst ab 0,25 nm davor. Toleranz ±{fmtNum(a.config.glidepathToleranceDeg, 1)}°. Ohne zugeordnete Runway entfällt er.
          </li>
          <li>
            <strong>Stabilisierter Anflug</strong> bei 1000 ft und 500 ft (interpoliert): Fahrwerk unten, Klappen gesetzt, |V/S| ≤ {fmt(a.config.maxVsFpm, 0, "fpm")},
            IAS {fmtSigned(-a.config.speedBelowKt, 0)}/{fmtSigned(a.config.speedAboveKt, 0, "kt")} zur IAS bei 500 ft (Ersatz für die unbekannte Vref), Gleitpfad, Querneigung
            ≤ {fmt(a.config.maxBankDeg, 0, "°")}.
          </li>
          <li>
            <strong>Abfangen:</strong> ab dem Sample, nach dem die Sinkrate bis zum Aufsetzen unter {fmtNum(a.config.flareVsFraction * 100)}{NNBSP}% der mittleren Anflug-Sinkrate
            (500–200 ft) blieb; Auflösung 1 s. <strong>Rollout:</strong> vom Aufsetzen bis GS unter {fmt(a.config.rolloutEndKt, 0, "kt")}.
          </li>
          <li>
            <strong>Wind:</strong> METAR des Flugplatzes zum Zeitpunkt der Landung (bei der Landung gespeichert), sonst die aktuelle – ohne eigene METAR die der nächsten
            Station im Umkreis von 25 nm (aviationweather.gov bzw. VATSIM), nur für Landungen der letzten 2 Stunden. Gegen-/Seitenwind sind auf die Runway-Richtung
            (rechtweisend) bezogen.
          </li>
          <li>Bänder: Landerate {VS_BANDS}; G-Last {G_BANDS}.</li>
          <li>
            <strong>VectaSim-Index</strong> (klein unter den Rohwerten, nie als Urteil gedacht):
            <ul className="method-sub">
              {indexFormulaLines().map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <div className="index-parts num">
              Diese Landung:{" "}
              {index.parts
                .map((p) => `${INDEX_LABEL[p.key]} ${p.points == null ? "entfällt" : `${fmtNum(p.points, 2)} × ${p.weight}`}`)
                .join(" · ")}{" "}
              → {index.value}
            </div>
          </li>
        </ul>
      </Panel>

      <Panel title="Messprotokoll" collapsible defaultOpen={false} level={3} className="debrief-fold debrief-protocol">
        <KV
          rows={[
            ["Simulator", `${providerLabel(f.provider)}${f.simName ? ` · ${f.simName}` : ""}`],
            ["Abtastrate", `Telemetrie rund 20 Hz (Landeerkennung) · gespeicherter Track ${trackHz != null ? fmt(trackHz, trackHz < 2 ? 1 : 0, "Hz") : "–"} (${fmtNum(a.samples.length)} Samples im Anflug)`],
            ["Landerate", td.landingRateSource === "sim" ? `Sim-Wert (PLANE TOUCHDOWN NORMAL VELOCITY) ${fmt(td.vsFpmSim, 0, "fpm")} · Messwert ${fmt(td.vsFpmMeasured, 0, "fpm")}` : `Messwert ${fmt(td.vsFpmMeasured, 0, "fpm")} (Sim lieferte keinen Wert)`],
            ["Runway-Daten", rwy ? `OurAirports (Public Domain) · RWY ${rwy.ident}/${rwy.oppositeIdent}, ${rwy.surface || "Belag unbekannt"}, Richtung ±${fmt(rwy.headingDiffDeg, 0, "°")} zum Steuerkurs` : "keine Runway zugeordnet"],
            ["Wind", d.metar ? `METAR ${d.metar.station}${d.metar.time ? ` ${d.metar.time}` : ""} · ${d.metarAtLanding ? "bei der Landung gespeichert" : "aktuell (Näherung)"}` : d.metarNote ?? "keine METAR"],
            ["Anflugbeginn", ap.startReason === "altitude" ? `letztes Sinken durch ${fmtNum(a.config.approachStartFt)} ft` : ap.startReason === "distance" ? `${fmt(a.config.approachFallbackM / 1852, 0, "nm")} vor dem Aufsetzen` : ap.startReason === "trackStart" ? "Beginn des Tracks" : "–"],
            ["Integrität", flags.length ? flags.join(" · ") : "keine Auffälligkeiten (kein Slew, kein Zeitraffer, keine Pause)"],
            ["Schwellwerte", `TDZ ${fmtNum(a.config.tdzStartM)}–${fmt(a.config.tdzEndM, 0, "m")} · Gleitpfad ${fmt(a.config.glidepathDeg, 1, "°")} ±${fmtNum(a.config.glidepathToleranceDeg, 1)}° · |V/S| ≤ ${fmt(a.config.maxVsFpm, 0, "fpm")} · Bank ≤ ${fmt(a.config.maxBankDeg, 0, "°")}`],
          ]}
        />
      </Panel>
    </div>
  );
}
