import { useEffect, useState } from "react";
import { LiveMap } from "../lazyMaps";
import Dispatch from "../Dispatch";
import OnlinePanel from "../OnlinePanel";
import { PHASE_LABEL, TRANSITION_ALTITUDE_FT, haversineNm } from "../format";
import { fmtMetarLine } from "../i18n/number";
import { fmt, fmtAltitude, fmtClock, fmtCoord, fmtDuration, fmtNum, fmtSigned, fmtWeight, fmtWeightNum } from "../i18n/number";
import { useT, type TKey } from "../i18n";
import { usePrefs, usePrivacy } from "../prefs";
import { userMessage } from "../errors";
import { CATEGORY_COLOR } from "../theme";
import type { AircraftInfo, Airport, FlightPhase, Metar, NavFix, OnlineSummary, OnlineView, Ofp, StatusSnapshot, Telemetry } from "../types";
import { shallowEqual, useFlight, useFlightHead, useTelemetry, useTelemetrySelector } from "../telemetryStore";
import Stat, { KV } from "../ui/Stat";
import { TabPanel, Tabs } from "../ui/Tabs";
import { Chevron } from "../ui/Panel";
import Collapsible from "../ui/Collapsible";
import { ToastViewport } from "../ui/Toast";
import { useAirport, useMetar, useNearestIcao, useStoredState } from "./hooks";
import { etaMs, remainingNm } from "./progress";
import { actualFromSummary, fmtPunctuality, fmtPvaDelta, fmtPvaValue, planVsActual, type PvaLine } from "../pirep";
import AirframeImage from "../airframes/AirframeImage";
import { airframeName, shownAirframeName } from "../airframes/airframe";
import { useActiveAirframe } from "../airframes/hooks";
import { navigate } from "../airframes/navigation";
import { demoLabel, waitingShort, type RecStatus } from "../status";
import AfterFlightCard, { type AfterFlight } from "./AfterFlightCard";
import ReadyCard from "./ReadyCard";
import { isDebriefOpen, openDebrief, useDebrief } from "../landing/debriefStore";
import { isModalOpen } from "../ui/modalStack";
import { G_HARD } from "../landing/facts";
import { liveMaxG, liveMaxGTitle } from "../gload";
import { eventsSummary, useEventLog } from "./eventLog";
import { isRated } from "../landing/rated";

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

