import { type ComponentProps, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { UserAttentionType, getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import "./flows.css";
import "./a11y.css";
import Activities from "./Activities";
import Countries from "./countries/Countries.tsx";
import ErrorNotice from "./ErrorNotice";
import Fleet from "./Fleet";
import { onNavigate } from "./airframes/navigation";
import Logbook from "./Logbook";
import Settings from "./Settings";
import LiveView, { type LogLine } from "./live/LiveView";
import { useStoredState } from "./live/hooks";
import { Tabs } from "./ui/Tabs";
import Landings from "./Landings";
import { matchRunway } from "./live/progress";
import LandingDebrief from "./landing/LandingDebrief";
import { isDebriefOpen, openDebrief, useDebrief } from "./landing/debriefStore";
import { G_HARD } from "./landing/facts";
import { autoSaveCard, saveCardPng } from "./landing/exportCard";
import type { LandingDebriefData } from "./landing/types";
import { PHASE_LABEL, fmt, fmtDuration, privacy } from "./format";
import { getPrefs, initZoom, loadPrefs, setZoom, stepZoom } from "./prefs";
import { userMessage } from "./errors";
import { DEMO_LABEL, isDemo, recordingStatus } from "./status";
import type { AfterFlight } from "./live/AfterFlightCard";
import StatusButton, { type LastError } from "./ui/StatusButton";
import { getLiveState, resetLive, setFlight, setTelemetry, startTelemetryListeners, useRecFlight, useStats } from "./telemetryStore";
import TitleBar from "./ui/TitleBar";
import { ToastAnnouncer, ToastViewport, dismissToast, focusNewestToast, hasToast, showToast, type ToastOptions } from "./ui/Toast";
import { checkForUpdate, setRecordingCheck } from "./updater";
import { RESUME_TOAST_MS, resumeCandidate } from "./resume";
import { ask } from "@tauri-apps/plugin-dialog";
import type {
  AircraftInfo,
  Airport,
  FlightEvent,
  FlightRow,
  NearestAirport,
  NotifyKind,
  OnlineSummary,
  Ofp,
  ResumeCandidate,
  Runway,
  SimEvent,
  StatusSnapshot,
  TouchdownReport,
} from "./types";

type View = "live" | "logbook" | "countries" | "settings";
/** Sections of the logbook: flights, aircraft (fleet), airports, landings. */
type LogbookTab = "flights" | "aircraft" | "airports" | "landings";
const LOGBOOK_TABS: Array<{ id: LogbookTab; label: string }> = [
  { id: "flights", label: "Flüge" },
  { id: "aircraft", label: "Flugzeuge" },
  { id: "airports", label: "Flughäfen" },
  { id: "landings", label: "Landungen" },
];
const LOGBOOK_TAB_KEY = "vectasim.logbookTab";
const isLogbookTab = (v: string): v is LogbookTab => LOGBOOK_TABS.some((t) => t.id === v);

/** Icon sidebar: map, logbook (with its sections), countries, settings. */
const NAV: Array<{ view: View; label: string; key: string; icon: string }> = [
  { view: "live", label: "Karte", key: "1", icon: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" },
  { view: "logbook", label: "Logbuch", key: "2", icon: "M5 3h11l3 3v15H5zM8 9h8M8 13h8M8 17h5" },
  { view: "countries", label: "Länder", key: "3", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c-2.4 2.5-3.6 5.5-3.6 9s1.2 6.5 3.6 9M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9" },
  { view: "settings", label: "Einstellungen", key: "4", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4a8.5 8.5 0 0 0-.1-1.2l2.1-1.6-2-3.5-2.5 1a8.7 8.7 0 0 0-2.1-1.2L15.5 2h-7l-.4 2.5a8.7 8.7 0 0 0-2.1 1.2l-2.5-1-2 3.5 2.1 1.6a8.5 8.5 0 0 0 0 2.4l-2.1 1.6 2 3.5 2.5-1a8.7 8.7 0 0 0 2.1 1.2L8.5 22h7l.4-2.5a8.7 8.7 0 0 0 2.1-1.2l2.5 1 2-3.5-2.1-1.6c.1-.4.1-.8.1-1.2z" },
];

/** How long the landing notice stays on the map once the window has focus. */
const LANDING_TOAST_MS = 15_000;
/** A flight that ended longer ago than this is not "the flight you just finished" after a restart. */
const AFTER_FLIGHT_RESTORE_MS = 6 * 3600_000;
/** The OFP is fetched by itself at most this often (start, reconnects). */
const OFP_AUTO_MIN_INTERVAL_MS = 5 * 60_000;

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

/**
 * Windows notification for a toast the pilot cannot see (window in the background). The backend
 * checks the settings (Einstellungen → Integrationen) and the focus once more; landing, flight
 * saved and connection notices come from the backend itself.
 */
function notifyUnfocused(kind: NotifyKind, title: string, body: string) {
  if (document.hasFocus()) return;
  invoke("notify", { kind, title, body }).catch(() => {});
}

/** Flights the pilot answered "Flug fortsetzen?" for in this window (each is asked once). */
const resumeAnswered = new Set<string>();

/**
 * `flight:resumable`: after a crash the sim is back where an interrupted flight ended. Ask
 * whether to continue it; no answer within 60 s = the rest is a new flight (already recording).
 */
function offerResume(c: ResumeCandidate, demo: boolean) {
  const p = resumeCandidate(c, { demo, nowMs: Date.now(), answered: resumeAnswered });
  if (!p) return;
  const answer = () => resumeAnswered.add(c.flightId);
  requestAttention();
  showToast({
    id: p.id,
    tone: "info",
    title: p.title,
    body: p.body,
    durationMs: RESUME_TOAST_MS,
    actions: [
      {
        label: "Fortsetzen",
        onClick: () => {
          answer();
          invoke("resume_flight", { flightId: c.flightId })
            .then(() => showToast({ id: p.id, tone: "ok", title: "Flug wird fortgesetzt", body: "Die Aufzeichnung hängt an den unterbrochenen Flug an." }))
            .catch((e) => {
              const m = userMessage(e, "logbook");
              showToast({ id: p.id, tone: "warn", title: "Fortsetzen nicht möglich", body: m.detail || m.hint, durationMs: 8000 });
            });
        },
      },
      { label: "Neuer Flug", onClick: answer },
    ],
  });
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

type TouchdownOutcomeKind = Extract<FlightEvent, { kind: "touchdownOutcome" }>["outcome"];

/** Headline once the outcome is decided; `unknown` (stream broke off) leaves the toast as it is. */
function outcomeHeadline(o: TouchdownOutcomeKind): string | null {
  return o === "fullStop" ? "Gelandet" : o === "touchAndGo" ? "Touch-and-go" : null;
}

/**
 * The landing toast (id `landing`): shown neutral ("Aufgesetzt") at the touchdown report, its
 * headline replaced by "Gelandet" / "Touch-and-go" when the outcome follows. `build` rebuilds
 * the toast with another headline.
 */
let landingToast: { touchdownMs: number; build: (headline: string) => ToastOptions } | null = null;
/** An outcome that came before its toast was built (short roll: same sample as the report). */
let earlyOutcome: { touchdownMs: number; outcome: TouchdownOutcomeKind } | null = null;

function onTouchdownOutcome(touchdownMs: number, outcome: TouchdownOutcomeKind) {
  const headline = outcomeHeadline(outcome);
  if (!headline) return;
  if (landingToast?.touchdownMs === touchdownMs) {
    // dismissed or timed out: the outcome does not bring it back
    if (hasToast("landing")) showToast(landingToast.build(headline));
  } else {
    earlyOutcome = { touchdownMs, outcome };
  }
}

function describeFlightEvent(e: FlightEvent): string | null {
  switch (e.kind) {
    case "flightStarted":
      return "Flug begonnen (Off-Block)";
    case "flightEnded":
      return e.interrupted ? "Flug unterbrochen gespeichert" : "Flug gespeichert (On-Block)";
    case "phaseChanged":
      return `Phase: ${PHASE_LABEL[e.from]} → ${PHASE_LABEL[e.to]}`;
    case "touchdown":
      return `Landung ${fmt(e.landingRateFpm, 0, "fpm")}, ${fmt(e.peakG, 2, "g")}${e.bounces ? `, ${e.bounces} Bounce${e.bounces > 1 ? "s" : ""}` : ""}${e.touchAndGo ? ", Touch-and-go" : ""}`;
    case "touchdownOutcome":
      return e.outcome === "fullStop" ? "Landung bestätigt (Full-Stop)" : e.outcome === "touchAndGo" ? "Touch-and-go" : null;
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
  // telemetry, flight summary and data rate arrive up to 10×/s: they live in telemetryStore, the
  // root only follows what the recording status needs (state, off-block) – so the logbook,
  // settings and countries do not re-render with every sample
  const flight = useRecFlight();
  const [aircraft, setAircraft] = useState<AircraftInfo | null>(null);
  const [events, setEvents] = useState<LogLine[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [view, setView] = useState<View>("live");
  const [storedTab, setLogbookTab] = useStoredState<string>(LOGBOOK_TAB_KEY, "flights");
  const logbookTab: LogbookTab = isLogbookTab(storedTab) ? storedTab : "flights";
  const [ofp, setOfp] = useState<Ofp | null>(null);
  const [online, setOnline] = useState<OnlineSummary | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [lastSimError, setLastSimError] = useState<LastError | null>(null);
  /** "Nach dem Flug" card on the map: from on-block until the next off-block. */
  const [afterFlight, setAfterFlight] = useState<AfterFlight | null>(null);
  /** Flight the logbook should select (landing notice, "Details im Logbuch"); `n` re-triggers. */
  const [logbookFocus, setLogbookFocus] = useState<{ id: string; n: number } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const statusRef = useRef<StatusSnapshot | null>(null);
  const viewRef = useRef<View>("live");
  viewRef.current = view;
  const debriefOpen = useDebrief() != null;

  // Each view (and logbook section) keeps its own scroll position in the shared container:
  // back in the settings you are where you left them. Content that loads after the switch
  // (settings panels) gets a few frames to grow before the position is final.
  const scrollKey = view === "logbook" ? `logbook:${logbookTab}` : view;
  const scrollKeyRef = useRef(scrollKey);
  scrollKeyRef.current = scrollKey;
  const scrollPos = useRef<Record<string, number>>({});
  const restoring = useRef(false);
  const onMainScroll = () => {
    const m = mainRef.current;
    if (m && !restoring.current) scrollPos.current[scrollKeyRef.current] = m.scrollTop;
  };
  useLayoutEffect(() => {
    const m = mainRef.current;
    if (!m) return;
    const target = scrollPos.current[scrollKey] ?? 0;
    m.scrollTop = target;
    if (target <= 0) return;
    // panels that load after the switch grow the content (and scroll anchoring shifts it):
    // hold the position for up to 1.5 s, until the user scrolls, clicks or types
    restoring.current = true;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      restoring.current = false;
      m.removeEventListener("wheel", stop);
      m.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
    const timer = window.setTimeout(stop, 1500);
    const hold = () => {
      if (Math.abs(m.scrollTop - target) > 1) m.scrollTop = target;
      raf = requestAnimationFrame(hold);
    };
    m.addEventListener("wheel", stop, { passive: true });
    m.addEventListener("pointerdown", stop);
    window.addEventListener("keydown", stop);
    raf = requestAnimationFrame(hold);
    return stop;
  }, [scrollKey]);

  /** After Ctrl+1…4 the focus goes to the new view instead of falling back to <body>. */
  const focusViewRef = useRef(false);
  useEffect(() => {
    if (!focusViewRef.current) return;
    focusViewRef.current = false;
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);
  // the logbook stays mounted once opened: search, filters, selection and list scroll survive a view change
  const showFlights = view === "logbook" && logbookTab === "flights";
  const [keepLogbook, setKeepLogbook] = useState(false);
  if (showFlights && !keepLogbook) setKeepLogbook(true);

  const openFlight = useCallback(
    (id: string) => {
      setLogbookFocus((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
      setLogbookTab("flights");
      setView("logbook");
    },
    [setLogbookTab],
  );
  /** Airframe the fleet should select (flight detail → "In Flotte"). */
  const [fleetFocus, setFleetFocus] = useState<{ registration: string; n: number } | null>(null);
  useEffect(
    () =>
      onNavigate((t) => {
        if (t.kind === "flight") openFlight(t.id);
        else {
          setFleetFocus((prev) => ({ registration: t.registration, n: (prev?.n ?? 0) + 1 }));
          setLogbookTab("aircraft");
          setView("logbook");
        }
      }),
    [openFlight, setLogbookTab],
  );
  const openCurrentFlight = useCallback(() => {
    currentFlightId().then((id) => (id ? openFlight(id) : setView("logbook")));
  }, [openFlight]);

  // Global keys: Ctrl+1…4 switch views (not behind the debrief), Ctrl+Plus/Minus/0 zoom,
  // Alt+T jumps to the newest toast (also above the debrief).
  useEffect(() => {
    initZoom();
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
        if (focusNewestToast()) e.preventDefault();
        return;
      }
      // AltGr arrives as Ctrl+Alt ("²", "³", "~"): not a shortcut
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") {
        e.preventDefault();
        stepZoom(1);
        return;
      }
      if (e.key === "-" || e.code === "NumpadSubtract") {
        e.preventDefault();
        stepZoom(-1);
        return;
      }
      if (e.key === "0" || e.code === "Numpad0") {
        e.preventDefault();
        setZoom(1);
        return;
      }
      if (isDebriefOpen()) return;
      const item = NAV.find((n) => n.key === e.key);
      if (!item) return;
      e.preventDefault();
      focusViewRef.current = true;
      setView(item.view);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pushEvent = (text: string) => setEvents((prev) => [{ ms: Date.now(), text }, ...prev].slice(0, 40));

  // SimBrief without a click: the latest OFP for the saved pilot id, at start and when the
  // sim connects. Quiet unless something changed; failures are a toast, never a blocker.
  const ofpRef = useRef<Ofp | null>(null);
  ofpRef.current = ofp;
  const lastOfpAutoRef = useRef(0);
  const autoLoadOfp = useCallback(async () => {
    if (!getPrefs().simbriefAuto) return;
    if (Date.now() - lastOfpAutoRef.current < OFP_AUTO_MIN_INTERVAL_MS) return;
    lastOfpAutoRef.current = Date.now();
    try {
      const rows = await invoke<[string, string][]>("get_settings");
      if (!rows.find(([k]) => k === "simbrief_user")?.[1]) return;
      const o = await invoke<Ofp>("simbrief_fetch", { user: null });
      const changed = o.generatedAtS !== ofpRef.current?.generatedAtS;
      setOfp(o);
      if (changed)
        showToast({
          id: "ofp-auto",
          tone: "ok",
          title: "Flugplan geladen",
          body: `${privacy(o.callsign, "callsign")} · ${o.originIcao} → ${o.destinationIcao} · ${o.aircraftIcao}`,
          durationMs: 6000,
        });
    } catch (e) {
      const m = userMessage(e, "simbrief");
      showToast({ id: "ofp-auto", tone: "warn", title: "SimBrief-Flugplan nicht geladen", body: m.hint, durationMs: 8000 });
    }
  }, []);
  const autoLoadOfpRef = useRef(autoLoadOfp);
  autoLoadOfpRef.current = autoLoadOfp;

  // Closing or updating mid-flight ends the recording: ask first. The title-bar close button,
  // Alt+F4 and the taskbar all arrive here as a close request.
  useEffect(() => {
    const recording = () => getLiveState().flight?.state === "active" && !isDemo(statusRef.current);
    setRecordingCheck(recording);
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return; // browser preview without Tauri
    }
    const un = win
      .onCloseRequested(async (event) => {
        if (!recording()) return;
        const quit = await ask("Der Flug wird abgebrochen und im Logbuch als unterbrochen gespeichert.", {
          title: "Aufzeichnung läuft – trotzdem beenden?",
          kind: "warning",
          okLabel: "Beenden",
          cancelLabel: "Weiterfliegen",
        }).catch(() => true);
        if (!quit) event.preventDefault();
      })
      .catch(() => () => {});
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Hidden or minimised window: the backend throttles telemetry emits to 1 Hz (recording is unaffected).
  useEffect(() => {
    const push = () => void invoke("set_ui_visible", { visible: !document.hidden }).catch(() => {});
    document.addEventListener("visibilitychange", push);
    push();
    return () => document.removeEventListener("visibilitychange", push);
  }, []);

  // Quiet update check shortly after start; a dev build (vite) has no updater endpoint and just logs the error.
  // An update found while the window is in the background is also a Windows notification.
  useEffect(() => {
    const t = window.setTimeout(
      () =>
        void checkForUpdate({ silent: true }).then((u) => {
          if (u.phase === "available") notifyUnfocused("update", u.version ? `Update ${u.version} verfügbar` : "Update verfügbar", "Installieren unter Einstellungen → Updates.");
        }),
      10_000,
    );
    return () => window.clearTimeout(t);
  }, []);

  const onFlightEvent = useCallback(
    async (e: FlightEvent) => {
      const line = describeFlightEvent(e);
      if (line) pushEvent(line);
      if (e.kind === "touchdownOutcome") {
        onTouchdownOutcome(e.touchdownMs, e.outcome);
        return;
      }
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
          // optional: the landing card goes to the pictures folder by itself (setting card_autosave)
          if (done.landingRateFpm != null) void autoSaveCard(done.flightId);
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
      const rate = fmt(e.landingRateFpm, 0, "fpm");
      // neutral until the outcome is decided; a short-roll touch-and-go is decided in the report
      const early = earlyOutcome?.touchdownMs === e.timestampMs ? outcomeHeadline(earlyOutcome.outcome) : null;
      earlyOutcome = null;
      const build = (headline: string): ToastOptions => ({
        id: "landing",
        region: "map",
        announce: `${headline}${place ? ` ${place}` : ""}. Landerate ${rate}, g-Last ${fmt(e.peakG, 2)}, ${e.bounces} Bounces. Alt+T für die Landeauswertung.`,
        tone: hard ? "warn" : "ok",
        className: "toast-landing",
        durationMs: LANDING_TOAST_MS,
        holdWhileUnfocused: true,
        title: `${headline} · ${rate}${place ? ` · ${place}` : ""}`,
        body: (
          <div className="landing-values num">
            <span>
              <span className="detail">Landerate</span> <strong className={hard ? "warn-text" : undefined}>{rate}</strong>
            </span>
            <span>
              <span className="detail">g-Last</span> <strong className={e.peakG >= G_HARD ? "warn-text" : undefined}>{fmt(e.peakG, 2)}</strong>
            </span>
            <span>
              <span className="detail">Bounces</span> <strong className={e.bounces > 0 ? "warn-text" : undefined}>{e.bounces}</strong>
            </span>
          </div>
        ),
        actions: [
          { label: "Landeauswertung", onClick: () => (id ? openDebrief(id, null) : setView("logbook")) },
          ...(id
            ? [
                {
                  label: "Landekarte",
                  onClick: () =>
                    void invoke<LandingDebriefData>("landing_analysis", { flightId: id, touchdownIndex: null })
                      .then((d) => saveCardPng(d))
                      .catch((err) => showToast({ tone: "warn", title: "Landekarte nicht erstellt", body: userMessage(err, "export").hint })),
                },
              ]
            : []),
        ],
      });
      landingToast = { touchdownMs: e.timestampMs, build };
      showToast(build(early ?? (e.touchAndGo ? "Touch-and-go" : "Aufgesetzt")));
    },
    [],
  );
  const onFlightEventRef = useRef(onFlightEvent);
  onFlightEventRef.current = onFlightEvent;

  const onStatus = (s: StatusSnapshot) => {
    const prev = statusRef.current;
    statusRef.current = s;
    setStatus(s);
    // another provider (demo ended, demo started): its session starts empty, so does the view –
    // flight, telemetry (map marker), aircraft, the event list behind the "Flug n" badge, the
    // data rate and the "Nach dem Flug" card
    if (prev && prev.provider !== s.provider) {
      resetLive({ flight: s.flight ?? null, telemetry: s.lastTelemetry ?? null });
      setAircraft(s.aircraft ?? null);
      setAfterFlight(null);
      setEvents([]);
      setLastSimError(null);
      dismissToast("landing");
    }
    if (s.state === "disconnected") setAircraft(null);
    if (s.state === "error") setLastSimError({ detail: s.detail, ms: Date.now() });
    // connection lost mid-flight: reassure that nothing is lost; stays until the sim is back
    const active = getLiveState().flight?.state === "active";
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
    if (prev?.state !== "connected" && s.state === "connected" && !active) void autoLoadOfpRef.current();
  };
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    loadPrefs()
      .then(() => autoLoadOfpRef.current())
      .catch((e) => setAppError(String(e)));
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
      listen<AircraftInfo>("sim:aircraft", (e) => setAircraft(e.payload)),
      listen<SimEvent>("sim:event", (e) => pushEvent(describeSimEvent(e.payload))),
      listen<FlightEvent>("sim:flight-event", (e) => onFlightEventRef.current(e.payload)),
      listen<Ofp | null>("dispatch:ofp", (e) => setOfp(e.payload)),
      listen<OnlineSummary>("online:summary", (e) => setOnline(e.payload)),
      listen<ResumeCandidate>("flight:resumable", (e) => offerResume(e.payload, isDemo(statusRef.current))),
    ];
    // sim:telemetry / sim:flight / sim:stats go straight into telemetryStore; a frame still in
    // flight from the provider that was just stopped would put the old aircraft back on the
    // map, so telemetry only counts while a provider is connected
    const stopLive = startTelemetryListeners(() => {
      const st = statusRef.current;
      return !st || st.state === "connected";
    });
    return () => {
      stopLive();
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, []);

  const rec = recordingStatus(status, flight);
  const demo = isDemo(status);

  const selectProvider = (kind: string) => {
    setAppError(null);
    invoke("select_provider", { kind }).catch((e) => {
      // leaving the demo without a SimConnect build: nothing to switch to – that is the waiting state, not an error
      if (kind === "simconnect" && /unknown provider|nicht verfügbar|not available/i.test(String(e))) return;
      setAppError(String(e));
    });
  };
  const title = NAV.find((n) => n.view === view)?.label ?? "";
  const live = view === "live";

  return (
    <>
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
            <LiveStatusButton
              status={status}
              providers={providers}
              lastError={lastSimError}
              onSelectProvider={selectProvider}
              onOpenSettings={() => setView("settings")}
            />
          </aside>

          <main
            ref={mainRef}
            tabIndex={-1}
            onScroll={onMainScroll}
            aria-label={title}
            className={`layout${live ? " layout-live" : ""}${(view === "logbook" && (logbookTab === "flights" || logbookTab === "aircraft")) || view === "countries" ? " layout-fill" : ""}`}
          >
            {!live && (
              <header className="topbar">
                <h1>{title}</h1>
                {view === "logbook" && <Tabs tabs={LOGBOOK_TABS} active={logbookTab} onChange={setLogbookTab} idBase="logbook" label="Logbuch-Bereiche" className="topbar-tabs" />}
              </header>
            )}

            {demo && (
              <div className="demo-banner" role="status">
                <span className="badge badge-demo">Demo</span>
                <span>
                  <strong>Demo-Flug</strong> – die Flugdaten sind simuliert. Demo-Flüge bleiben nur bis zum Ende der Demo im Logbuch und werden dann gelöscht.
                </span>
                <div className="spacer" />
                {/* always offered: without a SimConnect provider it falls back to the waiting state */}
                <button className="btn btn-sm" onClick={() => selectProvider("simconnect")}>
                  {DEMO_LABEL} beenden
                </button>
              </div>
            )}

            {rec.error && status && <ErrorNotice error={status.detail} context="sim" compact={live} />}
            {appError && <ErrorNotice error={appError} onDismiss={() => setAppError(null)} compact={live} />}

            {(showFlights || keepLogbook) && <Logbook active={showFlights} focus={logbookFocus} onGoLive={() => setView("live")} />}
            {view === "logbook" && logbookTab === "aircraft" && <Fleet focus={fleetFocus} />}
            {view === "logbook" && logbookTab === "airports" && <Activities />}
            {view === "logbook" && logbookTab === "landings" && <Landings />}
            {view === "countries" && <Countries />}
            {view === "settings" && (
              <LiveSettings providers={providers} onProvider={selectProvider} online={online} status={status} ofp={ofp} />
            )}

            {/* always mounted: the map keeps camera, layers and track across view changes */}
            <LiveView
              active={live}
              aircraft={aircraft}
              ofp={ofp}
              onOfp={setOfp}
              online={online}
              events={events}
              onOpenFlight={openCurrentFlight}
              rec={rec}
              status={status}
              afterFlight={afterFlight}
              onAfterFlightLogbook={(id) => openFlight(id)}
              onAfterFlightDismiss={() => setAfterFlight(null)}
              onTryDemo={providers.includes("mock") ? () => selectProvider("mock") : undefined}
            />
          </main>
        </div>
      </div>
      {/* outside .shell: the debrief makes .shell-body inert, toasts stay reachable above it */}
      <LandingDebrief />
      <ToastViewport regions={live && !debriefOpen ? ["app"] : ["app", "map"]} placement="bottom-right" />
      <ToastAnnouncer />
    </>
  );
}

/**
 * The sidebar status button with the data rate (1 Hz) from telemetryStore: only the button
 * re-renders with it, not the root.
 */
function LiveStatusButton(props: Omit<ComponentProps<typeof StatusButton>, "flight" | "stats">) {
  const flight = useRecFlight();
  const stats = useStats();
  return <StatusButton {...props} flight={flight} stats={stats} />;
}

/** Settings with recording state and data rate from telemetryStore (re-renders 1×/s while open). */
function LiveSettings(props: Omit<ComponentProps<typeof Settings>, "flight" | "stats">) {
  const flight = useRecFlight();
  const stats = useStats();
  return <Settings {...props} flight={flight} stats={stats} />;
}
