import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDS_LAYERS,
  CLOUDS_PROTOCOL,
  DEFAULT_WEATHER,
  RADAR_PROTOCOL,
  WEATHER_EVENT,
  WEATHER_STORAGE_KEY,
  cloudAlpha,
  cloudsTileUrl,
  fromProtocolUrl,
  getWeatherState,
  irToClouds,
  latestRadarFrame,
  loadWeatherPrefs,
  protocolUrl,
  radarTileUrl,
  radarWithoutMagenta,
  saveWeatherPrefs,
  setWeatherMaster,
  weatherBeforeId,
  weatherWanted,
  wmsDefaultTime,
  zuluLabel,
} from "./weatherOverlay";
import { legendRows } from "./WeatherToggle";

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe("radar frames (RainViewer)", () => {
  const index = {
    host: "https://tilecache.rainviewer.com",
    radar: {
      past: [
        { time: 1792414200, path: "/v2/radar/5d003acf8e75" },
        { time: 1792414800, path: "/v2/radar/ab1870a64ca5" },
        { time: 1792413600, path: "/v2/radar/5eb52622b9c9" },
      ],
      nowcast: [],
    },
  };

  it("picks the newest past frame and builds its tile template", () => {
    expect(latestRadarFrame(index)).toEqual({
      time: 1792414800,
      url: "https://tilecache.rainviewer.com/v2/radar/ab1870a64ca5/256/{z}/{x}/{y}/2/1_1.png",
    });
    expect(radarTileUrl("https://h.example", "/p")).toBe("https://h.example/p/256/{z}/{x}/{y}/2/1_1.png");
  });

  it("returns null without frames or with an unexpected host", () => {
    expect(latestRadarFrame(null)).toBeNull();
    expect(latestRadarFrame({ host: index.host, radar: { past: [] } })).toBeNull();
    expect(latestRadarFrame({ ...index, host: "http://tilecache.rainviewer.com" })).toBeNull();
    expect(latestRadarFrame({ ...index, host: "https://evil.example/x?" })).toBeNull();
    expect(latestRadarFrame({ host: index.host, radar: { past: [{ time: 1, path: "relative" }] } })).toBeNull();
  });
});

describe("cloud frames (EUMETView WMS)", () => {
  it("reads the default time from the capabilities", () => {
    const xml = '<Layer><Dimension name="time" default="2026-10-19T12:00:00Z" units="ISO8601" nearestValue="1">2020-09-01T00:00:00.000Z/2026-10-19T12:00:00.000Z/PT15M</Dimension></Layer>';
    expect(wmsDefaultTime(xml)).toBe(Date.UTC(2026, 9, 19, 12, 0) / 1000);
    expect(wmsDefaultTime('<Dimension default="2026-10-19T09:00:00Z" name="time">')).toBe(Date.UTC(2026, 9, 19, 9, 0) / 1000);
    expect(wmsDefaultTime("<Layer/>")).toBeNull();
    expect(wmsDefaultTime('<Dimension name="time" default="soon">')).toBeNull();
  });

  it("builds a GetMap template with the layers, the time and an unescaped bbox placeholder", () => {
    const url = cloudsTileUrl(Date.UTC(2026, 9, 19, 12, 0) / 1000);
    expect(url.startsWith("https://view.eumetsat.int/geoserver/wms?")).toBe(true);
    expect(url.endsWith("&bbox={bbox-epsg-3857}")).toBe(true);
    const q = new URL(url.replace("{bbox-epsg-3857}", "0,0,1,1")).searchParams;
    expect(q.get("layers")).toBe(CLOUDS_LAYERS.join(","));
    expect(q.get("crs")).toBe("EPSG:3857");
    expect(q.get("transparent")).toBe("true");
    expect(q.get("time")).toBe("2026-10-19T12:00:00Z");
    expect(new URL(cloudsTileUrl(null).replace("{bbox-epsg-3857}", "0")).searchParams.has("time")).toBe(false);
  });

  it("turns warm ground transparent and cold cloud tops opaque", () => {
    expect(cloudAlpha(60)).toBe(0);
    expect(cloudAlpha(105)).toBe(0);
    expect(cloudAlpha(255)).toBe(255);
    const mid = cloudAlpha(155);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(155);
    expect(cloudAlpha(180)).toBeGreaterThan(mid);
  });

  it("recolours IR pixels into clouds, keeping no-data transparent", () => {
    const px = new Uint8ClampedArray([250, 250, 250, 255, 70, 70, 70, 255, 250, 250, 250, 0]);
    irToClouds(px, "dark");
    expect([...px.slice(0, 4)]).toEqual([238, 242, 246, 255]);
    expect(px[7]).toBe(0);
    expect(px[11]).toBe(0);
    const light = new Uint8ClampedArray([250, 250, 250, 255]);
    irToClouds(light, "light");
    expect([...light]).toEqual([84, 98, 116, 255]);
  });
});

