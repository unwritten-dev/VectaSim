// Data behind the traffic card: the selected pilot kept current from the backend's feed
// (`online_pilot` on every poll, so it works even when the aircraft is outside the view) and
// its Planespotters photo (`traffic_photo`, throttled and cached in the backend).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OnlineSummary, Pilot, TrafficPhoto } from "../types";
import { usePrefs } from "../prefs";
import { applyFeedUpdate, sameTraffic, selectTraffic, shouldClose, type TrafficRef, type TrafficSelection } from "./trafficInfo";

/** When the network's feed was fetched (its poll time), else now – the timestamp of a V/S sample. */
function fetchedAt(summary: OnlineSummary | null, network: TrafficRef["network"]): number {
  return summary?.networks?.find((n) => n.network === network)?.fetchedMs ?? Date.now();
}

/**
 * The selected pilot over feed updates. `initial` (from the map feature or the panel list) shows
 * at once; the detail query fills in name and remarks. A pilot missing from the feed is marked
 * gone; `onExpired` fires 30 s later (GONE_CLOSE_MS) unless it comes back.
 */
export function useTrafficSelection(ref: TrafficRef | null, initial: Pilot | null, onExpired: () => void): TrafficSelection | null {
  const [sel, setSel] = useState<TrafficSelection | null>(null);
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const network = ref?.network;
  const cid = ref?.cid;

  useEffect(() => {
    if (network == null || cid == null) {
      setSel(null);
      return;
    }
    const r: TrafficRef = { network, cid };
    let alive = true;
    const seed = initialRef.current && sameTraffic(initialRef.current, r) ? initialRef.current : null;
    setSel(selectTraffic(r, seed));
    const refresh = (summary: OnlineSummary | null) => {
      invoke<Pilot | null>("online_pilot", { cid, network })
        .then((p) => {
          if (!alive) return;
          setSel((s) => (s && sameTraffic(s, r) ? applyFeedUpdate(s, p, fetchedAt(summary, network)) : s));
        })
        // the card keeps the last known state; the next poll asks again
        .catch(() => {});
    };
    refresh(null);
    const un = listen<OnlineSummary>("online:summary", (e) => refresh(e.payload));
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [network, cid]);

  const gone = sel?.goneSinceMs ?? null;
  useEffect(() => {
    if (gone == null || !sel) return;
    const id = window.setInterval(() => {
      if (shouldClose(sel, Date.now())) onExpiredRef.current();
    }, 1000);
    return () => window.clearInterval(id);
  }, [gone, sel]);

  return sel;
}

// one lookup per registration and app session; the backend caches for days and queues ≤ 1/s
const photoAsks = new Map<string, Promise<TrafficPhoto>>();

export type TrafficPhotoState = TrafficPhoto | { registration: string | null; status: "loading" | "unknown" };

/** Photo for a traffic registration; nothing is asked while the photo setting is off. */
export function useTrafficPhoto(registration: string | null): TrafficPhotoState {
  const { airframePhotos } = usePrefs();
  const [state, setState] = useState<TrafficPhotoState>({ registration, status: registration ? "loading" : "unknown" });
  useEffect(() => {
    if (!registration) {
      setState({ registration: null, status: "unknown" });
      return;
    }
    if (!airframePhotos) {
      setState({ registration, status: "off", url: null, thumbUrl: null, photographer: null, link: null });
      return;
    }
    let alive = true;
    setState({ registration, status: "loading" });
    let ask = photoAsks.get(registration);
    if (!ask) {
      ask = invoke<TrafficPhoto>("traffic_photo", { registration }).catch(
        (): TrafficPhoto => ({ registration, status: "error", url: null, thumbUrl: null, photographer: null, link: null }),
      );
      photoAsks.set(registration, ask);
      // an error is asked again on the next selection (the backend backs off by itself)
      void ask.then((p) => p.status === "error" && photoAsks.delete(registration));
    }
    void ask.then((p) => alive && setState(p));
    return () => {
      alive = false;
    };
  }, [registration, airframePhotos]);
  return state;
}
