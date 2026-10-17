import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Airport, GeoPoint, Metar, NearestAirport } from "../types";

/** Resolve the ICAO of the nearest airport (≤ 3 nm) for a departure/arrival point. */
export function useNearestIcao(point: GeoPoint | null | undefined): string | null {
  const [icao, setIcao] = useState<string | null>(null);
  const key = point ? `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}` : "";
  useEffect(() => {
    if (!point) {
      setIcao(null);
      return;
    }
    let cancelled = false;
    invoke<NearestAirport | null>("nearest_airport", { lat: point.latitude, lon: point.longitude, maxNm: 3 })
      .then((n) => !cancelled && setIcao(n?.airport.ident ?? null))
      // local airport DB lookup; on failure the route simply shows "····" (no ICAO)
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return icao;
}

/** METAR for one station, refreshed every 10 min (the backend cache has the same lifetime). */
export function useMetar(icao: string | null): { metar: Metar | null; error: string | null } {
  const [metar, setMetar] = useState<Metar | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMetar(null);
    setError(null);
    if (!icao) return;
    let cancelled = false;
    const load = () =>
      invoke<Metar | null>("metar", { icao })
        .then((m) => {
          if (cancelled) return;
          setMetar(m);
          setError(null);
        })
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const id = window.setInterval(load, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [icao]);
  return { metar, error };
}

/** Coordinates of an airport by ident (destination distance, weather switch). */
export function useAirport(ident: string | null): Airport | null {
  const [airport, setAirport] = useState<Airport | null>(null);
  useEffect(() => {
    setAirport(null);
    if (!ident) return;
    let cancelled = false;
    invoke<{ airport: Airport } | null>("get_airport", { ident })
      .then((d) => !cancelled && setAirport(d?.airport ?? null))
      // without it the remaining distance shows "–" and we keep departure weather
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ident]);
  return airport;
}

/** Boolean stored in localStorage (per-viewer convenience; falls back to `initial`). */
export function useStoredState<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      return (typeof initial === "boolean" ? raw === "1" : raw) as T;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, typeof v === "boolean" ? (v ? "1" : "0") : v);
    } catch {
      /* storage unavailable: the state still works for this session */
    }
  };
  return [value, set];
}
