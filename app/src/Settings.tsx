import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
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
  OnlineSummary,
  Ofp,
  ReplaySettings,
  Stats,
  StatusSnapshot,
  WipeResult,
} from "./types";
import { fmt, fmtClock, fmtDate } from "./format";
import ErrorNotice from "./ErrorNotice";
import CsvImportDialog from "./CsvImport";
import { ZOOM_STEPS, setPref, setZoom, stepZoom, togglePrivacyMode, usePrefs, usePrivacy, useZoom, type Prefs } from "./prefs";
import { DEMO_LABEL, isDemo, isSimMissing, providerLabel, recordingStatus } from "./status";
import { triedDllPaths, userMessage } from "./errors";
import { showToast } from "./ui/Toast";
import Panel from "./ui/Panel";
import { KV } from "./ui/Stat";
import { checkForUpdate, installUpdate, useUpdateState } from "./updater";
import { OWN_AIRCRAFT, THEMES, type ThemeId } from "./themes";
import LiveRawData from "./LiveRawData";
import IntegrationsPanel from "./IntegrationsPanel";
import { REPLAY_SPEEDS, diagPackageName, fmtBytes } from "./rawDiag";
import SimConnectDownload from "./SimConnectDownload";

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
const LOG_LEVELS: Array<{ id: string; label: string }> = [
  { id: "info", label: "Normal" },
  { id: "debug", label: "Ausführlich" },
  { id: "trace", label: "Alles (große Dateien)" },
];

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
      target = await saveFileDialog({ title: "Diagnosepaket speichern", defaultPath, filters: [{ name: "ZIP-Archiv", extensions: ["zip"] }] });
    } catch (e) {
      showToast({ tone: "err", title: "Diagnosepaket nicht erstellt", body: String(e) });
      return;
    }
    if (!target) return;
    setPacking(true);
    try {
      const pkg = await invoke<DiagPackageInfo>("create_diag_package", { targetPath: target });
      showToast({
        tone: "ok",
        title: "Paket gespeichert – an den Entwickler schicken",
        body: `${mp(pkg.path)} · ${fmtBytes(pkg.bytes)} · ${pkg.files.length} Dateien`,
        durationMs: 12000,
        actions: [{ label: "Ordner öffnen", onClick: () => void revealItemInDir(pkg.path).catch(() => {}) }],
      });
    } catch (e) {
      showToast({ tone: "err", title: "Diagnosepaket nicht erstellt", body: String(e) });
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
        showToast({ tone: "ok", title: "Dump gespeichert", body: mp(path), durationMs: 6000 });
        void revealItemInDir(path).catch(() => {});
        invoke<DumpInfo>("dump_info").then(setDump).catch(() => {});
      })
      .catch((e) => showToast({ tone: "warn", title: "Kein Dump gespeichert", body: String(e), durationMs: 6000 }));

  const chooseReplay = async () => {
    try {
      const picked = await openFileDialog({
        title: "Roh-Dump für das Replay wählen",
        multiple: false,
        directory: false,
        defaultPath: dump?.dir || undefined,
        filters: [{ name: "VectaSim-Dump", extensions: ["vsdump"] }],
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
        setDllNote(restarted ? "✓ gespeichert · Verbindung wird neu aufgebaut" : "✓ gespeichert · gilt ab dem nächsten Verbindungsaufbau");
        window.setTimeout(() => setDllNote(null), 4000);
        void loadInfo();
      })
      .catch((e) => setError(String(e)));

  const chooseDll = async () => {
    try {
      const picked = await openFileDialog({
        title: "SimConnect.dll wählen",
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
  const reveal = (path: string) => revealItemInDir(path).catch((e) => setError(String(e)));
  const recTone: Tone = rec.error ? "err" : rec.kind === "ready" || rec.kind === "recording" ? "ok" : rec.kind === "suspended" ? "warn" : rec.kind === "demo" ? "info" : "off";
  const recording = flight?.state === "active" && !demo;
  const logFile = logDir ? joinPath(logDir, LOG_FILE) : null;
  const dllMissing = isSimMissing(status?.detail ?? "");
  const tried = dllMissing ? triedDllPaths(status?.detail ?? "") : [];
  const mono = (s: string) => <span className="mono">{mp(s)}</span>;

  const diag: DiagRow[] = [
    { label: "Simulator", text: providerLabel(status?.provider) },
    { label: "Status", text: `${rec.label} (${status?.state ?? "idle"})` },
    { label: "Sim-Version", text: status?.simName ? `${status.simName} ${status.simVersion ?? ""}`.trim() : "–" },
    { label: "Datenrate", text: stats ? fmt(stats.rateHz, 1, "Hz") : "–" },
    { label: "Datensätze", text: fmt(stats?.frames ?? status?.frames ?? 0) },
    info?.simconnectDll
      ? {
          label: "SimConnect.dll",
          text: `${mp(info.simconnectDll)}${info.simconnectDllSource ? ` (${info.simconnectDllSource})` : ""}`,
          node: (
            <span className="diag-paths">
              {mono(info.simconnectDll)}
              {info.simconnectDllSource && <span className="detail">{info.simconnectDllSource}</span>}
            </span>
          ),
        }
      : { label: "SimConnect.dll", text: info ? "nicht gefunden – unter Simulator mit einem Klick herunterladen oder Datei wählen" : "–" },
    ...(dllPath ? [{ label: "DLL (gewählt)", text: mp(dllPath), node: mono(dllPath) }] : []),
    ...(tried.length
      ? [
          {
            label: "Durchsucht",
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
    { label: "Protokolle", text: logFile ? mp(logFile) : "–", node: logFile ? mono(logFile) : undefined },
    {
      label: "Roh-Dump",
      text: dump?.status.file
        ? `${mp(dump.status.file)} (${fmtBytes(dump.status.fileBytes)} unkomprimiert)`
        : dump?.enabled || debugMode
          ? `an · ${dump?.dir ? mp(dump.dir) : "–"} (Datei beginnt mit der nächsten SimConnect-Sitzung)`
          : "aus",
      node: dump?.status.file ? mono(dump.status.file) : undefined,
    },
    {
      label: "Protokollstufe",
      text: logLevel
        ? logLevel.envOverride
          ? `RUST_LOG=${logLevel.envOverride}`
          : `${logLevel.level}${debugMode ? " · Debug-Modus (debug für vectasim_*)" : ""}`
        : "–",
    },
    { label: "Logbuch", text: info ? mp(info.dbPath) : "–", node: info ? mono(info.dbPath) : undefined },
    { label: "App-Daten", text: info ? mp(info.dataDir) : "–", node: info ? mono(info.dataDir) : undefined },
    { label: "App-Version", text: info?.version ?? "–" },
    ...(priv.on ? [{ label: "Streamer-Modus", text: "an · Benutzername in Pfaden ausgeblendet" }] : []),
    ...(status?.detail && status.state !== "connected" ? [{ label: "Meldung", text: mp(status.detail), node: mono(status.detail) }] : []),
  ];

  const copyDiagnose = () => {
    const text = [`VectaSim-Diagnose · ${new Date().toISOString()}`, ...diag.map((r) => `${r.label}: ${r.text}`)].join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => showToast({ tone: "warn", title: "Kopieren nicht möglich", body: "Die Zwischenablage ist gerade nicht verfügbar.", durationMs: 5000 }));
  };

  return (
    <section className="settings">
      {error && <ErrorNotice error={error} context="settings" onDismiss={() => setError(null)} />}

      <Panel
        title="Simulator"
        description="VectaSim erkennt MSFS 2020/2024 automatisch, sobald er läuft. Die Aufzeichnung startet beim Losrollen – du musst nichts starten."
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
              {status?.provider === "replay" ? "Replay beenden" : `${DEMO_LABEL} beenden`}
            </button>
          ) : (
            providers.includes("mock") && (
              <>
                <button onClick={() => onProvider("mock")} title="Ein simulierter Flug, um VectaSim ohne MSFS kennenzulernen">
                  {DEMO_LABEL} starten
                </button>
                <span className="detail">ohne Simulator ausprobieren</span>
              </>
            )
          )}
        </div>
        <SimConnectDownload dllMissing={info ? !info.simconnectDll : null} statusMissing={dllMissing && !dllPath} onInstalled={() => void loadInfo()} />
        <div className="setting-row">
          <span className="setting-label">SimConnect.dll</span>
          <span className={`dll-path${dllPath ? " mono" : " detail"}`} title={mp(dllPath || info?.simconnectDll || "") || undefined}>
            {dllPath ? mp(dllPath) : info?.simconnectDll ? `automatisch · ${mp(info.simconnectDll)}` : "automatisch · nicht gefunden"}
          </span>
          <button onClick={() => void chooseDll()}>Datei wählen …</button>
          {dllPath && <button onClick={() => void applyDll(null)}>Zurücksetzen</button>}
          {dllNote && (
            <span className="ok-text" role="status">
              {dllNote}
            </span>
          )}
        </div>
        {(dllMissing || (info && !info.simconnectDll)) && !dllPath && (
          <div className="detail">
            Liegt die SimConnect.dll schon woanders (z. B. aus einer SDK-Installation), wähle sie mit „Datei wählen …“ aus.
          </div>
        )}
      </Panel>

      <Panel title="Flugplanung" description="Mit deiner SimBrief-Pilot-ID lädt VectaSim deinen letzten Flugplan und vergleicht Plan und Ist.">
        <div className="setting-row">
          <label htmlFor="simbrief">SimBrief-Pilot-ID</label>
          <input
            id="simbrief"
            // Streamer-Modus: still editable, but not readable on stream
            type={priv.on ? "password" : "text"}
            autoComplete="off"
            title={priv.on ? "Im Streamer-Modus verdeckt" : undefined}
            value={simbriefUser}
            onChange={(e) => setSimbriefUser(e.target.value)}
            placeholder="Pilot-ID (Zahl) oder Benutzername"
            onKeyDown={(e) => e.key === "Enter" && saveUser()}
            onBlur={saveUser}
          />
          {savedMark ? (
            <span className="ok-text" role="status">
              ✓ gespeichert
            </span>
          ) : (
            <button onClick={saveUser} disabled={simbriefUser.trim() === storedUser}>
              Speichern
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={prefs.simbriefAuto} onChange={(e) => toggle("simbriefAuto", e.target.checked)} />
          Letzten Flugplan beim Start und beim Verbinden automatisch laden
        </label>
        <IntegrationStatus tone={storedUser ? (ofp ? "ok" : "info") : "off"}>
          {storedUser
            ? ofp
              ? `Flugplan geladen: ${priv.mask(ofp.callsign, "callsign")} ${ofp.originIcao} → ${ofp.destinationIcao}`
              : "Pilot-ID hinterlegt · noch kein Flugplan geladen (Karte → Seitenpanel → Dispatch)"
            : "Keine Pilot-ID hinterlegt. Du findest sie auf simbrief.com unter Account."}
        </IntegrationStatus>
      </Panel>

      <IntegrationsPanel onError={(e) => setError(e)} />

      <Panel title="Anzeige" description="Erscheinungsbild, Zeitbasis, Gewichtseinheit, Streamer-Modus, Landekarte, Flugzeugfotos und Online-Verkehr." className="settings-wide">
        <ThemePicker value={prefs.theme} onChange={(id) => setPref("theme", id).catch((e) => setError(String(e)))} />
        <div className="setting-row">
          <span className="setting-label" id="time-base">
            Uhrzeiten
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="time-base">
            <button role="radio" aria-checked={!prefs.timeLocal} className={!prefs.timeLocal ? "active" : ""} onClick={() => toggle("timeLocal", false)}>
              UTC
            </button>
            <button role="radio" aria-checked={prefs.timeLocal} className={prefs.timeLocal ? "active" : ""} onClick={() => toggle("timeLocal", true)}>
              Ortszeit
            </button>
          </div>
          <span className="detail">jetzt {fmtClock(Date.now())}</span>
        </div>
        <div className="setting-row">
          <span className="setting-label" id="weight-unit">
            Gewichte
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="weight-unit">
            {(["kg", "lb"] as const).map((u) => (
              <button
                key={u}
                role="radio"
                aria-checked={prefs.weightUnit === u}
                className={prefs.weightUnit === u ? "active" : ""}
                onClick={() => setPref("weightUnit", u).catch((e) => setError(String(e)))}
              >
                {u}
              </button>
            ))}
          </div>
          <span className="detail">Treibstoff und Gewichte · Höhen in ft, Geschwindigkeiten in kt</span>
        </div>
        <ZoomRow />
        <label className="check">
          <input type="checkbox" checked={prefs.privacyMode} onChange={(e) => void togglePrivacyMode(e.target.checked)} />
          <strong>Streamer-Modus</strong>
          <kbd className="privacy-kbd">Strg+Umschalt+P</kbd>
        </label>
        <div className="detail">
          Blendet Kennzeichen (D-••••), Rufzeichen und Flugnummer, Airline, SimBrief-ID und deinen Windows-Benutzernamen in Pfaden aus – in der ganzen
          Oberfläche, auf der Landekarte und im Diagnosepaket. Gespeichert bleibt alles wie es ist; Foto-Credits bleiben sichtbar.
        </div>
        <CardPanel onError={(e) => setError(e)} />
        <label className="check">
          <input type="checkbox" checked={prefs.airframePhotos} onChange={(e) => toggle("airframePhotos", e.target.checked)} />
          Flugzeugfotos von Planespotters.net laden
        </label>
        <div className="detail">
          Gesendet wird nur die Registrierung (z. B. D-AINA), höchstens eine Anfrage pro Sekunde; Fotos werden 7 Tage zwischengespeichert und zeigen immer
          Fotograf und Quelle. Bei fiktiven Registrierungen erscheint eine Typ-Silhouette.
        </div>
        <IntegrationStatus tone={!online?.enabled ? "off" : online.lastError ? "warn" : "ok"}>
          {!online?.enabled
            ? "VATSIM-Verkehr aus · einschalten mit „Verkehr“ auf der Karte"
            : online.lastError
              ? `VATSIM-Verkehr an · ${userMessage(online.lastError, "vatsim").title} Nächster Versuch in ${online.nextPollS} s.`
              : `VATSIM-Verkehr an · ${online.fetchedMs ? `${fmt(online.pilots)} Piloten, ${fmt(online.controllers)} Lotsen` : "warte auf ersten Abruf …"} · ausschalten mit „Verkehr“ auf der Karte`}
        </IntegrationStatus>
      </Panel>

      <DataPanel onError={(e) => setError(e)} />

      <Panel title="Updates">
        <IntegrationStatus
          tone={upd.phase === "available" || upd.phase === "ready" ? "info" : upd.phase === "error" ? "warn" : upd.phase === "none" ? "ok" : "off"}
        >
          {upd.phase === "idle" && `Version ${info?.version ?? "–"} · noch nicht geprüft`}
          {upd.phase === "checking" && `Version ${info?.version ?? "–"} · suche nach Updates …`}
          {upd.phase === "none" && `Version ${info?.version ?? "–"} · aktuell${upd.checkedMs ? ` (geprüft ${fmtClock(upd.checkedMs)})` : ""}`}
          {upd.phase === "available" && `Version ${upd.version} verfügbar (installiert: ${info?.version ?? "–"})`}
          {upd.phase === "downloading" && `Lade Version ${upd.version} … ${Math.round((upd.progress ?? 0) * 100)} %`}
          {upd.phase === "ready" && "Installiert – Neustart läuft"}
          {upd.phase === "error" && `Version ${info?.version ?? "–"} · Prüfung fehlgeschlagen: ${userMessage(upd.error ?? "", "settings").hint}`}
        </IntegrationStatus>
        {upd.phase === "downloading" && <progress className="update-progress" max={1} value={upd.progress ?? 0} aria-label="Download-Fortschritt" />}
        {upd.notes && upd.phase === "available" && <pre className="update-notes detail">{upd.notes}</pre>}
        {upd.phase === "available" && recording && (
          <div className="detail">Aufzeichnung läuft – die Installation startet VectaSim neu. Installiere das Update nach dem Flug.</div>
        )}
        <div className="setting-row">
          {upd.phase === "available" ? (
            <button className="btn-primary" onClick={() => void installUpdate()} disabled={recording}>
              Version {upd.version} installieren und neu starten
            </button>
          ) : (
            <button onClick={() => void checkForUpdate()} disabled={upd.phase === "checking" || upd.phase === "downloading"}>
              Nach Updates suchen
            </button>
          )}
        </div>
      </Panel>

      <KeyboardPanel />

      <Panel
        // remount once the Debug-Modus is known: with it on, the section starts open
        key={debugMode == null ? "loading" : "loaded"}
        title="Diagnose"
        description="Für den Support – hilft, wenn ein Flug nicht erkannt wird."
        collapsible
        defaultOpen={!!debugMode}
        actions={
          debugMode ? (
            <span className="badge badge-debug" title="Ausführliches Protokoll, Roh-Dump und Live-Rohdaten sind an. Nach der Fehlersuche wieder ausschalten.">
              <span className="badge-dot" aria-hidden="true" />
              Debug-Modus aktiv · Dump läuft
            </span>
          ) : undefined
        }
      >
        <label className="check debug-mode-toggle">
          <input type="checkbox" checked={!!debugMode} disabled={debugMode == null || debugBusy} onChange={(e) => toggleDebugMode(e.target.checked)} />
          <strong>Debug-Modus</strong>
        </label>
        <div className="detail">
          Für die Fehlersuche: ausführliches Protokoll, Roh-Dump-Aufzeichnung und Live-Rohdaten mit einem Schalter. Bleibt bis zum Ausschalten an (auch nach
          einem Neustart); danach gelten wieder deine vorherigen Einstellungen. Fehler nachstellen, dann „Diagnosepaket erstellen“.
        </div>
        <div className="setting-row">
          <button className="btn-primary" onClick={() => void createDiagPackage()} disabled={packing}>
            {packing ? "Erstellt …" : "Diagnosepaket erstellen"}
          </button>
          <span className="detail">
            {debugMode
              ? "ZIP mit Protokollen, Einstellungen, System- und Logbuch-Statistik, Roh-Dumps (max. 200 MB) und SimConnect-Infos"
              : "ZIP mit Protokollen, Einstellungen, System- und Logbuch-Statistik · mit Debug-Modus zusätzlich Roh-Dumps"}
          </span>
        </div>
        <KV rows={diag.map((r): [string, ReactNode] => [r.label, r.node ?? r.text])} />
        <div className="setting-row">
          <label htmlFor="log-level">Protokollstufe</label>
          <select
            id="log-level"
            value={logLevel?.level ?? "info"}
            onChange={(e) => void changeLogLevel(e.target.value)}
            disabled={!logLevel || !!logLevel.envOverride || !!debugMode}
            title={
              logLevel?.envOverride
                ? `Festgelegt durch RUST_LOG=${logLevel.envOverride}`
                : debugMode
                  ? "Der Debug-Modus schreibt ausführlich; nach dem Ausschalten gilt wieder diese Stufe"
                  : "Wie viel VectaSim ins Protokoll schreibt"
            }
          >
            {LOG_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          {logLevel?.envOverride ? (
            <span className="detail">festgelegt durch RUST_LOG</span>
          ) : (
            debugMode && <span className="detail">Debug-Modus: ausführlich für VectaSim</span>
          )}
        </div>
        <div className="setting-row">
          <button onClick={() => logFile && reveal(logFile)} disabled={!logFile} title={logDir ?? undefined}>
            Protokoll-Ordner öffnen
          </button>
          <button onClick={copyDiagnose}>{copied ? "✓ kopiert" : "Diagnose kopieren"}</button>
          <button onClick={() => info && reveal(info.dbPath)} disabled={!info}>
            Logbuch im Explorer zeigen
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={!!dump?.enabled || !!debugMode}
            disabled={!dump || !!debugMode}
            onChange={(e) => void toggleDump(e.target.checked)}
          />
          Roh-Dump aufzeichnen (pro Simulator-Sitzung eine Datei, etwa 5–10 MB pro Stunde){debugMode ? " · an durch den Debug-Modus" : ""}
        </label>
        <div className="detail">
          Zeichnet alle SimConnect-Rohdaten auf, damit Fehler ohne Simulator nachgestellt werden können. Unabhängig davon hält VectaSim die letzten
          30 Minuten im Speicher – „Dump jetzt speichern“ schreibt sie in eine Datei.
          {dump?.status.lastError && <span className="err-text"> {dump.status.lastError}</span>}
        </div>
        <div className="setting-row">
          <button onClick={() => void dumpNow()}>Dump jetzt speichern</button>
          <button onClick={() => dump && reveal(dump.dir)} disabled={!dump?.dir} title={dump?.dir}>
            Dump-Ordner öffnen
          </button>
        </div>
        {providers.includes("mock") && providers.includes("replay") && (
          <Panel title="Replay" description="Spielt einen Roh-Dump ab – für die Fehlersuche am Entwicklungsrechner." collapsible defaultOpen={false} level={3}>
            <div className="setting-row">
              <span className="setting-label">Datei</span>
              <span className={`dll-path${replay.path ? " mono" : " detail"}`} title={replay.path ? mp(replay.path) : undefined}>
                {replay.path ? mp(replay.path) : "keine gewählt"}
              </span>
              <button onClick={() => void chooseReplay()}>Datei wählen …</button>
            </div>
            <div className="setting-row">
              <label htmlFor="replay-speed">Geschwindigkeit</label>
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
                Endlos wiederholen
              </label>
            </div>
            <div className="setting-row">
              <button className="btn-primary" onClick={() => void startReplay()} disabled={!replay.path}>
                {status?.provider === "replay" ? "Neu starten" : "Replay starten"}
              </button>
              {status?.provider === "replay" && <button onClick={() => onProvider("simconnect")}>Replay beenden</button>}
            </div>
          </Panel>
        )}
        <Panel
          // remount so switching the Debug-Modus on opens the view (and off collapses it)
          key={debugMode ? "debug" : "normal"}
          title="Live-Rohdaten"
          description="Jede SimConnect-Variable roh und umgerechnet, Ereignisse, Engine-Zustand."
          collapsible
          defaultOpen={!!debugMode}
          level={3}
        >
          <LiveRawData />
        </Panel>
      </Panel>

      <p className="about detail">
        VectaSim {info?.version ?? ""} · Dein Logbuch liegt nur auf diesem PC – ohne Konto, ohne Cloud. Daten: Karte © OpenStreetMap-Mitwirkende, OpenFreeMap ·
        Flughäfen OurAirports (Public Domain) · Wetter NOAA aviationweather.gov (Ersatz VATSIM) · Online-Verkehr VATSIM · Flugpläne SimBrief (Navigraph) · Flugzeugfotos Planespotters.net ·{" "}
        <button className="link-btn" onClick={() => openUrl(THIRD_PARTY_NOTICES_URL).catch(() => {})} title={THIRD_PARTY_NOTICES_URL}>
          Lizenzen Dritter
        </button>
      </p>
    </section>
  );
}

/** Six visual directions as cards (radio group: arrow keys move, applied instantly). */
/** Interface size (Ctrl+Plus/Minus/0), remembered on this PC. */
/** „Landekarte“: automatic PNG after each landing, its folder, and the card without registration. */
function CardPanel({ onError }: { onError: (e: string) => void }) {
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
      const picked = await openFileDialog({ title: "Ordner für Landekarten wählen", directory: true, multiple: false, defaultPath: dir?.dir });
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
        Landekarte nach jeder Landung automatisch als PNG speichern
      </label>
      <div className="setting-row card-dir-row">
        <span className="setting-label">Ordner</span>
        <span className="dll-path mono" title={dir ? priv.mask(dir.dir, "path") : undefined}>
          {dir ? priv.mask(dir.dir, "path") : "–"}
        </span>
        {dir?.isDefault && <span className="detail">Standard</span>}
        <button onClick={() => void change()}>Ändern …</button>
        <button onClick={() => void openDir()} disabled={!dir}>
          Öffnen
        </button>
        {dir && !dir.isDefault && <button onClick={() => void reset()}>Zurücksetzen</button>}
      </div>
      <label className="check">
        <input type="checkbox" checked={prefs.cardHideReg || prefs.privacyMode} disabled={prefs.privacyMode} onChange={(e) => set("cardHideReg", e.target.checked)} />
        Landekarte ohne Kennzeichen (D-••••){prefs.privacyMode ? " · an durch den Streamer-Modus" : ""}
      </label>
    </>
  );
}

function ZoomRow() {
  const zoom = useZoom();
  const pct = `${Math.round(zoom * 100)} %`;
  const min = zoom <= ZOOM_STEPS[0];
  const max = zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return (
    <div className="setting-row">
      <span className="setting-label" id="zoom-label">
        Größe
      </span>
      <div className="zoom-control" role="group" aria-labelledby="zoom-label">
        <button className="btn-sm" onClick={() => stepZoom(-1)} disabled={min} aria-label="Verkleinern (Strg+Minus)" title="Verkleinern (Strg+Minus)">
          −
        </button>
        <output className="num zoom-value" aria-live="polite">
          {pct}
        </output>
        <button className="btn-sm" onClick={() => stepZoom(1)} disabled={max} aria-label="Vergrößern (Strg+Plus)" title="Vergrößern (Strg+Plus)">
          +
        </button>
        <button className="btn-sm" onClick={() => setZoom(1)} disabled={zoom === 1} title="Zurück auf 100 % (Strg+0)">
          100 %
        </button>
      </div>
      <span className="detail">Strg+Plus/Minus, Strg+0 · gilt nur auf diesem PC</span>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["Strg+1 / 2 / 3 / 4", "Karte, Logbuch, Länder, Einstellungen"],
  ["Strg+.", "Seitenpanel der Karte ein- und ausklappen"],
  ["Strg+F", "Logbuch durchsuchen (Flüge)"],
  ["↑ / ↓, Bild↑ / Bild↓, Pos1 / Ende", "Im Logbuch durch die Flüge blättern; ↓ im Suchfeld springt in die Liste"],
  ["Eingabetaste", "Landeauswertung des gewählten Flugs öffnen"],
  ["Entf", "Gewählten Flug in den Papierkorb legen (mit Rückfrage)"],
  ["← / →, Pos1 / Ende", "Tabs und Auswahlgruppen wechseln; im Streubild von Landung zu Landung"],
  ["Esc", "Schließt das Innerste zuerst: Herkunfts-Hinweis, dann Landeauswertung; im Suchfeld leert es die Suche"],
  ["Alt+T", "Zum neuesten Hinweis (Toast) springen; Esc schließt ihn und springt zurück"],
  ["Strg+Plus / Minus / 0", "Oberfläche vergrößern, verkleinern, zurück auf 100 %"],
  ["Strg+Umschalt+P", "Streamer-Modus ein- und ausschalten (Kennzeichen, Rufzeichen, IDs und Pfade ausblenden)"],
];

/** "Tastatur": every shortcut in one place (they were only in tooltips before). */
function KeyboardPanel() {
  return (
    <Panel title="Tastatur" description="Alle Tastenkürzel von VectaSim." collapsible defaultOpen={false}>
      <table className="shortcut-table">
        <caption className="sr-only">Tastenkürzel</caption>
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <th scope="row">
                <kbd>{keys}</kbd>
              </th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="detail">Solange die Landeauswertung offen ist, wirken nur Esc, Alt+T und der Zoom – Ansicht und Logbuch dahinter bleiben, wie sie sind.</p>
    </Panel>
  );
}

function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (id: ThemeId) => void }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = THEMES.findIndex((t) => t.id === value);
    const next = THEMES[(i + step + THEMES.length) % THEMES.length];
    const group = e.currentTarget;
    onChange(next.id);
    requestAnimationFrame(() => group.querySelector<HTMLButtonElement>(`[data-theme-id="${next.id}"]`)?.focus());
  };
  return (
    <div className="theme-picker">
      <span className="setting-label" id="theme-label">
        Erscheinungsbild
      </span>
      <div className="theme-grid" role="radiogroup" aria-labelledby="theme-label" onKeyDown={onKey}>
        {THEMES.map((t) => {
          const c = t.colors;
          const on = t.id === value;
          return (
            <button
              key={t.id}
              data-theme-id={t.id}
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={`theme-card${on ? " active" : ""}`}
              onClick={() => onChange(t.id)}
              title={t.mood}
            >
              <span className="theme-preview" style={{ background: c.bg }} aria-hidden="true">
                {[c.surface1, c.accent, c.ok, c.warn, c.route, OWN_AIRCRAFT].map((col, i) => (
                  <span key={i} className="theme-swatch" style={{ background: col }} />
                ))}
                <span className="theme-sample" style={{ color: c.text, fontFamily: `${t.fonts.num}, monospace` }}>
                  −155
                </span>
              </span>
              <span className="theme-card-text">
                <strong>
                  {t.name}
                  {t.scheme === "light" && <span className="theme-day">Tagesthema</span>}
                </strong>
                <span className="detail">{t.mood}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="detail">
        Papierkarte und Arktis Studio sind helle Tagesthemen – im abgedunkelten Sim-Raum blenden sie. Das eigene Flugzeug bleibt in jedem Thema gelb.
      </div>
    </div>
  );
}

const BACKUP_KIND_LABEL: Record<string, string> = {
  regular: "Sicherung",
  preMigration: "vor Umstellung",
  preUpdate: "vor Update",
  preRestore: "vor Wiederherstellung",
  preWipe: "vor „Alle Daten löschen“",
  preImport: "vor Import (Ersetzen)",
};

/** `VectaSim-Export_2026-10-18.vectasim` (local date). */
function bundleFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `VectaSim-Export_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.vectasim`;
}

/** Result toast of an import: what came in, what was skipped. */
function importSummary(r: BundleImportReport): string {
  const parts = [`${fmt(r.flightsAdded)} Flüge übernommen`];
  if (r.flightsSkippedDuplicate) parts.push(`${fmt(r.flightsSkippedDuplicate)} schon vorhanden`);
  if (r.airframesAdded) parts.push(`${fmt(r.airframesAdded)} Flugzeuge neu`);
  if (r.airframesUpdated) parts.push(`${fmt(r.airframesUpdated)} ergänzt`);
  if (r.imagesAdded) parts.push(`${fmt(r.imagesAdded)} Bilder`);
  return parts.join(" · ");
}
/** Backups listed in the panel (the folder may hold more pre-migration copies). */
const BACKUPS_SHOWN = 8;
const WIPE_WORD = "LÖSCHEN";

function backupLabel(b: BackupEntry): string {
  const kind = BACKUP_KIND_LABEL[b.kind] ?? b.kind;
  return b.kind === "preMigration" && b.schemaFrom != null ? `${kind} (v${b.schemaFrom})` : kind;
}

/**
 * Einstellungen → Daten: where the logbook lives, backups (folder, automatic, restore),
 * Papierkorb and „Alle Daten löschen“.
 */
function DataPanel({ onError }: { onError: (e: string) => void }) {
  const priv = usePrivacy();
  const mp = (s: string) => priv.mask(s, "path");
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      showToast({ tone: "err", title: `${what} fehlgeschlagen`, body: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const backupNow = () =>
    run("Sicherung", async () => {
      const b = await invoke<BackupEntry>("create_backup", {});
      showToast({ tone: "ok", title: "Logbuch gesichert", body: `${b.fileName} · ${fmtBytes(b.bytes)}` });
      await load();
    });

  const chooseDir = async () => {
    try {
      const picked = await openFileDialog({ title: "Ordner für Sicherungen wählen", directory: true, multiple: false, defaultPath: info?.dir });
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
        title: "Sicherung zum Wiederherstellen wählen",
        multiple: false,
        directory: false,
        defaultPath: info?.dir,
        filters: [{ name: "VectaSim-Logbuch", extensions: ["db"] }],
      });
      if (typeof picked === "string" && picked) setRestoreAsk(picked);
    } catch (e) {
      onError(String(e));
    }
  };

  const restore = (path: string) =>
    run("Wiederherstellung", async () => {
      await invoke<string>("restore_backup", { path });
      setRestoreAsk(null);
      showToast({ tone: "ok", title: "Sicherung wird wiederhergestellt", body: "VectaSim startet jetzt neu.", durationMs: null });
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
      target = await saveFileDialog({ title: "Alles exportieren", defaultPath, filters: [{ name: "VectaSim-Export", extensions: ["vectasim"] }] });
    } catch (e) {
      onError(String(e));
      return;
    }
    if (!target) return;
    await run("Export", async () => {
      const r = await invoke<BundleExportReport>("export_bundle", { path: target, includeDeleted: withTrash });
      const m = r.manifest;
      const trash = m.flightsDeleted ? ` (davon ${fmt(m.flightsDeleted)} im Papierkorb)` : "";
      showToast({
        tone: r.warnings.length ? "warn" : "ok",
        title: `Exportiert · ${fmt(m.flights)} Flüge${trash}, ${fmt(m.airframes)} Flugzeuge`,
        body: `${mp(r.path)} · ${fmtBytes(r.bytes)}${r.warnings.length ? ` · ${r.warnings.length} Hinweise im Protokoll` : ""}`,
        durationMs: 12_000,
        actions: [{ label: "Ordner öffnen", onClick: () => void revealItemInDir(r.path).catch(() => {}) }],
      });
    });
  };

  const chooseImportFile = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({
        title: "VectaSim-Export zum Importieren wählen",
        multiple: false,
        directory: false,
        filters: [{ name: "VectaSim-Export", extensions: ["vectasim"] }],
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
      showToast({ tone: "err", title: "Datei nicht lesbar", body: String(e) });
    }
  };

  const importBundle = (path: string, mode: "merge" | "replace") =>
    run("Import", async () => {
      const r = await invoke<BundleImportReport>("import_bundle", { path, mode });
      setImportAsk(null);
      showToast({
        tone: r.warnings.length ? "warn" : "ok",
        title: mode === "replace" ? "Logbuch ersetzt" : "Import abgeschlossen",
        body: `${importSummary(r)}${r.warnings.length ? ` · ${r.warnings.length} Hinweise: ${r.warnings.slice(0, 2).join("; ")}` : ""}`,
        durationMs: 15_000,
        actions: r.backup ? [{ label: "Sicherung zeigen", onClick: () => void revealItemInDir(r.backup ?? "").catch(() => {}) }] : undefined,
      });
      await load();
    });

  const emptyTrash = () =>
    run("Papierkorb leeren", async () => {
      const n = await invoke<number>("empty_trash");
      setTrashAsk(false);
      showToast({ tone: "ok", title: `Papierkorb geleert · ${fmt(n)} Flüge endgültig gelöscht` });
      await load();
    });

  const wipe = () =>
    run("Löschen", async () => {
      const r = await invoke<WipeResult>("delete_all_data");
      setWipeStep(0);
      setWipeWord("");
      showToast({
        tone: "ok",
        title: `Alle Daten gelöscht · ${fmt(r.flights)} Flüge`,
        body: `Sicherung davor: ${mp(r.backup)}`,
        durationMs: 12_000,
        actions: [{ label: "Ordner öffnen", onClick: () => void revealItemInDir(r.backup).catch(() => {}) }],
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
    <Panel title="Daten" description="Wo dein Logbuch liegt, wie es gesichert wird und wie du es zurückholst." className="settings-wide">
      <h3 className="data-head">Datenbank</h3>
      <div className="setting-row">
        <span className="setting-label">Speicherort</span>
        <span className="dll-path mono" title={info ? mp(info.dbPath) : undefined}>
          {info ? mp(info.dbPath) : "–"}
        </span>
        {info && <span className="detail">{fmtBytes(info.dbBytes)}</span>}
        <button onClick={() => info && void revealItemInDir(info.dbPath).catch((e) => onError(String(e)))} disabled={!info}>
          Im Explorer zeigen
        </button>
      </div>
      {info?.dbSync && (
        <IntegrationStatus tone="warn">
          Die Datenbank liegt in {info.dbSync}. Sync-Dienste können eine geöffnete Datenbank beschädigen – leg nur die Sicherungen dorthin, nicht
          das Logbuch selbst.
        </IntegrationStatus>
      )}

      <h3 className="data-head">Sicherungen</h3>
      <div className="setting-row">
        <span className="setting-label">Ordner</span>
        <span className="dll-path mono" title={info ? mp(info.dir) : undefined}>
          {info ? mp(info.dir) : "–"}
        </span>
        <button onClick={() => void chooseDir()} disabled={!info}>
          Ändern …
        </button>
        {info && !info.isDefault && <button onClick={() => void resetDir()}>Zurücksetzen</button>}
        <button onClick={() => invoke("open_backup_dir").catch((e) => onError(String(e)))} disabled={!info}>
          Ordner öffnen
        </button>
      </div>
      {info?.dirSync ? (
        <IntegrationStatus tone="ok">Der Ordner liegt in {info.dirSync} – so hast du deine Sicherungen auch außerhalb dieses PCs.</IntegrationStatus>
      ) : (
        info && (
          <div className="detail">
            Tipp: Wähle einen Ordner in OneDrive, Dropbox, Google Drive oder auf einem NAS – dann liegen deine Sicherungen auch außerhalb dieses PCs.
          </div>
        )
      )}
      <IntegrationStatus tone={last ? "ok" : "off"}>
        {last ? `Letzte Sicherung: ${fmtDate(last)} ${fmtClock(last)}` : "Noch keine Sicherung"} · automatisch täglich, vor Updates und vor jeder
        Umstellung des Datenformats; die letzten 7 Tage bleiben.
      </IntegrationStatus>
      <div className="setting-row">
        <button className="btn-primary" onClick={() => void backupNow()} disabled={!info || busy != null}>
          {busy === "Sicherung" ? "Sichert …" : "Jetzt sichern"}
        </button>
        <button onClick={() => void chooseRestoreFile()} disabled={!info || blocked || busy != null}>
          Aus Datei wiederherstellen …
        </button>
      </div>
      {blocked && <div className="detail">Aufzeichnung läuft – Wiederherstellen und Löschen gehen nach dem Flug.</div>}
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
              <span className="detail">{backupLabel(b)}</span>
              <span className="detail num">{fmtBytes(b.bytes)}</span>
              {restoreAsk === b.path ? (
                <RestoreConfirm path={b.path} busy={busy != null} onConfirm={() => void restore(b.path)} onCancel={() => setRestoreAsk(null)} onKey={cancelOnEsc} />
              ) : (
                <button className="btn-sm" onClick={() => setRestoreAsk(b.path)} disabled={blocked || busy != null} title={mp(b.path)}>
                  Wiederherstellen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="data-head">Gesamtexport</h3>
      <div className="setting-row">
        <button onClick={() => void exportAll()} disabled={!info || busy != null}>
          {busy === "Export" ? "Exportiert …" : "Alles exportieren …"}
        </button>
        <label className="check">
          <input type="checkbox" checked={withTrash} onChange={(e) => setWithTrash(e.target.checked)} />
          Papierkorb einschließen
        </label>
        <button onClick={() => void chooseImportFile()} disabled={!info || busy != null}>
          Aus Datei importieren …
        </button>
      </div>
      <div className="detail">
        Zum Umzug auf einen anderen PC oder zum Zusammenführen zweier PCs. Die Datei (.vectasim) enthält alle Flüge mit Tracks, die Flotte und
        eigene Flugzeugbilder.
      </div>
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

      <h3 className="data-head">Import</h3>
      <div className="setting-row">
        <button onClick={() => setCsvOpen(true)} disabled={!info || busy != null} aria-haspopup="dialog">
          CSV importieren …
        </button>
        <span className="detail">
          Flüge aus Volanta (Import-CSV), SimToolkitPro, einem VA-Export oder dem eigenen Logbuch-CSV übernehmen – ohne Track und
          Landeanalyse, aber mit Stunden, Strecken, Flotte und Ländern.
        </span>
      </div>
      {csvOpen && <CsvImportDialog onClose={() => setCsvOpen(false)} />}

      <h3 className="data-head">Papierkorb</h3>
      <div className="setting-row">
        <span>
          {info ? (info.trashCount ? `${fmt(info.trashCount)} Flüge im Papierkorb` : "Der Papierkorb ist leer") : "–"}
          <span className="detail"> · nach {info?.trashDays ?? 30} Tagen endgültig gelöscht, wiederherstellen im Logbuch → Papierkorb</span>
        </span>
        {trashAsk ? (
          <span className="confirm-delete" role="group" aria-label="Papierkorb leeren bestätigen" onKeyDown={cancelOnEsc(() => setTrashAsk(false))}>
            <span className="detail">Endgültig löschen?</span>
            <button className="btn-sm danger" onClick={() => void emptyTrash()} disabled={busy != null}>
              Papierkorb leeren
            </button>
            <button className="btn-sm" onClick={() => setTrashAsk(false)} autoFocus>
              Abbrechen
            </button>
          </span>
        ) : (
          <button onClick={() => setTrashAsk(true)} disabled={!info?.trashCount}>
            Papierkorb leeren
          </button>
        )}
      </div>

      <h3 className="data-head">Alle Daten löschen</h3>
      {wipeStep === 0 && (
        <div className="setting-row">
          <span className="detail">Löscht alle Flüge und die Flotte. Vorher legt VectaSim eine Sicherung an; deine Einstellungen bleiben.</span>
          <button className="danger" onClick={() => setWipeStep(1)} disabled={!info || blocked}>
            Alle Daten löschen …
          </button>
        </div>
      )}
      {wipeStep === 1 && (
        <div className="setting-row confirm-delete" role="group" aria-label="Alle Daten löschen" onKeyDown={cancelOnEsc(() => setWipeStep(0))}>
          <span>Wirklich alle Flüge und die Flotte löschen? Eine Sicherung davon landet im Sicherungsordner.</span>
          <button className="btn-sm danger" onClick={() => setWipeStep(2)}>
            Weiter
          </button>
          <button className="btn-sm" onClick={() => setWipeStep(0)} autoFocus>
            Abbrechen
          </button>
        </div>
      )}
      {wipeStep === 2 && (
        <div
          className="setting-row confirm-delete"
          role="group"
          aria-label="Alle Daten löschen – letzte Bestätigung"
          onKeyDown={cancelOnEsc(() => {
            setWipeStep(0);
            setWipeWord("");
          })}
        >
          <label htmlFor="wipe-word">Tippe {WIPE_WORD} zur Bestätigung</label>
          <input id="wipe-word" className="wipe-word" value={wipeWord} onChange={(e) => setWipeWord(e.target.value)} autoFocus autoComplete="off" />
          <button className="btn-sm danger" onClick={() => void wipe()} disabled={wipeWord.trim().toUpperCase() !== WIPE_WORD || busy != null}>
            {busy === "Löschen" ? "Löscht …" : "Endgültig löschen"}
          </button>
          <button
            className="btn-sm"
            onClick={() => {
              setWipeStep(0);
              setWipeWord("");
            }}
          >
            Abbrechen
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
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const m = manifest;
  const shownPath = usePrivacy().mask(path, "path");
  return (
    <div className="import-confirm" role="group" aria-label="Import bestätigen" onKeyDown={onKey(onCancel)}>
      <div className="dll-path mono" title={shownPath}>
        {shownPath}
      </div>
      {m && (
        <div className="detail">
          {fmt(m.flights)} Flüge{m.flightsDeleted ? ` (davon ${fmt(m.flightsDeleted)} im Papierkorb)` : ""} · {fmt(m.airframes)} Flugzeuge
          {m.images ? ` · ${fmt(m.images)} Bilder` : ""} · exportiert am {fmtDate(m.createdMs)} {fmtClock(m.createdMs)} mit VectaSim {m.appVersion}
        </div>
      )}
      <label className="check">
        <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} autoFocus />
        <span>
          <strong>Zusammenführen</strong>
          <span className="detail"> – neue Flüge und Flugzeuge kommen dazu. Flüge, die schon da sind (gleicher Flug oder gleiche Strecke mit
          weniger als 15 min Abstand beim Off-Block), werden übersprungen; vorhandene Flugzeugdaten bleiben.</span>
        </span>
      </label>
      <label className="check">
        <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} disabled={replaceBlocked} />
        <span>
          <strong>Ersetzen</strong>
          <span className="detail">
            {" "}
            – dein Logbuch und die Flotte werden durch den Inhalt der Datei ersetzt. Vorher legt VectaSim eine Sicherung an.
            {replaceBlocked ? " Während einer Aufzeichnung nicht möglich." : ""}
          </span>
        </span>
      </label>
      <div className="setting-row">
        <button className={mode === "replace" ? "btn-sm danger" : "btn-sm btn-primary"} onClick={() => onImport(mode)} disabled={busy || (mode === "replace" && replaceBlocked)}>
          {busy ? "Importiert …" : mode === "replace" ? "Sichern und ersetzen" : "Zusammenführen"}
        </button>
        <button className="btn-sm" onClick={onCancel}>
          Abbrechen
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
  const shownPath = usePrivacy().mask(path, "path");
  return (
    <span className="confirm-delete restore-confirm" role="group" aria-label="Wiederherstellen bestätigen" onKeyDown={onKey(onCancel)} title={shownPath}>
      <span className="detail">Logbuch durch diese Sicherung ersetzen? Dein aktueller Stand wird vorher gesichert, dann startet VectaSim neu.</span>
      <button className="btn-sm danger" onClick={onConfirm} disabled={busy}>
        Ersetzen und neu starten
      </button>
      <button className="btn-sm" onClick={onCancel} autoFocus>
        Abbrechen
      </button>
    </span>
  );
}
