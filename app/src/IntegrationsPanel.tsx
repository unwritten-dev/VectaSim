// Einstellungen → Integrationen: Discord Rich Presence, Windows notifications, tray icon.
// The backend does the work (discord.rs, notify.rs, tray.rs); this panel only switches and
// shows the state.

import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t as tGlobal, useT } from "./i18n";
import type { TFunction } from "./i18n";
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

const NOTIFY_KINDS = [
  { key: "notifyLanding", label: "settings.integrations.notify.landing" },
  { key: "notifySaved", label: "settings.integrations.notify.saved" },
  { key: "notifyConnection", label: "settings.integrations.notify.connection" },
  { key: "notifyUpdate", label: "settings.integrations.notify.update" },
] as const satisfies ReadonlyArray<{ key: keyof Prefs; label: string }>;

/**
 * Status line of the Discord switch. `customAppId` = the stored own App-ID ("" = VectaSim
 * default). "no_app_id" with an empty field means the build carries no default ID – a
 * developer error, logged, and told to the user without blaming the empty field.
 */
export function discordLine(t: TFunction, on: boolean, s: DiscordStatus | null, customAppId = ""): { tone: Tone; text: string } {
  if (!on) return { tone: "off", text: t("settings.integrations.discord.off") };
  switch (s?.state) {
    case "connected":
      return {
        tone: "ok",
        text: s.showing ? t("settings.integrations.discord.showing", { showing: s.showing }) : t("settings.integrations.discord.connected"),
      };
    case "not_running":
      return { tone: "info", text: t("settings.integrations.discord.notRunning") };
    case "no_app_id":
      return customAppId.trim()
        ? { tone: "warn", text: t("settings.integrations.discord.noAppId") }
        : { tone: "warn", text: t("settings.integrations.discord.noDefaultAppId") };
    default:
      return { tone: "info", text: t("settings.integrations.discord.connecting") };
  }
}

export default function IntegrationsPanel({ onError }: { onError?: (e: string) => void }) {
  const t = useT();
  const prefs = usePrefs();
  const [discord, setDiscord] = useState<DiscordStatus | null>(null);
  const [appId, setAppId] = useState("");
  const [storedAppId, setStoredAppId] = useState("");
  const [trayActive, setTrayActive] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  const fail = (e: unknown) => (onError ? onError(String(e)) : showToast({ tone: "warn", title: tGlobal("settings.notSaved"), body: String(e) }));

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
    const timer = window.setInterval(poll, DISCORD_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // no own App-ID and still "no_app_id": the build lacks the default ID – a developer error
  const missingDefault = discord?.state === "no_app_id" && !storedAppId.trim();
  useEffect(() => {
    if (missingDefault) console.error("[discord] this build carries no default Discord App-ID (discord.rs DISCORD_APP_ID is empty)");
  }, [missingDefault]);

  const toggle = (key: keyof Prefs, on: boolean) => void setPref(key, on).catch(fail);

  const saveAppId = () => {
    const v = appId.trim();
    if (v === storedAppId) return;
    if (v && !/^\d{15,22}$/.test(v)) {
      fail(t("settings.integrations.discord.appIdInvalid"));
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
        title: r.shown ? t("settings.integrations.test.sent") : t("settings.integrations.test.failed"),
        body: r.shown ? t("settings.integrations.test.sentHint") : t("settings.integrations.test.failedHint"),
        durationMs: 6000,
      });
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const d = discordLine(t, prefs.discordPresence, discord, storedAppId);

  return (
    <Panel title={t("settings.integrations.title")} description={t("settings.integrations.description")}>
      <div className="integrations">
        <section className="integrations-group" aria-labelledby="int-discord">
          <h3 id="int-discord" className="integrations-title">
            Discord
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.discordPresence} onChange={(e) => toggle("discordPresence", e.target.checked)} />
            {t("settings.integrations.discord.enable")}
          </label>
          <div className="detail">{t("settings.integrations.discord.help")}</div>
          <Status tone={d.tone}>{d.text}</Status>
          {prefs.discordPresence && (
            <details className="setting-row setting-expert">
              <summary className="detail">{t("settings.integrations.discord.expert")}</summary>
              <label htmlFor="discord-app-id">{t("settings.integrations.discord.appId")}</label>
              <input
                id="discord-app-id"
                inputMode="numeric"
                autoComplete="off"
                value={appId}
                placeholder={t("settings.integrations.discord.appIdPlaceholder")}
                onChange={(e) => setAppId(e.target.value)}
                onBlur={saveAppId}
                onKeyDown={(e) => e.key === "Enter" && saveAppId()}
              />
              <span className="detail">{t("settings.integrations.discord.appIdHelp")}</span>
            </details>
          )}
        </section>

        <section className="integrations-group" aria-labelledby="int-notify">
          <h3 id="int-notify" className="integrations-title">
            {t("settings.integrations.notify.title")}
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.notifications} onChange={(e) => toggle("notifications", e.target.checked)} />
            {t("settings.integrations.notify.enable")}
          </label>
          <div className="integrations-sub" aria-label={t("settings.integrations.notify.kinds")}>
            {NOTIFY_KINDS.map((k) => (
              <label key={k.key} className="check">
                <input type="checkbox" checked={!!prefs[k.key]} disabled={!prefs.notifications} onChange={(e) => toggle(k.key, e.target.checked)} />
                {t(k.label)}
              </label>
            ))}
          </div>
          <div className="setting-row">
            <button className="btn btn-sm" onClick={() => void sendTest()} disabled={testing}>
              {t("settings.integrations.test.send")}
            </button>
            <span className="detail">{t("settings.integrations.test.help")}</span>
          </div>
        </section>

        <section className="integrations-group" aria-labelledby="int-tray">
          <h3 id="int-tray" className="integrations-title">
            {t("settings.integrations.tray.title")}
          </h3>
          <label className="check">
            <input type="checkbox" checked={prefs.trayMinimize} onChange={(e) => void setTray(e.target.checked)} />
            {t("settings.integrations.tray.enable")}
          </label>
          <div className="detail">{t("settings.integrations.tray.help")}</div>
          <Status tone={trayActive ? "ok" : "off"}>{trayActive ? t("settings.integrations.tray.active") : t("settings.integrations.tray.inactive")}</Status>
        </section>
      </div>
    </Panel>
  );
}
