import { describe, expect, it } from "vitest";
import { FACILITY_LABEL, NETWORK_LABEL } from "./onlineText";
import * as mapOnline from "./map/online";

// The side panel takes its labels from onlineText (no MapLibre in the start chunk); the map
// layers keep their own copy in map/online.ts – both must stay the same.
describe("online labels", () => {
  it("match the map's tables", () => {
    expect(FACILITY_LABEL).toEqual(mapOnline.FACILITY_LABEL);
    expect(NETWORK_LABEL).toEqual(mapOnline.NETWORK_LABEL);
  });
});
