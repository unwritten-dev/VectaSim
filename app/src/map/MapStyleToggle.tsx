// "Satellit" on/off in the live map and track map toolbars: the shared map style choice
// (satellite.ts), the same as the check box in Einstellungen → Anzeige.

import { useT } from "../i18n";
import { useMapStyle } from "./satellite";

export default function MapStyleToggle() {
  const t = useT();
  const [mode, setMode] = useMapStyle();
  const on = mode === "satellite";
  return (
    <button className="toggle" onClick={() => setMode(on ? "map" : "satellite")} aria-pressed={on} title={on ? t("map.mapStyle.offTitle") : t("map.mapStyle.onTitle")}>
      {t("map.mapStyle.satellite")}
    </button>
  );
}
