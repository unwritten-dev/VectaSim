import { useEffect, useState } from "react";
import LiveMap from "../map/LiveMap";
import Dispatch from "../Dispatch";
import OnlinePanel from "../OnlinePanel";
import {
  PHASE_LABEL,
  deltaMinutes,
  fmt,
  fmtAltitude,
  fmtClock,
  fmtCoord,
  fmtDeltaKg,
  fmtDeltaMin,
  fmtDuration,
  fmtMetarLine,
  fmtNum,
  fmtSigned,
  haversineNm,
} from "../format";
import { userMessage } from "../errors";
import { CATEGORY_COLOR } from "../theme";
import type { AircraftInfo, FlightPhase, FlightSummary, Metar, OnlineSummary, OnlineView, Ofp, Telemetry } from "../types";
import Stat, { KV } from "../ui/Stat";
import { TabPanel, Tabs } from "../ui/Tabs";
import { Chevron } from "../ui/Panel";
import EmptyState from "../ui/EmptyState";
import { ToastViewport } from "../ui/Toast";
import { useAirport, useMetar, useNearestIcao, useStoredState } from "./hooks";
import { etaMs, remainingNm } from "./progress";
import AirframeImage from "../airframes/AirframeImage";
import { airframeName } from "../airframes/airframe";
import { useActiveAirframe } from "../airframes/hooks";
import { navigate } from "../airframes/navigation";
import type { RecStatus } from "../status";
import AfterFlightCard, { type AfterFlight } from "./AfterFlightCard";
import { openDebrief } from "../landing/debriefStore";

export interface LogLine {
  ms: number;
  text: string;
}

interface Props {
  telemetry: Telemetry | null;
  flight: FlightSummary | null;
  aircraft: AircraftInfo | null;
  ofp: Ofp | null;
  onOfp: (ofp: Ofp | null) => void;
  online: OnlineSummary | null;
  events: LogLine[];
  /** Open the logbook detail of the running/last flight. */
  onOpenFlight?: () => void;
  /** Recording status for the pill on the map (same texts as the sidebar button). */
  rec: RecStatus;
  /** The flight that just ended (from on-block until the next off-block). */
  afterFlight?: AfterFlight | null;
  onAfterFlightLogbook?: (flightId: string) => void;
  onAfterFlightDismiss?: () => void;
  /** Start the demo flight (only offered while waiting for the simulator). */
  onTryDemo?: () => void;
}

type Tab = "flight" | "plan" | "systems" | "online" | "events";

/** From top of descent on, the destination weather is what matters. */
const PAST_TOD: FlightPhase[] = ["descent", "approach", "final", "landing", "taxiIn", "shutdown"];
const DEST_WX_RANGE_NM = 100;

const LIGHT_LABEL: Array<[keyof Telemetry["lights"], string]> = [
  ["beacon", "Beacon"],
  ["nav", "Positionslicht"],
  ["strobe", "Strobe"],
  ["landing", "Landelicht"],
  ["taxi", "Rolllicht"],
];

const PANEL_KEY = "vectasim.livePanel";
const TAB_KEY = "vectasim.liveTab";

/**
 * Live view: the map fills the content area, the six primary values sit
 * in a bar over the map, everything else is in a collapsible side panel (Ctrl+.).
 */
