import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Airframe, AirframeRow } from "../types";

/** Re-run `load` whenever airframes or the logbook change. */
function useRefreshOn(load: () => void) {
  useEffect(() => {
    load();
    const uns = [listen("airframes:changed", load), listen("logbook:changed", load)];
    return () => {
      uns.forEach((u) => u.then((f) => f()));
    };
  }, [load]);
}

/** All airframes with aggregates; `null` while loading. */
export function useAirframes(includeDemo: boolean): { rows: AirframeRow[] | null; error: string | null; refresh: () => void } {
  const [rows, setRows] = useState<AirframeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    invoke<AirframeRow[]>("list_airframes", { includeDemo })
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [includeDemo]);
  useRefreshOn(refresh);
  return { rows, error, refresh };
}

/** One airframe by registration, kept current. */
export function useAirframe(registration: string | null | undefined): Airframe | null {
  const [a, setA] = useState<Airframe | null>(null);
  const load = useCallback(() => {
    if (!registration) {
      setA(null);
      return;
    }
    invoke<AirframeRow | null>("get_airframe", { registration })
      .then((r) => setA(r))
      .catch(() => setA(null));
  }, [registration]);
  useRefreshOn(load);
  return registration ? a : null;
}

/** Airframe of the flight being recorded. `key` re-asks when the flight or aircraft changes. */
export function useActiveAirframe(key: string): Airframe | null {
  const [a, setA] = useState<Airframe | null>(null);
  const load = useCallback(() => {
    invoke<Airframe | null>("active_airframe")
      .then(setA)
      .catch(() => setA(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is only the re-ask trigger (flight/aircraft changed); the command takes no argument
  }, [key]);
  useRefreshOn(load);
  return a;
}
