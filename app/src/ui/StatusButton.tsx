import { useRef, useState } from "react";
import type { FlightSummary, Stats, StatusSnapshot } from "../types";
import { isRealSimError, isSimMissing, recordingStatus } from "../status";
import { isDllMissing, userMessage } from "../errors";
import { fmt, fmtClock } from "../i18n/number";
import { useT } from "../i18n";
import { togglePrivacyMode, usePrefs, usePrivacyShortcut } from "../prefs";
import Popover from "./Popover";
import { KV } from "./Stat";

export interface LastError {
  detail: string;
  ms: number;
}

interface Props {
  status: StatusSnapshot | null;
  flight: FlightSummary | null;
  stats: Stats | null;
  providers: string[];
  lastError: LastError | null;
  onSelectProvider: (kind: string) => void;
  onOpenSettings: () => void;
}

const RADIO = [
  "M16.24 7.76a6 6 0 0 1 0 8.49",
  "M7.76 16.24a6 6 0 0 1 0-8.49",
  "M19.07 4.93a10 10 0 0 1 0 14.14",
  "M4.93 19.07a10 10 0 0 1 0-14.14",
];
/** Eye with a slash: the Streamer-Modus mark in the popover head. */
const EYE_OFF = ["M3 3l18 18", "M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 4.5 10 6a17 17 0 0 1-2.6 3.2", "M6.6 7.6C4.3 9 2.6 11.1 2 12c1 1.5 5 6 10 6 1.6 0 3-.4 4.3-1.1", "M9.9 9.9a3 3 0 0 0 4.2 4.2"];
const ALERT = ["M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"];

/**
 * Sidebar recording-status button: icon + colour + a shape-coded corner mark (ring =
 * waiting/ready, filled dot = recording, triangle = suspended, diamond = demo, square =
 * error). Opens a popover with the same texts as the map pill and the next step.
 */
export default function StatusButton({ status, flight, stats, providers, lastError, onSelectProvider, onOpenSettings }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const { privacyMode } = usePrefs();
  // the sidebar button is always mounted: it carries the global Strg+Umschalt+P
  usePrivacyShortcut();
  const rec = recordingStatus(status, flight);
  const close = () => setOpen(false);
  // only real errors are shown as errors; "sim not installed / not running" is the waiting state
  const err = isRealSimError(status) ? { detail: status!.detail, ms: 0 } : lastError && !isDllMissing(lastError.detail) ? lastError : null;
  const errMsg = err ? userMessage(err.detail, "sim") : null;
  const sim = status?.simName ? `${status.simName}${status.simVersion ? ` ${status.simVersion}` : ""}` : "–";
  const live = rec.kind === "ready" || rec.kind === "recording" || rec.kind === "demo";
  const mark = rec.error ? "error" : rec.kind;
  // SimConnect.dll missing: the next step is the download card in Einstellungen → Simulator
  const needsSetup = rec.kind === "waiting" && isSimMissing(status?.detail ?? "");

  return (
    <>
      <button
        ref={ref}
        className={`status-btn status-${mark}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "status-popover" : undefined}
        aria-label={t("shell.statusButton.aria", { label: rec.label })}
        title={`${rec.label} – ${rec.hint}`}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {rec.error ? (
            ALERT.map((d) => <path key={d} d={d} />)
          ) : (
            <>
              <circle cx="12" cy="12" r="2" />
              {RADIO.map((d, i) => (
                <path key={d} d={d} opacity={rec.kind === "waiting" && i >= 2 ? 0.35 : 1} />
              ))}
            </>
          )}
        </svg>
        <span className={`dot status-mark dot-${mark}`} aria-hidden="true" />
      </button>
      <Popover open={open} onClose={close} anchorRef={ref} label={t("shell.statusButton.popover")} id="status-popover" className="status-popover">
        <div className="status-pop-head">
          <span className={`dot dot-${mark}`} aria-hidden="true" />
          <strong>{rec.label}</strong>
          {privacyMode && (
            <button
              className="btn-ghost privacy-mark"
              onClick={() => void togglePrivacyMode(false)}
              title={t("shell.statusButton.privacyTitle")}
              aria-label={t("shell.statusButton.privacyAria")}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {EYE_OFF.map((d) => (
                  <path key={d} d={d} />
                ))}
              </svg>
            </button>
          )}
        </div>
        <p className="status-pop-hint">{rec.hint}</p>
        <KV
          rows={[
            [t("settings.simulator.label"), sim],
            [t("shell.statusButton.dataRate"), live && stats ? t("shell.statusButton.rate", { rate: fmt(stats.rateHz, 1, "Hz"), frames: fmt(stats.frames) }) : "–"],
          ]}
        />
        {err && errMsg && (
          <div className="alert compact status-pop-error">
            <div>
              <strong>{err.ms ? t("shell.statusButton.lastError", { time: fmtClock(err.ms, { seconds: true }) }) : t("shell.statusButton.error")}</strong> {errMsg.title}
            </div>
            <div className="detail">{errMsg.hint}</div>
            {errMsg.detail && (
              <details className="alert-details">
                <summary>{t("shell.action.details")}</summary>
                <code>{errMsg.detail}</code>
              </details>
            )}
          </div>
        )}
        <div className="status-pop-actions">
          {needsSetup && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                onOpenSettings();
                close();
              }}
              title={t("shell.statusButton.setupTitle")}
            >
              {t("settings.simconnect.title")}
            </button>
          )}
          {/* always offered; without SimConnect the app falls back to the waiting state */}
          {rec.kind === "demo" && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                onSelectProvider("simconnect");
                close();
              }}
            >
              {status?.provider === "replay" ? t("shell.demo.stopReplay") : t("shell.demo.stop")}
            </button>
          )}
          {(rec.kind === "waiting" || rec.kind === "suspended") && (
            <button
              className="btn btn-sm"
              onClick={() => {
                onSelectProvider(status?.provider || "simconnect");
                close();
              }}
              title={t("shell.statusButton.connectTitle")}
            >
              {t("shell.statusButton.connect")}
            </button>
          )}
          {rec.kind === "waiting" && providers.includes("mock") && (
            <button
              className="btn btn-sm"
              onClick={() => {
                onSelectProvider("mock");
                close();
              }}
              title={t("shell.demo.startTitle")}
            >
              {t("shell.demo.start")}
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              onOpenSettings();
              close();
            }}
          >
            {t("nav.settings")}
          </button>
        </div>
      </Popover>
    </>
  );
}
