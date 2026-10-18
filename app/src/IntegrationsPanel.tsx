// Einstellungen → Integrationen: Discord Rich Presence, Windows notifications, tray icon.
// The backend does the work (discord.rs, notify.rs, tray.rs); this panel only switches and
// shows the state.

import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import Panel from "./ui/Panel";
import { showToast } from "./ui/Toast";
import { setPref, usePrefs, type Prefs } from "./prefs";
import type { DiscordStatus, NotifyResult } from "./types";
import "./integrations.css";

const SETTING_DISCORD_APP_ID = "discord_app_id";
const DISCORD_POLL_MS = 5000;

type Tone = "ok" | "warn" | "off" | "err" | "info";

/** Same markup as the status lines in Settings (`.integration`, App.css). */
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

const NOTIFY_KINDS: Array<{ key: keyof Prefs; label: string }> = [
  { key: "notifyLanding", label: "Landung (Landerate, g-Last, Bounces)" },
  { key: "notifySaved", label: "Flug gespeichert" },
  { key: "notifyConnection", label: "Verbindung zum Simulator verloren / wieder da" },
  { key: "notifyUpdate", label: "Update verfügbar" },
];

function discordLine(on: boolean, s: DiscordStatus | null): { tone: Tone; text: string } {
  if (!on) return { tone: "off", text: "Aus · Discord zeigt nichts von VectaSim." };
  switch (s?.state) {
    case "connected":
      return { tone: "ok", text: s.showing ? `Verbunden · Discord zeigt: ${s.showing}` : "Verbunden · Status wird gleich gesetzt" };
    case "not_running":
      return { tone: "info", text: "Discord nicht gestartet · VectaSim versucht es alle 30 s erneut." };
    case "no_app_id":
      return { tone: "warn", text: "Keine Discord-App-ID hinterlegt · trage unten die ID deiner Discord-Anwendung ein." };
    default:
      return { tone: "info", text: "Verbinde mit Discord …" };
  }
}

