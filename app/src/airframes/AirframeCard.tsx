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
import { useT } from "../i18n";
import { errorToast } from "../ui/errorToast";

/** Flight detail: which airframe the flight is booked onto, with "Flugzeug ändern". */
export default function AirframeCard({ flight: f, onOpenFleet }: { flight: FlightRow; onOpenFleet?: (registration: string) => void }) {
  const a = useAirframe(f.airframeReg);
  const [picking, setPicking] = useState(false);
  const priv = usePrivacy();
  const t = useT();

  const pick = (registration: string | null) => {
    setPicking(false);
    if (registration === (f.airframeReg ?? null)) return;
    invoke<boolean>("set_flight_airframe", { flightId: f.id, registration })
      .then(() =>
        showToast({ tone: "ok", title: registration ? t("logbook.airframe.booked", { reg: priv.mask(registration, "registration") }) : t("logbook.airframe.unassigned") }),
      )
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.airframe.changeFailed"), e, "logbook") }));
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
            <strong>{t("logbook.airframe.noneTitle")}</strong>
            <span className="detail">{t("logbook.airframe.noneText")}</span>
          </>
        )}
      </div>
      <div className="af-card-actions">
        {f.airframeReg && onOpenFleet && (
          <button className="btn-sm" onClick={() => onOpenFleet(f.airframeReg!)} title={t("logbook.airframe.openInFleetTitle")}>
            {t("logbook.airframe.openInFleet")}
          </button>
        )}
        <button className="btn-sm" onClick={() => setPicking(!picking)} aria-expanded={picking}>
          {t("logbook.airframe.change")}
        </button>
      </div>
      {picking && <AirframePicker current={f.airframeReg} onPick={pick} onCancel={() => setPicking(false)} />}
    </div>
  );
}
