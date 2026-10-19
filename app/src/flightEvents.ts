// Wording and bookkeeping for `sim:flight-event` (App.tsx onFlightEvent, the live event log).
// A ground session (core flight.rs FlightDiscardedEvent) ends with the usual `flightEnded` and
// right after it a `flightDiscarded` with the same `timestampMs`: the end line and the
// "Flug gespeichert" toast of that `flightEnded` must not stand. Pure apart from the small
// set of discarded end times, see flightEvents.test.ts.

import { PHASE_LABEL } from "./format";
import { fmt } from "./i18n/number";
import { t } from "./i18n";
import { rateText } from "./landing/rated";
import type { FlightEvent } from "./types";
import type { ToastOptions } from "./ui/Toast";

/** Event-log line of a flight event; null for one the log leaves out. */
export function describeFlightEvent(e: FlightEvent): string | null {
  switch (e.kind) {
    case "flightStarted":
      return t("shell.flightEvent.started");
    case "flightEnded":
      return e.interrupted ? t("shell.flightEvent.interrupted") : t("shell.flightEvent.saved");
    case "flightDiscarded":
      return t("shell.flightEvent.discarded");
    case "phaseChanged":
      return `Phase: ${PHASE_LABEL[e.from]} → ${PHASE_LABEL[e.to]}`;
    case "touchdown":
      return [
        // unrated (slewed down): "nicht bewertbar", never "0 fpm"
        t("shell.flightEvent.touchdown", { rate: rateText(e), g: fmt(e.peakG, 2, "g") }),
        e.bounces ? t("count.bounces", { count: e.bounces }) : null,
        e.touchAndGo ? t("shell.landing.touchAndGo") : null,
      ]
        .filter(Boolean)
        .join(", ");
    case "touchdownOutcome":
      return e.outcome === "fullStop" ? t("shell.flightEvent.fullStop") : e.outcome === "touchAndGo" ? t("shell.landing.touchAndGo") : null;
  }
}

/** Event-log lines a `flightEnded` writes; a following `flightDiscarded` replaces them. */
export const isFlightEndedLine = (text: string): boolean => text === t("shell.flightEvent.saved") || text === t("shell.flightEvent.interrupted");

/** End times (`timestampMs`) of discarded ground sessions seen in this window (newest last). */
const discardedEnds: number[] = [];
const DISCARDED_KEEP = 16;

/** A `flightDiscarded` arrived: its `flightEnded` (same timestamp) saved no flight. */
export function noteDiscarded(timestampMs: number) {
  if (!discardedEnds.includes(timestampMs)) discardedEnds.push(timestampMs);
  if (discardedEnds.length > DISCARDED_KEEP) discardedEnds.splice(0, discardedEnds.length - DISCARDED_KEEP);
}

/** The `flightEnded` at this time ended a ground session: no "Flug gespeichert", no after-flight card. */
export const wasDiscarded = (timestampMs: number): boolean => discardedEnds.includes(timestampMs);

export function resetFlightEventsForTests() {
  discardedEnds.length = 0;
}

/** In-app notice for a discarded ground session (the Windows notification comes from the backend). */
export function discardedToast(durationMs: number): ToastOptions {
  return {
    id: "flight-discarded",
    tone: "info",
    title: t("shell.flightDiscarded"),
    durationMs,
    holdWhileUnfocused: true,
  };
}
