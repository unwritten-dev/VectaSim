// Texts for the online networks (VATSIM, IVAO) in Einstellungen → Anzeige and → Diagnose.
// Pure functions over OnlineSummary, so the wording is testable without the app.

import { fmt } from "./i18n/number";
import { t } from "./i18n";
import { userMessage } from "./errors";
import type { Network, NetworkStatus, OnlineSummary } from "./types";

export const NETWORKS: Network[] = ["vatsim", "ivao"];

export const NETWORK_LABEL: Record<Network, string> = { vatsim: "VATSIM", ivao: "IVAO" };

const OFF: Omit<NetworkStatus, "network" | "label"> = {
  enabled: false,
  pilots: 0,
  controllers: 0,
  atis: 0,
  prefiles: 0,
  consecutiveErrors: 0,
  nextPollS: 0,
};

/**
 * One status per network, always VATSIM then IVAO. Summaries from older builds have no
 * `networks`: those were VATSIM-only, so their totals are VATSIM's.
 */
export function networkStatuses(summary: OnlineSummary | null): NetworkStatus[] {
  const list = summary?.networks;
  return NETWORKS.map((network) => {
    const found = list?.find((n) => n.network === network);
    if (found) return found;
    if (!list && summary && network === "vatsim")
      return {
        network,
        label: NETWORK_LABEL.vatsim,
        enabled: summary.enabled,
        pilots: summary.pilots,
        controllers: summary.controllers,
        atis: summary.atis,
        prefiles: summary.prefiles,
        updateTimestamp: summary.updateTimestamp,
        fetchedMs: summary.fetchedMs,
        lastError: summary.lastError,
        consecutiveErrors: summary.consecutiveErrors,
        nextPollS: summary.nextPollS,
      };
    return { network, label: NETWORK_LABEL[network], ...OFF };
  });
}

/** Networks that are on, for `online_set_networks` after toggling one of them. */
export function networksWith(summary: OnlineSummary | null, network: Network, on: boolean): Network[] {
  const enabled = new Set(networkStatuses(summary).filter((n) => n.enabled).map((n) => n.network));
  if (on) enabled.add(network);
  else enabled.delete(network);
  return NETWORKS.filter((n) => enabled.has(n));
}

const noDot = (s: string) => s.replace(/\.\s*$/, "");

/** "VATSIM an (2 176 Piloten, 211 Lotsen)" · "IVAO aus" · "IVAO an (IVAO ist nicht erreichbar – nächster Versuch in 30 s)". */
export function networkPart(n: NetworkStatus): string {
  const name = n.label || NETWORK_LABEL[n.network];
  if (!n.enabled) return t("online.part.off", { name });
  if (n.lastError) return t("online.part.error", { name, error: noDot(userMessage(n.lastError, n.network).title), seconds: n.nextPollS });
  if (!n.fetchedMs) return t("online.part.waiting", { name });
  return t("online.part.on", { name, pilots: fmt(n.pilots), controllers: fmt(n.controllers) });
}

/** Status line in Einstellungen → Anzeige: "Online-Verkehr: VATSIM an (…) · IVAO aus". */
export function onlineLine(summary: OnlineSummary | null): string {
  if (!summary) return t("online.line.loading");
  return t("online.line.status", { parts: networkStatuses(summary).map(networkPart).join(" · ") });
}

export type OnlineTone = "ok" | "warn" | "off";

export function onlineTone(summary: OnlineSummary | null): OnlineTone {
  const on = networkStatuses(summary).filter((n) => n.enabled);
  if (!on.length) return "off";
  return on.some((n) => n.lastError) ? "warn" : "ok";
}

/** Host of a feed URL ("https://data.vatsim.net/v3/vatsim-data.json" → "data.vatsim.net"). */
export function sourceHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#\s]+)/i.exec(url.trim());
    return m ? m[1] : null;
  }
}

/** Seconds since the last download → "vor 12 s", "vor 3 min", "vor 2 h". */
export function fmtAgo(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return t("online.ago.seconds", { n: Math.round(seconds) });
  if (seconds < 3600) return t("online.ago.minutes", { n: Math.floor(seconds / 60) });
  return t("online.ago.hours", { n: Math.floor(seconds / 3600) });
}

/** Diagnose text of one network: "an · data.vatsim.net · vor 12 s · 2 176 Piloten, 211 Lotsen · OK". */
export function diagText(n: NetworkStatus): string {
  if (!n.enabled) return t("online.diag.off");
  const parts = [t("online.diag.on")];
  const host = sourceHost(n.source);
  if (host) parts.push(host);
  parts.push(fmtAgo(n.ageS) ?? t("online.diag.noFetch"));
  if (n.fetchedMs) parts.push(t("online.diag.counts", { pilots: fmt(n.pilots), controllers: fmt(n.controllers) }));
  if (n.lastError) {
    parts.push(
      n.consecutiveErrors > 1
        ? t("online.diag.errorRepeated", { times: n.consecutiveErrors, error: n.lastError, seconds: n.nextPollS })
        : t("online.diag.error", { error: n.lastError, seconds: n.nextPollS }),
    );
  } else parts.push(n.fetchedMs ? t("online.diag.ok") : t("online.diag.waiting"));
  return parts.join(" · ");
}

/** Diagnose rows, one per network ("Online VATSIM", "Online IVAO"). */
export function onlineDiagRows(summary: OnlineSummary | null): Array<{ label: string; text: string }> {
  if (!summary) return [{ label: t("online.diag.label"), text: "–" }];
  return networkStatuses(summary).map((n) => ({ label: t("online.diag.rowLabel", { name: n.label || NETWORK_LABEL[n.network] }), text: diagText(n) }));
}
