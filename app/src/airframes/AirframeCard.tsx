import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FlightRow } from "../types";
import { icaoFromAtcModel } from "../map/aircraftIcons";
import { showToast } from "../ui/Toast";
import { airframeName, shownAirframeName } from "./airframe";
import { usePrivacy } from "../prefs";
import AirframeImage from "./AirframeImage";
import AirframePicker from "./AirframePicker";
import { useAirframe } from "./hooks";

/** Flight detail: which airframe the flight is booked onto, with "Flugzeug ändern". */
export default function AirframeCard({ flight: f, onOpenFleet }: { flight: FlightRow; onOpenFleet?: (registration: string) => void }) {
  const a = useAirframe(f.airframeReg);
  const [picking, setPicking] = useState(false);
  const priv = usePrivacy();

  const pick = (registration: string | null) => {
    setPicking(false);
    if (registration === (f.airframeReg ?? null)) return;
    invoke<boolean>("set_flight_airframe", { flightId: f.id, registration })
      .then(() =>
        showToast({ tone: "ok", title: registration ? `Flug auf ${priv.mask(registration, "registration")} gebucht` : "Flugzeug-Zuordnung entfernt" }),
      )
      .catch((e) => showToast({ tone: "err", title: "Flugzeug nicht geändert", body: String(e) }));
  };

  const type = a?.icaoType || icaoFromAtcModel(f.aircraft.atcModel);
  return (
    <div className="af-card">
      <AirframeImage airframe={a} fallbackType={type} fallbackTitle={f.aircraft.title} />
      <div className="af-card-text">
        {f.airframeReg ? (
          <>
            <strong className="num">{priv.mask(f.airframeReg, "registration")}</strong>
            <span className="detail">
              {[a ? airframeName(a) : null, type, a?.airline]
                .filter((s, i, all) => s && all.indexOf(s) === i && s !== f.airframeReg)
                .map((s) => (s === a?.airline ? priv.mask(s, "airline") : a && s === airframeName(a) ? shownAirframeName(a, priv.on) : s))
                .join(" · ") || "–"}
            </span>
          </>
        ) : (
          <>
            <strong>Kein Flugzeug zugeordnet</strong>
            <span className="detail">Weder der Flugplan noch der Simulator lieferten eine Registrierung.</span>
          </>
        )}
      </div>
      <div className="af-card-actions">
        {f.airframeReg && onOpenFleet && (
          <button className="btn-sm" onClick={() => onOpenFleet(f.airframeReg!)} title="Flugzeug in der Flotte öffnen">
            In Flotte
          </button>
        )}
        <button className="btn-sm" onClick={() => setPicking(!picking)} aria-expanded={picking}>
          Flugzeug ändern
        </button>
      </div>
      {picking && <AirframePicker current={f.airframeReg} onPick={pick} onCancel={() => setPicking(false)} />}
    </div>
  );
}
