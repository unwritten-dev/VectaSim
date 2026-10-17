import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { UserAttentionType, getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import Activities from "./Activities";
import ErrorNotice from "./ErrorNotice";
import Fleet from "./Fleet";
import { onNavigate } from "./airframes/navigation";
import Logbook from "./Logbook";
import Settings from "./Settings";
import LiveView, { type LogLine } from "./live/LiveView";
import { matchRunway } from "./live/progress";
import LandingDebrief from "./landing/LandingDebrief";
import { openDebrief } from "./landing/debriefStore";
import { PHASE_LABEL, fmt, fmtDuration } from "./format";
import { loadPrefs, usePrefs } from "./prefs";
import { isDemo, recordingStatus } from "./status";
import type { AfterFlight } from "./live/AfterFlightCard";
import StatusButton, { type LastError } from "./ui/StatusButton";
import TitleBar from "./ui/TitleBar";
import { ToastViewport, dismissToast, showToast } from "./ui/Toast";
import { checkForUpdate } from "./updater";
import type {
  AircraftInfo,
  Airport,
  FlightEvent,
  FlightRow,
  FlightSummary,
  NearestAirport,
  OnlineSummary,
  Ofp,
  Runway,
  SimEvent,
  Stats,
  StatusSnapshot,
  Telemetry,
  TouchdownReport,
} from "./types";

type View = "live" | "logbook" | "fleet" | "activities" | "settings";

/** Icon sidebar: map first, then logbook, fleet, activities, settings. */
const NAV: Array<{ view: View; label: string; key: string; icon: string }> = [
  { view: "live", label: "Karte", key: "1", icon: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" },
  { view: "logbook", label: "Logbuch", key: "2", icon: "M5 3h11l3 3v15H5zM8 9h8M8 13h8M8 17h5" },
  { view: "fleet", label: "Flotte", key: "3", icon: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" },
  { view: "activities", label: "Aktivitäten", key: "4", icon: "M12 2l2.9 6.3 6.9.7-5.2 4.7 1.5 6.8L12 17l-6.1 3.5 1.5-6.8L2.2 9l6.9-.7z" },
  { view: "settings", label: "Einstellungen", key: "5", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4a8.5 8.5 0 0 0-.1-1.2l2.1-1.6-2-3.5-2.5 1a8.7 8.7 0 0 0-2.1-1.2L15.5 2h-7l-.4 2.5a8.7 8.7 0 0 0-2.1 1.2l-2.5-1-2 3.5 2.1 1.6a8.5 8.5 0 0 0 0 2.4l-2.1 1.6 2 3.5 2.5-1a8.7 8.7 0 0 0 2.1 1.2L8.5 22h7l.4-2.5a8.7 8.7 0 0 0 2.1-1.2l2.5 1 2-3.5-2.1-1.6c.1-.4.1-.8.1-1.2z" },
];

/** How long the landing notice stays on the map once the window has focus. */
const LANDING_TOAST_MS = 15_000;
/** A flight that ended longer ago than this is not "the flight you just finished" after a restart. */
const AFTER_FLIGHT_RESTORE_MS = 6 * 3600_000;

function afterFlightOf(row: FlightRow): AfterFlight | null {
  if (row.state !== "completed" || !row.onBlockMs) return null;
  return {
    flightId: row.id,
    depIcao: row.depIcao,
    arrIcao: row.arrIcao,
    landingRateFpm: row.landingVsFpm,
    blockMs: row.offBlockMs ? row.onBlockMs - row.offBlockMs : null,
    onBlockMs: row.onBlockMs,
  };
}

/** Taskbar flashes once (Windows) / dock bounces (macOS) – the pilot is in the sim. */
function requestAttention() {
  getCurrentWindow()
    .requestUserAttention(UserAttentionType.Informational)
    // not available (browser preview, missing permission): the card on the map still shows it
    .catch(() => {});
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function describeSimEvent(e: SimEvent): string {
  switch (e.kind) {
    case "paused":
      return e.paused ? "Simulator pausiert" : "Simulator fortgesetzt";
    case "simRunning":
      return e.running ? "Simulation läuft" : "Simulation gestoppt (Menü)";
    case "crashed":
      return "Absturz erkannt";
    case "aircraftLoaded":
      return `Flugzeug geladen: ${baseName(e.path)}`;
    case "flightLoaded":
      return `Flug geladen: ${baseName(e.path)}`;
  }
}

function describeFlightEvent(e: FlightEvent): string {
  switch (e.kind) {
    case "flightStarted":
      return "Flug begonnen (Off-Block)";
    case "flightEnded":
      return "Flug gespeichert (On-Block)";
    case "phaseChanged":
      return `Phase: ${PHASE_LABEL[e.from]} → ${PHASE_LABEL[e.to]}`;
    case "touchdown":
      return `Landung ${fmt(e.landingRateFpm, 0, "fpm")}, ${fmt(e.peakG, 2, "G")}${e.bounces ? `, ${e.bounces} Bounce${e.bounces > 1 ? "s" : ""}` : ""}${e.touchAndGo ? ", Touch-and-go" : ""}`;
  }
}

/** Airport + runway of a touchdown, from the local airport DB (best effort). */
async function touchdownPlace(td: TouchdownReport): Promise<string | null> {
  try {
    const n = await invoke<NearestAirport | null>("nearest_airport", { lat: td.latitude, lon: td.longitude, maxNm: 3 });
    if (!n) return null;
    const d = await invoke<{ airport: Airport; runways: Runway[] } | null>("get_airport", { ident: n.airport.ident });
    const rwy = d ? matchRunway(td, d.runways) : null;
    return rwy ? `${n.airport.ident} · RWY ${rwy}` : n.airport.ident;
  } catch {
    return null;
  }
}

/** The running flight (the touchdown belongs to it), else the latest one. */
async function currentFlightId(): Promise<string | null> {
  try {
    const rows = await invoke<FlightRow[]>("list_flights", { limit: 5 });
    return (rows.find((r) => r.state === "active") ?? rows[0])?.id ?? null;
  } catch {
    return null;
  }
}

export default function App() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [flight, setFlight] = useState<FlightSummary | null>(null);
  const [aircraft, setAircraft] = useState<AircraftInfo | null>(null);
  const [events, setEvents] = useState<LogLine[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [view, setView] = useState<View>("live");
  const [ofp, setOfp] = useState<Ofp | null>(null);
  const [online, setOnline] = useState<OnlineSummary | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [lastSimError, setLastSimError] = useState<LastError | null>(null);
  /** "Nach dem Flug" card on the map: from on-block until the next off-block. */
  const [afterFlight, setAfterFlight] = useState<AfterFlight | null>(null);
  /** Flight the logbook should select (landing notice, "Details im Logbuch"); `n` re-triggers. */
  const [logbookFocus, setLogbookFocus] = useState<{ id: string; n: number } | null>(null);
  const prefs = usePrefs();
  const mainRef = useRef<HTMLElement>(null);
  const flightRef = useRef<FlightSummary | null>(null);
  flightRef.current = flight;
  const statusRef = useRef<StatusSnapshot | null>(null);
  const viewRef = useRef<View>("live");
  viewRef.current = view;

  // each view starts at the top (the scroll container is shared)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const openFlight = useCallback((id: string) => {
    setLogbookFocus((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
    setView("logbook");
  }, []);
  /** Airframe the fleet should select (flight detail → "In Flotte"). */
  const [fleetFocus, setFleetFocus] = useState<{ registration: string; n: number } | null>(null);
  useEffect(
    () =>
      onNavigate((t) => {
        if (t.kind === "flight") openFlight(t.id);
        else {
          setFleetFocus((prev) => ({ registration: t.registration, n: (prev?.n ?? 0) + 1 }));
          setView("fleet");
        }
      }),
    [openFlight],
  );
  const openCurrentFlight = useCallback(() => {
    currentFlightId().then((id) => (id ? openFlight(id) : setView("logbook")));
  }, [openFlight]);

  // Ctrl+1…5 switch views (also used by the screenshot tooling)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const item = NAV.find((n) => n.key === e.key);
      if (item) setView(item.view);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pushEvent = (text: string) => setEvents((prev) => [{ ms: Date.now(), text }, ...prev].slice(0, 40));

  // Quiet update check shortly after start; a dev build (vite) has no updater endpoint and just logs the error.
  useEffect(() => {
    const t = window.setTimeout(() => void checkForUpdate({ silent: true }), 10_000);
    return () => window.clearTimeout(t);
  }, []);

  const onFlightEvent = useCallback(
    async (e: FlightEvent) => {
      pushEvent(describeFlightEvent(e));
      if (e.kind === "flightStarted") {
        setAfterFlight(null);
        return;
      }
      if (e.kind === "flightEnded") {
        requestAttention();
        try {
          const rows = await invoke<FlightRow[]>("list_flights", { limit: 1 });
          const done = rows[0] ? afterFlightOf(rows[0]) : null;
          if (!done) return;
          setAfterFlight(done);
          // the card carries the landing now; one notice is enough
          dismissToast("landing");
          // on the map the card says it; elsewhere a toast points to it
          if (viewRef.current !== "live")
            showToast({
              id: "flight-saved",
              tone: "ok",
              title: `Flug gespeichert · ${done.depIcao ?? "····"} → ${done.arrIcao ?? "····"} · ${fmtDuration(done.blockMs, { seconds: false })}`,
              durationMs: LANDING_TOAST_MS,
              holdWhileUnfocused: true,
              actions: done.landingRateFpm != null ? [{ label: "Landeauswertung", onClick: () => openDebrief(done.flightId, null) }] : undefined,
            });
        } catch {
          /* logbook not readable right now: the event line under Details → Ereignisse remains */
        }
        return;
      }
      if (e.kind !== "touchdown") return;
      const [place, id] = await Promise.all([touchdownPlace(e), currentFlightId()]);
      const hard = e.landingRateFpm <= -600;
      showToast({
        id: "landing",
        region: "map",
        tone: hard ? "warn" : "ok",
        className: "toast-landing",
        durationMs: LANDING_TOAST_MS,
        holdWhileUnfocused: true,
        title: `${e.touchAndGo ? "Touch-and-go" : "Gelandet"}${place ? ` · ${place}` : ""}`,
        body: (
          <div className="landing-values num">
            <span>
              <span className="detail">Landerate</span> <strong className={hard ? "warn-text" : undefined}>{fmt(e.landingRateFpm, 0, "fpm")}</strong>
            </span>
            <span>
              <span className="detail">G-Last</span> <strong className={e.peakG > 1.75 ? "warn-text" : undefined}>{fmt(e.peakG, 2)}</strong>
            </span>
            <span>
              <span className="detail">Bounces</span> <strong className={e.bounces > 0 ? "warn-text" : undefined}>{e.bounces}</strong>
            </span>
          </div>
        ),
        actions: [{ label: "Landeauswertung", onClick: () => (id ? openDebrief(id, null) : setView("logbook")) }],
      });
    },
    [openFlight],
  );
  const onFlightEventRef = useRef(onFlightEvent);
  onFlightEventRef.current = onFlightEvent;

  const onStatus = (s: StatusSnapshot) => {
    const prev = statusRef.current;
    statusRef.current = s;
    setStatus(s);
    if (s.state === "disconnected") setAircraft(null);
    if (s.state === "error") setLastSimError({ detail: s.detail, ms: Date.now() });
    // connection lost mid-flight: reassure that nothing is lost; stays until the sim is back
    const active = flightRef.current?.state === "active";
    if (prev?.state === "connected" && (s.state === "disconnected" || s.state === "error") && active) {
      showToast({
        id: "conn",
        tone: "warn",
        title: "Sim weg – Flug gesichert",
        body: "Dein Flug ist gesichert und läuft weiter, sobald der Simulator zurück ist.",
        durationMs: null,
      });
    } else if (prev && prev.state !== "connected" && s.state === "connected" && active) {
      showToast({ id: "conn", tone: "ok", title: "Simulator wieder da", body: "Die Aufzeichnung läuft weiter.", durationMs: 5000 });
    }
  };
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    loadPrefs().catch((e) => setAppError(String(e)));
    invoke<StatusSnapshot>("get_status")
      .then((s) => {
        statusRef.current = s;
        setStatus(s);
        if (s.lastTelemetry) setTelemetry(s.lastTelemetry);
        if (s.aircraft) setAircraft(s.aircraft);
        if (s.flight) setFlight(s.flight);
        // restart after a finished flight: the card stays until the next off-block
        if (s.flight?.state !== "active")
          invoke<FlightRow[]>("list_flights", { limit: 1 })
            .then((rows) => {
              const done = rows[0] ? afterFlightOf(rows[0]) : null;
              if (done && Date.now() - done.onBlockMs < AFTER_FLIGHT_RESTORE_MS) setAfterFlight((cur) => cur ?? done);
            })
            .catch(() => {});
      })
      .catch((e) => setAppError(String(e)));
    invoke<string[]>("list_providers")
      .then(setProviders)
      .catch((e) => setAppError(String(e)));
    // no OFP loaded is the normal state; a failure here means the same for the user
    invoke<Ofp | null>("get_current_ofp").then(setOfp).catch(() => {});
    // the online panel shows "VATSIM aus" until the first summary arrives
    invoke<OnlineSummary>("online_summary").then(setOnline).catch(() => {});

    const unlisteners = [
      listen<StatusSnapshot>("sim:status", (e) => onStatusRef.current(e.payload)),
      listen<Telemetry>("sim:telemetry", (e) => setTelemetry(e.payload)),
      listen<FlightSummary>("sim:flight", (e) => setFlight(e.payload)),
      listen<AircraftInfo>("sim:aircraft", (e) => setAircraft(e.payload)),
      listen<SimEvent>("sim:event", (e) => pushEvent(describeSimEvent(e.payload))),
      listen<FlightEvent>("sim:flight-event", (e) => onFlightEventRef.current(e.payload)),
      listen<Stats>("sim:stats", (e) => setStats(e.payload)),
      listen<Ofp | null>("dispatch:ofp", (e) => setOfp(e.payload)),
      listen<OnlineSummary>("online:summary", (e) => setOnline(e.payload)),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  const rec = recordingStatus(status, flight);
  const demo = isDemo(status);

  const selectProvider = (kind: string) => {
    setAppError(null);
    invoke("select_provider", { kind }).catch((e) => setAppError(String(e)));
  };
  const title = NAV.find((n) => n.view === view)?.label ?? "";
  const live = view === "live";

  return (
    <div className="shell">
      <TitleBar rec={rec} />
      <div className="shell-body">
        <aside className="sidebar">
          <nav className="nav" aria-label="Ansichten">
            {NAV.map((n) => (
              <button
                key={n.view}
                className={`nav-btn${view === n.view ? " active" : ""}`}
                onClick={() => setView(n.view)}
                title={`${n.label} (Strg+${n.key})`}
                aria-label={n.label}
                aria-current={view === n.view ? "page" : undefined}
              >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
                  <path d={n.icon} />
                </svg>
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <StatusButton
            status={status}
            flight={flight}
            stats={stats}
            providers={providers}
            lastError={lastSimError}
            onSelectProvider={selectProvider}
            onOpenSettings={() => setView("settings")}
          />
        </aside>

        <main ref={mainRef} className={`layout${live ? " layout-live" : ""}${view === "logbook" || view === "fleet" ? " layout-fill" : ""}`}>
          {!live && (
            <header className="topbar">
              <h1>{title}</h1>
            </header>
          )}

          {demo && (
            <div className="demo-banner" role="status">
              <span className="badge badge-demo">Demo</span>
              <span>
                <strong>Demo-Flug</strong> – die Flugdaten sind simuliert.{" "}
                {prefs.showDemo
                  ? "Demo-Flüge zählen in Summen, Flotte und Aktivitäten mit."
                  : "Demo-Flüge sind im Logbuch ausgeblendet und zählen nicht in Summen, Flotte und Aktivitäten."}
              </span>
              <div className="spacer" />
              {providers.includes("simconnect") && (
                <button className="btn btn-sm" onClick={() => selectProvider("simconnect")}>
                  Demo beenden
                </button>
              )}
            </div>
          )}

          {rec.error && status && <ErrorNotice error={status.detail} context="sim" compact={live} />}
          {appError && <ErrorNotice error={appError} onDismiss={() => setAppError(null)} compact={live} />}

          {view === "logbook" && <Logbook focus={logbookFocus} onGoLive={() => setView("live")} />}
          {view === "fleet" && <Fleet focus={fleetFocus} />}
          {view === "activities" && <Activities />}
          {view === "settings" && (
            <Settings providers={providers} onProvider={selectProvider} online={online} status={status} flight={flight} stats={stats} ofp={ofp} />
          )}

          {live && (
            <LiveView
              telemetry={telemetry}
              flight={flight}
              aircraft={aircraft}
              ofp={ofp}
              onOfp={setOfp}
              online={online}
              events={events}
              onOpenFlight={openCurrentFlight}
              rec={rec}
              afterFlight={afterFlight}
              onAfterFlightLogbook={(id) => openFlight(id)}
              onAfterFlightDismiss={() => setAfterFlight(null)}
              onTryDemo={providers.includes("mock") ? () => selectProvider("mock") : undefined}
            />
          )}
        </main>
      </div>
      <ToastViewport regions={live ? ["app"] : ["app", "map"]} placement="bottom-right" />
      <LandingDebrief />
    </div>
  );
}
