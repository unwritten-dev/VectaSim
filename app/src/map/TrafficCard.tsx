// Flight card for a selected online-traffic aircraft (VATSIM / IVAO), floating at the map's
// right edge in the look of the Bereit / Nach-dem-Flug cards. Opened by a click on the aircraft
// or on its line in the Dispatch panel; LiveMap owns the selection, highlight, follow and route.
//
// Streamer-Modus: other pilots' callsigns, types and routes are public network data and stay;
// only the pilot's real name (VATSIM) is hidden. IVAO publishes no names at all.

import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { planespottersLink } from "./photoLink";
import type { Pilot, RouteResolution } from "../types";
import { routeSourcesText } from "./trafficRoute";
import { DASH, fmt, fmtAltitude, fmtDuration } from "../i18n/number";
import { useT, type TKey } from "../i18n";
import { usePrivacy } from "../prefs";
import { useAirport } from "../live/hooks";
import { AirframeSilhouette } from "../airframes/AirframeImage";
import { isDebriefOpen } from "../landing/debriefStore";
import Collapsible from "../ui/Collapsible";
import { NETWORK_LABEL } from "./online";
import {
  GONE_CLOSE_MS,
  aircraftTypeName,
  airlineFromCallsign,
  compassPoint,
  distanceBearing,
  flightRulesLabel,
  plannedAltitude,
  trafficRegistration,
  trendOf,
  verticalSpeedFpm,
  type TrafficSelection,
} from "./trafficInfo";
import { useTrafficPhoto } from "./trafficHooks";
import "./trafficCard.css";
import { useHintIds } from "./hint";

interface Props {
  sel: TrafficSelection;
  /** Own aircraft position (connected sim), for distance and bearing. */
  own: { lat: number; lon: number } | null;
  following: boolean;
  routeShown: boolean;
  /** State of the shown route (null while it is hidden). */
  route?: TrafficRouteState | null;
  onFollow: () => void;
  onRoute: () => void;
  onClose: () => void;
}

/** The route drawn for the card: being resolved, resolved (backend result), or the backend failed. */
export type TrafficRouteState = { status: "resolving" } | { status: "done"; res: RouteResolution } | { status: "failed" };

/** The line under the route button: "14 of 18 waypoints resolved · MSFS, X-Plane" or the great-circle note. */
export function routeStatusLine(route: TrafficRouteState, t: ReturnType<typeof useT>): { text: string; title?: string } {
  if (route.status === "resolving") return { text: t("map.trafficCard.routeResolving") };
  if (route.status === "failed" || route.res.enroute === 0) return { text: t("map.trafficCard.routeGreatCircle") };
  const { res } = route;
  const sources = routeSourcesText(res.sources);
  const vars = { resolved: res.resolvedCount, total: res.total };
  const text = sources ? t("map.trafficCard.routeResolved", { ...vars, sources }) : t("map.trafficCard.routeResolvedPlain", vars);
  return { text, title: res.unresolved.length ? t("map.trafficCard.routeUnresolvedTitle", { idents: res.unresolved.join(" ") }) : undefined };
}

const TREND_TEXT: Record<"climb" | "descent" | "level", TKey> = {
  climb: "map.trafficCard.trend.climb",
  descent: "map.trafficCard.trend.descent",
  level: "map.trafficCard.trend.level",
};
const TREND_ARROW = { climb: "↑", descent: "↓", level: "→" } as const;