export default function LiveView({
  telemetry: t,
  flight: f,
  aircraft,
  ofp,
  onOfp,
  online,
  events,
  onOpenFlight,
  rec,
  afterFlight,
  onAfterFlightLogbook,
  onAfterFlightDismiss,
  onTryDemo,
}: Props) {
  const [panelOpen, setPanelOpen] = useStoredState<boolean>(PANEL_KEY, true);
  const [tab, setTab] = useStoredState<Tab>(TAB_KEY, "flight");
  const [onlineView, setOnlineView] = useState<{ view: OnlineView | null; center: { lat: number; lon: number } } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ".") {
        e.preventDefault();
        setPanelOpen(!panelOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, setPanelOpen]);

  // ---- airports, destination, weather ----------------------------------------------
  const depIcao = useNearestIcao(f?.departure);
  const arrIcao = useNearestIcao(f?.arrival);
  // Before a flight starts there is no departure point yet: use the airport we stand on.
  // Rounded to ~1 km so taxiing doesn't trigger a lookup per frame.
  const groundPoint =
    t?.onGround && f?.state !== "active" ? { latitude: Math.round(t.latitude * 100) / 100, longitude: Math.round(t.longitude * 100) / 100 } : null;
  const groundIcao = useNearestIcao(groundPoint);

  const destIcao = (ofp?.destinationIcao || arrIcao) ?? null;
  const destAirport = useAirport(destIcao);
  const pos = t ? { latitude: t.latitude, longitude: t.longitude } : null;
  const directNm = destAirport && t ? haversineNm(t.latitude, t.longitude, destAirport.latitude, destAirport.longitude) : null;
  const routeForDest = ofp && ofp.destinationIcao === destIcao ? ofp.navlog : null;
  const restNm = remainingNm(pos, destAirport, routeForDest);
  const landed = !!f?.landingMs;
  const eta = landed ? null : etaMs(Date.now(), restNm, t?.groundSpeedKt);

  const useDest = !!destIcao && (PAST_TOD.includes(f?.phase ?? "preflight") || (directNm != null && directNm < DEST_WX_RANGE_NM));
  const depOrGround = depIcao ?? (ofp?.originIcao || null) ?? groundIcao;
  // departure weather until takeoff, then the destination's (if known), else stay on departure
  const wxIcao = useDest || (f?.takeoffMs && destIcao) ? destIcao : depOrGround;
  const { metar: wx, error: wxError } = useMetar(wxIcao);

  // ---- derived values --------------------------------------------------------------
  const vs = t?.verticalSpeedFpm ?? 0;
  const vsWarn = !t
    ? null
    : vs > 4000
      ? "Steigrate über 4 000 fpm"
      : vs < -1000 && !t.onGround && t.altitudeAglFt < 2500
        ? "Sinkrate über 1 000 fpm unter 2 500 ft AGL"
        : null;
  const phase = f?.phase ?? "preflight";
  const routeText = `${depIcao ?? (f?.departure ? "····" : (ofp?.originIcao || "–"))} → ${arrIcao ?? (ofp?.destinationIcao || (f?.arrival ? "····" : "–"))}`;
  const callsign = ofp?.callsign || (aircraft ? `${aircraft.atcAirline} ${aircraft.atcFlightNumber}`.trim() || aircraft.atcId : "");
  const altSub = !t ? undefined : !t.onGround && t.altitudeAglFt < 2500 ? `AGL ${fmt(t.altitudeAglFt, 0, "ft")}` : t.altitudeMslFt >= 18000 ? fmtAltitude(t.altitudeMslFt) : undefined;
  const restSub = landed
    ? "gelandet"
    : !destIcao
      ? "Ziel unbekannt"
      : eta
        ? `ETA ${fmtClock(eta)} · ${fmtDuration(eta - Date.now(), { seconds: false })}`
        : "ETA ab 50 kt GS";

  const tabs: Array<{ id: Tab; label: string; badge?: string }> = [
    { id: "flight", label: "Flug" },
    { id: "plan", label: "Flugplan", badge: ofp ? "●" : undefined },
    { id: "systems", label: "Systeme" },
    { id: "online", label: "Online" },
    { id: "events", label: "Ereignisse", badge: events.length ? String(events.length) : undefined },
  ];

  return (
    <section className={`live${panelOpen ? " panel-open" : ""}`}>
      <div className="live-map-area">
        <LiveMap
          telemetry={t}
          aircraft={aircraft}
          route={ofp?.navlog}
          trafficOn={online?.enabled ?? false}
          onOnlineView={(v, center) => setOnlineView({ view: v, center })}
          overlay={<StatusPill rec={rec} onTryDemo={onTryDemo} />}
        />
        <ToastViewport regions={["map"]} placement="top" />
        {afterFlight && f?.state !== "active" && (
          <AfterFlightCard
            flight={afterFlight}
            onDebrief={() => openDebrief(afterFlight.flightId, null)}
            onLogbook={() => onAfterFlightLogbook?.(afterFlight.flightId)}
            onDismiss={() => onAfterFlightDismiss?.()}
          />
        )}

        <button
          className="side-handle"
          onClick={() => setPanelOpen(!panelOpen)}
          aria-expanded={panelOpen}
          aria-controls="live-side"
          aria-label={panelOpen ? "Seitenpanel einklappen" : "Seitenpanel ausklappen"}
          title={`${panelOpen ? "Seitenpanel einklappen" : "Seitenpanel ausklappen"} (Strg+.)`}
        >
          <Chevron dir={panelOpen ? "right" : "left"} />
        </button>

        <div className="hud" aria-label="Flugdaten">
          <div className="hud-values">
            <div className="stat stat-lg hud-phase">
              <div className="stat-label">Phase</div>
              <div className={`stat-value phase-${phase}`} aria-live="polite">
                {PHASE_LABEL[phase]}
              </div>
              <div className="stat-sub">{f?.state === "active" ? "Aufzeichnung" : f?.state === "completed" ? "gespeichert" : "Bereit"}</div>
            </div>
            <Stat size="lg" label="Höhe MSL" value={t ? fmtNum(t.altitudeMslFt) : "–"} unit="ft" sub={altSub} />
            <Stat size="lg" label="GS / IAS" value={t ? fmtNum(t.groundSpeedKt) : "–"} unit="kt" sub={t ? `IAS ${fmt(t.iasKt, 0, "kt")}` : undefined} />
            <Stat size="lg" label="V/S" value={t ? fmtSigned(Math.round(vs)) : "–"} unit="fpm" warn={vsWarn} />
            <Stat size="lg" label="HDG" value={t ? String(Math.round(t.headingMagDeg) % 360 || 360).padStart(3, "0") : "–"} unit="°" sub="magnetisch" />
            <Stat
              size="lg"
              label={destIcao ? `Rest bis ${destIcao}` : "Rest"}
              value={restNm != null && !landed ? fmtNum(restNm) : "–"}
              unit="nm"
              sub={restSub}
              title={!destIcao ? "Lade einen SimBrief-Flugplan, um Restdistanz und ETA zu sehen." : routeForDest ? "Entlang der geplanten Route" : "Großkreis-Distanz"}
            />
          </div>
          <div className="hud-foot">
            <strong className="route">{routeText}</strong>
            {callsign && <span>{callsign}</span>}
            {wxIcao && <MetarInline icao={wxIcao} metar={wx} error={wxError} />}
          </div>
        </div>
      </div>

      <aside id="live-side" className="side-panel" hidden={!panelOpen} aria-label="Flugdetails">
        <div className="side-head">
          <Tabs tabs={tabs} active={tab} onChange={setTab} idBase="live" label="Flugdetails" />
        </div>
        <div className="side-body">
          {tab === "flight" && (
            <TabPanel idBase="live" id="flight">
              <FlightSection t={t} f={f} aircraft={aircraft} ofp={ofp} routeText={routeText} wxIcao={wxIcao} wx={wx} wxError={wxError} onOpenFlight={onOpenFlight} />
            </TabPanel>
          )}
          {tab === "plan" && (
            <TabPanel idBase="live" id="plan">
              <Dispatch ofp={ofp} onOfp={onOfp} />
            </TabPanel>
          )}
          {tab === "systems" && (
            <TabPanel idBase="live" id="systems">
              <SystemsSection t={t} f={f} ofp={ofp} />
            </TabPanel>
          )}
          {tab === "online" && (
            <TabPanel idBase="live" id="online">
              <OnlinePanel summary={online} view={onlineView?.view ?? null} origin={t ? { lat: t.latitude, lon: t.longitude } : (onlineView?.center ?? null)} />
            </TabPanel>
          )}
          {tab === "events" && (
            <TabPanel idBase="live" id="events">
              {events.length === 0 ? (
                <EmptyState compact title="Noch keine Ereignisse" text="Phasenwechsel, Landungen und Pausen dieser Sitzung erscheinen hier." />
              ) : (
                <ul className="events">
                  {events.map((e, i) => (
                    <li key={i}>
                      <span className="num detail">{fmtClock(e.ms, { seconds: true })}</span> {e.text}
                    </li>
                  ))}
                </ul>
              )}
            </TabPanel>
          )}
        </div>
      </aside>
    </section>
  );
}

