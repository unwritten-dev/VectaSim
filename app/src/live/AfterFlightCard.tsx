import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fmt, fmtClock, fmtDuration } from "../i18n/number";
import { useT } from "../i18n";
import { BAND_LABEL, BAND_VAR, vsBandOf, zonePhrase } from "../landing/facts";
import type { LandingDebriefData } from "../landing/types";
import { saveCardPng } from "../landing/exportCard";
import { HistoryLine } from "../landing/HistoryPanel";
import { userMessage } from "../errors";
import { showToast } from "../ui/Toast";

/** The flight that just ended (on-block); shown on the map until the next off-block. */
export interface AfterFlight {
  flightId: string;
  depIcao?: string | null;
  arrIcao?: string | null;
  landingRateFpm?: number | null;
  blockMs: number | null;
  onBlockMs: number;
}

interface Props {
  flight: AfterFlight;
  onDebrief: () => void;
  onLogbook: () => void;
  onDismiss: () => void;
}

/**
 * "Nach dem Flug": landing rate, block time and where the aircraft touched down, so a
 * pilot who comes back from the sim minutes later still sees how the flight ended.
 */
export default function AfterFlightCard({ flight, onDebrief, onLogbook, onDismiss }: Props) {
  const t = useT();
  const [place, setPlace] = useState<string | null>(null);
  /** The analysis behind the place line; reused for the landing card PNG. */
  const [data, setData] = useState<LandingDebriefData | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setPlace(null);
    setData(null);
    if (flight.landingRateFpm == null) return;
    invoke<LandingDebriefData>("landing_analysis", { flightId: flight.flightId, touchdownIndex: null })
      .then((d) => {
        if (!alive) return;
        setData(d);
        const rwy = d.analysis.runway;
        const zone = zonePhrase(d.analysis);
        setPlace([rwy ? `RWY ${rwy.ident}` : null, zone].filter(Boolean).join(" · ") || null);
      })
      // the card works without it: runway and zone are an extra line
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [flight.flightId, flight.landingRateFpm]);

  const saveCard = async () => {
    setSaving(true);
    try {
      const d = data ?? (await invoke<LandingDebriefData>("landing_analysis", { flightId: flight.flightId, touchdownIndex: null }));
      await saveCardPng(d);
    } catch (e) {
      showToast({ id: "card-export", tone: "warn", title: t("live.after.cardFailed"), body: userMessage(e, "export").hint });
    } finally {
      setSaving(false);
    }
  };

  const rate = flight.landingRateFpm;
  const band = rate != null ? vsBandOf(rate) : null;
  return (
    <section className="after-flight" aria-label={t("live.after.title")}>
      <div className="after-head">
        <span className="kicker">{t("live.after.title")}</span>
        <span className="detail">{t("live.after.saved", { time: fmtClock(flight.onBlockMs) })}</span>
        <span className="spacer" />
        <button className="btn-ghost after-close" onClick={onDismiss} aria-label={t("live.card.hide")} title={t("live.card.hideTitle")}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="after-route icao">
        {flight.depIcao ?? "····"} → {flight.arrIcao ?? "····"}
        {place && <span className="detail after-place">{place}</span>}
      </div>
      <div className="after-values">
        <div>
          <div className="after-label">{t("live.after.landingRate")}</div>
          <div className="after-value">
            {rate != null ? fmt(rate, 0) : "–"}
            {rate != null && <span className="unit">fpm</span>}
          </div>
          {band && (
            <div className="after-band">
              <span className="band-dot" style={{ background: BAND_VAR[band] }} aria-hidden="true" />
              {BAND_LABEL[band]}
            </div>
          )}
        </div>
        <div>
          <div className="after-label">{t("live.after.blockTime")}</div>
          <div className="after-value">{fmtDuration(flight.blockMs, { seconds: false })}</div>
        </div>
      </div>
      {/* "besser als 70 % deiner letzten 20 Landungen auf EDDF 25C" – nothing without history */}
      {rate != null && <HistoryLine flightId={flight.flightId} />}
      <div className="after-actions">
        <button className="btn-primary" onClick={onDebrief} disabled={rate == null} title={rate == null ? t("live.after.noLanding") : undefined}>
          {t("live.after.debrief")}
        </button>
        <button onClick={() => void saveCard()} disabled={rate == null || saving} title={rate == null ? t("live.after.noLanding") : t("live.after.saveCardTitle")}>
          {saving ? t("live.after.saving") : t("live.after.card")}
        </button>
        <button onClick={onLogbook}>{t("live.after.logbook")}</button>
      </div>
    </section>
  );
}
