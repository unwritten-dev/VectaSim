// Einstellungen → Overlay & Schnittstelle: switches the local HTTP/WebSocket server
// (crates/vectasim-server via server.rs) and lists the overlay URLs for OBS, a tablet and VAs.
// Pure parts (URLs, status line, port input) live in serverLinks.ts.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, useT } from "./i18n";
import Panel from "./ui/Panel";
import { rich } from "./ui/richText";
import { showToast } from "./ui/Toast";
import { usePrivacy } from "./prefs";
import {
  OVERLAYS,
  PORT_MAX,
  PORT_MIN,
  lanBase,
  localBase,
  obsSize,
  parsePortInput,
  shownToken,
  statusLine,
  urlFor,
  type ServerStatus,
  type Tone,
} from "./serverLinks";
import "./server.css";

/** Client count and "läuft seit" refresh while the panel is open. */
const POLL_MS = 3000;

/** Same markup as the status lines in Settings/Integrationen (`.integration`, App.css). */
function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  const sym = { ok: "✓", warn: "▲", off: "○", err: "!", info: "◆" }[tone];
  return (
    <div className={`integration integration-${tone}`} role="status">
      <span className="integration-icon" aria-hidden="true">
        {sym}
      </span>
      <span>{children}</span>
    </div>
  );
}

async function copy(text: string, copiedTitle: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ id: "server-copy", tone: "ok", title: copiedTitle, durationMs: 2500 });
    return true;
  } catch (e) {
    showToast({ id: "server-copy", tone: "warn", title: t("settings.server.copyFailed"), body: String(e) });
    return false;
  }
}

/** How long a copy button says "Kopiert ✓" and the port row "✓ gespeichert". */
const FEEDBACK_MS = 2000;

