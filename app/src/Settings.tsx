import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealPath } from "./revealPath";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { desktopDir, join } from "@tauri-apps/api/path";
import type {
  BackupEntry,
  BackupInfo,
  BundleExportReport,
  BundleImportReport,
  BundleManifest,
  CardDirInfo,
  DebugModeInfo,
  DiagPackageInfo,
  DumpInfo,
  FlightSummary,
  LogLevelInfo,
  Network,
  OnlineSummary,
  Ofp,
  ReplaySettings,
  Stats,
  StatusSnapshot,
  WipeResult,
  SimTextTestResult,
} from "./types";
import { fmt, fmtClock, fmtDate } from "./i18n/number";
import { useT, type TFunction, type TKey } from "./i18n";
import ErrorNotice from "./ErrorNotice";
import CsvImportDialog from "./CsvImport";
import { ZOOM_STEPS, setPref, setZoom, stepZoom, togglePrivacyMode, usePrefs, usePrivacy, useZoom, type Prefs } from "./prefs";
import { isDemo, isSimMissing, providerLabel, recordingStatus } from "./status";
import { triedDllPaths, userMessage } from "./errors";
import { showToast } from "./ui/Toast";
import Panel from "./ui/Panel";
import { KV } from "./ui/Stat";
import { checkForUpdate, installUpdate, useUpdateState } from "./updater";
import { OWN_AIRCRAFT, THEMES, type ThemeId } from "./themes";
import LiveRawData from "./LiveRawData";
import IntegrationsPanel from "./IntegrationsPanel";
import ServerPanel from "./ServerPanel";
import ApproachProfilesPanel from "./ApproachProfilesPanel";
import { REPLAY_SPEEDS, diagPackageName, fmtBytes } from "./rawDiag";
import SimConnectDownload from "./SimConnectDownload";
import SimulatorSelect from "./SimulatorSelect";
import { statusLine as serverStatusLine, type ServerStatus } from "./serverLinks";
import { useGlobe } from "./map/projection";
import { useMapStyle } from "./map/satellite";
import { NETWORK_LABEL, networkStatuses, networksWith, onlineDiagRows, onlineLine, onlineTone } from "./onlineText";
import { errorToast } from "./ui/errorToast";
import { Segmented } from "./ui/Segmented";

interface Props {
  providers: string[];
  onProvider: (kind: string) => void;
  online: OnlineSummary | null;
  status: StatusSnapshot | null;
  flight: FlightSummary | null;
  stats: Stats | null;
  ofp: Ofp | null;
}

interface AppInfo {
  version: string;
  dataDir: string;
  dbPath: string;
  simconnectDll?: string | null;
  /** Where that DLL comes from ("von VectaSim heruntergeladen (MSFS SDK)", "MSFS SDK", …). */
  simconnectDllSource?: string | null;
}

const SETTING_DLL = "simconnect_dll_path";
/** Active log file inside the folder from `log_dir` (tauri-plugin-log appends `.log`). */
const LOG_FILE = "vectasim.log";
const LOG_LEVELS: Array<{ id: string; label: TKey }> = [
  { id: "info", label: "settings.diag.logLevel.info" },
  { id: "debug", label: "settings.diag.logLevel.debug" },
  { id: "trace", label: "settings.diag.logLevel.trace" },
];
/** Language choice in Anzeige (setting `language`): the language names stay in their own language. */
const LANGUAGE_OPTIONS = [
  { value: "system", label: "settings.display.language.system" },
  { value: "de", label: "settings.display.language.de" },
  { value: "en", label: "settings.display.language.en" },
] as const satisfies ReadonlyArray<{ value: Prefs["language"]; label: TKey }>;

const CONN_STATES = ["idle", "connecting", "connected", "disconnected", "error"] as const;
/** Connection state for the Diagnose row: one of the known ones, else "idle". */
function connState(s: string | null | undefined): (typeof CONN_STATES)[number] {
  return (CONN_STATES as readonly string[]).includes(s ?? "") ? (s as (typeof CONN_STATES)[number]) : "idle";
}

/** Backend DllSource labels (German, vectasim-simconnect ffi.rs) → UI language. */
const DLL_SOURCE: Record<string, TKey> = {
  "manuell gewählt": "settings.diag.dllSource.override",
  "von VectaSim heruntergeladen (MSFS SDK)": "settings.diag.dllSource.downloaded",
  "neben vectasim.exe": "settings.diag.dllSource.exeDir",
  "MSFS SDK": "settings.diag.dllSource.sdk",
  "Windows-Suchpfad": "settings.diag.dllSource.searchPath",
};
function dllSourceLabel(source: string, t: TFunction): string {
  const key = DLL_SOURCE[source];
  return key ? t(key) : source;
}

/** "info" → "Normal": the same names as the Protokollstufe select below the table. */
function logLevelName(level: string, t: TFunction): string {
  const l = LOG_LEVELS.find((x) => x.id === level);
  return l ? t(l.label) : level;
}

/** One Diagnose line: label, plain text (for „Diagnose kopieren“), optional rich value. */
type DiagRow = { label: string; text: string; node?: ReactNode };

function joinPath(dir: string, file: string): string {
  return /[\\/]$/.test(dir) ? `${dir}${file}` : `${dir}\\${file}`;
}

type Tone = "ok" | "warn" | "off" | "err" | "info";

/** Status line of an integration: colour + symbol + text. */
function IntegrationStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  const sym = { ok: "✓", warn: "▲", off: "○", err: "!", info: "◆" }[tone];
  return (
    <div className={`integration integration-${tone}`}>
      <span className="integration-icon" aria-hidden="true">
        {sym}
      </span>
      <span>{children}</span>
    </div>
  );
}

const THIRD_PARTY_NOTICES_URL = "https://github.com/unwritten-dev/VectaSim/blob/main/THIRD-PARTY-NOTICES.md";

/**
 * Settings, reduced to what cannot be detected (everything else is automatic): Simulator · Flugplanung ·
 * Anzeige · Daten, then Updates and a collapsed Diagnose section for support.
 */