describe("protocol URLs", () => {
  it("round-trips radar and cloud URLs through the tile protocols", () => {
    const radar = "https://tilecache.rainviewer.com/v2/radar/x/256/1/2/3/2/1_1.png";
    expect(protocolUrl("radar", radar)).toBe(`${RADAR_PROTOCOL}://tilecache.rainviewer.com/v2/radar/x/256/1/2/3/2/1_1.png`);
    expect(fromProtocolUrl(protocolUrl("radar", radar))).toEqual({ https: radar, scheme: "dark" });
    const clouds = "https://view.eumetsat.int/geoserver/wms?layers=a&bbox=1,2,3,4";
    expect(protocolUrl("clouds", clouds, "light")).toBe(`${CLOUDS_PROTOCOL}://light/view.eumetsat.int/geoserver/wms?layers=a&bbox=1,2,3,4`);
    expect(fromProtocolUrl(protocolUrl("clouds", clouds, "light"))).toEqual({ https: clouds, scheme: "light" });
  });
});

describe("legend time", () => {
  it("formats UTC as 13:40z", () => {
    expect(zuluLabel(Date.UTC(2026, 9, 19, 13, 40, 59) / 1000)).toBe("13:40z");
    expect(zuluLabel(Date.UTC(2026, 9, 19, 0, 5) / 1000)).toBe("00:05z");
  });
});

describe("weather preferences", () => {
  it("defaults to METAR on, radar and clouds off (nothing fetched)", () => {
    expect(loadWeatherPrefs()).toEqual(DEFAULT_WEATHER);
    expect(DEFAULT_WEATHER).toEqual({ metar: true, radar: false, clouds: false });
  });

  it("persists and announces a change; ignores junk", () => {
    let events = 0;
    window.addEventListener(WEATHER_EVENT, () => events++);
    saveWeatherPrefs({ metar: false, radar: true, clouds: false });
    expect(JSON.parse(store.get(WEATHER_STORAGE_KEY) ?? "")).toEqual({ metar: false, radar: true, clouds: false });
    expect(loadWeatherPrefs()).toEqual({ metar: false, radar: true, clouds: false });
    expect(getWeatherState().prefs.radar).toBe(true);
    expect(events).toBe(1);
    store.set(WEATHER_STORAGE_KEY, '{"radar":"yes","clouds":true}');
    expect(loadWeatherPrefs()).toEqual({ metar: true, radar: false, clouds: true });
    store.set(WEATHER_STORAGE_KEY, "{oops");
    expect(loadWeatherPrefs()).toEqual(DEFAULT_WEATHER);
  });

  it("shows radar and clouds only under the Wetter master switch", () => {
    const prefs = { metar: true, radar: true, clouds: false };
    expect(weatherWanted({ prefs, master: true }, "radar")).toBe(true);
    expect(weatherWanted({ prefs, master: false }, "radar")).toBe(false);
    expect(weatherWanted({ prefs, master: true }, "clouds")).toBe(false);
  });

  it("lists legend rows for the shown layers only", () => {
    saveWeatherPrefs({ metar: true, radar: true, clouds: true });
    setWeatherMaster(true);
    const rows = legendRows(getWeatherState());
    expect(rows.map((r) => r.kind)).toEqual(["radar", "clouds"]);
    expect(rows[0].time).toBeNull();
    setWeatherMaster(false);
    expect(legendRows(getWeatherState())).toEqual([]);
    setWeatherMaster(true);
  });
});

