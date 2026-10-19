import { useT } from "../i18n";
import "./mapUnavailable.css";

/**
 * Shown in place of a map that could not be created (no WebGL2, GPU process gone, driver
 * blocklisted): a short hint instead of a blank area. The recording does not depend on the map.
 */
export default function MapUnavailable() {
  const t = useT();
  return (
    <div className="map-unavailable" role="status">
      <strong>{t("map.unavailable.title")}</strong>
      <span>{t("map.unavailable.body")}</span>
    </div>
  );
}