function Photo({ pilot }: { pilot: Pilot }) {
  const t = useT();
  const reg = trafficRegistration(pilot);
  const photo = useTrafficPhoto(reg);
  const [broken, setBroken] = useState(false);
  const url = "url" in photo ? (photo.url ?? photo.thumbUrl) : null;
  useEffect(() => setBroken(false), [url]);
  const show = photo.status === "found" && !!url && !broken;
  // only Planespotters pages are opened: the link comes from the API or from an import
  const link = planespottersLink("link" in photo ? photo.link : null);
  const credit =
    "photographer" in photo && photo.photographer
      ? t("map.trafficCard.photo.credit", { photographer: photo.photographer })
      : t("map.trafficCard.photo.creditPlain");
  const hint = !reg
    ? t("map.trafficCard.photo.noRegistration")
    : photo.status === "loading"
      ? t("map.trafficCard.photo.loading")
      : photo.status === "off"
        ? t("map.trafficCard.photo.off")
        : photo.status === "error"
          ? t("map.trafficCard.photo.error")
          : t("map.trafficCard.photo.none");
  return (
    <figure className="traffic-photo">
      <div className="traffic-photo-frame">
        {show ? (
          <img src={url} alt={t("map.trafficCard.photo.alt", { registration: reg ?? "" })} onError={() => setBroken(true)} draggable={false} />
        ) : (
          <AirframeSilhouette icaoType={pilot.aircraftShort} />
        )}
      </div>
      <figcaption className="detail">
        {reg && <span className="num traffic-reg">{reg}</span>}
        {show ? (
          link ? (
            <button className="link-btn" onClick={() => openUrl(link).catch(() => {})} title={t("map.trafficCard.photo.openTitle", { link })}>
              {credit}
            </button>
          ) : (
            <span>{credit}</span>
          )
        ) : (
          <span>{hint}</span>
        )}
      </figcaption>
    </figure>
  );
}

function AirportLine({ ident, role }: { ident: string; role: string }) {
  const a = useAirport(ident || null);
  return (
    <div className="traffic-apt">
      <span className="traffic-apt-role">{role}</span>
      <strong className="num">{ident || "?"}</strong>
      {a?.name && <span className="detail traffic-apt-name">{a.name}</span>}
    </div>
  );
}

