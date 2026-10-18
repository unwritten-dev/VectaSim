import { useMemo } from "react";
import { airframeName, shownAirframeName } from "../airframes/airframe";
import { useAirframes } from "../airframes/hooks";
import { usePrefs, usePrivacy } from "../prefs";
import type { RecStatus } from "../status";
import { DEMO_LABEL, providerLabel } from "../status";
import type { AircraftInfo, Ofp, StatusSnapshot } from "../types";

interface Props {
  rec: RecStatus;
  status: StatusSnapshot | null;
  ofp: Ofp | null;
  aircraft: AircraftInfo | null;
  /** Open the side panel on the Dispatch tab. */
  onOpenDispatch: () => void;
  onTryDemo?: () => void;
  onDismiss: () => void;
}

/**
 * "Bereit" card on the map before a flight: what VectaSim is connected to, which plan it
 * will attach and which aircraft it expects – so the pilot sees in one glance that the
 * recording will start by itself. Disappears once the flight is active.
 */
export default function ReadyCard({ rec, status, ofp, aircraft, onOpenDispatch, onTryDemo, onDismiss }: Props) {
  const { showDemo } = usePrefs();
  const priv = usePrivacy();
  const { rows } = useAirframes(showDemo);
  const last = useMemo(() => {
    const flown = (rows ?? []).filter((r) => r.lastFlownMs != null);
    flown.sort((a, b) => (b.lastFlownMs ?? 0) - (a.lastFlownMs ?? 0));
    return flown[0] ?? null;
  }, [rows]);

  const sim =
    rec.kind === "ready" || rec.kind === "recording"
      ? `${status?.simName ?? providerLabel(status?.provider)}${status?.simVersion ? ` ${status.simVersion}` : ""} verbunden`
      : rec.kind === "demo"
        ? "Demo-Flug · simulierte Daten"
        : // the kicker already says "Warte auf Simulator"
          "MSFS noch nicht verbunden";
  const known = aircraft ? { registration: aircraft.atcId, airline: aircraft.atcAirline, callsign: ofp?.callsign } : {};
  const aircraftText = aircraft ? [priv.title(aircraft.title, known), priv.mask(aircraft.atcId, "registration")].filter(Boolean).join(" · ") : null;

  return (
    <section className={`after-flight ready-card ready-${rec.kind}`} aria-label="Bereit">
      <div className="after-head">
        <span className={`dot dot-${rec.error ? "error" : rec.kind}`} aria-hidden="true" />
        <span className="kicker">{rec.label}</span>
        <span className="spacer" />
        <button className="btn-ghost after-close" onClick={onDismiss} aria-label="Karte ausblenden" title="Ausblenden">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <dl className="ready-rows">
        <dt>Simulator</dt>
        <dd>
          <span>{sim}</span>
          {rec.kind === "waiting" && onTryDemo && (
            <button className="link-btn" onClick={onTryDemo} title="Ohne Simulator ausprobieren – ein simulierter Flug">
              {DEMO_LABEL} starten
            </button>
          )}
        </dd>
        <dt>Flugplan</dt>
        <dd>
          {ofp ? (
            <span className="num">
              {priv.mask(ofp.callsign, "callsign")} · {ofp.originIcao} → {ofp.destinationIcao}
            </span>
          ) : (
            <span className="detail">kein SimBrief-Flugplan</span>
          )}
          <button className="link-btn" onClick={onOpenDispatch}>
            {ofp ? "Dispatch" : "laden"}
          </button>
        </dd>
        <dt>Flugzeug</dt>
        <dd>
          {aircraftText ? (
            <span>{aircraftText}</span>
          ) : last ? (
            <span>
              <span className="detail">zuletzt </span>
              <strong className="num">{priv.mask(last.registration, "registration")}</strong>
              {airframeName(last) !== last.registration && <span className="detail"> · {shownAirframeName(last, priv.on)}</span>}
            </span>
          ) : (
            <span className="detail">wird beim Verbinden erkannt</span>
          )}
        </dd>
      </dl>
      <div className="detail ready-hint">{rec.hint}</div>
    </section>
  );
}