function MetarInline({ icao, metar, error }: { icao: string; metar: Metar | null; error: string | null }) {
  return (
    <span className="metar-line" title={metar?.raw ?? (error ? userMessage(error, "metar").hint : "Kein METAR verfügbar")}>
      <strong>{icao}</strong>{" "}
      {metar ? (
        <>
          <span className="cat-badge" style={{ background: CATEGORY_COLOR[metar.category] }}>
            {metar.category === "UNKNOWN" ? "?" : metar.category}
          </span>{" "}
          {fmtMetarLine(metar)}
        </>
      ) : error ? (
        <span className="warn-text">
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
          {userMessage(error, "metar").title}
        </span>
      ) : (
        <span className="detail">kein METAR</span>
      )}
    </span>
  );
}

// ---- side panel: Flug ----------------------------------------------------------------

function FlightSection({
  t,
  f,
  aircraft,
  ofp,
  routeText,
  wxIcao,
  wx,
  wxError,
  onOpenFlight,
}: {
  t: Telemetry | null;
  f: FlightSummary | null;
  aircraft: AircraftInfo | null;
  ofp: Ofp | null;
  routeText: string;
  wxIcao: string | null;
  wx: Metar | null;
  wxError: string | null;
  onOpenFlight?: () => void;
}) {
  const now = t?.timestampMs;
  const blockMs = f?.offBlockMs ? (f.onBlockMs ?? now ?? f.offBlockMs) - f.offBlockMs : null;
  const flightMs = f?.takeoffMs ? (f.landingMs ?? now ?? f.takeoffMs) - f.takeoffMs : null;
  const fuelUsed = f?.fuelStartKg != null && t ? f.fuelStartKg - (f.fuelEndKg ?? t.fuelTotalKg) : null;
  const plannedBlockMs = ofp ? ofp.times.blockS * 1000 : null;
  // OFP vs actual: block delta only once the flight is complete, landing fuel once landed
  const blockDone = !!f?.onBlockMs && blockMs != null;
  const blockDelta = blockDone ? fmtDeltaMin(blockMs, plannedBlockMs) : null;
  const blockDeltaMin = blockDone ? deltaMinutes(blockMs, plannedBlockMs) : null;
  const landingFuel = f?.landingMs ? (f.fuelEndKg ?? t?.fuelTotalKg ?? null) : null;
  const fuelDelta = ofp && landingFuel != null ? fmtDeltaKg(landingFuel, ofp.fuel.planLandingKg) : null;
  const fuelBelowPlan = !!ofp && landingFuel != null && landingFuel < ofp.fuel.planLandingKg - 0.5;
  const lastTd = f?.touchdowns.length ? f.touchdowns[f.touchdowns.length - 1] : null;
  const plan = (s: number | undefined) => (ofp && s ? `Plan ${fmtClock(s * 1000)}` : undefined);
  const aircraftLine = aircraft
    ? [aircraft.atcModel, aircraft.atcId, `${aircraft.atcAirline} ${aircraft.atcFlightNumber}`.trim()].filter(Boolean).join(" · ")
    : "";
  const airframe = useActiveAirframe(`${f?.state}|${f?.offBlockMs}|${aircraft?.atcId}`);
  const integrity = f?.integrity;
  const issues = integrity
    ? [
        integrity.slewDetected && "Slew",
        integrity.timeAccelerationDetected && `Zeitraffer (max. ${fmt(integrity.maxSimRate, 0)}×)`,
        integrity.crashed && "Absturz",
        integrity.fuelIncreasedAirborne && "Treibstoff in der Luft erhöht",
        integrity.pauseCount > 0 && `${integrity.pauseCount}× Pause (${fmtDuration(integrity.pausedMs)})`,
      ].filter(Boolean)
    : [];

  return (
    <div className="side-stack">
      <div className="flight-head">
        <div className="flight-route num">{routeText}</div>
        <div className="flight-aircraft" title={aircraft?.title}>
          {aircraft?.title ?? "Kein Flugzeug erkannt"}
        </div>
        {aircraftLine && <div className="detail">{aircraftLine}</div>}
        {airframe && f?.state === "active" && (
          <button className="af-live" onClick={() => navigate({ kind: "airframe", registration: airframe.registration })} title="Flugzeug in der Flotte öffnen">
            <AirframeImage airframe={airframe} />
            <span className="af-live-text">
              <strong className="num">{airframe.registration}</strong>
              <span className="detail">{airframeName(airframe) !== airframe.registration ? airframeName(airframe) : "gebucht auf dieses Flugzeug"}</span>
            </span>
          </button>
        )}
      </div>

      {issues.length > 0 && (
        <div className="alert warn-alert compact" role="status">
          <div className="alert-main">
            <span className="alert-icon" aria-hidden="true">
              ▲
            </span>
            <div className="alert-text">
              <strong>Integrität:</strong> {issues.join(" · ")}
            </div>
          </div>
        </div>
      )}

      <div className="side-group">
        <div className="side-group-title">Zeiten</div>
        <div className="stat-grid cols-4">
          <Stat size="sm" label="Off-Block" value={fmtClock(f?.offBlockMs)} sub={plan(ofp?.times.schedOutS)} />
          <Stat size="sm" label="Start" value={fmtClock(f?.takeoffMs)} sub={plan(ofp?.times.schedOffS)} />
          <Stat size="sm" label="Landung" value={fmtClock(f?.landingMs)} sub={plan(ofp?.times.schedOnS)} />
          <Stat size="sm" label="On-Block" value={fmtClock(f?.onBlockMs)} sub={plan(ofp?.times.schedInS)} />
        </div>
      </div>

      <div className="side-group">
        <div className="side-group-title">{ofp ? "Ist gegen Plan" : "Flug"}</div>
        <div className="stat-grid cols-2">
          <Stat
            label="Blockzeit"
            value={fmtDuration(blockMs)}
            sub={ofp ? `Plan ${fmtDuration(plannedBlockMs)}${blockDelta ? ` · ${blockDelta}` : ""}` : undefined}
            warn={blockDeltaMin != null && blockDeltaMin >= 15 ? `Blockzeit ${blockDelta} über Plan` : null}
          />
          <Stat label="Flugzeit" value={fmtDuration(flightMs)} sub={ofp ? `Plan ${fmtDuration(ofp.times.enrouteS * 1000)}` : undefined} />
          <Stat label="Distanz" value={fmt(f?.distanceNm, 1)} unit="nm" sub={ofp ? `Plan ${fmt(ofp.routeDistanceNm, 0, "nm")}` : undefined} />
          <Stat
            label="Verbrauch"
            value={fmt(fuelUsed, 0)}
            unit="kg"
            sub={fuelDelta ? `Landung ${fuelDelta} vs. Plan` : ofp ? `Plan ${fmt(ofp.fuel.tripKg + ofp.fuel.taxiKg, 0, "kg")}` : undefined}
            warn={fuelBelowPlan ? "Weniger Treibstoff bei der Landung als geplant" : null}
          />
          <Stat label="Max. Höhe" value={fmt(f?.maxAltitudeMslFt, 0)} unit="ft" sub={ofp ? `Plan FL${Math.round(ofp.cruiseAltitudeFt / 100)}` : undefined} />
          <Stat label="Treibstoff an Bord" value={fmt(t?.fuelTotalKg, 0)} unit="kg" sub={ofp ? `Plan Landung ${fmt(ofp.fuel.planLandingKg, 0, "kg")}` : undefined} />
        </div>
      </div>

      <div className="side-group">
        <div className="side-group-title">Wetter</div>
        {wxIcao ? (
          <>
            <MetarInline icao={wxIcao} metar={wx} error={wxError} />
            {wx && <div className="metar-raw mono">{wx.raw}</div>}
          </>
        ) : (
          <div className="detail">Kein Flughafen in der Nähe bekannt – das Wetter erscheint, sobald Abflug oder Ziel feststehen.</div>
        )}
      </div>

      <div className="side-group" aria-live="polite">
        <div className="side-group-title">
          Letzte Landung
          {lastTd && onOpenFlight && (
            <button className="link-btn" onClick={onOpenFlight}>
              Im Logbuch
            </button>
          )}
        </div>
        {lastTd ? (
          <div className="stat-grid cols-4">
            <Stat
              size="sm"
              label="Landerate"
              value={fmt(lastTd.landingRateFpm, 0)}
              unit="fpm"
              sub={lastTd.landingRateSource === "sim" ? "Sim-Wert" : "gemessen"}
              warn={lastTd.landingRateFpm <= -600 ? "Harte Landung (ab 600 fpm)" : null}
            />
            <Stat size="sm" label="Messwert" value={fmt(lastTd.vsFpmMeasured, 0)} unit="fpm" sub="letztes Sample" />
            <Stat size="sm" label="G-Last" value={fmt(lastTd.peakG, 2)} unit="G" warn={lastTd.peakG > 1.75 ? "G-Last über 1,75 G" : null} />
            <Stat size="sm" label="Bounces" value={String(lastTd.bounces)} warn={lastTd.bounces > 0 ? `${lastTd.bounces} Bounce${lastTd.bounces > 1 ? "s" : ""}` : null} />
          </div>
        ) : (
          <div className="detail">Nach dem Aufsetzen siehst du hier Landerate, G-Last und Bounces.</div>
        )}
      </div>
    </div>
  );
}