const LIGHT_LABEL: Array<[keyof Telemetry["lights"], TKey]> = [
  ["beacon", "live.systems.light.beacon"],
  ["nav", "live.systems.light.nav"],
  ["strobe", "live.systems.light.strobe"],
  ["landing", "live.systems.light.landing"],
  ["taxi", "live.systems.light.taxi"],
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
  onOpenFlight,
  rec,
  status,
  afterFlight,
  onAfterFlightLogbook,
  onAfterFlightDismiss,
  onTryDemo,
}: Props) {
  const t = useT();
  const priv = usePrivacy();
  const f = useFlightHead();
  // the session's event list: a store outside App, so a remount of the tree does not empty it
  const events = useEventLog();
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
      if (e.ctrlKey && e.key === "." && !isDebriefOpen() && !isModalOpen()) {
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
    { id: "flight", label: t("live.tabs.flight"), badge: events.length ? String(events.length) : undefined },
    { id: "dispatch", label: t("live.tabs.dispatch"), badge: ofp || online?.enabled ? "●" : undefined },
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
                <div className="status-pill pill-suspended map-offline-pill" role="status" title={t("live.mapOffline.title")}>
                  <span className="dot dot-suspended" aria-hidden="true" />
                  <span className="status-pill-text">{t("live.mapOffline.text")}</span>
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
          aria-label={panelOpen ? t("live.panel.collapse") : t("live.panel.expand")}
          title={t("live.panel.shortcut", { action: panelOpen ? t("live.panel.collapse") : t("live.panel.expand") })}
        >
          <Chevron dir={panelOpen ? "right" : "left"} />
        </button>

        <div className="hud" role="group" aria-label={t("live.hud.aria")}>
          <div className="hud-values">
            <div className="stat stat-lg hud-phase">
              <div className="stat-label">{t("live.hud.phase")}</div>
              <div className={`stat-value phase-${phase}`} aria-live="polite">
                {PHASE_LABEL[phase]}
              </div>
              {/* the recording state is the pill's and the Bereit card's job; here only what the flight is */}
              {f?.state === "active" ? <div className="stat-sub">{t("live.hud.recording")}</div> : f?.state === "completed" ? <div className="stat-sub">{t("live.hud.completed")}</div> : null}
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

      <aside id="live-side" className="side-panel" hidden={!panelOpen} aria-label={t("live.panel.aria")}>
        <div className="side-head">
          <Tabs tabs={tabs} active={tab} onChange={setTab} idBase="live" label={t("live.panel.aria")} />
        </div>
        <div className="side-body">
          {tab === "flight" && (
            <TabPanel idBase="live" id="flight">
              <FlightSection aircraft={aircraft} ofp={ofp} routeText={routeText} wxIcao={wxIcao} wx={wx} wxError={wxError} onOpenFlight={onOpenFlight} />
              <SystemsSection ofp={ofp} />
              <div className="side-stack">
                <Collapsible
                  id="live.events"
                  className="side-group"
                  headClassName="side-group-title"
                  title={t("live.events.title")}
                  summary={eventsSummary(events)}
                >
                  {events.length === 0 ? (
                    <div className="detail">{t("live.events.empty")}</div>
                  ) : (
                    <ul className="events">
                      {events.map((e, i) => (
                        <li key={i}>
                          <span className="num detail">{fmtClock(e.ms, { seconds: true })}</span> {e.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </Collapsible>
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
  const t = useT();
  const tel = useTelemetry();
  const pos = tel ? { latitude: tel.latitude, longitude: tel.longitude } : null;
  const restNm = remainingNm(pos, destAirport, routeForDest);
  const eta = landed ? null : etaMs(Date.now(), restNm, tel?.groundSpeedKt);
  const vs = tel?.verticalSpeedFpm ?? 0;
  const vsWarn = !tel
    ? null
    : vs > 4000
      ? t("live.hud.climbWarn", { rate: 4000 })
      : vs < -1000 && !tel.onGround && tel.altitudeAglFt < 2500
        ? t("live.hud.descentWarn", { rate: 1000, agl: 2500 })
        : null;
  const altSub = !tel
    ? undefined
    : !tel.onGround && tel.altitudeAglFt < 2500
      ? t("live.hud.agl", { altitude: fmt(tel.altitudeAglFt, 0, "ft") })
      : tel.altitudeMslFt > TRANSITION_ALTITUDE_FT
        ? fmtAltitude(tel.altitudeMslFt)
        : undefined;
  const restSub = landed
    ? t("live.hud.landed")
    : !destIcao
      ? t("live.hud.destUnknown")
      : eta
        ? t("live.hud.eta", { time: fmtClock(eta), duration: fmtDuration(eta - Date.now(), { seconds: false }) })
        : t("live.hud.etaFrom", { speed: fmt(50, 0, "kt") });
  return (
    <>
      <Stat size="lg" label={t("live.hud.altitudeMsl")} value={tel ? fmtNum(tel.altitudeMslFt) : "–"} unit="ft" sub={altSub} />
      <Stat size="lg" label={t("live.hud.gsIas")} value={tel ? fmtNum(tel.groundSpeedKt) : "–"} unit="kt" sub={tel ? t("live.hud.ias", { speed: fmt(tel.iasKt, 0, "kt") }) : undefined} />
      <Stat size="lg" label="V/S" value={tel ? fmtSigned(Math.round(vs)) : "–"} unit="fpm" warn={vsWarn} />
      <Stat size="lg" label={t("live.hud.heading")} value={tel ? String(Math.round(tel.headingMagDeg) % 360 || 360).padStart(3, "0") : "–"} unit="°" sub={t("live.hud.magnetic")} />
      <Stat
        size="lg"
        label={destIcao ? t("live.hud.remainingTo", { icao: destIcao }) : t("live.hud.remaining")}
        value={restNm != null && !landed ? fmtNum(restNm) : "–"}
        unit="nm"
        sub={restSub}
        title={!destIcao ? t("live.hud.remainingNoPlan") : routeForDest ? t("live.hud.alongRoute") : t("live.hud.greatCircle")}
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
  const t = useT();
  return (
    <span className="metar-line" title={metar?.raw ?? (error ? userMessage(error, "metar").hint : t("live.metar.unavailable"))}>
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
        <span className="detail">{t("live.metar.none")}</span>
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
  const t = useT();
  const { weightUnit } = usePrefs();
  const priv = usePrivacy();
  // times, totals and fuel run with every sample: this section reads them itself
  const tel = useTelemetry();
  const f = useFlight();
  // plan against actual (pirep.ts, same as the logbook detail); deltas only once a value is final
  const pva = planVsActual(actualFromSummary(f, tel), null, ofp);
  const L = pva.byKey;
  const blockMs = L.block?.actual ?? null;
  const flightMs = L.air?.actual ?? null;
  const fuelUsed = L.blockFuel?.actual ?? null;
  const delta = (l: PvaLine | undefined) => (l && l.delta != null ? fmtPvaDelta(l) : null);
  const planSub = (l: PvaLine | undefined, label: "live.flight.plan" | "live.flight.planLanding" = "live.flight.plan") => {
    if (!ofp || !l) return undefined;
    const d = delta(l);
    return `${t(label, { value: fmtPvaValue(l.kind, l.plan) })}${d ? ` · ${d}` : ""}`;
  };
  const lastTd = f?.touchdowns.length ? f.touchdowns[f.touchdowns.length - 1] : null;
  // folded "Zeiten": the latest of off-block, take-off, landing, on-block that happened
  const lastTime = (
    [
      [f?.onBlockMs, "live.flight.onBlock"],
      [f?.landingMs, "live.flight.landing"],
      [f?.takeoffMs, "live.flight.takeoff"],
      [f?.offBlockMs, "live.flight.offBlock"],
    ] as const
  ).find(([ms]) => ms != null);
  const timesSummary = lastTime ? `${t(lastTime[1])} ${fmtClock(lastTime[0])}` : undefined;
  const aircraftLine = aircraft
    ? [aircraft.atcModel, priv.mask(aircraft.atcId, "registration"), priv.mask(`${aircraft.atcAirline} ${aircraft.atcFlightNumber}`.trim(), "callsign")].filter(Boolean).join(" · ")
    : "";
  const aircraftTitle = aircraft ? priv.title(aircraft.title, { registration: aircraft.atcId, airline: aircraft.atcAirline, callsign: ofp?.callsign }) : null;
  const airframe = useActiveAirframe(`${f?.state}|${f?.offBlockMs}|${aircraft?.atcId}`);
  const integrity = f?.integrity;
  const issues = integrity
    ? [
        integrity.slewDetected && t("live.flight.issue.slew"),
        integrity.timeAccelerationDetected && t("live.flight.issue.timeAccel", { rate: fmt(integrity.maxSimRate, 0) }),
        integrity.crashed && t("live.flight.issue.crashed"),
        integrity.fuelIncreasedAirborne && t("live.flight.issue.fuelAirborne"),
        integrity.teleportDetected && t("live.flight.issue.teleport"),
        integrity.pauseCount > 0 && t("live.flight.issue.pauses", { count: integrity.pauseCount, duration: fmtDuration(integrity.pausedMs) }),
      ].filter(Boolean)
    : [];

  return (
    <div className="side-stack">
      <Collapsible
        id="live.overview"
        className="side-group"
        headClassName="side-group-title"
        title={t("live.section.overview")}
        summary={[routeText, aircraft?.atcModel].filter(Boolean).join(" · ")}
      >
        <div className="flight-head">
          <div className="flight-route num">{routeText}</div>
          <div className="flight-aircraft" title={aircraftTitle ?? undefined}>
            {aircraftTitle ?? t("live.flight.noAircraft")}
          </div>
          {aircraftLine && <div className="detail">{aircraftLine}</div>}
          {airframe && f?.state === "active" && (
            <button className="af-live" onClick={() => navigate({ kind: "airframe", registration: airframe.registration })} title={t("live.flight.openAirframe")}>
              <AirframeImage airframe={airframe} />
              <span className="af-live-text">
                <strong className="num">{priv.mask(airframe.registration, "registration")}</strong>
                <span className="detail">{airframeName(airframe) !== airframe.registration ? shownAirframeName(airframe, priv.on) : t("live.flight.bookedOn")}</span>
              </span>
            </button>
          )}
        </div>
      </Collapsible>

      {issues.length > 0 && (
        <div className="alert warn-alert compact" role="status">
          <div className="alert-main">
            <span className="alert-icon" aria-hidden="true">
              ▲
            </span>
            <div className="alert-text">
              <strong>{t("live.flight.integrity")}</strong> {issues.join(" · ")}
            </div>
          </div>
        </div>
      )}

      <Collapsible id="live.times" className="side-group" headClassName="side-group-title" title={t("live.flight.times")} summary={timesSummary}>
        <div className="stat-grid cols-4">
          <Stat size="sm" label={t("live.flight.offBlock")} value={fmtClock(f?.offBlockMs)} sub={planSub(L.offBlock)} />
          <Stat size="sm" label={t("live.flight.takeoff")} value={fmtClock(f?.takeoffMs)} sub={planSub(L.takeoff)} />
          <Stat size="sm" label={t("live.flight.landing")} value={fmtClock(f?.landingMs)} sub={planSub(L.landing)} />
          <Stat
            size="sm"
            label={t("live.flight.onBlock")}
            value={fmtClock(f?.onBlockMs)}
            sub={planSub(L.onBlock)}
            warn={pva.arrival?.status === "late" ? t("live.flight.onBlockLate", { punctuality: fmtPunctuality(pva.arrival) }) : null}
          />
        </div>
      </Collapsible>

      <Collapsible
        id="live.vsPlan"
        className="side-group"
        headClassName="side-group-title"
        title={ofp ? t("live.flight.vsPlan") : t("live.flight.flight")}
        summary={`${fmtDuration(blockMs)} · ${fmt(f?.distanceNm, 1, "nm")}`}
      >
        <div className="stat-grid cols-2">
          <Stat label={t("live.flight.blockTime")} value={fmtDuration(blockMs)} sub={planSub(L.block)} warn={L.block?.warn ?? null} />
          <Stat label={t("live.flight.airTime")} title={t("live.flight.airTimeTitle")} value={fmtDuration(flightMs)} sub={planSub(L.air)} />
          <Stat label={t("live.flight.distance")} value={fmt(f?.distanceNm, 1)} unit="nm" sub={planSub(L.distance)} />
          <Stat
            label={t("live.flight.fuelUsed")}
            value={fmtWeightNum(fuelUsed)}
            unit={weightUnit}
            sub={delta(L.landingFuel) ? t("live.flight.landingVsPlan", { delta: delta(L.landingFuel) ?? "" }) : planSub(L.blockFuel)}
            warn={L.landingFuel?.warn ?? null}
          />
          <Stat label={t("live.flight.maxAltitude")} value={fmt(f?.maxAltitudeMslFt, 0)} unit="ft" sub={planSub(L.cruise)} />
          <Stat label={t("live.flight.fuelOnBoard")} value={fmtWeightNum(tel?.fuelTotalKg)} unit={weightUnit} sub={planSub(L.landingFuel, "live.flight.planLanding")} />
          {liveMaxG(f?.gLoad) && <Stat label={t("gload.live.label")} title={liveMaxGTitle()} value={liveMaxG(f?.gLoad)} />}
        </div>
      </Collapsible>

      <Collapsible
        id="live.weather"
        className="side-group"
        headClassName="side-group-title"
        title={t("live.flight.weather")}
        summary={wxIcao ? `${wxIcao}${wx && wx.category !== "UNKNOWN" ? ` · ${wx.category}` : ""}` : undefined}
      >
        {wxIcao ? (
          <>
            <MetarInline icao={wxIcao} metar={wx} error={wxError} />
            {wx && <div className="metar-raw mono">{wx.raw}</div>}
          </>
        ) : (
          <div className="detail">{t("live.flight.noAirportWeather")}</div>
        )}
      </Collapsible>

      <Collapsible
        id="live.lastLanding"
        className="side-group"
        headClassName="side-group-title"
        aria-live="polite"
        title={t("live.flight.lastLanding")}
        summary={lastTd ? (isRated(lastTd) ? fmt(lastTd.landingRateFpm, 0, "fpm") : t("band.unrated")) : undefined}
        actions={
          lastTd && onOpenFlight ? (
            <button className="link-btn" onClick={onOpenFlight}>
              {t("live.flight.inLogbook")}
            </button>
          ) : undefined
        }
      >
        {lastTd ? (
          <div className="stat-grid cols-4">
            <Stat
              size="sm"
              label={t("live.flight.landingRate")}
              // unrated (slewed / fast-forwarded down): no value, "nicht bewertbar" below
              value={isRated(lastTd) ? fmt(lastTd.landingRateFpm, 0) : "–"}
              unit="fpm"
              sub={!isRated(lastTd) ? t("band.unrated") : lastTd.landingRateSource === "sim" ? t("live.flight.simValue") : t("live.flight.measured")}
              title={isRated(lastTd) ? undefined : t("band.unratedTitle")}
              warn={isRated(lastTd) && lastTd.landingRateFpm <= -600 ? t("live.flight.hardLanding", { rate: 600 }) : null}
            />
            <Stat size="sm" label={t("live.flight.measuredValue")} value={fmt(lastTd.vsFpmMeasured, 0)} unit="fpm" sub={t("live.flight.lastSample")} />
            <Stat
              size="sm"
              label={t("live.flight.gLoad")}
              value={fmt(lastTd.peakG, 2)}
              unit="g"
              warn={lastTd.peakG >= G_HARD ? t("live.flight.gHard", { g: fmtNum(G_HARD, 1), band: t("band.hard") }) : null}
            />
            <Stat size="sm" label={t("live.flight.bounces")} value={String(lastTd.bounces)} warn={lastTd.bounces > 0 ? t("count.bounces", { count: lastTd.bounces }) : null} />
          </div>
        ) : (
          <div className="detail">{t("live.flight.noLandingYet")}</div>
        )}
      </Collapsible>
    </div>
  );
}

// ---- side panel: Systeme -------------------------------------------------------------

function SystemsSection({ ofp }: { ofp: Ofp | null }) {
  const t = useT();
  const tel = useTelemetry();
  const f = useFlight();
  // re-render on a kg/lb switch even while no telemetry arrives (paused sim)
  usePrefs();
  // without telemetry the flight section above already says that the sim is not connected
  if (!tel) return null;
  const gear = tel.gearPct >= 99 ? t("live.systems.gearDown") : tel.gearPct <= 1 ? t("live.systems.gearUp") : t("live.systems.gearMoving", { pct: fmt(tel.gearPct, 0, "%") });
  const fuelUsed = f?.fuelStartKg != null ? f.fuelStartKg - (f.fuelEndKg ?? tel.fuelTotalKg) : null;
  const withMax = (value: number | null | undefined, max: number | null | undefined) => t("live.systems.withMax", { value: fmtWeight(value), max: fmtWeight(max) });
  return (
    <div className="side-stack">
      <Collapsible id="live.systems.config" className="side-group" headClassName="side-group-title" title={t("live.systems.config")} summary={gear}>
        <KV
          rows={[
            [t("live.systems.gear"), gear],
            [t("live.systems.flaps"), tel.flapsIndex === 0 ? t("live.systems.flapsUp") : t("live.systems.flapsStep", { step: tel.flapsIndex })],
            [t("live.systems.parkingBrake"), tel.parkingBrake ? t("live.systems.brakeSet") : t("live.systems.brakeReleased")],
            [t("live.systems.onGround"), tel.onGround ? t("live.systems.yes") : t("live.systems.no")],
            [t("live.systems.pitchBank"), `${fmt(tel.pitchDeg, 1, "°")} / ${fmt(tel.bankDeg, 1, "°")}`],
            [t("live.systems.gLoad"), fmt(tel.gForce, 2, "g")],
            [t("live.systems.transponder"), String(tel.transponderCode).padStart(4, "0")],
          ]}
        />
      </Collapsible>
      <Collapsible id="live.systems.enginesFuel" className="side-group" headClassName="side-group-title" title={t("live.systems.enginesFuel")} summary={fmtWeight(tel.fuelTotalKg)}>
        <KV
          rows={[
            [t("live.systems.engines"), t("live.systems.enginesRunning", { running: tel.enginesRunning, total: tel.numEngines })],
            [t("live.systems.fuel"), fmtWeight(tel.fuelTotalKg)],
            [t("live.systems.fuelUsed"), fmtWeight(fuelUsed)],
            ...(ofp ? ([[t("live.systems.planRampLanding"), `${fmtWeight(ofp.fuel.planRampKg)} / ${fmtWeight(ofp.fuel.planLandingKg)}`]] as Array<[string, string]>) : []),
          ]}
        />
      </Collapsible>
      <Collapsible id="live.systems.weights" className="side-group" headClassName="side-group-title" title={t("live.systems.weights")} summary={fmtWeight(tel.totalWeightKg)}>
        <KV
          rows={[
            [t("live.systems.grossWeight"), fmtWeight(tel.totalWeightKg)],
            ...(ofp
              ? ([
                  [t("live.systems.planTow"), withMax(ofp.weights.estTowKg, ofp.weights.maxTowKg)],
                  [t("live.systems.planLdw"), withMax(ofp.weights.estLdwKg, ofp.weights.maxLdwKg)],
                  [t("live.systems.planZfw"), fmtWeight(ofp.weights.estZfwKg)],
                ] as Array<[string, string]>)
              : []),
          ]}
        />
      </Collapsible>
      <Collapsible id="live.systems.lights" className="side-group" headClassName="side-group-title" title={t("live.systems.lights")} summary={t("live.section.lightsOn", { on: LIGHT_LABEL.filter(([k]) => tel.lights[k]).length, total: LIGHT_LABEL.length })}>
        <ul className="light-list">
          {LIGHT_LABEL.map(([k, label]) => (
            <li key={k} className={tel.lights[k] ? "on" : "off"}>
              <span className="light-dot" aria-hidden="true" />
              {t(label)}
              <span className="sr-only"> {tel.lights[k] ? t("live.systems.lightOn") : t("live.systems.lightOff")}</span>
            </li>
          ))}
        </ul>
      </Collapsible>
      <Collapsible id="live.systems.simulation" className="side-group" headClassName="side-group-title" title={t("live.systems.simulation")} summary={`${fmt(tel.simRate, 1, "×")}${tel.paused ? ` · ${t("live.systems.paused")}` : ""}`}>
        <KV
          rows={[
            [t("live.systems.simRate"), `${fmt(tel.simRate, 1, "×")}${tel.paused ? ` · ${t("live.systems.paused")}` : ""}`, tel.simRate > 1.01 ? t("live.systems.timeAccel") : null],
            [t("live.systems.slew"), tel.slew ? t("live.systems.active") : t("live.systems.off"), tel.slew ? t("live.systems.slewActive") : null],
            [t("live.systems.altitudeAgl"), fmt(tel.altitudeAglFt, 0, "ft")],
            ["TAS", fmt(tel.tasKt, 0, "kt")],
            [t("live.systems.trueCourse"), fmt(tel.headingTrueDeg, 0, "°")],
            [t("live.systems.position"), fmtCoord(tel.latitude, tel.longitude, 4)],
          ]}
        />
      </Collapsible>
    </div>
  );
}

// ---- recording status pill (map, top left) -------------------------------------------

function StatusPill({ rec, onTryDemo, short }: { rec: RecStatus; onTryDemo?: () => void; short?: boolean }) {
  const t = useT();
  const mark = rec.error ? "error" : rec.kind;
  return (
    <div className={`status-pill pill-${mark}`} role="status" title={rec.hint}>
      <span className={`dot dot-${mark}`} aria-hidden="true" />
      <span className="status-pill-text">{short ? waitingShort() : rec.text}</span>
      {rec.kind === "waiting" && onTryDemo && (
        <button className="link-btn" onClick={onTryDemo} title={t("live.ready.tryDemoTitle")}>
          {t("live.ready.startDemo", { demo: demoLabel() })}
        </button>
      )}
    </div>
  );
}
