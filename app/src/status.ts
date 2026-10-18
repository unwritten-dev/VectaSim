// Recording status: the pilot does not care about
// the connection, only "is my flight being recorded?". `sim:status` and the flight state
// combine into four user states plus demo; the map pill, the sidebar StatusButton and its
// popover all show these texts. "Getrennt", "Verbinde …" and "Fehler" are not labels.

import type { FlightSummary, StatusSnapshot } from "./types";
import { DLL_MISSING_TEXT, isDllMissing, isWaitingForSim, userMessage } from "./errors";
import { fmtClock } from "./format";

export type RecKind = "waiting" | "ready" | "recording" | "suspended" | "demo";

export interface RecStatus {
  kind: RecKind;
  /** Short state name: Warte auf Simulator / Bereit / Aufzeichnung läuft / Unterbrochen, wird fortgesetzt / Demo-Flug. */
  label: string;
  /** The pill text on the map ("Bereit · Aufzeichnung startet beim Losrollen"). */
  text: string;
  /** One sentence: what is going on, what (if anything) to do. */
  hint: string;
  /** CSS colour (token). */
  color: string;
  /**
   * A real error the user has to solve (red ErrorNotice). A missing SimConnect.dll or a
   * sim that is not running yet is a waiting state, never an error.
   */
  error: boolean;
  /** Raw backend text, for tooltips and the Diagnose section only. */
  detail: string;
}

export function isDemo(status: StatusSnapshot | null | undefined): boolean {
  return status?.provider === "mock" || status?.provider === "replay";
}

/**
 * SimConnect.dll missing (not downloaded, no MSFS SDK, no file chosen) – a hint with a next step,
 * not a red error: VectaSim keeps looking, and Einstellungen → Simulator downloads it on one click.
 */
export function isSimMissing(raw: string): boolean {
  return isDllMissing(raw);
}

/** Backend `state: "error"` that is not just "SimConnect.dll missing". */
export function isRealSimError(status: StatusSnapshot | null | undefined): boolean {
  return status?.state === "error" && !isSimMissing(status.detail ?? "");
}

const SIM_LABEL: Record<string, string> = { simconnect: "MSFS 2020/2024", mock: "Demo-Flug", replay: "Replay (Roh-Dump)" };

/** Simulator name for UI text (UI wording: "Simulator", not "Quelle"/"Provider"). */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "–";
  return SIM_LABEL[provider] ?? provider;
}

/** Map pill while waiting: says what starts (the recording), not "something starts". */
export const WAITING_TEXT = "Warte auf MSFS – Aufzeichnung startet beim Losrollen";
/** Short pill text while the Bereit card is on screen: the card carries the details and the demo. */
export const WAITING_SHORT = "Warte auf MSFS";
/** One name for the demo everywhere (buttons); "Ohne Simulator ausprobieren" only as a subtitle. */
export const DEMO_LABEL = "Demo-Flug";

function waitingHint(detail: string): string {
  if (isSimMissing(detail)) return `${DLL_MISSING_TEXT}.`;
  if (/simulator quit/i.test(detail)) return "Simulator beendet. VectaSim verbindet sich automatisch, sobald er wieder läuft.";
  if (isWaitingForSim(detail)) return "MSFS läuft noch nicht. Sobald das Hauptmenü erreicht ist, verbindet sich VectaSim von selbst.";
  return "Sobald MSFS läuft, verbindet sich VectaSim von selbst. Die Aufzeichnung startet beim Losrollen.";
}

export function recordingStatus(status: StatusSnapshot | null | undefined, flight: FlightSummary | null | undefined): RecStatus {
  const detail = status?.detail ?? "";
  const state = status?.state ?? "idle";
  const connected = state === "connected";
  const active = flight?.state === "active";

  if (isDemo(status)) {
    const replay = status?.provider === "replay";
    return {
      kind: "demo",
      label: replay ? "Replay" : "Demo-Flug",
      text: replay
        ? active
          ? `Replay läuft · seit ${fmtClock(flight?.offBlockMs)}`
          : "Replay · aufgezeichnete Rohdaten, ohne Simulator"
        : active
          ? `Demo-Flug läuft · seit ${fmtClock(flight?.offBlockMs)}`
          : "Demo-Flug · simulierte Daten, ohne Simulator",
      hint: replay
        ? "Ein aufgezeichneter Dump wird abgespielt. Für echte Flüge das Replay beenden – MSFS wird dann automatisch erkannt."
        : "Ein simulierter Flug zum Ausprobieren. Für echte Flüge den Demo-Flug beenden – MSFS wird dann automatisch erkannt.",
      color: "var(--info)",
      error: false,
      detail,
    };
  }
  if (active) {
    if (connected) {
      return {
        kind: "recording",
        label: "Aufzeichnung läuft",
        text: `Aufzeichnung läuft · seit ${fmtClock(flight?.offBlockMs)}`,
        hint: "Dein Flug wird aufgezeichnet. Du musst VectaSim dafür nicht im Blick haben.",
        color: "var(--ok)",
        error: false,
        detail,
      };
    }
    return {
      kind: "suspended",
      label: "Unterbrochen, wird fortgesetzt",
      text: "Sim weg – Flug gesichert, läuft weiter",
      hint: "Sim weg – dein Flug ist gesichert und läuft weiter, sobald der Simulator zurück ist.",
      color: "var(--warn)",
      error: isRealSimError(status),
      detail,
    };
  }
  if (connected) {
    const sim = status?.simName ? `${status.simName}${status.simVersion ? ` ${status.simVersion}` : ""}` : "dem Simulator";
    return {
      kind: "ready",
      label: "Bereit",
      text: "Bereit · Aufzeichnung startet beim Losrollen",
      hint: `Verbunden mit ${sim}. Die Aufzeichnung startet automatisch, sobald du losrollst.`,
      color: "var(--ok)",
      error: false,
      detail,
    };
  }
  const realError = isRealSimError(status);
  return {
    kind: "waiting",
    label: "Warte auf Simulator",
    text: WAITING_TEXT,
    hint: realError ? `${userMessage(detail, "sim").title} ${userMessage(detail, "sim").hint}` : waitingHint(detail),
    color: realError ? "var(--err)" : "var(--text-muted)",
    error: realError,
    detail,
  };
}