export default function IntegrationsPanel({ onError }: { onError?: (e: string) => void }) {
  const prefs = usePrefs();
  const [discord, setDiscord] = useState<DiscordStatus | null>(null);
  const [appId, setAppId] = useState("");
  const [storedAppId, setStoredAppId] = useState("");
  const [trayActive, setTrayActive] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const fail = (e: unknown) => (onError ? onError(String(e)) : showToast({ tone: "warn", title: "Einstellung nicht gespeichert", body: String(e) }));

  useEffect(() => {
    invoke<[string, string][]>("get_settings")
      .then((rows) => {
        const v = rows.find(([k]) => k === SETTING_DISCORD_APP_ID)?.[1] ?? "";
        setAppId(v);
        setStoredAppId(v);
      })
      .catch(() => {});
    invoke<boolean>("tray_active")
      .then(setTrayActive)
      .catch(() => setTrayActive(null));
  }, []);

  // the presence thread runs every 5 s: poll its state while the panel is open
  useEffect(() => {
    let alive = true;
    const poll = () =>
      void invoke<DiscordStatus>("discord_status")
        .then((s) => alive && setDiscord(s))
        .catch(() => {});
    poll();
    const t = window.setInterval(poll, DISCORD_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const toggle = (key: keyof Prefs, on: boolean) => void setPref(key, on).catch(fail);

  const saveAppId = () => {
    const v = appId.trim();
    if (v === storedAppId) return;
    if (v && !/^\d{15,22}$/.test(v)) {
      fail("Die Discord-App-ID ist eine Zahl mit 17–20 Stellen (Developer Portal → Applications → Application ID).");
      return;
    }
    invoke("set_setting", { key: SETTING_DISCORD_APP_ID, value: v })
      .then(() => setStoredAppId(v))
      .catch(fail);
  };

  const setTray = async (on: boolean) => {
    try {
      await setPref("trayMinimize", on);
      setTrayActive(await invoke<boolean>("set_tray_enabled", { on }));
    } catch (e) {
      fail(e);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await invoke<NotifyResult>("notify_test");
      showToast({
        id: "notify-test",
        tone: r.shown ? "ok" : "warn",
        title: r.shown ? "Testbenachrichtigung gesendet" : "Keine Benachrichtigung möglich",
        body: r.shown
          ? "Sie erscheint unten rechts. Siehst du nichts, prüfe Windows → Einstellungen → System → Benachrichtigungen (auch „Nicht stören“)."
          : "Windows hat die Benachrichtigung abgelehnt – Details im Protokoll.",
        durationMs: 6000,
      });
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const d = discordLine(prefs.discordPresence, discord);

  return (
    <Panel title="Integrationen" description="Discord-Status, Windows-Benachrichtigungen und Infobereich (Tray).">
      <div className="integrations">
        <section className="integrations-group" aria-labelledby="int-discord">
          <h3 id="int-discord" className="integrations-title">
            Discord
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.discordPresence} onChange={(e) => toggle("discordPresence", e.target.checked)} />
            Flug als Discord-Status zeigen (Rich Presence)
          </label>
          <div className="detail">
            Zeigt Route, Flugzeugtyp, Phase und Flugzeit, z. B. „EDDF → EGLL · A20N“ und „Reiseflug FL360 · noch 420 nm“. Im Streamer-Modus ohne Rufzeichen.
            Höchstens alle 15 s ein Update; nur der lokal laufende Discord-Client wird angesprochen.
          </div>
          <Status tone={d.tone}>{d.text}</Status>
          {prefs.discordPresence && (
            <div className="setting-row">
              <label htmlFor="discord-app-id">App-ID</label>
              <input
                id="discord-app-id"
                inputMode="numeric"
                autoComplete="off"
                value={appId}
                placeholder="leer = VectaSim-Standard"
                onChange={(e) => setAppId(e.target.value)}
                onBlur={saveAppId}
                onKeyDown={(e) => e.key === "Enter" && saveAppId()}
              />
              <span className="detail">optional · eigene Anwendung aus dem Discord Developer Portal (Bild-Asset „vectasim“)</span>
            </div>
          )}
        </section>

        <section className="integrations-group" aria-labelledby="int-notify">
          <h3 id="int-notify" className="integrations-title">
            Benachrichtigungen
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.notifications} onChange={(e) => toggle("notifications", e.target.checked)} />
            Windows-Benachrichtigungen, wenn VectaSim nicht im Vordergrund ist
          </label>
          <div className="integrations-sub" aria-label="Benachrichtigen bei">
            {NOTIFY_KINDS.map((k) => (
              <label key={k.key} className="check">
                <input type="checkbox" checked={!!prefs[k.key]} disabled={!prefs.notifications} onChange={(e) => toggle(k.key, e.target.checked)} />
                {k.label}
              </label>
            ))}
          </div>
          <div className="setting-row">
            <button className="btn btn-sm" onClick={() => void sendTest()} disabled={testing}>
              Test senden
            </button>
            <span className="detail">Ohne Kennzeichen und Rufzeichen. Ein Klick auf die Benachrichtigung holt VectaSim nach vorn.</span>
          </div>
        </section>

        <section className="integrations-group" aria-labelledby="int-tray">
          <h3 id="int-tray" className="integrations-title">
            Infobereich (Tray)
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.trayMinimize} onChange={(e) => void setTray(e.target.checked)} />
            Symbol im Infobereich · Minimieren versteckt das Fenster dorthin
          </label>
          <div className="detail">
            Doppelklick auf das Symbol öffnet VectaSim wieder; das Menü zeigt den Aufzeichnungsstatus, schaltet den Debug-Modus und beendet die App. Die Aufzeichnung läuft
            im Infobereich unverändert weiter, Beenden fragt während eines Flugs nach.
          </div>
          <Status tone={trayActive ? "ok" : "off"}>{trayActive ? "Symbol im Infobereich aktiv" : "Kein Symbol im Infobereich"}</Status>
        </section>
      </div>
    </Panel>
  );
}
