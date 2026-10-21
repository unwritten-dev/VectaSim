// "Satellite" on/off in the live map and track map toolbars: the shared map style choice
// (satellite.ts), the same as the check box under Settings → Display.

import { useT } from "../i18n";
import { useMapStyle } from "./satellite";
import { useHint } from "./hint";

export default function MapStyleToggle() {
  const t = useT();
  const [mode, setMode] = useMapStyle();
  const on = mode === "satellite";
  const title = on ? t("map.mapStyle.offTitle") : t("map.mapStyle.onTitle");
  const hint = useHint(title);
  return (
    <>
      <button className="toggle" onClick={() => setMode(on ? "map" : "satellite")} aria-pressed={on} title={title} aria-describedby={hint.describedBy}>
        {t("map.mapStyle.satellite")}
      </button>
      {hint.node}
    </>
  );
}
