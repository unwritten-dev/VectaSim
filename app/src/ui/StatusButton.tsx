import { useRef, useState } from "react";
import type { FlightSummary, Stats, StatusSnapshot } from "../types";
import { isRealSimError, recordingStatus } from "../status";
import { userMessage } from "../errors";
import { fmt, fmtClock } from "../format";
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
const ALERT = ["M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"];

/**
 * Sidebar recording-status button: icon + colour + a shape-coded corner mark (ring =
 * waiting/ready, filled dot = recording, triangle = suspended, diamond = demo, square =
 * error). Opens a popover with the same texts as the map pill and the next step.
 */
export default function StatusButton({ status, flight, stats, providers, lastError, onSelectProvider, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const rec = recordingStatus(status, flight);
  const close = () => setOpen(false);
  // only real errors are shown as errors; "sim not installed / not running" is the waiting state
  const err = isRealSimError(status) ? { detail: status!.detail, ms: 0 } : lastError && !/SimConnect\.dll not found|unloadable/i.test(lastError.detail) ? lastError : null;
  const errMsg = err ? userMessage(err.detail, "sim") : null;
  const sim = status?.simName ? `${status.simName}${status.simVersion ? ` ${status.simVersion}` : ""}` : "–";
  const live = rec.kind === "ready" || rec.kind === "recording" || rec.kind === "demo";
  const mark = rec.error ? "error" : rec.kind;

  return (
    <>
      <button
        ref={ref}
        className={`status-btn status-${mark}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "status-popover" : undefined}
        aria-label={`Aufzeichnung: ${rec.label}. Details anzeigen`}
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
      <Popover open={open} onClose={close} anchorRef={ref} label="Aufzeichnungsstatus" id="status-popover" className="status-popover">
        <div className="status-pop-head">
          <span className={`dot dot-${mark}`} aria-hidden="true" />
          <strong>{rec.label}</strong>
        </div>
        <p className="status-pop-hint">{rec.hint}</p>
        <KV
          rows={[
            ["Simulator", sim],
            ["Datenrate", live && stats ? `${fmt(stats.rateHz, 1, "Hz")} · ${fmt(stats.frames)} Datensätze` : "–"],
          ]}
        />
        {err && errMsg && (
          <div className="alert compact status-pop-error">
            <div>
              <strong>{err.ms ? `Letzter Fehler (${fmtClock(err.ms, { seconds: true })})` : "Fehler"}:</strong> {errMsg.title}
            </div>
            <div className="detail">{errMsg.hint}</div>
            {errMsg.detail && (
              <details className="alert-details">
                <summary>Details</summary>
                <code>{errMsg.detail}</code>
              </details>
            )}
          </div>
        )}
        <div className="status-pop-actions">
          {rec.kind === "demo" && providers.includes("simconnect") && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                onSelectProvider("simconnect");
                close();
              }}
            >
              Demo beenden
            </button>
          )}
          {(rec.kind === "waiting" || rec.kind === "suspended") && (
            <button
              className="btn btn-sm"
              onClick={() => {
                onSelectProvider(status?.provider || "simconnect");
                close();
              }}
              title="Sofort einen Verbindungsversuch starten, statt auf den nächsten automatischen zu warten"
            >
              Jetzt verbinden
            </button>
          )}
          {rec.kind === "waiting" && providers.includes("mock") && (
            <button
              className="btn btn-sm"
              onClick={() => {
                onSelectProvider("mock");
                close();
              }}
            >
              Ohne Simulator ausprobieren
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              onOpenSettings();
              close();
            }}
          >
            Einstellungen
          </button>
        </div>
      </Popover>
    </>
  );
}
