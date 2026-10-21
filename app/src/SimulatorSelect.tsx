import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import ErrorNotice from "./ErrorNotice";
import { t as tGlobal, useT } from "./i18n";
// one port range everywhere (X-Plane Web API and the overlay server)
import { PORT_MAX, PORT_MIN } from "./serverLinks";

/** Backend `simselect::SimSettings` (`get_sim_settings`). */
export interface SimSettings {
  /** auto | simconnect | xplane */
  mode: SimMode;
  xplaneHost: string;
  xplanePort: number;
  defaultHost: string;
  defaultPort: number;
  /** `VECTASIM_PROVIDER=…` / `VECTASIM_XPLANE_*=…` set for this run: they win over the setting. */
  envOverride: string[];
}

export type SimMode = "auto" | "simconnect" | "xplane";

export const SIM_MODES: { value: SimMode; label: string }[] = [
  {
    value: "auto",
    get label() {
      return tGlobal("settings.simulator.modeAuto");
    },
  },
  { value: "simconnect", label: "MSFS 2020/2024" },
  { value: "xplane", label: "X-Plane 12" },
];

/** Host check as the backend does it: not empty, no blanks, no path. */
export function hostError(host: string): string | null {
  const h = host.trim();
  if (!h) return tGlobal("settings.simulator.hostMissing");
  if (/\s|\//.test(h)) return tGlobal("settings.simulator.hostInvalid");
  return null;
}

/** Port 1024–65535 as text → number, or null. */
export function parsePort(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= PORT_MIN && n <= PORT_MAX ? n : null;
}

/** "localhost:8086" – what the Diagnose shows as source. */
export function endpointLabel(host: string, port: number | null): string {
  return `X-Plane Web API ${host.trim() || "?"}:${port ?? "?"}`;
}

interface Props {
  /** A flight is being recorded: the change applies with the next start. */
  flightActive?: boolean;
  /** VectaSim is connected to X-Plane right now (status provider "xplane", state "connected"). */
  xplaneConnected?: boolean;
}

/**
 * "Automatisch" without a running X-Plane connection: the X-Plane address is folded away
 * (MSFS users do not need it) – unless it is invalid or not the default.
 */
export function foldXplane(mode: SimMode, xplaneConnected: boolean, invalid: boolean, custom: boolean): boolean {
  return mode === "auto" && !xplaneConnected && !invalid && !custom;
}

/**
 * Settings → Simulator: which simulator VectaSim connects to and where X-Plane's Web API
 * listens. One save rule like the overlay port: the choice saves on change, host and port when
 * the field is left or with Enter, each with a short "✓ gespeichert" at its row. Saving restarts
 * the connection (not during a flight or a demo/replay).
 */
export default function SimulatorSelect({ flightActive, xplaneConnected = false }: Props) {
  const t = useT();
  const [saved, setSaved] = useState<SimSettings | null>(null);
  const [mode, setMode] = useState<SimMode>("auto");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  /** Short confirmation, shown at the row that saved. */
  const [note, setNote] = useState<{ row: "mode" | "xplane"; text: string } | null>(null);
  /** Load or save failure; a failed load offers "Retry" (the select stays disabled without settings). */
  const [error, setError] = useState<{ e: unknown; retry?: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The user opened/closed the X-Plane fold; null = follow foldXplane(). */
  const [foldOpen, setFoldOpen] = useState<boolean | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  const alive = useRef(true);
  const load = () => {
    setError(null);
    invoke<SimSettings>("get_sim_settings")
      .then((s) => {
        if (!alive.current) return;
        setSaved(s);
        setMode(s.mode);
        setHost(s.xplaneHost);
        setPort(String(s.xplanePort));
      })
      .catch((e) => alive.current && setError({ e, retry: load }));
  };
  const loadRef = useRef(load);
  useEffect(() => {
    alive.current = true;
    loadRef.current();
    return () => {
      alive.current = false;
      window.clearTimeout(noteTimer.current);
    };
  }, []);

  const portNum = parsePort(port);
  const invalid = hostError(host) ?? (portNum == null ? t("settings.simulator.portRange", { min: String(PORT_MIN), max: String(PORT_MAX) }) : null);
  const dirty = !!saved && (mode !== saved.mode || host.trim() !== saved.xplaneHost || portNum !== saved.xplanePort);

  const save = (row: "mode" | "xplane", next: { mode: SimMode; host: string; port: number }) => {
    setBusy(true);
    setError(null);
    invoke<boolean>("set_sim_settings", { mode: next.mode, xplaneHost: next.host.trim(), xplanePort: next.port })
      .then((restarted) => {
        setSaved((s) => (s ? { ...s, mode: next.mode, xplaneHost: next.host.trim(), xplanePort: next.port } : s));
        setNote({ row, text: restarted ? t("settings.simulator.savedRestart") : t("settings.simulator.savedLater") });
        window.clearTimeout(noteTimer.current);
        noteTimer.current = window.setTimeout(() => setNote(null), 4000);
      })
      .catch((e) => setError({ e }))
      .finally(() => setBusy(false));
  };

  /** Host/port field left or Enter: saves when changed and valid; an invalid value stays with its hint. */
  const commitAddress = () => {
    if (!saved || busy || invalid || portNum == null) return;
    if (host.trim() === saved.xplaneHost && portNum === saved.xplanePort) return;
    save("xplane", { mode, host, port: portNum });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitAddress();
  };

  const showXplane = mode !== "simconnect";
  const custom = !!saved && (saved.xplaneHost !== saved.defaultHost || saved.xplanePort !== saved.defaultPort);
  // before the settings arrive the empty fields read as invalid: wait for them
  const folded = foldXplane(mode, xplaneConnected, !!saved && !!invalid, custom);
  const noteAt = (row: "mode" | "xplane") =>
    note?.row === row && (
      <span className="ok-text" role="status">
        {note.text}
      </span>
    );

  return (
    <>
      <div className="setting-row">
        <label htmlFor="sim-mode">{t("settings.simulator.connectTo")}</label>
        <select
          id="sim-mode"
          value={mode}
          disabled={!saved || busy}
          onChange={(e) => {
            const m = e.target.value as SimMode;
            setMode(m);
            if (!saved) return;
            // the choice saves at once; a host/port still being typed (invalid) keeps the stored address
            const ok = !invalid && portNum != null;
            save("mode", { mode: m, host: ok ? host : saved.xplaneHost, port: ok ? portNum : saved.xplanePort });
          }}
          title={t("settings.simulator.modeTitle")}
        >
          {SIM_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {noteAt("mode")}
      </div>
      {showXplane && (
        <XplaneFold fold={mode === "auto"} open={foldOpen ?? !folded} onToggle={setFoldOpen} summary={t("settings.simulator.xplaneFold", { endpoint: endpointLabel(host, portNum) })}>
        <div className="setting-row">
          <label htmlFor="xplane-host">X-Plane Web API</label>
          <input
            id="xplane-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onBlur={commitAddress}
            onKeyDown={onEnter}
            placeholder={saved?.defaultHost ?? "localhost"}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!hostError(host)}
            aria-describedby="xplane-help"
            title={t("settings.simulator.hostTitle")}
            style={{ width: "12em" }}
          />
          <span aria-hidden="true">:</span>
          <input
            id="xplane-port"
            aria-label={t("settings.server.port.label")}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={commitAddress}
            onKeyDown={onEnter}
            placeholder={String(saved?.defaultPort ?? 8086)}
            inputMode="numeric"
            aria-invalid={portNum == null}
            aria-describedby="xplane-help"
            title={t("settings.simulator.portTitle")}
            style={{ width: "5em" }}
          />
          {saved && (host.trim() !== saved.defaultHost || portNum !== saved.defaultPort) && (
            <button
              disabled={busy}
              onClick={() => {
                setHost(saved.defaultHost);
                setPort(String(saved.defaultPort));
                save("xplane", { mode, host: saved.defaultHost, port: saved.defaultPort });
              }}
            >
              {t("settings.simulator.default")}
            </button>
          )}
          {noteAt("xplane")}
        </div>
        <div className={invalid ? "detail err-text" : "detail"} id="xplane-help">
          {invalid ? invalid : t("settings.simulator.xplaneHelp", { endpoint: endpointLabel(host, portNum) })}
        </div>
        </XplaneFold>
      )}
      {flightActive && dirty && <div className="detail">{t("settings.simulator.flightActive")}</div>}
      {saved && saved.envOverride.length > 0 && <div className="detail">{t("settings.simulator.envOverride", { vars: saved.envOverride.join(", ") })}</div>}
      {error && <ErrorNotice error={error.e} context="settings" compact onRetry={error.retry} />}
    </>
  );
}

/**
 * The X-Plane rows; with "Automatisch" inside an "X-Plane-Adresse …" fold, open as `open` says
 * until the user toggles it (then their choice stays).
 */
function XplaneFold({ fold, open, onToggle, summary, children }: { fold: boolean; open: boolean; onToggle: (open: boolean) => void; summary: string; children: ReactNode }) {
  if (!fold) return <>{children}</>;
  return (
    // a programmatic open/close (prop change) fires toggle too: only the user's own click differs from the prop
    <details className="fold xplane-fold" open={open} onToggle={(e) => e.currentTarget.open !== open && onToggle(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
