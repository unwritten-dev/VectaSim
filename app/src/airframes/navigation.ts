// Cross-view navigation between the fleet and the logbook without prop drilling
// (flight detail → "In Flotte", fleet detail → a flight). App subscribes and switches views.

export type NavTarget = { kind: "airframe"; registration: string } | { kind: "flight"; id: string };

const listeners = new Set<(t: NavTarget) => void>();

export function navigate(t: NavTarget) {
  listeners.forEach((l) => l(t));
}

export function onNavigate(l: (t: NavTarget) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
