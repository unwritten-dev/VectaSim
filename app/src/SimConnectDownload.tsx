import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SimConnectDownloadInfo, SimConnectDownloadProgress } from "./types";
import { showToast } from "./ui/Toast";
import { t, useT } from "./i18n";
import { fmtNum } from "./i18n/number";
import { rich } from "./ui/richText";

/** Backend event name (`simconnect_dl::PROGRESS_EVENT`). */
export const SIMCONNECT_PROGRESS_EVENT = "simconnect-download";
/** Fallbacks until `simconnect_download_info` answered (pinned in the backend). */
const DEFAULT_VERSION = "0.24.6.0";
const DEFAULT_BYTES = 113_306_986;
const DEFAULT_EULA = "https://docs.flightsimulator.com/html/Introduction/SDK_EULA.htm";

const MB = 1024 * 1024;

/** Megabytes with one decimal in the UI language ("12,3" / "12.3"). */
function mbNum(bytes: number): string {
  return fmtNum(Math.max(0, bytes) / MB, 1);
}

/** Bytes as "12,3 MB" (one decimal, comma in German, point in English). */
export function fmtMB(bytes: number): string {
  return `${mbNum(bytes)} MB`;
}

/** Rounded size for the intro text: "~108 MB". */
export function approxMB(bytes: number): string {
  return `~${Math.round(bytes / MB)} MB`;
}

/** 0…1 for the progress bar; null = indeterminate (no total yet). */
export function progressFraction(p: SimConnectDownloadProgress | null): number | null {
  if (!p) return null;
  if (p.phase !== "download") return 1;
  if (!p.total) return null;
  return Math.min(1, Math.max(0, p.received / p.total));
}

/** Status line under the bar: "Lade … 12,3 von 108,1 MB" / "Prüfe …" / "Entpacke …". */
export function progressText(p: SimConnectDownloadProgress | null): string {
  if (!p) return t("settings.simconnect.progress.start");
  switch (p.phase) {
    case "download":
      return p.total
        ? t("settings.simconnect.progress.downloadOf", { received: mbNum(p.received), total: fmtMB(p.total) })
        : t("settings.simconnect.progress.downloadBytes", { received: fmtMB(p.received) });
    case "verify":
      return t("settings.simconnect.progress.verify");
    case "extract":
      return t("settings.simconnect.progress.extract");
    case "done":
      return t("settings.simconnect.progress.done");
    default:
      return t("settings.simconnect.progress.download");
  }
}

/**
 * User text for a failed download. Backend errors arrive in the UI language already; curl's network failures
 * ("Could not resolve host", timeouts, exit 6/7/28/35/56) get a plain next step instead.
 */
export function downloadErrorText(raw: string): string {
  if (/läuft bereits|already running/i.test(raw)) return t("settings.simconnect.error.running");
  if (/could not resolve|couldn't resolve|failed to connect|timed out|connection (reset|refused)|ssl|exit (code|status): (6|7|28|35|56)\b|\((6|7|28|35|56)\)/i.test(raw))
    return t("settings.simconnect.error.network");
  if (/SHA-256|Größe \d+ statt|size \d+ instead/i.test(raw)) return t("settings.simconnect.error.corrupt");
  return raw;
}

interface Props {
  /** No SimConnect.dll found (`app_info().simconnectDll` empty); null while unknown. */
  dllMissing: boolean | null;
  /** The status reports "SimConnect.dll not found". */
  statusMissing: boolean;
  /** After a successful download: reload `app_info` for the Diagnose row. */
  onInstalled: () => void;
}

/**
 * "SimConnect einrichten" card in Einstellungen → Simulator: downloads the official MSFS SDK
 * from Microsoft and keeps only SimConnect.dll (backend `download_simconnect`). Does not block
 * closing the window; the backend cleans up its scratch folder on its own.
 */
export default function SimConnectDownload({ dllMissing, statusMissing, onInstalled }: Props) {
  const t = useT();
  const [info, setInfo] = useState<SimConnectDownloadInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SimConnectDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    invoke<SimConnectDownloadInfo>("simconnect_download_info")
      .then(setInfo)
      // the card works with the pinned defaults
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<SimConnectDownloadProgress>(SIMCONNECT_PROGRESS_EVENT, (e) => setProgress(e.payload))
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // a verified downloaded DLL on disk wins over a status that predates it (provider not restarted yet)
  const alreadyInstalled = info?.installed === true && dllMissing === false;
  if (done || alreadyInstalled || !(dllMissing === true || statusMissing)) return null;

  const version = info?.sdkVersion ?? DEFAULT_VERSION;
  const bytes = info?.downloadBytes ?? DEFAULT_BYTES;
  const eula = info?.eulaUrl ?? DEFAULT_EULA;
  const fraction = progressFraction(progress);

  const start = () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    invoke<SimConnectDownloadInfo>("download_simconnect")
      .then((res) => {
        setInfo(res);
        setDone(true);
        showToast({
          tone: "ok",
          title: t("settings.simconnect.installed"),
          body: res.restarted ? undefined : t("settings.simconnect.installedLater"),
          durationMs: 6000,
        });
        onInstalled();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="sc-download" role="group" aria-labelledby="sc-download-title">
      <strong id="sc-download-title" className="sc-download-title">
        {t("settings.simconnect.title")}
      </strong>
      <p className="sc-download-text">{t("settings.simconnect.intro", { version, size: approxMB(bytes) })}</p>
      <p className="detail">{t("settings.simconnect.installerHint")}</p>
      <p className="detail sc-download-eula">
        {rich(t("settings.simconnect.eula"), {
          link: (
            <a
              href={eula}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(eula).catch(() => {});
              }}
            >
              {t("settings.simconnect.eulaLink")}
            </a>
          ),
        })}
      </p>
      {busy && (
        <div className="sc-download-progress" role="status" aria-live="polite">
          {fraction == null ? (
            <progress className="update-progress" aria-label={t("settings.simconnect.progressLabel")} />
          ) : (
            <progress className="update-progress" max={1} value={fraction} aria-label={t("settings.simconnect.progressLabel")} />
          )}
          <span className="detail">{progressText(progress)}</span>
        </div>
      )}
      {error && !busy && (
        <div className="alert compact sc-download-error" role="alert">
          <div>
            <strong>{t("settings.simconnect.failed")}</strong> {downloadErrorText(error)}
          </div>
          <details className="alert-details">
            <summary>{t("shell.action.details")}</summary>
            <code>{error}</code>
          </details>
        </div>
      )}
      <div className="setting-row">
        <button className="btn-primary" onClick={start} disabled={busy} aria-busy={busy}>
          {busy ? t("settings.simconnect.downloading") : error ? t("shell.action.retry") : t("settings.simconnect.download")}
        </button>
      </div>
    </div>
  );
}
