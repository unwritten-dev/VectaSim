import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ofp } from "./types";
import { fmt, fmtClock, fmtDateTime, fmtDuration } from "./format";
import ErrorNotice from "./ErrorNotice";
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
        showToast({ tone: "ok", title: "Flugplan geladen", body: `${o.callsign} · ${o.originIcao} → ${o.destinationIcao} · ${o.aircraftIcao}` });
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
          placeholder="SimBrief-Pilot-ID oder Benutzername"
          aria-label="SimBrief-Pilot-ID oder Benutzername"
          title="Deine Pilot-ID findest du auf simbrief.com unter Account. Sie wird gespeichert."
          value={user}
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && load()}
          autoFocus={editing}
        />
      ) : (
        <span className="detail">
          SimBrief: <strong className="num">{savedUser}</strong>{" "}
          <button className="link-btn" onClick={() => setEditing(true)}>
            ändern
          </button>
        </span>
      )}
      <button className="btn-primary" onClick={load} disabled={busy || (!user.trim() && !savedUser)} aria-busy={busy} title={!user.trim() && !savedUser ? "Erst SimBrief-Pilot-ID eintragen" : undefined}>
        {busy ? "Lädt …" : ofp ? "Neu laden" : "Flugplan laden"}
      </button>
    </div>
  );

  return (
    <section className="dispatch side-stack">
      {error && <ErrorNotice error={error} context="simbrief" user={user.trim()} onRetry={load} onDismiss={() => setError(null)} compact />}
      {!ofp ? (
        <EmptyState
          compact
          title="Kein Flugplan geladen"
          text={
            <>
              Lade deinen letzten SimBrief-Flugplan, um Route, Restdistanz, ETA und Plan-gegen-Ist zu sehen.
              {!savedUser && " Deine Pilot-ID findest du auf simbrief.com → Account."}
            </>
          }
          actions={userForm}
        />
      ) : (
        <>
          <div className="dispatch-head">
            <div>
              <div className="flight-route num">
                {ofp.originIcao} → {ofp.destinationIcao}
              </div>
              <div className="detail">
                {ofp.callsign}
                {ofp.flightNumber ? ` (${ofp.airlineIcao}${ofp.flightNumber})` : ""} · {ofp.aircraftIcao} {ofp.registration}
              </div>
            </div>
          </div>
          {userForm}
          <div className="stat-grid cols-2">
            <Stat size="sm" label="Abflug" value={`${ofp.originIcao}${ofp.originRunway ? ` RWY ${ofp.originRunway}` : ""}`} sub={ofp.originName} />
            <Stat size="sm" label="Ankunft" value={`${ofp.destinationIcao}${ofp.destinationRunway ? ` RWY ${ofp.destinationRunway}` : ""}`} sub={ofp.destinationName} />
            <Stat size="sm" label="Ausweichflughafen" value={ofp.alternateIcao || "–"} sub={ofp.alternateName} />
            <Stat size="sm" label="Reiseflughöhe" value={`FL${Math.round(ofp.cruiseAltitudeFt / 100)}`} sub={`CI ${ofp.costIndex} · ${fmt(ofp.routeDistanceNm, 0, "nm")}`} />
            <Stat size="sm" label="Off-Block / On-Block (Plan)" value={`${clockS(ofp.times.schedOutS)} / ${clockS(ofp.times.schedInS)}`} />
            <Stat size="sm" label="Blockzeit / Flugzeit" value={fmtDuration(ofp.times.blockS * 1000)} sub={`Flugzeit ${fmtDuration(ofp.times.enrouteS * 1000)}`} />
            <Stat size="sm" label="Treibstoff Rampe" value={fmt(ofp.fuel.planRampKg, 0)} unit="kg" sub={`Trip ${fmt(ofp.fuel.tripKg, 0, "kg")} · Landung ${fmt(ofp.fuel.planLandingKg, 0, "kg")}`} />
            <Stat size="sm" label="TOW" value={fmt(ofp.weights.estTowKg, 0)} unit="kg" sub={`ZFW ${fmt(ofp.weights.estZfwKg, 0, "kg")} · ${ofp.passengers} PAX`} />
          </div>
          <div className="side-group">
            <div className="side-group-title">Route</div>
            <div className="route-string mono">{ofp.route}</div>
          </div>
          <div className="detail">
            AIRAC {ofp.airac} · erstellt {fmtDateTime(ofp.generatedAtS * 1000)} · {ofp.navlog.length} Wegpunkte
          </div>
          <div>
            <button className="btn-sm danger" onClick={clear}>
              Flugplan entfernen
            </button>
          </div>
        </>
      )}
    </section>
  );
}
