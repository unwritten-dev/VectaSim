import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAirportCache, lookupAirports } from "./airportLookup";
import type { Airport } from "./types";

const ap = (icao: string) => ({ icao, name: `${icao} Airport`, country: "DE" }) as unknown as Airport;

beforeEach(() => clearAirportCache());

describe("lookupAirports", () => {
  it("asks each ident once, also across refreshes and for unknown idents", async () => {
    const fetch = vi.fn((id: string) => Promise.resolve(id === "ZZZZ" ? null : { airport: ap(id) }));
    const first = await lookupAirports(["EDDF", "EDDM", "ZZZZ"], fetch);
    expect(first.get("EDDF")?.name).toBe("EDDF Airport");
    expect(first.get("ZZZZ")).toBeNull();
    const second = await lookupAirports(["EDDF", "ZZZZ", "EGLL"], fetch);
    expect(second.get("EGLL")?.name).toBe("EGLL Airport");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["EDDF", "EDDM", "ZZZZ", "EGLL"]);
  });

  it("shares a lookup still in flight", async () => {
    const fetch = vi.fn((id: string) => Promise.resolve({ airport: ap(id) }));
    await Promise.all([lookupAirports(["EDDF"], fetch), lookupAirports(["EDDF"], fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a failed lookup is null now and asked again later", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("ipc")).mockResolvedValue({ airport: ap("EDDF") });
    expect((await lookupAirports(["EDDF"], fetch)).get("EDDF")).toBeNull();
    expect((await lookupAirports(["EDDF"], fetch)).get("EDDF")?.name).toBe("EDDF Airport");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
