// Module cache for `get_airport` lookups by ICAO (Logbook → Airports). The airport database
// is static while the app runs, so every ident is asked once per session; a failed lookup is
// not cached (a later refresh tries again), an unknown ident (null) is.

import type { Airport } from "./types";

export type AirportFetcher = (ident: string) => Promise<{ airport: Airport } | null>;

const cache = new Map<string, Promise<Airport | null>>();

/** The airports for `idents` (null for unknown/failed), each fetched at most once while cached. */
export async function lookupAirports(idents: readonly string[], fetch: AirportFetcher): Promise<Map<string, Airport | null>> {
  const out = new Map<string, Airport | null>();
  await Promise.all(
    idents.map(async (ident) => {
      let p = cache.get(ident);
      if (!p) {
        p = fetch(ident).then((r) => r?.airport ?? null);
        cache.set(ident, p);
        // a transport error is not an answer: forget it so the next refresh asks again
        p.catch(() => cache.delete(ident));
      }
      out.set(ident, await p.catch(() => null));
    }),
  );
  return out;
}

/** Tests only. */
export function clearAirportCache() {
  cache.clear();
}
