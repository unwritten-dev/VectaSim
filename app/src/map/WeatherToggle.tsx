// "Wetter" in the live map toolbar: a split button like "Verkehr" (TrafficToggle.tsx, same
// frame and menu styles) – Wetter on/off on the left, on the right a menu with the three
// weather layers, each on/off: METAR rings, precipitation radar, clouds (satellite IR).
// The radar and cloud layers themselves live in weatherOverlay.ts; WeatherLegend shows the
// time of the images on the map.

import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT, type TKey } from "../i18n";
import { saveWeatherPrefs, setWeatherMaster, useWeatherState, zuluLabel, type WeatherPrefs, type WeatherState } from "./weatherOverlay";
import "./trafficToggle.css";
import { CATEGORY_COLOR } from "../theme";
import type { FlightCategory } from "../types";
import "./weatherToggle.css";
import { useHintIds } from "./hint";

const ITEMS: Array<{ id: keyof WeatherPrefs; labelKey: TKey; titleKey: TKey }> = [
  { id: "metar", labelKey: "map.weather.metar", titleKey: "map.weather.metarTitle" },
  { id: "radar", labelKey: "map.weather.radar", titleKey: "map.weather.radarTitle" },
  { id: "clouds", labelKey: "map.weather.clouds", titleKey: "map.weather.cloudsTitle" },
];

/** Fired so LiveMap re-asks (or clears) the METAR rings when their sub-switch changes. */
const LAYERS_EVENT = "vectasim:layers";

interface Props {
  /** "Wetter" on (LiveMap's weather layer choice). */
  on: boolean;
  /** Switches "Wetter" (LiveMap's toggleLayer("weather")). */
  onToggle: () => void;
  /** METAR rings appear from this zoom (tooltip). */
  metarZoom: number;
}

export default function WeatherToggle({ on, onToggle, metarZoom }: Props) {
  const t = useT();
  const wx = useWeatherState();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // the overlay follows "Wetter" (master) – radar and clouds are only fetched while it is on
  useEffect(() => setWeatherMaster(on), [on]);

  // close on outside click and Escape (capture phase, marked handled – see TrafficToggle)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      caretRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((b): b is HTMLButtonElement => b != null);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = (at - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  const flip = (id: keyof WeatherPrefs) => {
    const next = { ...wx.prefs, [id]: !wx.prefs[id] };
    saveWeatherPrefs(next);
    if (id === "metar") window.dispatchEvent(new Event(LAYERS_EVENT));
    // switching a layer on means "show me that weather": also switches "Wetter" on
    if (next[id] && !on) onToggle();
  };

  const hints = useHintIds();
  const mainTitle = t(on ? "map.weather.offTitle" : "map.weather.onTitle", { zoom: metarZoom });
  return (
    <span className={on ? "traffic-toggle traffic-split weather-split on" : "traffic-toggle traffic-split weather-split"} ref={wrapRef} role="group" aria-label={t("map.weather.groupLabel")}>
      <button className="toggle traffic-main" onClick={onToggle} aria-pressed={on} title={mainTitle} aria-describedby={hints("main", mainTitle).describedBy}>
        {t("map.toolbar.weather")}
      </button>
      <button
        ref={caretRef}
        className="traffic-net weather-caret"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("map.weather.menu")}
        title={t("map.weather.menuTitle")}
        aria-describedby={hints("menu", t("map.weather.menuTitle")).describedBy}
      >
        <span className="traffic-net-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="traffic-net-menu weather-menu" role="menu" aria-label={t("map.weather.menu")} onKeyDown={onMenuKey}>
          {ITEMS.map((item, i) => (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              tabIndex={i === 0 ? 0 : -1}
              role="menuitemcheckbox"
              aria-checked={wx.prefs[item.id]}
              className={wx.prefs[item.id] ? "active" : undefined}
              onClick={() => flip(item.id)}
              title={t(item.titleKey, { zoom: metarZoom })}
              aria-describedby={hints(item.id, t(item.titleKey, { zoom: metarZoom })).describedBy}
            >
              <span className="weather-check" aria-hidden="true">
                {wx.prefs[item.id] ? "✓" : ""}
              </span>
              {t(item.labelKey)}
            </button>
          ))}
          <div className="weather-menu-note">{t("map.weather.note")}</div>
          {ITEMS.map((item) => (
            <Fragment key={item.id}>{hints(item.id, t(item.titleKey, { zoom: metarZoom })).node}</Fragment>
          ))}
        </div>
      )}
      {hints("main", mainTitle).node}
      {hints("menu", t("map.weather.menuTitle")).node}
    </span>
  );
}

