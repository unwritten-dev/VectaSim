// The "connection lost" toast (App.tsx onStatus): shown when the sim drops mid-flight, it stays
// until the sim is back. On every reconnect it is replaced ("back", flight still running) or
// removed (no flight any more – interrupted, connection restarted) so it can never outlive the
// outage; a provider switch removes it as well.

export type ConnToastAction = "lost" | "back" | "dismiss" | null;

interface Conn {
  state: string;
  provider: string;
}

export function connToastAction(prev: Conn | null, next: Conn, flightActive: boolean): ConnToastAction {
  if (prev && prev.provider !== next.provider) return "dismiss";
  const lost = prev?.state === "connected" && (next.state === "disconnected" || next.state === "error");
  if (lost) return flightActive ? "lost" : null;
  if (prev && prev.state !== "connected" && next.state === "connected") return flightActive ? "back" : "dismiss";
  return null;
}
