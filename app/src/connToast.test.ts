import { describe, expect, it } from "vitest";
import { connToastAction } from "./connToast";

const c = (state: string, provider = "simconnect") => ({ state, provider });

describe("connToastAction", () => {
  it("shows 'lost' only when the sim drops during a flight", () => {
    expect(connToastAction(c("connected"), c("disconnected"), true)).toBe("lost");
    expect(connToastAction(c("connected"), c("error"), true)).toBe("lost");
    expect(connToastAction(c("connected"), c("disconnected"), false)).toBeNull();
  });
  it("replaces it with 'back' while the flight still runs", () => {
    expect(connToastAction(c("disconnected"), c("connected"), true)).toBe("back");
  });
  it("removes it on reconnect when no flight is active any more", () => {
    expect(connToastAction(c("disconnected"), c("connected"), false)).toBe("dismiss");
    expect(connToastAction(c("connecting"), c("connected"), false)).toBe("dismiss");
  });
  it("removes it on a provider switch", () => {
    expect(connToastAction(c("disconnected"), c("connecting", "mock"), true)).toBe("dismiss");
  });
  it("leaves it alone otherwise", () => {
    expect(connToastAction(null, c("connecting"), false)).toBeNull();
    expect(connToastAction(c("disconnected"), c("connecting"), true)).toBeNull();
    expect(connToastAction(c("connected"), c("connected"), true)).toBeNull();
  });
});
