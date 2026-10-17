// Recording status: the pilot does not care about
// the connection, only "is my flight being recorded?". `sim:status` and the flight state
// combine into four user states plus demo; the map pill, the sidebar StatusButton and its
// popover all show these texts. "Getrennt", "Verbinde …" and "Fehler" are not labels.

import type { FlightSummary, StatusSnapshot } from "./types";
import { isWaitingForSim, userMessage } from "./errors";
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
  return status?.provider === "mock";
}

/** SimConnect library missing: MSFS is probably not installed – a hint, not an error. */
export function isSimMissing(raw: string): boolean {
  return /SimConnect\.dll not found|unloadable/i.test(raw);
}

/** Backend `state: "error"` that is not just "no sim installed". */
export function isRealSimError(status: StatusSnapshot | null | undefined): boolean {
  return status?.state === "error" && !isSimMissing(status.detail ?? "");
}

const SIM_LABEL: Record<string, string> = { simconnect: "MSFS 2020/2024", mock: "Demo-Flug" };

/** Simulator name for UI text (UI wording: "Simulator", not "Quelle"/"Provider"). */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "–";
  return SIM_LABEL[provider] ?? provider;
}

function waitingHint(detail: string): string {
  if (isSimMissing(detail)) return "MSFS scheint nicht installiert – VectaSim sucht weiter, sobald du ihn installierst.";
  if (/simulator quit/i.test(detail)) return "Simulator beendet. VectaSim verbindet sich automatisch, sobald er wieder läuft.";
  if (isWaitingForSim(detail)) return "Starte MSFS – VectaSim verbindet sich automatisch, sobald das Hauptmenü erreicht ist.";
  return "Starte MSFS – VectaSim verbindet sich automatisch. Du musst nichts starten.";
}

export function recordingStatus(status: StatusSnapshot | null | undefined, flight: FlightSummary | null | undefined): RecStatus {
  const detail = status?.detail ?? "";
  const state = status?.state ?? "idle";
  const connected = state === "connected";
  const active = flight?.state === "active";

  if (isDemo(status)) {
    return {
      kind: "demo",
      label: "Demo-Flug",
      text: active ? `Demo-Flug läuft · seit ${fmtClock(flight?.offBlockMs)}` : "Demo-Flug · simulierte Daten, ohne Simulator",
      hint: "Ein simulierter Flug zum Ausprobieren. Für echte Flüge die Demo beenden – MSFS wird dann automatisch erkannt.",
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
    text: "Warte auf MSFS – startet automatisch",
    hint: realError ? `${userMessage(detail, "sim").title} ${userMessage(detail, "sim").hint}` : waitingHint(detail),
    color: realError ? "var(--err)" : "var(--text-muted)",
    error: realError,
    detail,
  };
}
