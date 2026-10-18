import { useEffect, useState } from "react";
import LiveMap from "../map/LiveMap";
import Dispatch from "../Dispatch";
import OnlinePanel from "../OnlinePanel";
import {
  PHASE_LABEL,
  fmt,
  fmtAltitude,
  TRANSITION_ALTITUDE_FT,
  fmtClock,
  fmtCoord,
  fmtDuration,
  fmtMetarLine,
  fmtNum,
  fmtSigned,
  fmtWeight,
  fmtWeightNum,
  haversineNm,
} from "../format";
import { usePrefs, usePrivacy } from "../prefs";
import { userMessage } from "../errors";
import { CATEGORY_COLOR } from "../theme";
import type { AircraftInfo, Airport, FlightPhase, Metar, NavFix, OnlineSummary, OnlineView, Ofp, StatusSnapshot, Telemetry } from "../types";
import { shallowEqual, useFlight, useFlightHead, useTelemetry, useTelemetrySelector } from "../telemetryStore";
import Stat, { KV } from "../ui/Stat";
import { TabPanel, Tabs } from "../ui/Tabs";
import { Chevron } from "../ui/Panel";
import { ToastViewport } from "../ui/Toast";
import { useAirport, useMetar, useNearestIcao, useStoredState } from "./hooks";
import { etaMs, remainingNm } from "./progress";
import { actualFromSummary, fmtPunctuality, fmtPvaDelta, fmtPvaValue, planVsActual, type PvaLine } from "../pirep";
import AirframeImage from "../airframes/AirframeImage";
import { airframeName, shownAirframeName } from "../airframes/airframe";
import { useActiveAirframe } from "../airframes/hooks";
import { navigate } from "../airframes/navigation";
import { DEMO_LABEL, WAITING_SHORT, type RecStatus } from "../status";
import AfterFlightCard, { type AfterFlight } from "./AfterFlightCard";
import ReadyCard from "./ReadyCard";
import { isDebriefOpen, openDebrief, useDebrief } from "../landing/debriefStore";
import { G_HARD } from "../landing/facts";

export interface LogLine {
  ms: number;
  text: string;
}

interface Props {
  /**
   * The live view is on screen. App keeps it mounted while another view is shown (hidden),
   * so the map keeps camera, layers and track; its shortcuts and map toasts pause meanwhile.
   */
  active?: boolean;
  aircraft: AircraftInfo | null;
  ofp: Ofp | null;
  onOfp: (ofp: Ofp | null) => void;
  online: OnlineSummary | null;
  events: LogLine[];
  /** Open the logbook detail of the running/last flight. */
  onOpenFlight?: () => void;
  /** Recording status for the pill on the map (same texts as the sidebar button). */
  rec: RecStatus;
  status: StatusSnapshot | null;
  /** The flight that just ended (from on-block until the next off-block). */
  afterFlight?: AfterFlight | null;
  onAfterFlightLogbook?: (flightId: string) => void;
  onAfterFlightDismiss?: () => void;
  /** Start the demo flight (only offered while waiting for the simulator). */
  onTryDemo?: () => void;
}

type Tab = "flight" | "dispatch";

/** Earlier builds stored five tab ids; map them onto the two tabs. */
export function normalizeTab(raw: string): Tab {
  return raw === "plan" || raw === "online" || raw === "dispatch" ? "dispatch" : "flight";
}

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

/**
 * "Bereit" card hidden by the pilot: for this app session (module state, survives view
 * changes and a remount), back with the next flight.
 */
let readyDismissedSession = false;

const PANEL_KEY = "vectasim.livePanel";
const TAB_KEY = "vectasim.liveTab";

/**
 * Live view: the map fills the content area, the six primary values sit
 * in a bar over the map, everything else is in a collapsible side panel (Ctrl+.).
 *
 * Telemetry and the flight summary come from telemetryStore (up to 10×/s). The view itself
 * only follows the flight's frame (state, phase, times, departure/arrival) and a few coarse
 * values; the HUD numbers, the side panel sections and the map read the samples themselves.
 */
