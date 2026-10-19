import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ofp } from "./types";
import { fmt, fmtClock, fmtDateTime, fmtDuration, fmtWeight, fmtWeightNum } from "./i18n/number";
import { useT } from "./i18n";
import { usePrefs, usePrivacy } from "./prefs";
import ErrorNotice from "./ErrorNotice";
import Collapsible from "./ui/Collapsible";
import Stat from "./ui/Stat";
import EmptyState from "./ui/EmptyState";
import { showToast } from "./ui/Toast";

interface Props {
  ofp: Ofp | null;
  onOfp: (ofp: Ofp | null) => void;
}

/** SimBrief times come as epoch seconds. */
const clockS = (s: number | undefined) => (s ? fmtClock(s * 1000) : "–");

/** SimBrief flight plan (side panel → Flugplan): load the latest OFP for the saved pilot id. */
export default function Dispatch({ ofp, onOfp }: Props) {
  const t = useT();
  const { weightUnit } = usePrefs();
  const priv = usePrivacy();
  const [user, setUser] = useState("");
  const [savedUser, setSavedUser] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<[string, string][]>("get_settings")
      .then((rows) => {
        const u = rows.find(([k]) => k === "simbrief_user")?.[1] ?? "";
        setUser(u);
        setSavedUser(u);
      })
      // prefill only: the field stays empty and the user can type the id
      .catch(() => {});
  }, []);

  const load = () => {
    setBusy(true);
    setError(null);
    invoke<Ofp>("simbrief_fetch", { user: user.trim() || null })
      .then((o) => {
        onOfp(o);
        setSavedUser(user.trim() || savedUser);
        setEditing(false);
        showToast({ tone: "ok", title: t("shell.ofp.loaded"), body: `${priv.mask(o.callsign, "callsign")} · ${o.originIcao} → ${o.destinationIcao} · ${o.aircraftIcao}` });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const clear = () =>
    invoke("clear_ofp")
      .then(() => onOfp(null))
      .catch((e) => setError(String(e)));

  const showInput = editing || !savedUser;
  const userForm = (
    <div className="dispatch-form">
      {showInput ? (
        <input
          className="sb-user"
          placeholder={t("dispatch.user.placeholder")}
          aria-label={t("dispatch.user.placeholder")}
          title={t("dispatch.user.title")}
          // Streamer-Modus: the SimBrief ID stays editable but unreadable
          type={priv.on ? "password" : "text"}
          autoComplete="off"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && load()}
          autoFocus={editing}
        />
      ) : (
        <span className="detail">
          SimBrief: <strong className="num">{savedUser}</strong>{" "}
          <button className="link-btn" onClick={() => setEditing(true)}>
            {t("dispatch.user.change")}
          </button>
        </span>
      )}
      <button className="btn-primary" onClick={load} disabled={busy || (!user.trim() && !savedUser)} aria-busy={busy} title={!user.trim() && !savedUser ? t("dispatch.user.missing") : undefined}>
        {busy ? t("shell.online.loading") : ofp ? t("dispatch.reload") : t("dispatch.load")}
      </button>
    </div>
  );

  return (
    <section className="dispatch side-stack">
      {error && <ErrorNotice error={error} context="simbrief" user={user.trim()} onRetry={load} onDismiss={() => setError(null)} compact />}
      {!ofp ? (
        <EmptyState
          compact
          title={t("dispatch.empty.title")}
          text={
            <>
              {t("dispatch.empty.text")}
              {!savedUser && ` ${t("dispatch.empty.idHint")}`}
            </>
          }
          actions={userForm}
        />
      ) : (
        <>
          <Collapsible
            id="dispatch.ofp"
            className="side-group"
            headClassName="side-group-title"
            bodyClassName="side-stack"
            title={t("dispatch.ofp")}
            summary={`${ofp.originIcao} → ${ofp.destinationIcao} · FL${Math.round(ofp.cruiseAltitudeFt / 100)}`}
          >
            <div className="dispatch-head">
              <div>
                <div className="flight-route num">
                  {ofp.originIcao} → {ofp.destinationIcao}
                </div>
                <div className="detail">
                  {priv.mask(ofp.callsign, "callsign")}
                  {ofp.flightNumber ? ` (${priv.on ? priv.mask(ofp.flightNumber, "callsign") : `${ofp.airlineIcao}${ofp.flightNumber}`})` : ""} · {ofp.aircraftIcao}{" "}
                  {priv.mask(ofp.registration, "registration")}
                </div>
              </div>
            </div>
            {userForm}
            <div className="stat-grid cols-2">
              <Stat size="sm" label={t("dispatch.stat.departure")} value={`${ofp.originIcao}${ofp.originRunway ? ` RWY ${ofp.originRunway}` : ""}`} sub={ofp.originName} />
              <Stat size="sm" label={t("dispatch.stat.arrival")} value={`${ofp.destinationIcao}${ofp.destinationRunway ? ` RWY ${ofp.destinationRunway}` : ""}`} sub={ofp.destinationName} />
              <Stat size="sm" label={t("dispatch.stat.alternate")} value={ofp.alternateIcao || "–"} sub={ofp.alternateName} />
              <Stat size="sm" label={t("dispatch.stat.cruise")} value={`FL${Math.round(ofp.cruiseAltitudeFt / 100)}`} sub={`CI ${ofp.costIndex} · ${fmt(ofp.routeDistanceNm, 0, "nm")}`} />
              <Stat size="sm" label={t("dispatch.stat.blockTimes")} value={`${clockS(ofp.times.schedOutS)} / ${clockS(ofp.times.schedInS)}`} />
              <Stat
                size="sm"
                label={t("dispatch.stat.blockAir")}
                value={fmtDuration(ofp.times.blockS * 1000)}
                sub={t("dispatch.stat.airTime", { time: fmtDuration(ofp.times.enrouteS * 1000) })}
              />
              <Stat
                size="sm"
                label={t("dispatch.stat.rampFuel")}
                value={fmtWeightNum(ofp.fuel.planRampKg)}
                unit={weightUnit}
                sub={t("dispatch.stat.fuelSub", { trip: fmtWeight(ofp.fuel.tripKg), landing: fmtWeight(ofp.fuel.planLandingKg) })}
              />
              <Stat
                size="sm"
                label={t("dispatch.stat.taxi")}
                value={`${ofp.times.taxiOutS ? Math.round(ofp.times.taxiOutS / 60) : "–"} / ${ofp.times.taxiInS ? Math.round(ofp.times.taxiInS / 60) : "–"} min`}
                sub={ofp.fuel.taxiKg ? t("dispatch.stat.taxiFuel", { fuel: fmtWeight(ofp.fuel.taxiKg) }) : undefined}
              />
              <Stat
                size="sm"
                label="Reserve / Alternate"
                value={fmtWeightNum(ofp.fuel.reserveKg)}
                unit={weightUnit}
                sub={`Alternate ${fmtWeight(ofp.fuel.alternateKg)} · Contingency ${fmtWeight(ofp.fuel.contingencyKg)}`}
              />
              <Stat size="sm" label="TOW"value={fmtWeightNum(ofp.weights.estTowKg)} unit={weightUnit} sub={`ZFW ${fmtWeight(ofp.weights.estZfwKg)} · ${ofp.passengers} PAX`} />
            </div>
          </Collapsible>
          <Collapsible id="dispatch.route" className="side-group" headClassName="side-group-title" title={t("dispatch.route")} summary={ofp.route}>
            <div className="route-string mono">{ofp.route}</div>
          </Collapsible>
          <div className="detail">
            {t("dispatch.footer", { airac: ofp.airac, created: fmtDateTime(ofp.generatedAtS * 1000), waypoints: t("dispatch.waypoints", { count: ofp.navlog.length }) })}
          </div>
          <div>
            <button className="btn-sm danger" onClick={clear}>
              {t("dispatch.remove")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
