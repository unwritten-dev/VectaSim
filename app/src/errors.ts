// Translate raw backend error strings (Rust `to_string()` of SimConnect, SimBrief,
// VATSIM/METAR and store errors) into user text (active UI language, i18n `errors.*`) with a
// next step. Recognition stays on the raw (English) backend wording. The raw
// text stays available as `detail` for a collapsible "Details" block.

import { t, type TKey } from "./i18n";

export type ErrorContext = "sim" | "simbrief" | "vatsim" | "ivao" | "metar" | "logbook" | "export" | "settings";

export interface UserMessage {
  title: string;
  hint: string;
  detail: string;
}

const NETWORK_RE =
  /network:|error sending request|error trying to connect|dns error|failed to lookup|timed out|operation timed out|connection (refused|reset|closed)|tcp connect|no such host|unreachable|tls|certificate/i;

const SERVICE_KEY = {
  sim: "errors.service.sim",
  simbrief: "errors.service.simbrief",
  vatsim: "errors.service.vatsim",
  ivao: "errors.service.ivao",
  metar: "errors.service.metar",
  logbook: "errors.service.logbook",
  export: "errors.service.export",
  settings: "errors.service.settings",
} as const satisfies Record<ErrorContext, TKey>;

/** Service name in the active language ("Wetterdienst" / "Weather service"). */
function service(ctx: ErrorContext | undefined): string {
  return ctx ? t(SERVICE_KEY[ctx]) : t("errors.service.unknown");
}

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
export function dllMissingText(): string {
  return t("errors.dllMissingText");
}

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

/**
 * Online-network context of a raw error: the summary prefixes errors with their network
 * ("IVAO: network: …"), so a "vatsim" fallback must not turn an IVAO failure into "VATSIM …".
 */
export function networkContext(raw: string, fallback: ErrorContext = "vatsim"): ErrorContext {
  if (/^\s*IVAO\s*:/i.test(raw)) return "ivao";
  if (/^\s*VATSIM\s*:/i.test(raw)) return "vatsim";
  return fallback;
}

export function userMessage(err: unknown, ctx?: ErrorContext, extra: { user?: string } = {}): UserMessage {
  const detail = rawText(err);
  if (ctx === "vatsim" || ctx === "ivao") ctx = networkContext(detail, ctx);
  const m = (title: string, hint: string): UserMessage => ({ title, hint, detail });

  // ---- simulator / provider
  if (isDllMissing(detail)) return m(t("errors.dllMissing.title"), t("errors.dllMissing.hint"));
  if (isWaitingForSim(detail)) {
    const s = retrySeconds(detail);
    return m(t("errors.waitingForSim.title"), s != null ? t("errors.waitingForSim.hintRetry", { seconds: s }) : t("errors.waitingForSim.hint"));
  }
  if (/unknown provider/i.test(detail)) return m(t("errors.unknownProvider.title"), t("errors.unknownProvider.hint"));
  if (/SimConnect exception/i.test(detail)) return m(t("errors.simException.title"), t("errors.simException.hint"));
  if (/simulator quit/i.test(detail)) return m(t("errors.simQuit.title"), t("errors.simQuit.hint"));

  // ---- SimBrief
  if (/no SimBrief pilot id or username/i.test(detail)) return m(t("errors.simbriefNoId.title"), t("errors.simbriefNoId.hint"));
  if (/Unknown UserID|unknown user/i.test(detail) || (ctx === "simbrief" && /HTTP (400|404)/.test(detail))) {
    const title = extra.user ? t("errors.simbriefNoPlan.titleUser", { user: extra.user }) : t("errors.simbriefNoPlan.title");
    return m(title, t("errors.simbriefNoPlan.hint"));
  }
  if (/fetch status:/i.test(detail)) return m(t("errors.simbriefFetch.title"), t("errors.simbriefFetch.hint"));

  // ---- network / HTTP (SimBrief, VATSIM, METAR)
  if (/rate limit|HTTP 429/i.test(detail))
    return m(t("errors.rateLimit.title", { service: service(ctx ?? "vatsim") }), t("errors.rateLimit.hint"));
  if (NETWORK_RE.test(detail)) {
    if (ctx === "ivao") return m(t("errors.unreachable.title", { service: service(ctx) }), t("errors.unreachable.hintIvao"));
    if (ctx === "vatsim" || ctx === "metar") return m(t("errors.unreachable.title", { service: service(ctx) }), t("errors.unreachable.hintOnline"));
    return m(t("errors.unreachable.title", { service: service(ctx) }), t("errors.unreachable.hint"));
  }
  const http = /HTTP (\d{3})/.exec(detail);
  if (http) {
    const code = Number(http[1]);
    return m(t("errors.http.title", { service: service(ctx), code: String(code) }), code >= 500 ? t("errors.http.hintServer") : t("errors.http.hintClient"));
  }
  if (/could not parse/i.test(detail)) return m(t("errors.parse.title"), t("errors.parse.hint"));

  // ---- local
  if (/Pfad nicht erlaubt|Path not allowed/i.test(detail)) return m(t("errors.pathNotAllowed.title"), t("errors.pathNotAllowed.hint"));
  if (/Flug nicht gefunden|Flight not found/i.test(detail)) return m(t("errors.flightNotFound.title"), t("errors.flightNotFound.hint"));
  if (/database is locked|SQLITE_BUSY/i.test(detail)) return m(t("errors.dbLocked.title"), t("errors.dbLocked.hint"));
  if (/Access is denied|Zugriff verweigert|permission denied|os error 5\b|os error 13\b/i.test(detail))
    return m(t("errors.accessDenied.title"), t("errors.accessDenied.hint"));

  return m(ctx ? t("errors.unexpected.titleService", { service: service(ctx) }) : t("errors.unexpected.title"), t("errors.unexpected.hint"));
}