/** `initialStatus` only seeds the first render (tests, static markup); the panel polls `server_status` itself. */
export default function ServerPanel({
  onError,
  className,
  initialStatus = null,
}: {
  onError?: (e: string) => void;
  className?: string;
  initialStatus?: ServerStatus | null;
}) {
  const t = useT();
  const priv = usePrivacy();
  const [status, setStatus] = useState<ServerStatus | null>(initialStatus);
  const [portText, setPortText] = useState(() => (initialStatus ? String(initialStatus.port) : ""));
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Port field: inline result (saved / error) instead of a toast, like the simulator address. */
  const [portNote, setPortNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  /** Which copy button just copied (its label says so for a moment). */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);
  const later = (fn: () => void) => timers.current.push(window.setTimeout(fn, FEEDBACK_MS));
  const copyWith = (id: string, text: string, copiedTitle: string) =>
    void copy(text, copiedTitle).then((ok) => {
      if (!ok) return;
      setCopiedId(id);
      later(() => setCopiedId((c) => (c === id ? null : c)));
    });
  const copyLabel = (id: string) => (copiedId === id ? t("settings.server.copiedButton") : t("shell.action.copy"));
  const fail = (e: unknown) => (onError ? onError(String(e)) : showToast({ tone: "warn", title: t("settings.notSaved"), body: String(e) }));

  useEffect(() => {
    let alive = true;
    const poll = () =>
      void invoke<ServerStatus>("server_status")
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          setNow(Date.now());
        })
        .catch(() => {});
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // the field follows the server until the user types
  const port = status?.port ?? null;
  useEffect(() => {
    if (port != null) setPortText(String(port));
  }, [port]);

  const run = async (cmd: string, args: Record<string, unknown>, onFail: (e: unknown) => void = fail): Promise<boolean> => {
    setBusy(true);
    try {
      setStatus(await invoke<ServerStatus>(cmd, args));
      setNow(Date.now());
      return true;
    } catch (e) {
      onFail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Field left or Enter: saves a changed port; errors and "✓ gespeichert" show at the field. */
  const savePort = () => {
    if (!status) return;
    const p = parsePortInput(portText);
    if ("error" in p) {
      setPortNote({ tone: "err", text: p.error });
      setPortText(String(status.port));
      return;
    }
    if (p.port === status.port) return;
    void run("server_set_options", { options: { port: p.port } }, (e) => setPortNote({ tone: "err", text: `${t("settings.notSaved")}: ${String(e)}` })).then(
      (ok) => {
        if (!ok) return;
        setPortNote({ tone: "ok", text: t("settings.savedMark") });
        later(() => setPortNote((n) => (n?.tone === "ok" ? null : n)));
      },
    );
  };

  const line = statusLine(status, now);
  const enabled = !!status?.enabled;
  const local = status ? localBase(status.port) : "";
  const lan = status ? lanBase(status) : null;
  const token = status?.token ?? "";

  return (
    <Panel
      title={t("settings.server.title")}
      className={className}
      description={t("settings.server.description")}
    >
      <div className="server-panel">
        <label className="check">
          <input type="checkbox" checked={enabled} disabled={!status || busy} onChange={(e) => void run("server_set_enabled", { enabled: e.target.checked })} />
          {t("settings.server.enable")}
        </label>
        <Status tone={line.tone}>{line.text}</Status>

        {/* port and LAN only matter while the server runs: dimmed (still editable) while it is
            off, so they do not read as active settings */}
        <div className={`server-options${status && !enabled ? " server-options-off" : ""}`}>
        {status && !enabled && <div className="detail server-options-note">{t("settings.server.optionsOff")}</div>}
        <div className="setting-row">
          <label htmlFor="server-port">{t("settings.server.port.label")}</label>
          <input
            id="server-port"
            className="num"
            inputMode="numeric"
            autoComplete="off"
            value={portText}
            disabled={!status || busy}
            onChange={(e) => {
              setPortText(e.target.value);
              if (portNote?.tone === "err") setPortNote(null);
            }}
            onBlur={savePort}
            onKeyDown={(e) => e.key === "Enter" && savePort()}
            aria-invalid={portNote?.tone === "err"}
            aria-describedby="server-port-note"
          />
          {portNote ? (
            <span id="server-port-note" className={portNote.tone === "ok" ? "ok-text" : "err-text"} role={portNote.tone === "ok" ? "status" : "alert"}>
              {portNote.text}
            </span>
          ) : (
            <span id="server-port-note" className="detail">
              {t("settings.server.port.detail", { port: "8095", min: String(PORT_MIN), max: String(PORT_MAX) })}
            </span>
          )}
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={!!status?.lan}
            disabled={!status || busy}
            onChange={(e) => void run("server_set_options", { options: { lan: e.target.checked } })}
          />
          {t("settings.server.lan")}
        </label>
        <div className="detail">{t("settings.server.lanHelp")}</div>
        {status?.lan && (
          <div className="setting-row server-token">
            <span className="server-token-label">{t("settings.server.token")}</span>
            <code className="server-code num" aria-label={t("settings.server.token")}>
              {shownToken(token, priv.on, revealed)}
            </code>
            {priv.on && (
              <button className="btn btn-sm" onClick={() => setRevealed(!revealed)}>
                {revealed ? t("shell.action.hide") : t("shell.action.show")}
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => copyWith("token", token, t("settings.server.copied.token"))}
              disabled={!token}
              aria-label={t("settings.server.copyAria.token")}
            >
              {copyLabel("token")}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => void run("server_set_options", { options: { regenerateToken: true } })}>
              {t("settings.server.regenerate")}
            </button>
          </div>
        )}
        {status?.lan && !status.lanAddress && <div className="detail">{t("settings.server.noLanAddress")}</div>}
        </div>

        {enabled && status && (
          <section className="server-links" aria-labelledby="server-links-title">
            <h3 id="server-links-title" className="server-title">
              {t("settings.server.addresses")}
            </h3>
            <ul className="server-list">
              {OVERLAYS.map((o) => {
                const url = urlFor(local, o.path);
                const lanUrl = lan ? urlFor(lan, o.path, token) : null;
                const size = obsSize(o);
                return (
                  <li key={o.id} className="server-item">
                    <div className="server-item-head">
                      <strong>{o.label}</strong>
                      <span className="detail">
                        {o.hint}
                        {size ? ` · ${t("settings.server.obs", { size })}` : ""}
                      </span>
                    </div>
                    <div className="server-url">
                      <code className="server-code">{url}</code>
                      <button
                        className="btn btn-sm"
                        onClick={() => copyWith(o.id, url, t("settings.server.copied.url", { name: o.label }))}
                        aria-label={t("settings.server.copyAria.url", { name: o.label })}
                      >
                        {copyLabel(o.id)}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={!status.running}
                        onClick={() => void openUrl(url).catch(fail)}
                        aria-label={t("settings.server.openAria", { name: o.label })}
                      >
                        {t("shell.action.openBrowser")}
                      </button>
                    </div>
                    {lanUrl && (
                      <div className="server-url">
                        <code className="server-code" title={t("settings.server.lanUrlTitle")}>
                          {priv.on && !revealed ? urlFor(lan!, o.path, shownToken(token, true, false)) : lanUrl}
                        </code>
                        <button
                          className="btn btn-sm"
                          onClick={() => copyWith(`${o.id}-lan`, lanUrl, t("settings.server.copied.lanUrl", { name: o.label }))}
                          aria-label={t("settings.server.copyAria.lanUrl", { name: o.label })}
                        >
                          {copyLabel(`${o.id}-lan`)}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="server-obs">
              <div className="server-obs-title">{t("settings.server.obsSteps.title")}</div>
              <ol className="server-obs-steps detail">
                <li>{t("settings.server.obsSteps.source")}</li>
                <li>{t("settings.server.obsSteps.url")}</li>
                <li>{t("settings.server.obsSteps.size")}</li>
                <li>{t("settings.server.obsSteps.done")}</li>
              </ol>
              <div className="detail">{rich(t("settings.server.obsHelp"), { scale: <code>?scale=1.5</code>, preview: <code>?preview=1</code> })}</div>
            </div>
          </section>
        )}
      </div>
    </Panel>
  );
}
