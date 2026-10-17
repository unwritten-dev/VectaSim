import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { FlightSummary, OnlineSummary, Ofp, Stats, StatusSnapshot } from "./types";
import { fmt, fmtClock } from "./format";
import ErrorNotice from "./ErrorNotice";
import { setPref, usePrefs, type Prefs } from "./prefs";
import { isDemo, providerLabel, recordingStatus } from "./status";
import { userMessage } from "./errors";
import Panel from "./ui/Panel";
import { KV } from "./ui/Stat";
import { checkForUpdate, installUpdate, useUpdateState } from "./updater";
import { OWN_AIRCRAFT, THEMES, type ThemeId } from "./themes";

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
 * Anzeige, then Updates and a collapsed Diagnose section for support.
 */
export default function Settings({ providers, onProvider, online, status, flight, stats, ofp }: Props) {
  const [simbriefUser, setSimbriefUser] = useState("");
  const [storedUser, setStoredUser] = useState("");
  const [savedMark, setSavedMark] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefs = usePrefs();
  const rec = recordingStatus(status, flight);
  const demo = isDemo(status);
  const upd = useUpdateState();

  useEffect(() => {
    invoke<[string, string][]>("get_settings")
      .then((rows) => {
        const u = rows.find(([k]) => k === "simbrief_user")?.[1] ?? "";
        setSimbriefUser(u);
        setStoredUser(u);
      })
      .catch((e) => setError(String(e)));
    invoke<AppInfo>("app_info")
      .then(setInfo)
      // diagnostics only; the rows show "–" without it
      .catch(() => {});
  }, []);

  const saveUser = () => {
    const v = simbriefUser.trim();
    if (v === storedUser) return;
    invoke("set_setting", { key: "simbrief_user", value: v })
      .then(() => {
        setStoredUser(v);
        // confirmed inline at the field, not with a toast (02 §5)
        setSavedMark(true);
        window.setTimeout(() => setSavedMark(false), 2500);
      })
      .catch((e) => setError(String(e)));
  };

  const toggle = (key: keyof Prefs, value: boolean) => setPref(key, value).catch((e) => setError(String(e)));
  const reveal = (path: string) => revealItemInDir(path).catch((e) => setError(String(e)));
  const recTone: Tone = rec.error ? "err" : rec.kind === "ready" || rec.kind === "recording" ? "ok" : rec.kind === "suspended" ? "warn" : rec.kind === "demo" ? "info" : "off";

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
          {demo
            ? providers.includes("simconnect") && (
                <button className="btn-primary" onClick={() => onProvider("simconnect")}>
                  Demo beenden
                </button>
              )
            : providers.includes("mock") && (
                <button onClick={() => onProvider("mock")} title="Ein simulierter Flug, um VectaSim ohne MSFS kennenzulernen">
                  Ohne Simulator ausprobieren
                </button>
              )}
        </div>
      </Panel>

      <Panel title="Flugplanung" description="Mit deiner SimBrief-Pilot-ID lädt VectaSim deinen letzten Flugplan und vergleicht Plan und Ist.">
        <div className="setting-row">
          <label htmlFor="simbrief">SimBrief-Pilot-ID</label>
          <input
            id="simbrief"
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
        <IntegrationStatus tone={storedUser ? (ofp ? "ok" : "info") : "off"}>
          {storedUser
            ? ofp
              ? `Flugplan geladen: ${ofp.callsign} ${ofp.originIcao} → ${ofp.destinationIcao}`
              : "Pilot-ID hinterlegt · noch kein Flugplan geladen (Karte → Seitenpanel → Flugplan)"
            : "Keine Pilot-ID hinterlegt. Du findest sie auf simbrief.com unter Account."}
        </IntegrationStatus>
      </Panel>

      <Panel title="Anzeige" description="Erscheinungsbild, Zeitbasis, Flugzeugfotos und Online-Verkehr." className="settings-wide">
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
        <div className="setting-row">
          {upd.phase === "available" ? (
            <button className="btn-primary" onClick={() => void installUpdate()}>
              Version {upd.version} installieren und neu starten
            </button>
          ) : (
            <button onClick={() => void checkForUpdate()} disabled={upd.phase === "checking" || upd.phase === "downloading"}>
              Nach Updates suchen
            </button>
          )}
        </div>
      </Panel>

      <Panel title="Diagnose" description="Für den Support – hilft, wenn ein Flug nicht erkannt wird." collapsible defaultOpen={false}>
        <KV
          rows={[
            ["Simulator", providerLabel(status?.provider)],
            ["Status", `${rec.label} (${status?.state ?? "idle"})`],
            ["Sim-Version", status?.simName ? `${status.simName} ${status.simVersion ?? ""}` : "–"],
            ["Datenrate", stats ? fmt(stats.rateHz, 1, "Hz") : "–"],
            ["Datensätze", fmt(stats?.frames ?? status?.frames ?? 0)],
            ["SimConnect.dll", info?.simconnectDll ? <span className="mono">{info.simconnectDll}</span> : info ? "nicht gefunden – ist MSFS installiert?" : "–"],
            ["Logbuch", info ? <span className="mono">{info.dbPath}</span> : "–"],
            ["App-Daten", info ? <span className="mono">{info.dataDir}</span> : "–"],
            ["App-Version", info?.version ?? "–"],
            ...(status?.detail && status.state !== "connected" ? ([["Meldung", <span className="mono">{status.detail}</span>]] as Array<[string, ReactNode]>) : []),
          ]}
        />
        <div>
          <button onClick={() => info && reveal(info.dbPath)} disabled={!info}>
            Logbuch im Explorer zeigen
          </button>
        </div>
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
