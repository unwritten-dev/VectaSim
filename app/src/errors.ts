// Translate raw backend error strings (Rust `to_string()` of SimConnect, SimBrief,
// VATSIM/METAR and store errors) into German user text with a next step. The raw
// text stays available as `detail` for a collapsible "Details" block.

export type ErrorContext = "sim" | "simbrief" | "vatsim" | "metar" | "logbook" | "export" | "settings";

export interface UserMessage {
  title: string;
  hint: string;
  detail: string;
}

const NETWORK_RE =
  /network:|error sending request|error trying to connect|dns error|failed to lookup|timed out|operation timed out|connection (refused|reset|closed)|tcp connect|no such host|unreachable|tls|certificate/i;

const SERVICE: Record<ErrorContext, string> = {
  sim: "Simulator",
  simbrief: "SimBrief",
  vatsim: "VATSIM",
  metar: "Wetterdienst",
  logbook: "Logbuch",
  export: "Export",
  settings: "Einstellungen",
};

export function rawText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** "retry in 8s" → 8, else null. */
export function retrySeconds(raw: string): number | null {
  const m = /retry in (\d+)\s*s/i.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * What to do when SimConnect.dll is missing. MSFS itself does not ship the DLL where VectaSim
 * can load it; it comes with the MSFS SDK – so this is not "MSFS is not installed". VectaSim
 * downloads it on one click (Einstellungen → Simulator → „SimConnect herunterladen“).
 */
export const DLL_MISSING_TEXT = "SimConnect fehlt noch – unter Einstellungen → Simulator mit einem Klick herunterladen";

/** Backend loader error: no SimConnect.dll on the search path (or none that loads). */
export function isDllMissing(raw: string): boolean {
  return /SimConnect\.dll not found|unloadable/i.test(raw);
}

/** Paths the loader tried, from "SimConnect.dll not found or unloadable (tried: a, b); last error: …". */
export function triedDllPaths(raw: string): string[] {
  const m = /\(tried: (.*?)\); last error:/s.exec(raw) ?? /\(tried: (.*)\)/s.exec(raw);
  if (!m) return [];
  return m[1]
    .split(/,\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** True for the SimConnect "sim not running yet" message, which is a state, not an error. */
export function isWaitingForSim(raw: string): boolean {
  return /sim not reachable/i.test(raw);
}

export function userMessage(err: unknown, ctx?: ErrorContext, extra: { user?: string } = {}): UserMessage {
  const detail = rawText(err);
  const m = (title: string, hint: string): UserMessage => ({ title, hint, detail });

  // ---- simulator / provider
  if (isDllMissing(detail))
    return m(
      "SimConnect fehlt noch.",
      "Unter Einstellungen → Simulator mit einem Klick herunterladen (offizielles MSFS-SDK von Microsoft) oder dort die Datei wählen. Zum Ausprobieren: „Demo-Flug“ auf der Karte.",
    );
  if (isWaitingForSim(detail)) {
    const s = retrySeconds(detail);
    return m("Warte auf Simulator …", `Starte MSFS – VectaSim verbindet sich automatisch${s != null ? ` (nächster Versuch in ${s} s)` : ""}.`);
  }
  if (/unknown provider/i.test(detail))
    return m("Unbekannter Simulator.", "Wähle in den Einstellungen unter „Simulator“ einen verfügbaren Simulator.");
  if (/SimConnect exception/i.test(detail))
    return m("Der Simulator hat eine Anfrage abgelehnt.", "Meist harmlos. Tritt das wiederholt auf, starte den Flug im Simulator neu.");
  if (/simulator quit/i.test(detail)) return m("Simulator beendet.", "Starte den Simulator erneut – VectaSim verbindet sich automatisch.");

  // ---- SimBrief
  if (/no SimBrief pilot id or username/i.test(detail))
    return m("Keine SimBrief-Pilot-ID hinterlegt.", "Trage deine Pilot-ID oder deinen Benutzernamen ein (simbrief.com → Account).");
  if (/Unknown UserID|unknown user/i.test(detail) || (ctx === "simbrief" && /HTTP (400|404)/.test(detail))) {
    const who = extra.user ? ` für „${extra.user}“` : "";
    return m(`Kein Flugplan${who} gefunden.`, "Prüfe deine Pilot-ID oder erstelle zuerst einen Flugplan auf simbrief.com.");
  }
  if (/fetch status:/i.test(detail))
    return m("SimBrief hat keinen Flugplan geliefert.", "Erstelle auf simbrief.com einen Flugplan und lade ihn erneut.");

  // ---- network / HTTP (SimBrief, VATSIM, METAR)
  if (/rate limit|HTTP 429/i.test(detail))
    return m(`${SERVICE[ctx ?? "vatsim"]}: zu viele Anfragen.`, "VectaSim wartet kurz und versucht es automatisch erneut.");
  if (NETWORK_RE.test(detail)) {
    if (ctx === "vatsim" || ctx === "metar")
      return m(
        `${SERVICE[ctx]} ist nicht erreichbar.`,
        "Keine Internetverbindung? Wetter und VATSIM sind pausiert, das Tracking läuft lokal weiter. VectaSim versucht es automatisch erneut.",
      );
    return m(`${ctx ? SERVICE[ctx] : "Der Dienst"} ist nicht erreichbar.`, "Prüfe deine Internetverbindung und versuche es erneut.");
  }
  const http = /HTTP (\d{3})/.exec(detail);
  if (http) {
    const code = Number(http[1]);
    return m(
      `${ctx ? SERVICE[ctx] : "Der Dienst"} antwortet mit einem Fehler (HTTP ${code}).`,
      code >= 500 ? "Der Dienst hat gerade Probleme. Versuche es später erneut." : "Versuche es erneut. Bleibt der Fehler, prüfe deine Eingabe.",
    );
  }
  if (/could not parse/i.test(detail))
    return m("Die Antwort konnte nicht gelesen werden.", "Versuche es später erneut. Bleibt der Fehler, melde ihn mit den Details unten.");

  // ---- local
  if (/Pfad nicht erlaubt/i.test(detail))
    return m("Dieser Speicherort ist nicht erlaubt.", "Wähle einen Ordner außerhalb von Windows- und Programmverzeichnissen, z. B. Dokumente oder den Desktop.");
  if (/Flug nicht gefunden/i.test(detail)) return m("Flug nicht gefunden.", "Er wurde vermutlich gelöscht. Die Liste wird aktualisiert.");
  if (/database is locked|SQLITE_BUSY/i.test(detail)) return m("Logbuch ist gerade belegt.", "Versuche es in ein paar Sekunden erneut.");
  if (/Access is denied|Zugriff verweigert|permission denied|os error 5\b|os error 13\b/i.test(detail))
    return m("Datei konnte nicht geschrieben werden.", "Wähle einen anderen Ordner oder schließe die Datei in anderen Programmen.");

  return m(
    ctx ? `${SERVICE[ctx]}: unerwarteter Fehler.` : "Unerwarteter Fehler.",
    "Versuche es erneut. Bleibt der Fehler, hilft der Text unter „Details“ bei der Fehlersuche.",
  );
}