export default function LiveView({
  active = true,
  aircraft,
  ofp,
  onOfp,
  online,
  events,
  onOpenFlight,
  rec,
  status,
  afterFlight,
  onAfterFlightLogbook,
  onAfterFlightDismiss,
  onTryDemo,
}: Props) {
  const priv = usePrivacy();
  const f = useFlightHead();
  const [panelOpen, setPanelOpen] = useStoredState<boolean>(PANEL_KEY, true);
  const [storedTab, setTab] = useStoredState<string>(TAB_KEY, "flight");
  const tab = normalizeTab(storedTab);
  const [readyDismissed, setReadyDismissedState] = useState(readyDismissedSession);
  const setReadyDismissed = (v: boolean) => {
    readyDismissedSession = v;
    setReadyDismissedState(v);
  };
  // a new flight: the card may come back before the next one
  const flightActive = f?.state === "active";
  useEffect(() => {
    if (!flightActive) return;
    readyDismissedSession = false;
    setReadyDismissedState(false);
  }, [flightActive]);
  const debriefOpen = useDebrief() != null;
  /** Basemap tiles not reachable (LiveMap onOffline): a hint, recording is unaffected. */
  const [mapOffline, setMapOffline] = useState(false);
  const openDispatch = () => {
    setPanelOpen(true);
    setTab("dispatch");
  };
  const [onlineView, setOnlineView] = useState<{ view: OnlineView | null; center: { lat: number; lon: number } } | null>(null);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "." && !isDebriefOpen()) {
        e.preventDefault();
        setPanelOpen(!panelOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, panelOpen, setPanelOpen]);

  // back on screen: MapLibre measured a hidden (0 × 0) container meanwhile – let it resize
  // (its ResizeObserver usually does; the window event is the safety net)
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("vectasim:map-visible"));
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  // ---- airports, destination, weather ----------------------------------------------
  const depIcao = useNearestIcao(f?.departure);
  const arrIcao = useNearestIcao(f?.arrival);
  // Before a flight starts there is no departure point yet: use the airport we stand on.
  // Rounded to ~1 km so taxiing doesn't trigger a lookup (nor a re-render) per frame.
  const groundPoint = useTelemetrySelector(
    ({ telemetry: t, flight }) =>
      t?.onGround && flight?.state !== "active" ? { latitude: Math.round(t.latitude * 100) / 100, longitude: Math.round(t.longitude * 100) / 100 } : null,
    shallowEqual,
  );
  const groundIcao = useNearestIcao(groundPoint);

  const destIcao = (ofp?.destinationIcao || arrIcao) ?? null;
  const destAirport = useAirport(destIcao);
  const routeForDest = ofp && ofp.destinationIcao === destIcao ? ofp.navlog : null;
  const landed = !!f?.landingMs;
  // a boolean: the view re-renders when the aircraft crosses the 100 nm ring, not per sample
  const nearDest = useTelemetrySelector(
    ({ telemetry: t }) => !!destAirport && !!t && haversineNm(t.latitude, t.longitude, destAirport.latitude, destAirport.longitude) < DEST_WX_RANGE_NM,
  );

  const useDest = !!destIcao && (PAST_TOD.includes(f?.phase ?? "preflight") || nearDest);
  const depOrGround = depIcao ?? (ofp?.originIcao || null) ?? groundIcao;
  // departure weather until takeoff, then the destination's (if known), else stay on departure
  const wxIcao = useDest || (f?.takeoffMs && destIcao) ? destIcao : depOrGround;
  const { metar: wx, error: wxError } = useMetar(wxIcao);

  // ---- derived values --------------------------------------------------------------
  const phase = f?.phase ?? "preflight";
  const routeText = `${depIcao ?? (f?.departure ? "····" : (ofp?.originIcao || "–"))} → ${arrIcao ?? (ofp?.destinationIcao || (f?.arrival ? "····" : "–"))}`;
  const rawCallsign = ofp?.callsign || (aircraft ? `${aircraft.atcAirline} ${aircraft.atcFlightNumber}`.trim() || aircraft.atcId : "");
  // Streamer-Modus: the HUD line shows no callsign/registration (display only)
  const callsign = priv.mask(rawCallsign, rawCallsign === aircraft?.atcId && !ofp?.callsign ? "registration" : "callsign");

  const tabs: Array<{ id: Tab; label: string; badge?: string }> = [
    { id: "flight", label: "Flug", badge: events.length ? String(events.length) : undefined },
    { id: "dispatch", label: "Dispatch", badge: ofp || online?.enabled ? "●" : undefined },
  ];
  const showAfter = !!afterFlight && f?.state !== "active";
  const showReady = !showAfter && !readyDismissed && f?.state !== "active";

  return (
    <section className={`live${panelOpen ? " panel-open" : ""}`} hidden={!active}>
      <div className="live-map-area">
        <LiveMap
          aircraft={aircraft}
          route={ofp?.navlog}
          trafficOn={online?.enabled ?? false}
          onOnlineView={(v, center) => setOnlineView({ view: v, center })}
          onOffline={setMapOffline}
          overlay={
            <>
              {/* the Bereit card leads before a flight: the pill then only names the state, the demo is offered on the card */}
              <StatusPill rec={rec} onTryDemo={showReady ? undefined : onTryDemo} short={showReady && rec.kind === "waiting"} />
              {mapOffline && (
                <div className="status-pill pill-suspended map-offline-pill" role="status" title="Die Kartenkacheln laden gerade nicht. Position, Track und Aufzeichnung laufen lokal weiter.">
                  <span className="dot dot-suspended" aria-hidden="true" />
                  <span className="status-pill-text">Karte offline – Tracking läuft weiter</span>
                </div>
              )}
            </>
          }
        />
        {/* while hidden or behind the debrief, App's viewport shows the map toasts */}
        <ToastViewport regions={active && !debriefOpen ? ["map"] : []} placement="top" />
        {showReady && (
          <ReadyCard rec={rec} status={status} ofp={ofp} aircraft={aircraft} onOpenDispatch={openDispatch} onTryDemo={onTryDemo} onDismiss={() => setReadyDismissed(true)} />
        )}
        {showAfter && afterFlight && (
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

        <div className="hud" role="group" aria-label="Flugdaten">
          <div className="hud-values">
            <div className="stat stat-lg hud-phase">
              <div className="stat-label">Phase</div>
              <div className={`stat-value phase-${phase}`} aria-live="polite">
                {PHASE_LABEL[phase]}
              </div>
              {/* the recording state is the pill's and the Bereit card's job; here only what the flight is */}
              {f?.state === "active" ? <div className="stat-sub">Aufzeichnung</div> : f?.state === "completed" ? <div className="stat-sub">abgeschlossen</div> : null}
            </div>
            <HudValues destIcao={destIcao} destAirport={destAirport} routeForDest={routeForDest} landed={landed} />
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
              <FlightSection aircraft={aircraft} ofp={ofp} routeText={routeText} wxIcao={wxIcao} wx={wx} wxError={wxError} onOpenFlight={onOpenFlight} />
              <SystemsSection ofp={ofp} />
              <div className="side-stack">
                <div className="side-group">
                  <div className="side-group-title">Ereignisse</div>
                  {events.length === 0 ? (
                    <div className="detail">Phasenwechsel, Landungen und Pausen dieser Sitzung erscheinen hier.</div>
                  ) : (
                    <ul className="events">
                      {events.map((e, i) => (
                        <li key={i}>
                          <span className="num detail">{fmtClock(e.ms, { seconds: true })}</span> {e.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </TabPanel>
          )}
          {tab === "dispatch" && (
            <TabPanel idBase="live" id="dispatch">
              <Dispatch ofp={ofp} onOfp={onOfp} />
              <LiveOnlinePanel summary={online} view={onlineView?.view ?? null} center={onlineView?.center ?? null} />
            </TabPanel>
          )}
        </div>
      </aside>
    </section>
  );
}

/**
 * The five HUD numbers: the only part of the frame that follows every telemetry sample, so
 * only it re-renders 10×/s (not the live view with its map, cards and side panel).
 */
function HudValues({
  destIcao,
  destAirport,
  routeForDest,
  landed,
}: {
  destIcao: string | null;
  destAirport: Airport | null;
  routeForDest: NavFix[] | null;
  landed: boolean;
}) {
  const t = useTelemetry();
  const pos = t ? { latitude: t.latitude, longitude: t.longitude } : null;
  const restNm = remainingNm(pos, destAirport, routeForDest);
  const eta = landed ? null : etaMs(Date.now(), restNm, t?.groundSpeedKt);
  const vs = t?.verticalSpeedFpm ?? 0;
  const vsWarn = !t
    ? null
    : vs > 4000
      ? "Steigrate über 4 000 fpm"
      : vs < -1000 && !t.onGround && t.altitudeAglFt < 2500
        ? "Sinkrate über 1 000 fpm unter 2 500 ft AGL"
        : null;
  const altSub = !t ? undefined : !t.onGround && t.altitudeAglFt < 2500 ? `AGL ${fmt(t.altitudeAglFt, 0, "ft")}` : t.altitudeMslFt > TRANSITION_ALTITUDE_FT ? fmtAltitude(t.altitudeMslFt) : undefined;
  const restSub = landed
    ? "gelandet"
    : !destIcao
      ? "Ziel unbekannt"
      : eta
        ? `ETA ${fmtClock(eta)} · ${fmtDuration(eta - Date.now(), { seconds: false })}`
        : "ETA ab 50 kt GS";
  return (
    <>
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
    </>
  );
}

type Origin = { lat: number; lon: number } | null;

/** "Nearby" traffic from the own position rounded to ~100 m (distances there are whole nm), else the map centre. */
function LiveOnlinePanel({ summary, view, center }: { summary: OnlineSummary | null; view: OnlineView | null; center: Origin }) {
  const own = useTelemetrySelector<Origin>(
    ({ telemetry: t }) => (t ? { lat: Math.round(t.latitude * 1000) / 1000, lon: Math.round(t.longitude * 1000) / 1000 } : null),
    shallowEqual,
  );
  return <OnlinePanel summary={summary} view={view} origin={own ?? center} />;
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
  aircraft,
  ofp,
  routeText,
  wxIcao,
  wx,
  wxError,
  onOpenFlight,
}: {
  aircraft: AircraftInfo | null;
  ofp: Ofp | null;
  routeText: string;
  wxIcao: string | null;
  wx: Metar | null;
  wxError: string | null;
  onOpenFlight?: () => void;
}) {
  const { weightUnit } = usePrefs();
  const priv = usePrivacy();
  // times, totals and fuel run with every sample: this section reads them itself
  const t = useTelemetry();
  const f = useFlight();
  // plan against actual (pirep.ts, same as the logbook detail); deltas only once a value is final
  const pva = planVsActual(actualFromSummary(f, t), null, ofp);
  const L = pva.byKey;
  const blockMs = L.block?.actual ?? null;
  const flightMs = L.air?.actual ?? null;
  const fuelUsed = L.blockFuel?.actual ?? null;
  const delta = (l: PvaLine | undefined) => (l && l.delta != null ? fmtPvaDelta(l) : null);
  const planSub = (l: PvaLine | undefined, label = "Plan") => {
    if (!ofp || !l) return undefined;
    const d = delta(l);
    return `${label} ${fmtPvaValue(l.kind, l.plan)}${d ? ` · ${d}` : ""}`;
  };
  const lastTd = f?.touchdowns.length ? f.touchdowns[f.touchdowns.length - 1] : null;
  const aircraftLine = aircraft
    ? [aircraft.atcModel, priv.mask(aircraft.atcId, "registration"), priv.mask(`${aircraft.atcAirline} ${aircraft.atcFlightNumber}`.trim(), "callsign")].filter(Boolean).join(" · ")
    : "";
  const aircraftTitle = aircraft ? priv.title(aircraft.title, { registration: aircraft.atcId, airline: aircraft.atcAirline, callsign: ofp?.callsign }) : null;
  const airframe = useActiveAirframe(`${f?.state}|${f?.offBlockMs}|${aircraft?.atcId}`);
  const integrity = f?.integrity;
  const issues = integrity
    ? [
        integrity.slewDetected && "Slew",
        integrity.timeAccelerationDetected && `Zeitraffer (max. ${fmt(integrity.maxSimRate, 0)}×)`,
        integrity.crashed && "Absturz",
        integrity.fuelIncreasedAirborne && "Treibstoff in der Luft erhöht",
        integrity.teleportDetected && "Positionssprung (Teleport/Neuladen)",
        integrity.pauseCount > 0 && `${integrity.pauseCount}× Pause (${fmtDuration(integrity.pausedMs)})`,
      ].filter(Boolean)
    : [];

  return (
    <div className="side-stack">
      <div className="flight-head">
        <div className="flight-route num">{routeText}</div>
        <div className="flight-aircraft" title={aircraftTitle ?? undefined}>
          {aircraftTitle ?? "Kein Flugzeug erkannt"}
        </div>
        {aircraftLine && <div className="detail">{aircraftLine}</div>}
        {airframe && f?.state === "active" && (
          <button className="af-live" onClick={() => navigate({ kind: "airframe", registration: airframe.registration })} title="Flugzeug in der Flotte öffnen">
            <AirframeImage airframe={airframe} />
            <span className="af-live-text">
              <strong className="num">{priv.mask(airframe.registration, "registration")}</strong>
              <span className="detail">{airframeName(airframe) !== airframe.registration ? shownAirframeName(airframe, priv.on) : "gebucht auf dieses Flugzeug"}</span>
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
          <Stat size="sm" label="Off-Block" value={fmtClock(f?.offBlockMs)} sub={planSub(L.offBlock)} />
          <Stat size="sm" label="Start" value={fmtClock(f?.takeoffMs)} sub={planSub(L.takeoff)} />
          <Stat size="sm" label="Landung" value={fmtClock(f?.landingMs)} sub={planSub(L.landing)} />
          <Stat
            size="sm"
            label="On-Block"
            value={fmtClock(f?.onBlockMs)}
            sub={planSub(L.onBlock)}
            warn={pva.arrival?.status === "late" ? `On-Block ${fmtPunctuality(pva.arrival)}` : null}
          />
        </div>
      </div>

      <div className="side-group">
        <div className="side-group-title">{ofp ? "Ist gegen Plan" : "Flug"}</div>
        <div className="stat-grid cols-2">
          <Stat label="Blockzeit" value={fmtDuration(blockMs)} sub={planSub(L.block)} warn={L.block?.warn ?? null} />
          <Stat label="Luftzeit" title="Abheben bis Aufsetzen – für das Flugbuch zählt die Blockzeit" value={fmtDuration(flightMs)} sub={planSub(L.air)} />
          <Stat label="Distanz" value={fmt(f?.distanceNm, 1)} unit="nm" sub={planSub(L.distance)} />
          <Stat
            label="Verbrauch"
            value={fmtWeightNum(fuelUsed)}
            unit={weightUnit}
            sub={delta(L.landingFuel) ? `Landung ${delta(L.landingFuel)} vs. Plan` : planSub(L.blockFuel)}
            warn={L.landingFuel?.warn ?? null}
          />
          <Stat label="Max. Höhe" value={fmt(f?.maxAltitudeMslFt, 0)} unit="ft" sub={planSub(L.cruise)} />
          <Stat label="Treibstoff an Bord" value={fmtWeightNum(t?.fuelTotalKg)} unit={weightUnit} sub={planSub(L.landingFuel, "Plan Landung")} />
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
            <Stat size="sm" label="g-Last" value={fmt(lastTd.peakG, 2)} unit="g" warn={lastTd.peakG >= G_HARD ? "g-Last ab 2,0 g (Band „hart“)" : null} />
            <Stat size="sm" label="Bounces" value={String(lastTd.bounces)} warn={lastTd.bounces > 0 ? `${lastTd.bounces} Bounce${lastTd.bounces > 1 ? "s" : ""}` : null} />
          </div>
        ) : (
          <div className="detail">Nach dem Aufsetzen siehst du hier Landerate, g-Last und Bounces.</div>
        )}
      </div>
    </div>
  );
}

// ---- side panel: Systeme -------------------------------------------------------------

function SystemsSection({ ofp }: { ofp: Ofp | null }) {
  const t = useTelemetry();
  const f = useFlight();
  // re-render on a kg/lb switch even while no telemetry arrives (paused sim)
  usePrefs();
  // without telemetry the flight section above already says that the sim is not connected
  if (!t) return null;
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
            ["g-Last", fmt(t.gForce, 2, "g")],
            ["Transponder", String(t.transponderCode).padStart(4, "0")],
          ]}
        />
      </div>
      <div className="side-group">
        <div className="side-group-title">Triebwerke &amp; Treibstoff</div>
        <KV
          rows={[
            ["Triebwerke", `${t.enginesRunning} von ${t.numEngines} laufen`],
            ["Treibstoff", fmtWeight(t.fuelTotalKg)],
            ["Verbrauch", fmtWeight(fuelUsed)],
            ...(ofp ? ([["Plan Rampe / Landung", `${fmtWeight(ofp.fuel.planRampKg)} / ${fmtWeight(ofp.fuel.planLandingKg)}`]] as Array<[string, string]>) : []),
          ]}
        />
      </div>
      <div className="side-group">
        <div className="side-group-title">Gewichte</div>
        <KV
          rows={[
            ["Gesamtgewicht", fmtWeight(t.totalWeightKg)],
            ...(ofp
              ? ([
                  ["Plan TOW", `${fmtWeight(ofp.weights.estTowKg)} (max. ${fmtWeight(ofp.weights.maxTowKg)})`],
                  ["Plan LDW", `${fmtWeight(ofp.weights.estLdwKg)} (max. ${fmtWeight(ofp.weights.maxLdwKg)})`],
                  ["Plan ZFW", fmtWeight(ofp.weights.estZfwKg)],
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

function StatusPill({ rec, onTryDemo, short }: { rec: RecStatus; onTryDemo?: () => void; short?: boolean }) {
  const mark = rec.error ? "error" : rec.kind;
  return (
    <div className={`status-pill pill-${mark}`} role="status" title={rec.hint}>
      <span className={`dot dot-${mark}`} aria-hidden="true" />
      <span className="status-pill-text">{short ? WAITING_SHORT : rec.text}</span>
      {rec.kind === "waiting" && onTryDemo && (
        <button className="link-btn" onClick={onTryDemo} title="Ohne Simulator ausprobieren – ein simulierter Flug">
          {DEMO_LABEL} starten
        </button>
      )}
    </div>
  );
}