export default function Settings({ providers, onProvider, online, status, flight, stats, ofp }: Props) {
  const t = useT();
  const [simbriefUser, setSimbriefUser] = useState("");
  const [storedUser, setStoredUser] = useState("");
  const [savedMark, setSavedMark] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefs = usePrefs();
  const priv = usePrivacy();
  /** Paths as shown (and copied) – without the user name in the Streamer-Modus. */
  const mp = (s: string) => priv.mask(s, "path");
  const rec = recordingStatus(status, flight);
  const demo = isDemo(status);
  const upd = useUpdateState();

  const [dllPath, setDllPath] = useState("");
  const [dllNote, setDllNote] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [logLevel, setLogLevel] = useState<LogLevelInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [dump, setDump] = useState<DumpInfo | null>(null);
  const [replay, setReplay] = useState<ReplaySettings>({ path: null, speed: 1, repeat: false });
  const [debugMode, setDebugMode] = useState<boolean | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [packing, setPacking] = useState(false);
  const [netBusy, setNetBusy] = useState(false);
  /** Overlay server, for its Diagnose row (the panel itself polls on its own). */
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [globe, setGlobe] = useGlobe();
  const [mapStyle, setMapStyle] = useMapStyle();

  const loadInfo = () =>
    invoke<AppInfo>("app_info")
      .then(setInfo)
      // diagnostics only; the rows show "–" without it
      .catch(() => {});

  useEffect(() => {
    invoke<[string, string][]>("get_settings")
      .then((rows) => {
        const u = rows.find(([k]) => k === "simbrief_user")?.[1] ?? "";
        setSimbriefUser(u);
        setStoredUser(u);
        setDllPath(rows.find(([k]) => k === SETTING_DLL)?.[1] ?? "");
      })
      .catch((e) => setError(String(e)));
    void loadInfo();
    invoke<string>("log_dir")
      .then(setLogDir)
      .catch(() => {});
    invoke<LogLevelInfo>("get_log_level")
      .then(setLogLevel)
      .catch(() => {});
    invoke<DumpInfo>("dump_info")
      .then(setDump)
      .catch(() => {});
    invoke<ReplaySettings>("get_replay")
      .then(setReplay)
      .catch(() => {});
    invoke<DebugModeInfo>("get_debug_mode")
      .then((d) => setDebugMode(d.on))
      .catch(() => {});
    invoke<ServerStatus>("server_status")
      .then(setServer)
      // diagnostics only; the row shows "–" without it
      .catch(() => {});
  }, []);

  // Debug-Modus switched from the tray menu: follow it (log level and dump change with it)
  useEffect(() => {
    const un = listen<boolean>("debug:changed", (e) => {
      setDebugMode(e.payload);
      invoke<DebugModeInfo>("get_debug_mode")
        .then((d) => {
          setDebugMode(d.on);
          setLogLevel(d.log);
          setDump(d.dump);
        })
        .catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const toggleDebugMode = (on: boolean) => {
    setDebugBusy(true);
    invoke<DebugModeInfo>("set_debug_mode", { on })
      .then((d) => {
        setDebugMode(d.on);
        setLogLevel(d.log);
        setDump(d.dump);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setDebugBusy(false));
  };

  const createDiagPackage = async () => {
    const name = diagPackageName(new Date());
    let defaultPath = name;
    try {
      defaultPath = await join(await desktopDir(), name);
    } catch {
      // no desktop folder: the dialog opens in its own default folder
    }
    let target: string | null;
    try {
      target = await saveFileDialog({ title: t("settings.diag.package.saveTitle"), defaultPath, filters: [{ name: t("settings.diag.package.zip"), extensions: ["zip"] }] });
    } catch (e) {
      showToast({ tone: "err", ...errorToast(t("settings.diag.package.failed"), e, "settings") });
      return;
    }
    if (!target) return;
    setPacking(true);
    try {
      const pkg = await invoke<DiagPackageInfo>("create_diag_package", { targetPath: target });
      showToast({
        tone: "ok",
        title: t("settings.diag.package.saved"),
        body: `${mp(pkg.path)} · ${fmtBytes(pkg.bytes)} · ${t("settings.diag.package.files", { count: pkg.files.length })}`,
        durationMs: 12000,
        actions: [{ label: t("settings.openFolder"), onClick: () => void revealPath(pkg.path).catch(() => {}) }],
      });
    } catch (e) {
      showToast({ tone: "err", ...errorToast(t("settings.diag.package.failed"), e, "settings") });
    } finally {
      setPacking(false);
    }
  };

  const toggleDump = (on: boolean) =>
    invoke<DumpInfo>("set_raw_dump", { on })
      .then(setDump)
      .catch((e) => setError(String(e)));

  const dumpNow = () =>
    invoke<string>("dump_now")
      .then((path) => {
        showToast({ tone: "ok", title: t("settings.diag.dump.saved"), body: mp(path), durationMs: 6000 });
        void revealPath(path).catch(() => {});
        invoke<DumpInfo>("dump_info").then(setDump).catch(() => {});
      })
      .catch((e) => showToast({ tone: "warn", ...errorToast(t("settings.diag.dump.notSaved"), e, "settings"), durationMs: 6000 }));

  const chooseReplay = async () => {
    try {
      const picked = await openFileDialog({
        title: t("settings.diag.replay.pickTitle"),
        multiple: false,
        directory: false,
        defaultPath: dump?.dir || undefined,
        filters: [{ name: t("settings.diag.replay.fileType"), extensions: ["vsdump"] }],
      });
      if (typeof picked === "string" && picked) setReplay((r) => ({ ...r, path: picked }));
    } catch (e) {
      setError(String(e));
    }
  };

  const startReplay = () =>
    invoke("set_replay", { path: replay.path ?? null, speed: replay.speed, repeat: replay.repeat })
      .then(() => onProvider("replay"))
      .catch((e) => setError(String(e)));

  const applyDll = (path: string | null) =>
    invoke<boolean>("set_simconnect_dll", { path })
      .then((restarted) => {
        setDllPath(path ?? "");
        setDllNote(restarted ? t("settings.sim.dll.savedRestart") : t("settings.sim.dll.savedLater"));
        window.setTimeout(() => setDllNote(null), 4000);
        void loadInfo();
      })
      .catch((e) => setError(String(e)));

  const chooseDll = async () => {
    try {
      const picked = await openFileDialog({
        title: t("settings.sim.dll.pickTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: "SimConnect.dll", extensions: ["dll"] }],
      });
      if (typeof picked === "string" && picked) await applyDll(picked);
    } catch (e) {
      setError(String(e));
    }
  };

  const changeLogLevel = (level: string) =>
    invoke("set_log_level", { level })
      .then(() => setLogLevel((cur) => ({ envOverride: cur?.envOverride ?? null, level })))
      .catch((e) => setError(String(e)));

  const saveUser = () => {
    const v = simbriefUser.trim();
    if (v === storedUser) return;
    invoke("set_setting", { key: "simbrief_user", value: v })
      .then(() => {
        setStoredUser(v);
        // confirmed inline at the field, not with a toast
        setSavedMark(true);
        window.setTimeout(() => setSavedMark(false), 2500);
      })
      .catch((e) => setError(String(e)));
  };

  const toggle = (key: keyof Prefs, value: boolean) => setPref(key, value).catch((e) => setError(String(e)));
  // "Send test message" into the sim (SimConnect_Text), answered by the running session
  const [simTextBusy, setSimTextBusy] = useState(false);
  const [simTextResult, setSimTextResult] = useState<SimTextTestResult | null>(null);
  const simTextTest = async () => {
    setSimTextBusy(true);
    setSimTextResult(null);
    try {
      setSimTextResult(await invoke<SimTextTestResult>("sim_text_test"));
    } catch (e) {
      setError(String(e));
    } finally {
      setSimTextBusy(false);
    }
  };
  const simTextResultText = (r: SimTextTestResult) =>
    r.status === "sent"
      ? t("settings.sim.textTestSent")
      : r.status === "rejected"
        ? t("settings.sim.textTestRejected", { code: r.hresult })
        : r.status === "exception"
          ? t("settings.sim.textTestException", { name: r.name, code: r.code })
          : t("settings.sim.textTestNoSession");
  /** Switch one network; the summary comes back via `online:summary` (App state). */
  const setNetwork = (network: Network, on: boolean) => {
    setNetBusy(true);
    invoke<OnlineSummary>("online_set_networks", { networks: networksWith(online, network, on) })
      .catch((e) => {
        const m = userMessage(e, network);
        showToast({
          id: "settings-network",
          tone: "warn",
          title: on ? t("settings.display.online.notOn", { name: NETWORK_LABEL[network] }) : t("settings.display.online.notOff", { name: NETWORK_LABEL[network] }),
          body: `${m.title} ${m.hint}`,
          durationMs: 8000,
        });
      })
      .finally(() => setNetBusy(false));
  };
  const reveal = (path: string) => revealPath(path).catch((e) => setError(String(e)));
  const recTone: Tone = rec.error ? "err" : rec.kind === "ready" || rec.kind === "recording" ? "ok" : rec.kind === "suspended" ? "warn" : rec.kind === "demo" ? "info" : "off";
  const recording = flight?.state === "active" && !demo;
  const logFile = logDir ? joinPath(logDir, LOG_FILE) : null;
  const dllMissing = isSimMissing(status?.detail ?? "");
  const tried = dllMissing ? triedDllPaths(status?.detail ?? "") : [];
  const mono = (s: string) => <span className="mono">{mp(s)}</span>;

  const diag: DiagRow[] = [
    { label: t("settings.simulator.label"), text: providerLabel(status?.provider) },
    { label: t("settings.diag.row.status"), text: `${rec.label} · ${t(`settings.diag.state.${connState(status?.state)}`)}` },
    { label: t("settings.diag.row.simVersion"), text: status?.simName ? `${status.simName} ${status.simVersion ?? ""}`.trim() : "–" },
    { label: t("shell.statusButton.dataRate"), text: stats ? fmt(stats.rateHz, 1, "Hz") : "–" },
    { label: t("settings.diag.row.frames"), text: fmt(stats?.frames ?? status?.frames ?? 0) },
    info?.simconnectDll
      ? {
          label: "SimConnect.dll",
          text: `${mp(info.simconnectDll)}${info.simconnectDllSource ? ` (${dllSourceLabel(info.simconnectDllSource, t)})` : ""}`,
          node: (
            <span className="diag-paths">
              {mono(info.simconnectDll)}
              {info.simconnectDllSource && <span className="detail">{dllSourceLabel(info.simconnectDllSource, t)}</span>}
            </span>
          ),
        }
      : { label: "SimConnect.dll", text: info ? t("settings.diag.row.dllNotFound") : "–" },
    ...(dllPath ? [{ label: t("settings.diag.row.dllChosen"), text: mp(dllPath), node: mono(dllPath) }] : []),
    ...(tried.length
      ? [
          {
            label: t("settings.diag.row.searched"),
            text: tried.map(mp).join("; "),
            node: (
              <span className="diag-paths">
                {tried.map((p) => (
                  <span key={p} className="mono">
                    {mp(p)}
                  </span>
                ))}
              </span>
            ),
          },
        ]
      : []),
    { label: t("settings.diag.row.logs"), text: logFile ? mp(logFile) : "–", node: logFile ? mono(logFile) : undefined },
    {
      label: t("settings.diag.row.dump"),
      text: dump?.status.file
        ? t("settings.diag.row.dumpFile", { file: mp(dump.status.file), size: fmtBytes(dump.status.fileBytes) })
        : dump?.enabled || debugMode
          ? t("settings.diag.row.dumpOn", { dir: dump?.dir ? mp(dump.dir) : "–" })
          : t("online.diag.off"),
      node: dump?.status.file ? mono(dump.status.file) : undefined,
    },
    {
      label: t("settings.diag.row.logLevel"),
      text: logLevel
        ? logLevel.envOverride
          ? `RUST_LOG=${logLevel.envOverride}`
          : debugMode
            ? t("settings.diag.row.logLevelDebug", { level: logLevelName(logLevel.level, t) })
            : logLevelName(logLevel.level, t)
        : "–",
    },
    { label: t("settings.server.title"), text: server ? serverStatusLine(server, Date.now()).text : "–" },
    { label: t("nav.logbook"), text: info ? mp(info.dbPath) : "–", node: info ? mono(info.dbPath) : undefined },
    { label: t("settings.diag.row.appData"), text: info ? mp(info.dataDir) : "–", node: info ? mono(info.dataDir) : undefined },
    { label: t("settings.diag.row.appVersion"), text: info?.version ?? "–" },
    ...onlineDiagRows(online),
    ...(priv.on ? [{ label: t("settings.display.privacy.label"), text: t("settings.diag.row.privacy") }] : []),
    ...(status?.detail && status.state !== "connected" ? [{ label: t("settings.diag.row.message"), text: mp(status.detail), node: mono(status.detail) }] : []),
  ];

  const copyDiagnose = () => {
    const text = [t("settings.diag.copyHeader", { time: new Date().toISOString() }), ...diag.map((r) => `${r.label}: ${r.text}`)].join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => showToast({ tone: "warn", title: t("settings.server.copyFailed"), body: t("settings.diag.clipboard"), durationMs: 5000 }));
  };

  return (
    <section className="settings">
      {error && <ErrorNotice error={error} context="settings" onDismiss={() => setError(null)} />}

      {/* two columns: the short cards stacked on the left, the long Integrationen card on the right */}
      <div className="settings-col">
        <Panel
          title={t("settings.simulator.label")}
          description={t("settings.sim.description")}
          actions={
            <span className={`badge badge-${rec.kind}`} title={rec.hint}>
              <span className="badge-dot" aria-hidden="true" />
              {rec.label}
            </span>
          }
        >
          <IntegrationStatus tone={recTone}>{rec.hint}</IntegrationStatus>
          <div className="setting-row">
            {demo ? (
              // always offered; without SimConnect the app falls back to the waiting state
              <button className="btn-primary" onClick={() => onProvider("simconnect")}>
                {status?.provider === "replay" ? t("shell.demo.stopReplay") : t("shell.demo.stop")}
              </button>
            ) : (
              providers.includes("mock") && (
                <>
                  <button onClick={() => onProvider("mock")} title={t("settings.sim.demoTitle")}>
                    {t("shell.demo.start")}
                  </button>
                  <span className="detail">{t("settings.sim.demoHint")}</span>
                </>
              )
            )}
          </div>
          <SimulatorSelect flightActive={flight?.state === "active"} xplaneConnected={status?.provider === "xplane" && status.state === "connected"} />
          <SimConnectDownload dllMissing={info ? !info.simconnectDll : null} statusMissing={dllMissing && !dllPath} onInstalled={() => void loadInfo()} />
          <div className="setting-row">
            <span className="setting-label">SimConnect.dll</span>
            <span className={`dll-path${dllPath ? " mono" : " detail"}`} title={mp(dllPath || info?.simconnectDll || "") || undefined}>
              {dllPath ? mp(dllPath) : info?.simconnectDll ? t("settings.sim.dll.auto", { path: mp(info.simconnectDll) }) : t("settings.sim.dll.autoNotFound")}
            </span>
            <button onClick={() => void chooseDll()}>{t("csvImport.pickFile")}</button>
            {dllPath && <button onClick={() => void applyDll(null)}>{t("settings.reset")}</button>}
            {dllNote && (
              <span className="ok-text" role="status">
                {dllNote}
              </span>
            )}
          </div>
          {(dllMissing || (info && !info.simconnectDll)) && !dllPath && (
            <div className="detail">{t("settings.sim.dll.elsewhere")}</div>
          )}
          <label className="check">
            <input type="checkbox" checked={prefs.simTextLanding} onChange={(e) => toggle("simTextLanding", e.target.checked)} />
            {t("settings.sim.textLanding")}
          </label>
          <div className="detail">{t("settings.sim.textLandingHint")}</div>
          <div className="setting-row">
            <button onClick={() => void simTextTest()} disabled={simTextBusy || status?.provider !== "simconnect" || status?.state !== "connected"} title={t("settings.sim.textTestTitle")}>
              {simTextBusy ? t("settings.sim.textTestBusy") : t("settings.sim.textTest")}
            </button>
            {simTextResult && (
              <span className={simTextResult.status === "sent" ? "ok-text" : "detail"} role="status">
                {simTextResultText(simTextResult)}
              </span>
            )}
          </div>
        </Panel>

        <Panel title={t("settings.planning.title")} description={t("settings.planning.description")}>
          <div className="setting-row">
            <label htmlFor="simbrief">{t("settings.planning.pilotId")}</label>
            <input
              id="simbrief"
              // Streamer-Modus: still editable, but not readable on stream
              type={priv.on ? "password" : "text"}
              autoComplete="off"
              title={priv.on ? t("settings.planning.hidden") : undefined}
              value={simbriefUser}
              onChange={(e) => setSimbriefUser(e.target.value)}
              placeholder={t("settings.planning.placeholder")}
              onKeyDown={(e) => e.key === "Enter" && saveUser()}
              onBlur={saveUser}
            />
            {savedMark ? (
              <span className="ok-text" role="status">
                {t("settings.savedMark")}
              </span>
            ) : (
              <button onClick={saveUser} disabled={simbriefUser.trim() === storedUser}>
                {t("shell.action.save")}
              </button>
            )}
          </div>
          <label className="check">
            <input type="checkbox" checked={prefs.simbriefAuto} onChange={(e) => toggle("simbriefAuto", e.target.checked)} />
            {t("settings.planning.auto")}
          </label>
          <IntegrationStatus tone={storedUser ? (ofp ? "ok" : "info") : "off"}>
            {storedUser
              ? ofp
                ? t("settings.planning.loaded", { callsign: priv.mask(ofp.callsign, "callsign"), dep: ofp.originIcao, arr: ofp.destinationIcao })
                : t("settings.planning.noPlan")
              : t("settings.planning.noId")}
          </IntegrationStatus>
        </Panel>

        <Panel title={t("settings.updates.title")}>
          <IntegrationStatus
            tone={upd.phase === "available" || upd.phase === "ready" ? "info" : upd.phase === "error" ? "warn" : upd.phase === "none" ? "ok" : "off"}
          >
            {upd.phase === "idle" && t("settings.updates.idle", { version: info?.version ?? "–" })}
            {upd.phase === "checking" && t("settings.updates.checking", { version: info?.version ?? "–" })}
            {upd.phase === "none" &&
              (upd.checkedMs
                ? t("settings.updates.currentChecked", { version: info?.version ?? "–", time: fmtClock(upd.checkedMs) })
                : t("settings.updates.current", { version: info?.version ?? "–" }))}
            {upd.phase === "available" && t("settings.updates.available", { version: upd.version ?? "–", installed: info?.version ?? "–" })}
            {upd.phase === "downloading" && t("settings.updates.downloading", { version: upd.version ?? "–", percent: Math.round((upd.progress ?? 0) * 100) })}
            {upd.phase === "ready" && t("settings.updates.ready")}
            {upd.phase === "error" && t("settings.updates.error", { version: info?.version ?? "–", hint: userMessage(upd.error ?? "", "settings").hint })}
          </IntegrationStatus>
          {upd.phase === "downloading" && <progress className="update-progress" max={1} value={upd.progress ?? 0} aria-label={t("settings.simconnect.progressLabel")} />}
          {upd.notes && upd.phase === "available" && <pre className="update-notes detail">{upd.notes}</pre>}
          {upd.phase === "available" && recording && (
            <div className="detail">{t("settings.updates.recording")}</div>
          )}
          <div className="setting-row">
            {upd.phase === "available" ? (
              <button className="btn-primary" onClick={() => void installUpdate()} disabled={recording}>
                {t("settings.updates.install", { version: upd.version ?? "" })}
              </button>
            ) : (
              <button onClick={() => void checkForUpdate()} disabled={upd.phase === "checking" || upd.phase === "downloading"}>
                {t("settings.updates.check")}
              </button>
            )}
          </div>
        </Panel>
      </div>

      {/* Overlay & API under Integrationen made the right column
          ~450 px longer than the left (more with the server on); with the X-Plane address folded
          (SimulatorSelect) both columns now end within ~60 px, so the overlay stays full width */}
      <IntegrationsPanel onError={(e) => setError(e)} />

      <ServerPanel onError={(e) => setError(e)} className="settings-wide" />

      <Panel title={t("settings.display.title")} description={t("settings.display.description")} className="settings-wide">
        <div className="setting-row">
          <span className="setting-label" id="ui-language">
            {t("settings.display.language.label")}
          </span>
          <Segmented
            aria-labelledby="ui-language"
            options={LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
            value={prefs.language}
            onChange={(v) => setPref("language", v).catch((e) => setError(String(e)))}
          />
          <span className="detail">{t("settings.display.language.hint")}</span>
        </div>
        <ThemePicker value={prefs.theme} onChange={(id) => setPref("theme", id).catch((e) => setError(String(e)))} />
        <div className="setting-row">
          <span className="setting-label" id="time-base">
            {t("settings.display.times")}
          </span>
          <Segmented
            aria-labelledby="time-base"
            options={[
              { value: false, label: "UTC" },
              { value: true, label: t("time.local") },
            ]}
            value={prefs.timeLocal}
            onChange={(v) => toggle("timeLocal", v)}
          />
          <span className="detail">{t("settings.display.now", { time: fmtClock(Date.now()) })}</span>
        </div>
        <div className="setting-row">
          <span className="setting-label" id="weight-unit">
            {t("settings.display.weights")}
          </span>
          <Segmented
            aria-labelledby="weight-unit"
            options={(["kg", "lb"] as const).map((u) => ({ value: u, label: u }))}
            value={prefs.weightUnit}
            onChange={(u) => setPref("weightUnit", u).catch((e) => setError(String(e)))}
          />
          <span className="detail">{t("settings.display.weightsHint")}</span>
        </div>
        <ZoomRow />
        <label className="check">
          <input type="checkbox" checked={prefs.privacyMode} onChange={(e) => void togglePrivacyMode(e.target.checked)} />
          <strong>{t("settings.display.privacy.label")}</strong>
          <kbd className="privacy-kbd">{t("settings.display.privacy.key")}</kbd>
        </label>
        <div className="detail">{t("settings.display.privacy.help")}</div>
        <CardPanel onError={(e) => setError(e)} />
        <label className="check">
          <input type="checkbox" checked={prefs.airframePhotos} onChange={(e) => toggle("airframePhotos", e.target.checked)} />
          {t("settings.display.photos.label")}
        </label>
        <div className="detail">{t("settings.display.photos.help")}</div>
        {/* the same choice as the Globus button on every map (map/projection.ts) */}
        <label className="check">
          <input type="checkbox" checked={globe} onChange={(e) => setGlobe(e.target.checked)} />
          {t("settings.display.globe.label")}
        </label>
        <div className="detail">{t("settings.display.globe.help")}</div>
        {/* the same choice as the Satellit button on the live and track map (map/satellite.ts) */}
        <label className="check">
          <input type="checkbox" checked={mapStyle === "satellite"} onChange={(e) => setMapStyle(e.target.checked ? "satellite" : "map")} />
          {t("settings.display.satellite.label")}
        </label>
        <div className="detail">{t("settings.display.satellite.help")}</div>
        <IntegrationStatus tone={onlineTone(online)}>{onlineLine(online)}</IntegrationStatus>
        <div className="setting-row">
          <span className="setting-label" id="online-networks-label">
            {t("online.diag.label")}
          </span>
          <span className="check-group" role="group" aria-labelledby="online-networks-label">
            {networkStatuses(online).map((n) => (
              <label className="check" key={n.network}>
                <input
                  type="checkbox"
                  checked={n.enabled}
                  disabled={!online || netBusy}
                  onChange={(e) => setNetwork(n.network, e.target.checked)}
                />
                {NETWORK_LABEL[n.network]}
              </label>
            ))}
          </span>
          <span className="detail">{t("settings.display.online.hint")}</span>
        </div>
      </Panel>

      <ApproachProfilesPanel />

      <DataPanel onError={(e) => setError(e)} />

      <KeyboardPanel />

      <Panel
        // remount once the Debug-Modus is known: with it on, the section starts open
        key={debugMode == null ? "loading" : "loaded"}
        title={t("settings.diag.title")}
        description={t("settings.diag.description")}
        // both columns: an open Diagnose no longer leaves the left half empty
        className="settings-wide"
        collapsible
        defaultOpen={!!debugMode}
        actions={
          debugMode ? (
            <span className="badge badge-debug" title={t("settings.diag.debug.badgeTitle")}>
              <span className="badge-dot" aria-hidden="true" />
              {t("settings.diag.debug.badge")}
            </span>
          ) : undefined
        }
      >
        <label className="check debug-mode-toggle">
          <input type="checkbox" checked={!!debugMode} disabled={debugMode == null || debugBusy} onChange={(e) => toggleDebugMode(e.target.checked)} />
          <strong>{t("settings.diag.debug.label")}</strong>
        </label>
        <div className="detail">{t("settings.diag.debug.help")}</div>
        <div className="setting-row">
          <button className="btn-primary" onClick={() => void createDiagPackage()} disabled={packing}>
            {packing ? t("settings.diag.package.creating") : t("settings.diag.package.create")}
          </button>
          <span className="detail">{debugMode ? t("settings.diag.package.contentsDebug") : t("settings.diag.package.contents")}</span>
        </div>
        <KV rows={diag.map((r): [string, ReactNode] => [r.label, r.node ?? r.text])} />
        <div className="setting-row">
          <label htmlFor="log-level">{t("settings.diag.row.logLevel")}</label>
          <select
            id="log-level"
            value={logLevel?.level ?? "info"}
            onChange={(e) => void changeLogLevel(e.target.value)}
            disabled={!logLevel || !!logLevel.envOverride || !!debugMode}
            title={
              logLevel?.envOverride
                ? t("settings.diag.logLevel.envTitle", { value: logLevel.envOverride })
                : debugMode
                  ? t("settings.diag.logLevel.debugTitle")
                  : t("settings.diag.logLevel.title")
            }
          >
            {LOG_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {t(l.label)}
              </option>
            ))}
          </select>
          {logLevel?.envOverride ? (
            <span className="detail">{t("settings.diag.logLevel.env")}</span>
          ) : (
            debugMode && <span className="detail">{t("settings.diag.logLevel.debugHint")}</span>
          )}
        </div>
        <div className="setting-row">
          <button onClick={() => logFile && reveal(logFile)} disabled={!logFile} title={logDir ?? undefined}>
            {t("settings.diag.openLogs")}
          </button>
          <button onClick={copyDiagnose}>{copied ? t("settings.diag.copied") : t("settings.diag.copy")}</button>
          <button onClick={() => info && reveal(info.dbPath)} disabled={!info}>
            {t("settings.diag.showLogbook")}
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={!!dump?.enabled || !!debugMode}
            disabled={!dump || !!debugMode}
            onChange={(e) => void toggleDump(e.target.checked)}
          />
          {t("settings.diag.dump.record")}
          {debugMode ? ` · ${t("settings.diag.dump.byDebug")}` : ""}
        </label>
        <div className="detail">
          {t("settings.diag.dump.help")}
          {dump?.status.lastError && <span className="err-text"> {dump.status.lastError}</span>}
        </div>
        <div className="setting-row">
          <button onClick={() => void dumpNow()}>{t("settings.diag.dump.now")}</button>
          <button onClick={() => dump && reveal(dump.dir)} disabled={!dump?.dir} title={dump?.dir}>
            {t("settings.diag.dump.openDir")}
          </button>
        </div>
        {providers.includes("mock") && providers.includes("replay") && (
          <Panel title={t("status.replay.label")} description={t("settings.diag.replay.description")} collapsible defaultOpen={false} level={3}>
            <div className="setting-row">
              <span className="setting-label">{t("csvImport.step.file")}</span>
              <span className={`dll-path${replay.path ? " mono" : " detail"}`} title={replay.path ? mp(replay.path) : undefined}>
                {replay.path ? mp(replay.path) : t("settings.diag.replay.none")}
              </span>
              <button onClick={() => void chooseReplay()}>{t("csvImport.pickFile")}</button>
            </div>
            <div className="setting-row">
              <label htmlFor="replay-speed">{t("settings.diag.replay.speed")}</label>
              <select id="replay-speed" value={replay.speed} onChange={(e) => setReplay((r) => ({ ...r, speed: Number(e.target.value) }))}>
                {REPLAY_SPEEDS.some((o) => o.value === replay.speed) ? null : <option value={replay.speed}>{replay.speed}×</option>}
                {REPLAY_SPEEDS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <label className="check">
                <input type="checkbox" checked={replay.repeat} onChange={(e) => setReplay((r) => ({ ...r, repeat: e.target.checked }))} />
                {t("settings.diag.replay.repeat")}
              </label>
            </div>
            <div className="setting-row">
              <button className="btn-primary" onClick={() => void startReplay()} disabled={!replay.path}>
                {status?.provider === "replay" ? t("settings.diag.replay.restart") : t("settings.diag.replay.start")}
              </button>
              {status?.provider === "replay" && <button onClick={() => onProvider("simconnect")}>{t("shell.demo.stopReplay")}</button>}
            </div>
          </Panel>
        )}
        <Panel
          // remount so switching the Debug-Modus on opens the view (and off collapses it)
          key={debugMode ? "debug" : "normal"}
          title={t("settings.diag.raw.title")}
          description={t("settings.diag.raw.description")}
          collapsible
          defaultOpen={!!debugMode}
          level={3}
        >
          <LiveRawData />
        </Panel>
      </Panel>

      <p className="about detail">
        {t("settings.about", { version: info?.version ?? "" })}{" "}
        <button className="link-btn" onClick={() => openUrl(THIRD_PARTY_NOTICES_URL).catch(() => {})} title={THIRD_PARTY_NOTICES_URL}>
          {t("settings.thirdParty")}
        </button>
      </p>
    </section>
  );
}

/** Six visual directions as cards (radio group: arrow keys move, applied instantly). */
/** Interface size (Ctrl+Plus/Minus/0), remembered on this PC. */
/** „Landekarte“: automatic PNG after each landing, its folder, and the card without registration. */
function CardPanel({ onError }: { onError: (e: string) => void }) {
  const t = useT();
  const prefs = usePrefs();
  const priv = usePrivacy();
  const [dir, setDir] = useState<CardDirInfo | null>(null);
  useEffect(() => {
    invoke<CardDirInfo>("get_card_dir", { create: false })
      .then(setDir)
      // without it the row shows "–"; saving still reports its own error
      .catch(() => {});
  }, []);
  const change = async () => {
    try {
      const picked = await openFileDialog({ title: t("settings.card.pickTitle"), directory: true, multiple: false, defaultPath: dir?.dir });
      if (typeof picked !== "string" || !picked) return;
      setDir(await invoke<CardDirInfo>("set_card_dir", { path: picked }));
    } catch (e) {
      onError(String(e));
    }
  };
  const reset = () =>
    invoke<CardDirInfo>("set_card_dir", { path: null })
      .then(setDir)
      .catch((e) => onError(String(e)));
  const openDir = () =>
    invoke<CardDirInfo>("get_card_dir", { create: true, open: true })
      .then(setDir)
      .catch((e) => onError(String(e)));
  const set = (key: "cardAutosave" | "cardHideReg", on: boolean) => setPref(key, on).catch((e) => onError(String(e)));
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={prefs.cardAutosave} onChange={(e) => set("cardAutosave", e.target.checked)} />
        {t("settings.card.autosave")}
      </label>
      <div className="setting-row card-dir-row">
        <span className="setting-label">{t("settings.folder")}</span>
        <span className="dll-path mono" title={dir ? priv.mask(dir.dir, "path") : undefined}>
          {dir ? priv.mask(dir.dir, "path") : "–"}
        </span>
        {dir?.isDefault && <span className="detail">{t("settings.simulator.default")}</span>}
        <button onClick={() => void change()}>{t("settings.change")}</button>
        <button onClick={() => void openDir()} disabled={!dir}>
          {t("settings.open")}
        </button>
        {dir && !dir.isDefault && <button onClick={() => void reset()}>{t("settings.reset")}</button>}
      </div>
      <label className="check">
        <input type="checkbox" checked={prefs.cardHideReg || prefs.privacyMode} disabled={prefs.privacyMode} onChange={(e) => set("cardHideReg", e.target.checked)} />
        {t("settings.card.hideReg")}
        {prefs.privacyMode ? ` · ${t("settings.card.byPrivacy")}` : ""}
      </label>
    </>
  );
}

function ZoomRow() {
  const t = useT();
  const zoom = useZoom();
  const pct = `${Math.round(zoom * 100)} %`;
  const min = zoom <= ZOOM_STEPS[0];
  const max = zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return (
    <div className="setting-row">
      <span className="setting-label" id="zoom-label">
        {t("settings.zoom.label")}
      </span>
      <div className="zoom-control" role="group" aria-labelledby="zoom-label">
        <button className="btn-sm" onClick={() => stepZoom(-1)} disabled={min} aria-label={t("settings.zoom.out")} title={t("settings.zoom.out")}>
          −
        </button>
        <output className="num zoom-value" aria-live="polite">
          {pct}
        </output>
        <button className="btn-sm" onClick={() => stepZoom(1)} disabled={max} aria-label={t("settings.zoom.in")} title={t("settings.zoom.in")}>
          +
        </button>
        <button className="btn-sm" onClick={() => setZoom(1)} disabled={zoom === 1} title={t("settings.zoom.reset")}>
          100 %
        </button>
      </div>
      <span className="detail">{t("settings.zoom.hint")}</span>
    </div>
  );
}

/** Shortcut rows: key names and description are both language-dependent ("Strg" / "Ctrl"). */
const SHORTCUTS = ["views", "panel", "search", "list", "enter", "delete", "arrows", "esc", "toast", "zoom", "privacy"] as const;

/** "Tastatur": every shortcut in one place (they were only in tooltips before). */
function KeyboardPanel() {
  const t = useT();
  return (
    <Panel title={t("settings.keyboard.title")} description={t("settings.keyboard.description")} collapsible defaultOpen={false} className="settings-wide">
      <table className="shortcut-table">
        <caption className="sr-only">{t("settings.keyboard.caption")}</caption>
        <tbody>
          {SHORTCUTS.map((id) => (
            <tr key={id}>
              <th scope="row">
                <kbd>{t(`settings.keyboard.keys.${id}`)}</kbd>
              </th>
              <td>{t(`settings.keyboard.what.${id}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="detail">{t("settings.keyboard.debriefHint")}</p>
    </Panel>
  );
}

function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (id: ThemeId) => void }) {
  const t = useT();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = THEMES.findIndex((th) => th.id === value);
    const next = THEMES[(i + step + THEMES.length) % THEMES.length];
    const group = e.currentTarget;
    onChange(next.id);
    requestAnimationFrame(() => group.querySelector<HTMLButtonElement>(`[data-theme-id="${next.id}"]`)?.focus());
  };
  return (
    <div className="theme-picker">
      <span className="setting-label" id="theme-label">
        {t("settings.theme.label")}
      </span>
      <div className="theme-grid" role="radiogroup" aria-labelledby="theme-label" onKeyDown={onKey}>
        {THEMES.map((th) => {
          const c = th.colors;
          const on = th.id === value;
          return (
            <button
              key={th.id}
              data-theme-id={th.id}
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={`theme-card${on ? " active" : ""}`}
              onClick={() => onChange(th.id)}
              title={th.mood}
            >
              <span className="theme-preview" style={{ background: c.bg }} aria-hidden="true">
                {[c.surface1, c.accent, c.ok, c.warn, c.route, OWN_AIRCRAFT].map((col, i) => (
                  <span key={i} className="theme-swatch" style={{ background: col }} />
                ))}
                <span className="theme-sample" style={{ color: c.text, fontFamily: `${th.fonts.num}, monospace` }}>
                  −155
                </span>
              </span>
              <span className="theme-card-text">
                <strong>
                  {th.name}
                  {th.scheme === "light" && <span className="theme-day">{t("settings.theme.day")}</span>}
                </strong>
                <span className="detail">{th.mood}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="detail">{t("settings.theme.hint")}</div>
    </div>
  );
}

const BACKUP_KIND_LABEL: Record<string, TKey> = {
  regular: "settings.data.backupKind.regular",
  preMigration: "settings.data.backupKind.preMigration",
  preUpdate: "settings.data.backupKind.preUpdate",
  preRestore: "settings.data.backupKind.preRestore",
  preWipe: "settings.data.backupKind.preWipe",
  preImport: "settings.data.backupKind.preImport",
};

/** `VectaSim-Export_2026-10-18.vectasim` (local date). */
function bundleFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `VectaSim-Export_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.vectasim`;
}

/** Result toast of an import: what came in, what was skipped. */
function importSummary(t: TFunction, r: BundleImportReport): string {
  const parts = [t("csvImport.summary.added", { count: r.flightsAdded })];
  if (r.flightsSkippedDuplicate) parts.push(t("csvImport.summary.duplicate", { count: r.flightsSkippedDuplicate }));
  if (r.airframesAdded) parts.push(t("csvImport.summary.airframes", { count: r.airframesAdded }));
  if (r.airframesUpdated) parts.push(t("settings.data.summary.updated", { count: r.airframesUpdated }));
  if (r.imagesAdded) parts.push(t("settings.data.summary.images", { count: r.imagesAdded }));
  return parts.join(" · ");
}
/** Backups listed in the panel (the folder may hold more pre-migration copies). */
const BACKUPS_SHOWN = 8;
function backupLabel(t: TFunction, b: BackupEntry): string {
  const kind = BACKUP_KIND_LABEL[b.kind] ? t(BACKUP_KIND_LABEL[b.kind]) : b.kind;
  return b.kind === "preMigration" && b.schemaFrom != null ? `${kind} (v${b.schemaFrom})` : kind;
}

/** What `run` is busy with: the button text and the failure toast follow it. */
type DataTask = "backup" | "restore" | "export" | "import" | "emptyTrash" | "wipe";

/**
 * Settings → Data: where the logbook lives, backups (folder, automatic, restore),
 * trash and "Delete all data".
 */
function DataPanel({ onError }: { onError: (e: string) => void }) {
  const t = useT();
  const priv = usePrivacy();
  const mp = (s: string) => priv.mask(s, "path");
  const wipeWordExpected = t("settings.data.wipe.word");
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState<DataTask | null>(null);
  /** Backup (path) whose restore waits for confirmation. */
  const [restoreAsk, setRestoreAsk] = useState<string | null>(null);
  const [trashAsk, setTrashAsk] = useState(false);
  const [wipeStep, setWipeStep] = useState<0 | 1 | 2>(0);
  const [wipeWord, setWipeWord] = useState("");
  const [withTrash, setWithTrash] = useState(false);
  /** `.vectasim` file waiting for „Zusammenführen“/„Ersetzen“, with what it holds. */
  const [importAsk, setImportAsk] = useState<{ path: string; manifest: BundleManifest | null } | null>(null);
  /** „CSV importieren …“ dialog open. */
  const [csvOpen, setCsvOpen] = useState(false);

  const load = () =>
    invoke<BackupInfo>("get_backup_info")
      .then(setInfo)
      .catch((e) => onError(String(e)));

  useEffect(() => {
    void load();
    const a = listen("backup:changed", () => void load());
    const b = listen("logbook:changed", () => void load());
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once on mount; `load` is recreated each render but only calls invoke and the stable setters
  }, []);

  const run = async (what: DataTask, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      showToast({ tone: "err", ...errorToast(t(`settings.data.failed.${what}`), e, "settings") });
    } finally {
      setBusy(null);
    }
  };

  const backupNow = () =>
    run("backup", async () => {
      const b = await invoke<BackupEntry>("create_backup", {});
      showToast({ tone: "ok", title: t("settings.data.backup.done"), body: `${b.fileName} · ${fmtBytes(b.bytes)}` });
      await load();
    });

  const chooseDir = async () => {
    try {
      const picked = await openFileDialog({ title: t("settings.data.backup.pickDir"), directory: true, multiple: false, defaultPath: info?.dir });
      if (typeof picked !== "string" || !picked) return;
      setInfo(await invoke<BackupInfo>("set_backup_dir", { path: picked }));
    } catch (e) {
      onError(String(e));
    }
  };

  const resetDir = () =>
    invoke<BackupInfo>("set_backup_dir", { path: null })
      .then(setInfo)
      .catch((e) => onError(String(e)));

  const chooseRestoreFile = async () => {
    try {
      const picked = await openFileDialog({
        title: t("settings.data.restore.pickTitle"),
        multiple: false,
        directory: false,
        defaultPath: info?.dir,
        filters: [{ name: t("settings.data.restore.fileType"), extensions: ["db"] }],
      });
      if (typeof picked === "string" && picked) setRestoreAsk(picked);
    } catch (e) {
      onError(String(e));
    }
  };

  const restore = (path: string) =>
    run("restore", async () => {
      await invoke<string>("restore_backup", { path });
      setRestoreAsk(null);
      showToast({ tone: "ok", title: t("settings.data.restore.running"), body: t("settings.data.restore.restarting"), durationMs: null });
    });

  const exportAll = async () => {
    const name = bundleFileName(new Date());
    let defaultPath = name;
    try {
      defaultPath = await join(await desktopDir(), name);
    } catch {
      // no desktop folder: the dialog opens in its own default folder
    }
    let target: string | null;
    try {
      target = await saveFileDialog({ title: t("settings.data.export.title"), defaultPath, filters: [{ name: t("settings.data.export.fileType"), extensions: ["vectasim"] }] });
    } catch (e) {
      onError(String(e));
      return;
    }
    if (!target) return;
    await run("export", async () => {
      const r = await invoke<BundleExportReport>("export_bundle", { path: target, includeDeleted: withTrash });
      const m = r.manifest;
      const flights = m.flightsDeleted
        ? t("settings.data.export.flightsTrash", { flights: t("count.flights", { count: m.flights }), trash: fmt(m.flightsDeleted) })
        : t("count.flights", { count: m.flights });
      showToast({
        tone: r.warnings.length ? "warn" : "ok",
        title: t("settings.data.export.done", { flights, airframes: t("settings.data.airframes", { count: m.airframes }) }),
        body: r.warnings.length
          ? t("settings.data.export.bodyWarnings", { path: mp(r.path), size: fmtBytes(r.bytes), warnings: t("csvImport.done.warnings", { count: r.warnings.length }) })
          : `${mp(r.path)} · ${fmtBytes(r.bytes)}`,
        durationMs: 12_000,
        actions: [{ label: t("settings.openFolder"), onClick: () => void revealPath(r.path).catch(() => {}) }],
      });
    });
  };

  const chooseImportFile = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({
        title: t("settings.data.import.pickTitle"),
        multiple: false,
        directory: false,
        filters: [{ name: t("settings.data.export.fileType"), extensions: ["vectasim"] }],
      });
    } catch (e) {
      onError(String(e));
      return;
    }
    if (typeof picked !== "string" || !picked) return;
    const path = picked;
    try {
      setImportAsk({ path, manifest: await invoke<BundleManifest>("read_bundle_manifest", { path }) });
    } catch (e) {
      showToast({ tone: "err", ...errorToast(t("settings.data.import.unreadable"), e, "settings") });
    }
  };

  const importBundle = (path: string, mode: "merge" | "replace") =>
    run("import", async () => {
      const r = await invoke<BundleImportReport>("import_bundle", { path, mode });
      setImportAsk(null);
      showToast({
        tone: r.warnings.length ? "warn" : "ok",
        title: mode === "replace" ? t("settings.data.import.replaced") : t("settings.data.import.done"),
        body: r.warnings.length
          ? t("csvImport.done.bodyWarnings", { summary: importSummary(t, r), warnings: t("csvImport.done.warnings", { count: r.warnings.length }), list: r.warnings.slice(0, 2).join("; ") })
          : importSummary(t, r),
        durationMs: 15_000,
        actions: r.backup ? [{ label: t("settings.data.import.showBackup"), onClick: () => void revealPath(r.backup ?? "").catch(() => {}) }] : undefined,
      });
      await load();
    });

  const emptyTrash = () =>
    run("emptyTrash", async () => {
      const n = await invoke<number>("empty_trash");
      setTrashAsk(false);
      showToast({ tone: "ok", title: t("settings.data.trash.emptied", { count: n }) });
      await load();
    });

  const wipe = () =>
    run("wipe", async () => {
      const r = await invoke<WipeResult>("delete_all_data");
      setWipeStep(0);
      setWipeWord("");
      showToast({
        tone: "ok",
        title: t("settings.data.wipe.done", { flights: t("count.flights", { count: r.flights }) }),
        body: t("settings.data.wipe.backup", { path: mp(r.backup) }),
        durationMs: 12_000,
        actions: [{ label: t("settings.openFolder"), onClick: () => void revealPath(r.backup).catch(() => {}) }],
      });
      await load();
    });

  const cancelOnEsc = (cancel: () => void) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  };

  const blocked = !!info?.flightActive;
  const last = info?.lastBackupMs;
  const shown = info?.backups.slice(0, BACKUPS_SHOWN) ?? [];

  return (
    <Panel title={t("settings.data.title")} description={t("settings.data.description")} className="settings-wide">
      <h3 className="data-head">{t("settings.data.db.title")}</h3>
      <div className="setting-row">
        <span className="setting-label">{t("settings.data.db.location")}</span>
        <span className="dll-path mono" title={info ? mp(info.dbPath) : undefined}>
          {info ? mp(info.dbPath) : "–"}
        </span>
        {info && <span className="detail">{fmtBytes(info.dbBytes)}</span>}
        <button onClick={() => info && void revealPath(info.dbPath).catch((e) => onError(String(e)))} disabled={!info}>
          {t("settings.data.db.reveal")}
        </button>
      </div>
      {info?.dbSync && <IntegrationStatus tone="warn">{t("settings.data.db.sync", { service: info.dbSync })}</IntegrationStatus>}

      <h3 className="data-head">{t("settings.data.backup.title")}</h3>
      <div className="setting-row">
        <span className="setting-label">{t("settings.folder")}</span>
        <span className="dll-path mono" title={info ? mp(info.dir) : undefined}>
          {info ? mp(info.dir) : "–"}
        </span>
        <button onClick={() => void chooseDir()} disabled={!info}>
          {t("settings.change")}
        </button>
        {info && !info.isDefault && <button onClick={() => void resetDir()}>{t("settings.reset")}</button>}
        <button onClick={() => invoke("open_backup_dir").catch((e) => onError(String(e)))} disabled={!info}>
          {t("settings.openFolder")}
        </button>
      </div>
      {info?.dirSync ? (
        <IntegrationStatus tone="ok">{t("settings.data.backup.dirSync", { service: info.dirSync })}</IntegrationStatus>
      ) : (
        info && <div className="detail">{t("settings.data.backup.tip")}</div>
      )}
      <IntegrationStatus tone={last ? "ok" : "off"}>
        {last ? t("settings.data.backup.last", { date: fmtDate(last), time: fmtClock(last) }) : t("settings.data.backup.none")} ·{" "}
        {t("settings.data.backup.schedule")}
      </IntegrationStatus>
      <div className="setting-row">
        <button className="btn-primary" onClick={() => void backupNow()} disabled={!info || busy != null}>
          {busy === "backup" ? t("settings.data.backup.running") : t("settings.data.backup.now")}
        </button>
        <button onClick={() => void chooseRestoreFile()} disabled={!info || blocked || busy != null}>
          {t("settings.data.restore.fromFile")}
        </button>
      </div>
      {blocked && <div className="detail">{t("settings.data.blocked")}</div>}
      {restoreAsk && !shown.some((b) => b.path === restoreAsk) && (
        <RestoreConfirm path={restoreAsk} busy={busy != null} onConfirm={() => void restore(restoreAsk)} onCancel={() => setRestoreAsk(null)} onKey={cancelOnEsc} />
      )}
      {shown.length > 0 && (
        <ul className="backup-list">
          {shown.map((b) => (
            <li key={b.path}>
              <span className="num">
                {fmtDate(b.createdMs)} {fmtClock(b.createdMs)}
              </span>
              <span className="detail">{backupLabel(t, b)}</span>
              <span className="detail num">{fmtBytes(b.bytes)}</span>
              {restoreAsk === b.path ? (
                <RestoreConfirm path={b.path} busy={busy != null} onConfirm={() => void restore(b.path)} onCancel={() => setRestoreAsk(null)} onKey={cancelOnEsc} />
              ) : (
                <button className="btn-sm" onClick={() => setRestoreAsk(b.path)} disabled={blocked || busy != null} title={mp(b.path)}>
                  {t("settings.data.restore.button")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="data-head">{t("settings.data.export.heading")}</h3>
      <div className="setting-row">
        <button onClick={() => void exportAll()} disabled={!info || busy != null}>
          {busy === "export" ? t("settings.data.export.running") : t("settings.data.export.button")}
        </button>
        <label className="check">
          <input type="checkbox" checked={withTrash} onChange={(e) => setWithTrash(e.target.checked)} />
          {t("settings.data.export.withTrash")}
        </label>
        <button onClick={() => void chooseImportFile()} disabled={!info || busy != null}>
          {t("settings.data.import.fromFile")}
        </button>
      </div>
      <div className="detail">{t("settings.data.export.help")}</div>
      {importAsk && (
        <ImportConfirm
          path={importAsk.path}
          manifest={importAsk.manifest}
          busy={busy != null}
          replaceBlocked={blocked}
          onImport={(mode) => void importBundle(importAsk.path, mode)}
          onCancel={() => setImportAsk(null)}
          onKey={cancelOnEsc}
        />
      )}

      <h3 className="data-head">{t("settings.data.csv.heading")}</h3>
      <div className="setting-row">
        <button onClick={() => setCsvOpen(true)} disabled={!info || busy != null} aria-haspopup="dialog">
          {t("settings.data.csv.button")}
        </button>
        <span className="detail">{t("settings.data.csv.help")}</span>
      </div>
      {csvOpen && <CsvImportDialog onClose={() => setCsvOpen(false)} />}

      <h3 className="data-head">{t("settings.data.trash.title")}</h3>
      <div className="setting-row">
        <span>
          {info ? (info.trashCount ? t("settings.data.trash.count", { count: info.trashCount }) : t("settings.data.trash.empty")) : "–"}
          <span className="detail"> · {t("settings.data.trash.retention", { days: info?.trashDays ?? 30 })}</span>
        </span>
        {trashAsk ? (
          <span className="confirm-delete" role="group" aria-label={t("settings.data.trash.confirmLabel")} onKeyDown={cancelOnEsc(() => setTrashAsk(false))}>
            <span className="detail">{t("settings.data.trash.confirm")}</span>
            <button className="btn-sm danger" onClick={() => void emptyTrash()} disabled={busy != null}>
              {t("settings.data.trash.emptyButton")}
            </button>
            <button className="btn-sm" onClick={() => setTrashAsk(false)} autoFocus>
              {t("shell.action.cancel")}
            </button>
          </span>
        ) : (
          <button onClick={() => setTrashAsk(true)} disabled={!info?.trashCount}>
            {t("settings.data.trash.emptyButton")}
          </button>
        )}
      </div>

      <h3 className="data-head">{t("settings.data.wipe.title")}</h3>
      {wipeStep === 0 && (
        <div className="setting-row">
          <span className="detail">{t("settings.data.wipe.help")}</span>
          <button className="danger" onClick={() => setWipeStep(1)} disabled={!info || blocked}>
            {t("settings.data.wipe.button")}
          </button>
        </div>
      )}
      {wipeStep === 1 && (
        <div className="setting-row confirm-delete" role="group" aria-label={t("settings.data.wipe.title")} onKeyDown={cancelOnEsc(() => setWipeStep(0))}>
          <span>{t("settings.data.wipe.confirm")}</span>
          <button className="btn-sm danger" onClick={() => setWipeStep(2)}>
            {t("csvImport.next")}
          </button>
          <button className="btn-sm" onClick={() => setWipeStep(0)} autoFocus>
            {t("shell.action.cancel")}
          </button>
        </div>
      )}
      {wipeStep === 2 && (
        <div
          className="setting-row confirm-delete"
          role="group"
          aria-label={t("settings.data.wipe.lastConfirm")}
          onKeyDown={cancelOnEsc(() => {
            setWipeStep(0);
            setWipeWord("");
          })}
        >
          <label htmlFor="wipe-word">{t("settings.data.wipe.typeWord", { word: wipeWordExpected })}</label>
          <input id="wipe-word" className="wipe-word" value={wipeWord} onChange={(e) => setWipeWord(e.target.value)} autoFocus autoComplete="off" />
          <button className="btn-sm danger" onClick={() => void wipe()} disabled={wipeWord.trim().toUpperCase() !== wipeWordExpected || busy != null}>
            {busy === "wipe" ? t("settings.data.wipe.running") : t("settings.data.wipe.final")}
          </button>
          <button
            className="btn-sm"
            onClick={() => {
              setWipeStep(0);
              setWipeWord("");
            }}
          >
            {t("shell.action.cancel")}
          </button>
        </div>
      )}
    </Panel>
  );
}

/** „Aus Datei importieren“: what the file holds, Zusammenführen (default) or Ersetzen. */
function ImportConfirm({
  path,
  manifest,
  busy,
  replaceBlocked,
  onImport,
  onCancel,
  onKey,
}: {
  path: string;
  manifest: BundleManifest | null;
  busy: boolean;
  /** A flight is being recorded: Ersetzen waits. */
  replaceBlocked: boolean;
  onImport: (mode: "merge" | "replace") => void;
  onCancel: () => void;
  onKey: (cancel: () => void) => (e: KeyboardEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const m = manifest;
  const shownPath = usePrivacy().mask(path, "path");
  return (
    <div className="import-confirm" role="group" aria-label={t("settings.data.import.confirmLabel")} onKeyDown={onKey(onCancel)}>
      <div className="dll-path mono" title={shownPath}>
        {shownPath}
      </div>
      {m && (
        <div className="detail">
          {m.flightsDeleted
            ? t("settings.data.export.flightsTrash", { flights: t("count.flights", { count: m.flights }), trash: fmt(m.flightsDeleted) })
            : t("count.flights", { count: m.flights })}{" "}
          · {t("settings.data.airframes", { count: m.airframes })}
          {m.images ? ` · ${t("settings.data.summary.images", { count: m.images })}` : ""} ·{" "}
          {t("settings.data.import.exportedAt", { date: fmtDate(m.createdMs), time: fmtClock(m.createdMs), version: m.appVersion })}
        </div>
      )}
      <label className="check">
        <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} autoFocus />
        <span>
          <strong>{t("settings.data.import.merge")}</strong>
          <span className="detail"> – {t("settings.data.import.mergeHelp")}</span>
        </span>
      </label>
      <label className="check">
        <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} disabled={replaceBlocked} />
        <span>
          <strong>{t("settings.data.import.replace")}</strong>
          <span className="detail">
            {" "}
            – {t("settings.data.import.replaceHelp")}
            {replaceBlocked ? ` ${t("settings.data.import.replaceBlocked")}` : ""}
          </span>
        </span>
      </label>
      <div className="setting-row">
        <button className={mode === "replace" ? "btn-sm danger" : "btn-sm btn-primary"} onClick={() => onImport(mode)} disabled={busy || (mode === "replace" && replaceBlocked)}>
          {busy ? t("csvImport.importing") : mode === "replace" ? t("settings.data.import.replaceButton") : t("settings.data.import.merge")}
        </button>
        <button className="btn-sm" onClick={onCancel}>
          {t("shell.action.cancel")}
        </button>
      </div>
    </div>
  );
}

function RestoreConfirm({
  path,
  busy,
  onConfirm,
  onCancel,
  onKey,
}: {
  path: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onKey: (cancel: () => void) => (e: KeyboardEvent<HTMLElement>) => void;
}) {
  const t = useT();
  const shownPath = usePrivacy().mask(path, "path");
  return (
    <span className="confirm-delete restore-confirm" role="group" aria-label={t("settings.data.restore.confirmLabel")} onKeyDown={onKey(onCancel)} title={shownPath}>
      <span className="detail">{t("settings.data.restore.confirm")}</span>
      <button className="btn-sm danger" onClick={onConfirm} disabled={busy}>
        {t("settings.data.restore.confirmButton")}
      </button>
      <button className="btn-sm" onClick={onCancel} autoFocus>
        {t("shell.action.cancel")}
      </button>
    </span>
  );
}
