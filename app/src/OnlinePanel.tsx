import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Controller, LocatedController, Network, OnlineSummary, OnlineView } from "./types";
import { haversineNm } from "./format";
import { fmt, fmtAltitude } from "./i18n/number";
import { useT } from "./i18n";
import { FACILITY_LABEL, NETWORK_LABEL } from "./onlineText";
import { userMessage } from "./errors";
import ErrorNotice from "./ErrorNotice";
import Collapsible from "./ui/Collapsible";
import { selectTrafficOnMap } from "./map/trafficInfo";
import { stableNearest } from "./map/trafficOrder";

const MAX_TRAFFIC = 8;

interface Props {
  summary: OnlineSummary | null;
  view: OnlineView | null;
  /** Own aircraft if known, else the map centre: what "nearby" is measured from. */
  origin: { lat: number; lon: number } | null;
}

function groupByAirport(list: LocatedController[]): Array<[string, LocatedController[]]> {
  const m = new Map<string, LocatedController[]>();
  for (const c of list) m.set(c.airport, [...(m.get(c.airport) ?? []), c]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function stationText(c: Controller, tag: boolean) {
  return `${FACILITY_LABEL[c.facility]}${c.atisCode ? ` ${c.atisCode}` : ""} ${c.frequency}${tag ? ` (${NETWORK_LABEL[c.network ?? "vatsim"]})` : ""}`;
}

/** "VATSIM", "IVAO" or "VATSIM + IVAO" for the panel title. */
export function networkTitle(summary: Pick<OnlineSummary, "network"> | null): string {
  switch (summary?.network) {
    case "ivao":
      return "IVAO";
    case "both":
      return "VATSIM + IVAO";
    case "vatsim":
      return "VATSIM";
    default:
      return "VATSIM · IVAO";
  }
}

/** Small side panel: nearest VATSIM/IVAO traffic and ATC in view, with frequencies. */
export default function OnlinePanel({ summary, view, origin }: Props) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  /** Pointer or keyboard focus in the traffic list: its order is frozen (no line moves under the cursor). */
  const [frozen, setFrozen] = useState(false);
  const orderRef = useRef<string[]>([]);
  const sortedFeedRef = useRef<number | null | undefined>(undefined);
  if (!summary?.enabled) {
    const enable = (network: Network) => {
      setError(null);
      invoke("online_set_enabled", { network, enabled: true }).catch((e) => setError(String(e)));
    };
    return (
      <section className="online-panel">
        <div className="tile-label">Online · VATSIM · IVAO</div>
        <div className="detail">{t("shell.online.off")}</div>
        {error && <ErrorNotice error={error} context="settings" compact onDismiss={() => setError(null)} />}
        <div className="online-actions">
          <button onClick={() => enable("vatsim")}>{t("shell.online.enable", { name: "VATSIM" })}</button>{" "}
          <button onClick={() => enable("ivao")}>{t("shell.online.enable", { name: "IVAO" })}</button>
        </div>
      </section>
    );
  }
  // with both networks on, every entry says where it comes from
  const tag = summary.network === "both";
  const failing = (summary.networks ?? []).filter((n) => n.enabled && n.lastError);

  // re-sorted by distance only for a new feed state and while the list is not hovered/focused
  const feed = summary.fetchedMs ?? null;
  const resort = !frozen && sortedFeedRef.current !== feed;
  const traffic = origin
    ? stableNearest(
        orderRef.current,
        (view?.pilots ?? []).map((p) => ({ key: `${p.network ?? "vatsim"}-${p.cid}`, item: p, d: haversineNm(origin.lat, origin.lon, p.latitude, p.longitude) })),
        MAX_TRAFFIC,
        resort,
      ).map(({ key, item, d }) => ({ key, p: item, d }))
    : [];
  orderRef.current = traffic.map((x) => x.key);
  if (resort) sortedFeedRef.current = feed;
  const airports = groupByAirport(view?.controllers ?? []);
  const enroute = view?.enroute ?? [];

  return (
    <section className="online-panel">
      <div className="tile-label">
        Online · {networkTitle(summary)}
        <span className="detail">
          {" "}
          {t("shell.online.counts", { pilots: fmt(summary.pilots), controllers: fmt(summary.controllers) })}
        </span>
      </div>
      {failing.map((n) => (
        <div key={n.network} className="warn-text small" title={n.lastError ?? ""}>
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
          {userMessage(n.lastError, n.network).title} {t("shell.online.nextAttempt", { seconds: n.nextPollS })}
        </div>
      ))}
      {!summary.networks && summary.lastError && (
        <div className="warn-text small" title={summary.lastError}>
          <span className="warn-icon" aria-hidden="true">
            !
          </span>
          {userMessage(summary.lastError, "vatsim").title} {t("shell.online.nextAttempt", { seconds: summary.nextPollS })}
        </div>
      )}

      <div className="online-cols">
        <Collapsible id="online.nearby" headClassName="online-head" title={t("shell.online.nearby")} summary={traffic.length ? String(traffic.length) : undefined}>
          {traffic.length === 0 && <div className="detail">{summary.fetchedMs ? t("shell.online.noTraffic") : t("shell.online.loading")}</div>}
          <ul
            className="online-list online-traffic"
            onPointerEnter={() => setFrozen(true)}
            onPointerLeave={() => setFrozen(false)}
            onFocus={() => setFrozen(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFrozen(false);
            }}
          >
            {traffic.map(({ key, p, d }) => (
              <li
                key={key}
                className="online-pick"
                role="button"
                tabIndex={0}
                aria-label={t("shell.online.showOnMap", { callsign: p.callsign })}
                // a click shows the aircraft on the map and opens its flight card
                onClick={() => selectTrafficOnMap(p)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectTrafficOnMap(p);
                  }
                }}
                title={[t("shell.online.showOnMap", { callsign: p.callsign }), tag ? NETWORK_LABEL[p.network ?? "vatsim"] : "", p.route].filter(Boolean).join(" · ")}
              >
                {/* two fixed lines: callsign · type · altitude / route · distance · network */}
                <strong className="online-pick-cs">{p.callsign}</strong>
                <span className="online-pick-type">{p.aircraftShort || "–"}</span>
                <span className="online-pick-alt num">{fmtAltitude(p.altitudeFt)}</span>
                <span className="online-pick-go" aria-hidden="true">
                  ›
                </span>
                <span className="detail online-pick-sub">
                  {p.departure || p.arrival ? `${p.departure || "?"}→${p.arrival || "?"} · ` : ""}
                  {fmt(d, 0, "nm")}
                  {tag ? ` · ${NETWORK_LABEL[p.network ?? "vatsim"]}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Collapsible>

        <Collapsible
          id="online.atc"
          headClassName="online-head"
          title={t("shell.online.atc")}
          summary={airports.length + enroute.length ? [...airports.map(([icao]) => icao), ...enroute.map((c) => c.callsign)].join(" · ") : undefined}
        >
          {airports.length === 0 && enroute.length === 0 && <div className="detail">{t("shell.online.noAtc")}</div>}
          <ul className="online-list">
            {airports.map(([icao, list]) => (
              <li key={icao}>
                <strong>{icao}</strong>
                <span className="detail">{list.map((c) => stationText(c, tag)).join(" · ")}</span>
              </li>
            ))}
            {enroute.map((c) => (
              <li key={`${c.network}-${c.callsign}`} title={c.textAtis.join("\n")}>
                <strong>{c.callsign}</strong>
                <span className="detail">
                  {c.frequency}
                  {tag ? ` (${NETWORK_LABEL[c.network ?? "vatsim"]})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Collapsible>
      </div>
    </section>
  );
}