export default function TrafficCard({ sel, own, following, routeShown, route, onFollow, onRoute, onClose }: Props) {
  const t = useT();
  const priv = usePrivacy();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Descriptions of the action buttons for keyboard and screen-reader users (hint.tsx). */
  const hints = useHintIds();
  const p = sel.pilot;
  const key = `${sel.network}:${sel.cid}`;

  // focus moves to the close button when a (new) aircraft is selected
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [key]);

  // Esc closes – not while typing, not while the live view is hidden or the debrief lies over it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isDebriefOpen()) return;
      if (!closeRef.current || closeRef.current.offsetParent === null) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // "online seit" and the closing countdown tick once per second
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const net = NETWORK_LABEL[sel.network];
  const callsign = p?.callsign ?? DASH;
  if (!p) {
    return (
      <section className="after-flight traffic-card" role="dialog" aria-label={t("map.trafficCard.aria", { network: net })}>
        <div className="after-head">
          <span className="kicker">{t("map.trafficCard.kicker")}</span>
          <span className={`traffic-net-badge net-${sel.network}`}>{net}</span>
          <span className="spacer" />
          <CloseButton ref={closeRef} onClose={onClose} />
        </div>
        <div className="detail">{t("map.trafficCard.loading")}</div>
      </section>
    );
  }

  const airline = airlineFromCallsign(p.callsign);
  const typeName = aircraftTypeName(p.aircraftShort, p.aircraftModel);
  const rules = flightRulesLabel(p.flightRules);
  const planned = plannedAltitude(p.plannedAltitude);
  // "VFR · geplant VFR": a filed "VFR" level only repeats the flight rules
  const plannedRaw = planned ? ("ft" in planned ? fmtAltitude(planned.ft) : planned.text) : null;
  const plannedText = planned && "text" in planned && rules?.includes(planned.text) ? null : plannedRaw;
  const trend = trendOf(verticalSpeedFpm(sel));
  const fpm = verticalSpeedFpm(sel);
  const rel = own ? distanceBearing(own, { lat: p.latitude, lon: p.longitude }) : null;
  const logon = p.logonTime ? Date.parse(p.logonTime) : NaN;
  const name = !priv.on && p.name?.trim() ? p.name.trim() : null;
  const gone = sel.goneSinceMs != null;
  const closesIn = gone ? Math.max(0, Math.ceil((GONE_CLOSE_MS - (now - sel.goneSinceMs!)) / 1000)) : 0;
  const hasPlan = !!(p.departure || p.arrival);
  const fullPlan = !!(p.departure && p.arrival);
  const followTitle = following ? t("map.trafficCard.followingTitle") : t("map.trafficCard.followTitle");
  const routeTitle = fullPlan ? t("map.trafficCard.routeTitle") : t("map.trafficCard.noFullPlan");
  const followHint = hints("follow", followTitle);
  const routeHint = hints("route", routeTitle);
  // IVAO says so; VATSIM has no flag (its altitude stays MSL)
  const ground = p.onGround === true;

  return (
    <section className={`after-flight traffic-card${gone ? " traffic-gone" : ""}`} role="dialog" aria-label={t("map.trafficCard.ariaFlight", { callsign, network: net })}>
      <div className="after-head">
        <span className="kicker">{t("map.trafficCard.kicker")}</span>
        <span className={`traffic-net-badge net-${sel.network}`}>{net}</span>
        <span className="spacer" />
        <CloseButton ref={closeRef} onClose={onClose} />
      </div>

      {gone && (
        <div className="traffic-gone-note" role="status">
          {t("map.trafficCard.gone", { seconds: closesIn })}
        </div>
      )}

      <div className="traffic-title">
        <strong className="traffic-callsign num">{callsign}</strong>
        {airline && (
          <span className="detail">
            {airline.name ? `${airline.name} · ` : ""}
            {airline.icao}
          </span>
        )}
      </div>
      <div className="traffic-type">
        <strong className="num">{p.aircraftShort || DASH}</strong>
        {typeName && <span className="detail"> · {typeName}</span>}
      </div>

      {/* actions right under the title: reachable without scrolling at any window height */}
      <div className="after-actions traffic-actions">
        <button className="toggle" aria-pressed={following} onClick={onFollow} disabled={gone} title={followTitle} aria-describedby={followHint.describedBy}>
          {t("map.trafficCard.follow")}
        </button>
        {followHint.node}
        {/* aria-disabled without a full plan: stays focusable, the reason is its description */}
        <button
          className="toggle"
          aria-pressed={fullPlan && routeShown}
          onClick={() => fullPlan && onRoute()}
          aria-disabled={!fullPlan}
          title={routeTitle}
          aria-describedby={routeHint.describedBy}
        >
          {t("map.trafficCard.showRoute")}
        </button>
        {routeHint.node}
      </div>
      {fullPlan && routeShown && route && <RouteStatus route={route} />}

      <Collapsible id="traffic.photo" className="traffic-more" headClassName="traffic-more-head" title={t("map.trafficCard.photoTitle")} summary={trafficRegistration(p) ?? undefined}>
        <Photo pilot={p} />
      </Collapsible>

      {hasPlan ? (
        <div className="traffic-route">
          <AirportLine ident={p.departure} role={t("map.trafficCard.from")} />
          <AirportLine ident={p.arrival} role={t("map.trafficCard.to")} />
          <div className="detail">
            {rules || plannedText ? (
              <>
                {rules && <abbr title={rulesTitle(rules, t)}>{rules}</abbr>}
                {rules && plannedText && " · "}
                {plannedText && (
                  <span title={plannedText.startsWith("FL") ? t("map.trafficCard.flTitle") : undefined}>{t("map.trafficCard.planned", { altitude: plannedText })}</span>
                )}
              </>
            ) : (
              t("map.trafficCard.noRulesAltitude")
            )}
          </div>
        </div>
      ) : (
        <div className="detail">{t("map.trafficCard.noPlan")}</div>
      )}

      <dl className="traffic-values">
        <div>
          <dt>{t("map.trafficCard.altitude")}</dt>
          <dd className="num" title={!ground && fmtAltitude(p.altitudeFt).startsWith("FL") ? t("map.trafficCard.flTitle") : undefined}>
            {ground ? t("map.trafficCard.onGround") : fmtAltitude(p.altitudeFt)}
            {trend && !ground && (
              <span
                className={`traffic-trend trend-${trend}`}
                title={fpm != null ? t("map.trafficCard.trendTitle", { rate: fmt(Math.round(fpm / 50) * 50, 0, "ft/min") }) : undefined}
              >
                {" "}
                {TREND_ARROW[trend]} {t(TREND_TEXT[trend])}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>
            <abbr title={t("map.trafficCard.gsTitle")}>{t("map.trafficCard.gs")}</abbr>
          </dt>
          <dd className="num">{fmt(p.groundSpeedKt, 0, "kt")}</dd>
        </div>
        <div>
          <dt>
            <abbr title={t("map.trafficCard.headingTitle")}>{t("map.trafficCard.heading")}</abbr>
          </dt>
          <dd className="num">{`${String(((Math.round(p.headingDeg) % 360) + 360) % 360).padStart(3, "0")}°`}</dd>
        </div>
        <div>
          <dt>
            <abbr title={t("map.trafficCard.squawkTitle")}>{t("map.trafficCard.squawk")}</abbr>
          </dt>
          <dd className="num">{p.transponder || DASH}</dd>
        </div>
        {rel && (
          <div className="traffic-wide">
            <dt title={t("map.trafficCard.fromYouTitle")}>{t("map.trafficCard.fromYou")}</dt>
            <dd className="num">
              {fmt(rel.nm, rel.nm < 10 ? 1 : 0, "nm")} · {String(Math.round(rel.deg) % 360).padStart(3, "0")}° {compassPoint(rel.deg)}
            </dd>
          </div>
        )}
        {name && (
          <div className="traffic-wide">
            <dt>{t("map.trafficCard.pilot")}</dt>
            <dd>{name}</dd>
          </div>
        )}
        {Number.isFinite(logon) && (
          <div className="traffic-wide">
            <dt>{t("map.trafficCard.onlineSince")}</dt>
            <dd className="num">{fmtDuration(Math.max(0, now - logon), { seconds: false })}</dd>
          </div>
        )}
      </dl>

      {p.route?.trim() && (
        <Collapsible id="traffic.route" defaultOpen={false} className="traffic-more" headClassName="traffic-more-head" title={t("map.trafficCard.route")}>
          <p className="num">{p.route}</p>
        </Collapsible>
      )}
      {p.remarks?.trim() && (
        <Collapsible id="traffic.remarks" defaultOpen={false} className="traffic-more" headClassName="traffic-more-head" title={t("map.trafficCard.remarks")}>
          <p className="num">{p.remarks}</p>
        </Collapsible>
      )}

    </section>
  );
}

function RouteStatus({ route }: { route: TrafficRouteState }) {
  const t = useT();
  const line = routeStatusLine(route, t);
  return (
    <div className="detail traffic-route-status" role="status" aria-busy={route.status === "resolving"} title={line.title}>
      {line.text}
    </div>
  );
}

/** Tooltip for the flight rules: IFR, VFR or a change between them (Y/Z). */
function rulesTitle(rules: string, t: ReturnType<typeof useT>): string {
  if (rules.includes("→")) return t("map.trafficCard.rulesChangeTitle");
  if (rules === "IFR") return t("map.trafficCard.ifrTitle");
  if (rules === "VFR") return t("map.trafficCard.vfrTitle");
  return t("map.trafficCard.rulesTitle");
}

function CloseButton({ ref, onClose }: { ref: React.Ref<HTMLButtonElement>; onClose: () => void }) {
  const t = useT();
  return (
    <button ref={ref} className="btn-ghost after-close" onClick={onClose} aria-label={t("map.trafficCard.close")} title={t("map.trafficCard.closeTitle")}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}
