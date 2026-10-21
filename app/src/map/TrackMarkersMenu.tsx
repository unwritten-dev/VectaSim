// "Markers ▾" in the track-map toolbar: which flight-path markers (../trackEvents.ts) the map
// and the profile chart show – gear, flaps, rotation, approach gates, approach criteria,
// touchdowns. Remembered per viewer (localStorage). Menu keyboard model from ui/menu.ts;
// frame and menu styles shared with the Weather / Traffic split buttons (trafficToggle.css).

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT, type TKey } from "../i18n";
import { handleMenuKey, menuItems } from "../ui/menu";
import { TRACK_EVENT_GROUPS, getTrackEventFilter, setTrackEventFilter, subscribeTrackEventFilter, type TrackEventFilter, type TrackEventGroup } from "../trackEvents";
import { LABEL_ZOOM } from "./trackEventLayers";
import { useHintIds } from "./hint";
import "./trafficToggle.css";
import "./weatherToggle.css";

/** The shared marker filter (map + profile chart). */
export function useTrackEventFilter(): TrackEventFilter {
  return useSyncExternalStore(subscribeTrackEventFilter, getTrackEventFilter, getTrackEventFilter);
}

const label = (g: TrackEventGroup) => `map.markers.group.${g}` as TKey;
const title = (g: TrackEventGroup) => `map.markers.groupTitle.${g}` as TKey;

export default function TrackMarkersMenu() {
  const t = useT();
  const filter = useTrackEventFilter();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    menuItems(listRef.current)[0]?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const flip = (g: TrackEventGroup) => setTrackEventFilter({ ...filter, [g]: !filter[g] });
  const shown = TRACK_EVENT_GROUPS.filter((g) => filter[g]).length;
  const hints = useHintIds();
  const menuTitle = t("map.markers.menuTitle");
  return (
    <span
      className={shown ? "traffic-toggle traffic-split weather-split on" : "traffic-toggle traffic-split weather-split"}
      ref={wrapRef}
      onKeyDown={(e) => handleMenuKey(e, open, listRef.current, triggerRef.current, () => setOpen(false))}
    >
      <button
        ref={triggerRef}
        className="traffic-net traffic-main markers-trigger"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={menuTitle}
        aria-describedby={hints("menu", menuTitle).describedBy}
      >
        {t("map.markers.menu")}
        <span className="traffic-net-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} className="traffic-net-menu weather-menu markers-menu" role="menu" aria-label={t("map.markers.menuLabel")}>
          {TRACK_EVENT_GROUPS.map((g, i) => (
            <button
              key={g}
              tabIndex={i === 0 ? 0 : -1}
              role="menuitemcheckbox"
              aria-checked={filter[g]}
              className={filter[g] ? "active" : undefined}
              onClick={() => flip(g)}
              title={t(title(g))}
              aria-describedby={hints(g, t(title(g))).describedBy}
            >
              <span className="weather-check" aria-hidden="true">
                {filter[g] ? "✓" : ""}
              </span>
              {t(label(g))}
            </button>
          ))}
          <div className="weather-menu-note">{t("map.markers.note", { zoom: LABEL_ZOOM })}</div>
          {TRACK_EVENT_GROUPS.map((g) => (
            <Fragment key={g}>{hints(g, t(title(g))).node}</Fragment>
          ))}
        </div>
      )}
      {hints("menu", menuTitle).node}
    </span>
  );
}