describe("weatherBeforeId", () => {
  const base = [
    { id: "background", type: "background" },
    { id: "vectasim-satellite", type: "raster", source: "vectasim-satellite" },
    { id: "water", type: "fill", source: "openmaptiles" },
    { id: "water_name", type: "symbol", source: "openmaptiles" },
    { id: "track-3d-wall", type: "fill-extrusion", source: "track-3d" },
    { id: "highway_minor", type: "line", source: "openmaptiles" },
    { id: "place_city", type: "symbol", source: "openmaptiles" },
  ];

  it("goes above the basemap fills and lines, under its place names", () => {
    expect(weatherBeforeId(base, "radar")).toBe("place_city");
  });

  it("goes under our own layers, and clouds under the radar", () => {
    const withOwn = [...base.slice(0, 6), { id: "airports", type: "circle", source: "airports" }, ...base.slice(6)];
    expect(weatherBeforeId(withOwn, "radar")).toBe("airports");
    const withRadar = [...base.slice(0, 6), { id: "vectasim-wx-radar", type: "raster", source: "vectasim-wx-radar" }, ...base.slice(6)];
    expect(weatherBeforeId(withRadar, "clouds")).toBe("vectasim-wx-radar");
    // a second weather layer goes past the first, still under the names
    const withClouds = [...base.slice(0, 6), { id: "vectasim-wx-clouds", type: "raster", source: "vectasim-wx-clouds" }, ...base.slice(6)];
    expect(weatherBeforeId(withClouds, "radar")).toBe("place_city");
  });

  it("goes on top when the style has nothing above the basemap", () => {
    expect(weatherBeforeId(base.slice(0, 3), "radar")).toBeUndefined();
  });
});

describe("radar colours without magenta (RainViewer Universal Blue)", () => {
  // the scheme's rain steps from RainViewer's colour table (every 3 dBZ from 16 dBZ), plus snow blues
  const keep = ["#6cd1eb", "#1baee2", "#0091ca", "#0077aa", "#006295", "#005180", "#004768", "#ffd200", "#ffaa00", "#ff8b00", "#f23600", "#cd0d00", "#8f0000", "#ffffff", "#00ff00", "#b8f8ff", "#7fbfff", "#3f7fff", "#0000ff", "#dacc93", "#857d6a"];
  const magenta = ["#ffaaff", "#ff9fff", "#ff95ff", "#ff8bff", "#ff81ff", "#ff77ff", "#ff6cff", "#ff62ff", "#ff58ff", "#ff4eff"];
  const px = (hex: string[], a = 255) => new Uint8ClampedArray(hex.flatMap((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(a)));

  it("turns the 55–64 dBZ magenta steps white and keeps their alpha", () => {
    const p = px(magenta, 200);
    radarWithoutMagenta(p);
    for (let i = 0; i < p.length; i += 4) expect([p[i], p[i + 1], p[i + 2], p[i + 3]]).toEqual([255, 255, 255, 200]);
  });

  it("also the smoothed blend between dark red and magenta", () => {
    const p = new Uint8ClampedArray([199, 85, 128, 255]);
    radarWithoutMagenta(p);
    expect([...p]).toEqual([255, 255, 255, 255]);
  });

  it("every other colour of the scheme stays as it is; transparent pixels are skipped", () => {
    const p = px(keep);
    const before = [...p];
    radarWithoutMagenta(p);
    expect([...p]).toEqual(before);
    const clear = new Uint8ClampedArray([255, 0, 255, 0]);
    radarWithoutMagenta(clear);
    expect([...clear]).toEqual([255, 0, 255, 0]);
  });
});