/** Legend rows: "Radar 13:40z" per shown layer; "lädt …" before the first frame, a marker if the last refresh failed. */
export function legendRows(wx: WeatherState): Array<{ kind: "radar" | "clouds"; time: string | null; failed: boolean }> {
  if (!wx.master) return [];
  return (["radar", "clouds"] as const)
    .filter((k) => wx.prefs[k])
    .map((k) => ({ kind: k, time: wx.frames[k] ? zuluLabel(wx.frames[k].time) : null, failed: wx.failed[k] }));
}

/** METAR ring colours in the legend, in the order of worsening weather; grey = no ceiling/visibility. */
export const METAR_LEGEND: ReadonlyArray<{ cat: FlightCategory; label: string; titleKey: TKey }> = [
  { cat: "VFR", label: "VFR", titleKey: "map.weather.legend.vfr" },
  { cat: "MVFR", label: "MVFR", titleKey: "map.weather.legend.mvfr" },
  { cat: "IFR", label: "IFR", titleKey: "map.weather.legend.ifr" },
  { cat: "LIFR", label: "LIFR", titleKey: "map.weather.legend.lifr" },
  { cat: "UNKNOWN", label: "?", titleKey: "map.weather.legend.unknown" },
];

/** METAR row of the legend: null while "Wetter" or the METAR rings are off; `belowZoom` while zoomed out too far for them. */
export function metarLegend(wx: WeatherState, zoom: number | null | undefined, minZoom: number): { belowZoom: boolean } | null {
  if (!wx.master || !wx.prefs.metar) return null;
  return { belowZoom: zoom != null && zoom < minZoom };
}

/** Re-render on a theme switch: CATEGORY_COLOR is refreshed in place (theme.ts). */
function useThemeTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener("theme:changed", on);
    return () => window.removeEventListener("theme:changed", on);
  }, []);
}

/**
 * Small glass legend on the live map: what the METAR ring colours mean (flight categories, from
 * the configured zoom) and the time of the radar and cloud images.
 */
export function WeatherLegend({ zoom, metarZoom = 7 }: { zoom?: number | null; metarZoom?: number }) {
  const t = useT();
  useThemeTick();
  const wx = useWeatherState();
  const rows = legendRows(wx);
  const metar = metarLegend(wx, zoom, metarZoom);
  if (!rows.length && !metar) return null;
  return (
    <div className="weather-legend" title={t("map.weather.note")}>
      {metar && (
        <span className={metar.belowZoom ? "weather-legend-row metar-legend dim" : "weather-legend-row metar-legend"} role="list" aria-label={t("map.weather.legend.aria")}>
          <span className="metar-legend-name">{t("map.weather.metar")}</span>
          {metar.belowZoom ? (
            <span className="num">{t("map.weather.legend.fromZoom", { zoom: metarZoom })}</span>
          ) : (
            METAR_LEGEND.map((c) => (
              <span key={c.cat} className="metar-legend-item" role="listitem" title={t(c.titleKey)} aria-label={t(c.titleKey)}>
                <span className="metar-ring" style={{ borderColor: CATEGORY_COLOR[c.cat] }} aria-hidden="true" />
                {c.label}
              </span>
            ))
          )}
        </span>
      )}
      {rows.map((r) => (
        <span key={r.kind} className={r.failed ? "weather-legend-row failed" : "weather-legend-row"}>
          <span className={`weather-swatch ${r.kind}`} aria-hidden="true" />
          {t(r.kind === "radar" ? "map.weather.radar" : "map.weather.clouds")}{" "}
          <span className="num">{r.time ?? t("map.weather.loading")}</span>
          {r.failed && <span className="weather-legend-warn"> · {t("map.weather.failed")}</span>}
        </span>
      ))}
    </div>
  );
}