// ---- side panel: Systeme -------------------------------------------------------------

function SystemsSection({ t, f, ofp }: { t: Telemetry | null; f: FlightSummary | null; ofp: Ofp | null }) {
  if (!t) return <EmptyState compact title="Keine Live-Daten" text="Sobald der Simulator verbunden ist, erscheinen hier Konfiguration, Triebwerke und Lichter." />;
  const gear = t.gearPct >= 99 ? "ausgefahren" : t.gearPct <= 1 ? "eingefahren" : `${fmt(t.gearPct, 0, "%")} (in Bewegung)`;
  const fuelUsed = f?.fuelStartKg != null ? f.fuelStartKg - (f.fuelEndKg ?? t.fuelTotalKg) : null;
  return (
    <div className="side-stack">
      <div className="side-group">
        <div className="side-group-title">Konfiguration</div>
        <KV
          rows={[
            ["Fahrwerk", gear],
            ["Klappen", t.flapsIndex === 0 ? "eingefahren" : `Stufe ${t.flapsIndex}`],
            ["Parkbremse", t.parkingBrake ? "gesetzt" : "gelöst"],
            ["Am Boden", t.onGround ? "ja" : "nein"],
            ["Nick / Querlage", `${fmt(t.pitchDeg, 1, "°")} / ${fmt(t.bankDeg, 1, "°")}`],
            ["G-Last", fmt(t.gForce, 2, "G")],
            ["Transponder", String(t.transponderCode).padStart(4, "0")],
          ]}
        />
      </div>
      <div className="side-group">
        <div className="side-group-title">Triebwerke &amp; Treibstoff</div>
        <KV
          rows={[
            ["Triebwerke", `${t.enginesRunning} von ${t.numEngines} laufen`],
            ["Treibstoff", fmt(t.fuelTotalKg, 0, "kg")],
            ["Verbrauch", fmt(fuelUsed, 0, "kg")],
            ...(ofp ? ([["Plan Rampe / Landung", `${fmt(ofp.fuel.planRampKg, 0, "kg")} / ${fmt(ofp.fuel.planLandingKg, 0, "kg")}`]] as Array<[string, string]>) : []),
          ]}
        />
      </div>
      <div className="side-group">
        <div className="side-group-title">Gewichte</div>
        <KV
          rows={[
            ["Gesamtgewicht", fmt(t.totalWeightKg, 0, "kg")],
            ...(ofp
              ? ([
                  ["Plan TOW", `${fmt(ofp.weights.estTowKg, 0, "kg")} (max. ${fmt(ofp.weights.maxTowKg, 0, "kg")})`],
                  ["Plan LDW", `${fmt(ofp.weights.estLdwKg, 0, "kg")} (max. ${fmt(ofp.weights.maxLdwKg, 0, "kg")})`],
                  ["Plan ZFW", fmt(ofp.weights.estZfwKg, 0, "kg")],
                ] as Array<[string, string]>)
              : []),
          ]}
        />
      </div>
      <div className="side-group">
        <div className="side-group-title">Lichter</div>
        <ul className="light-list">
          {LIGHT_LABEL.map(([k, label]) => (
            <li key={k} className={t.lights[k] ? "on" : "off"}>
              <span className="light-dot" aria-hidden="true" />
              {label}
              <span className="sr-only">{t.lights[k] ? " an" : " aus"}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="side-group">
        <div className="side-group-title">Simulation</div>
        <KV
          rows={[
            ["Sim-Rate", `${fmt(t.simRate, 1, "×")}${t.paused ? " · Pause" : ""}`, t.simRate > 1.01 ? "Zeitraffer aktiv" : null],
            ["Slew", t.slew ? "aktiv" : "aus", t.slew ? "Slew-Modus aktiv" : null],
            ["Höhe AGL", fmt(t.altitudeAglFt, 0, "ft")],
            ["TAS", fmt(t.tasKt, 0, "kt")],
            ["Kurs (wahr)", fmt(t.headingTrueDeg, 0, "°")],
            ["Position", fmtCoord(t.latitude, t.longitude, 4)],
          ]}
        />
      </div>
    </div>
  );
}

// ---- recording status pill (map, top left) -------------------------------------------

function StatusPill({ rec, onTryDemo }: { rec: RecStatus; onTryDemo?: () => void }) {
  const mark = rec.error ? "error" : rec.kind;
  return (
    <div className={`status-pill pill-${mark}`} role="status" title={rec.hint}>
      <span className={`dot dot-${mark}`} aria-hidden="true" />
      <span className="status-pill-text">{rec.text}</span>
      {rec.kind === "waiting" && onTryDemo && (
        <button className="link-btn" onClick={onTryDemo}>
          Ohne Simulator ausprobieren
        </button>
      )}
    </div>
  );
}
