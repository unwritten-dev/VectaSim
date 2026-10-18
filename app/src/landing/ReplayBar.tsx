import { useEffect, useMemo, type KeyboardEvent } from "react";
import { NNBSP, fmt, fmtClock, fmtNum, fmtSigned } from "../format";
import { sideLabel } from "./geometry";
import { REPLAY_SPEEDS, sampleAt, useReplay, useReplayCursor, useReplayStore, type ReplayStore } from "./replayStore";
import type { ApproachAnalysis } from "./approachTypes";
import type { LandingAnalysis } from "./types";

/**
 * 2D playback of the debrief: play/pause, speed, a slider over the range, the cursor time
 * (hh:mm:ssz) and jump targets. Runs on requestAnimationFrame with real time × speed; never
 * starts by itself. Keys (focus in the bar): Space play/pause, ←/→ ±1 s (Shift ±10 s),
 * Home/End to the range edges.
 */

const clock = (t: number) => fmtClock(t, { seconds: true, local: false });

/** Runs the playback while `playing`: one store.advance per animation frame. */
function usePlaybackLoop(store: ReplayStore, playing: boolean) {
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      // a hidden window throttles rAF: never jump more than half a second at once
      store.advance(Math.min(500, Math.max(0, now - last)));
      last = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [store, playing]);
}

/** Shared keyboard model of the bar (and of anything that wants the same keys). */
export function replayKey(store: ReplayStore, e: KeyboardEvent): boolean {
  switch (e.key) {
    case " ":
    case "Spacebar":
      store.toggle();
      return true;
    case "ArrowLeft":
    case "ArrowDown":
      store.step(e.shiftKey ? -10 : -1);
      return true;
    case "ArrowRight":
    case "ArrowUp":
      store.step(e.shiftKey ? 10 : 1);
      return true;
    case "Home":
      store.toStart();
      return true;
    case "End":
      store.toEnd();
      return true;
    default:
      return false;
  }
}

export default function ReplayBar() {
  const store = useReplayStore();
  const { tMs, playing, speed, range, markers } = useReplay(store);
  usePlaybackLoop(store, playing);

  if (!range) return null;
  const t = tMs ?? range.startMs;
  const dur = range.endMs - range.startMs;
  const atMarker = markers.reduce<string | null>((k, m) => (Math.abs(m.tMs - t) < 500 ? m.key : k), null);
  const elapsedS = Math.round((t - range.startMs) / 1000);
  const elapsed = `${Math.floor(elapsedS / 60)}:${String(elapsedS % 60).padStart(2, "0")}`;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // buttons and the speed group keep their own Space/arrow behaviour
    const el = e.target as HTMLElement;
    if (el.tagName === "BUTTON" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (replayKey(store, e)) e.preventDefault();
  };

  return (
    <div className="replay" role="group" aria-label="Wiedergabe des Anflugs" onKeyDown={onKey}>
      <div className="replay-row">
        <button className="btn-sm replay-step" onClick={() => store.step(-1)} aria-label="Eine Sekunde zurück" title="1 s zurück (←, Shift: 10 s)">
          −1{NNBSP}s
        </button>
        <button className="btn-sm replay-play" onClick={() => store.toggle()} aria-label={playing ? "Pause" : "Wiedergabe starten"} aria-pressed={playing} title="Wiedergabe / Pause (Leertaste)">
          <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        </button>
        <button className="btn-sm replay-step" onClick={() => store.step(1)} aria-label="Eine Sekunde vor" title="1 s vor (→, Shift: 10 s)">
          +1{NNBSP}s
        </button>
        <span className="segmented replay-speed" role="radiogroup" aria-label="Wiedergabegeschwindigkeit">
          {REPLAY_SPEEDS.map((s) => (
            <button key={s} role="radio" aria-checked={speed === s} className={speed === s ? "active" : ""} onClick={() => store.setSpeed(s)} aria-label={`${s}-fache Geschwindigkeit`}>
              {s}×
            </button>
          ))}
        </span>
        <input
          type="range"
          className="replay-slider"
          min={0}
          max={dur}
          step={100}
          value={Math.round(t - range.startMs)}
          onChange={(e) => store.setCursor(range.startMs + Number(e.currentTarget.value))}
          aria-label="Zeitpunkt im Anflug"
          aria-valuetext={`${clock(t)}, ${elapsed} min nach Beginn${atMarker ? `, ${markers.find((m) => m.key === atMarker)?.label}` : ""}`}
        />
        <span className="replay-time num" aria-hidden="true">
          {clock(t)}
        </span>
      </div>
      {markers.length > 0 && (
        <div className="replay-marks" role="group" aria-label="Springen zu">
          <span className="detail">Springen:</span>
          {markers.map((m) => (
            <button
              key={m.key}
              className={`btn-sm replay-mark${atMarker === m.key ? " active" : ""}`}
              onClick={() => store.jumpTo(m)}
              aria-label={`Zu ${m.label} springen (${clock(m.tMs)})`}
              title={clock(m.tMs)}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const M_PER_NM = 1852;

function distText(m: number): string {
  return Math.abs(m) >= M_PER_NM ? fmt(Math.abs(m) / M_PER_NM, 1, "nm") : fmt(Math.abs(m), 0, "m");
}

function gearText(pct: number): string {
  return pct >= 95 ? "ausgefahren" : pct <= 5 ? "eingefahren" : `${fmtNum(pct)}${NNBSP}%`;
}

export interface CursorValues {
  tMs: number;
  hatFt: number;
  iasKt: number;
  iasDevKt: number | null;
  vsFpm: number;
  groundSpeedKt: number;
  bankDeg: number;
  gearPct: number;
  flapsIndex: number;
  xM: number | null;
  yM: number | null;
  onGround: boolean;
}

/**
 * Values at the cursor: from the approach profile while it covers the time (it carries the
 * deviations), else from the landing's track (rollout to the standstill). Null outside both.
 */
export function cursorValues(a: LandingAnalysis | null, apr: ApproachAnalysis | null, tMs: number | null): CursorValues | null {
  if (tMs == null) return null;
  const ref = apr?.reference.vappKt ?? a?.referenceSpeedKt ?? null;
  const p = apr ? sampleAt(apr.samples, tMs) : null;
  const s = p ?? (a ? sampleAt(a.samples, tMs) : null);
  if (!s) return null;
  const dev = p && p.iasDevKt != null ? p.iasDevKt : ref != null ? s.iasKt - ref : null;
  return {
    tMs,
    hatFt: s.hatFt,
    iasKt: s.iasKt,
    iasDevKt: s.onGround ? null : dev,
    vsFpm: s.vsFpm,
    groundSpeedKt: s.groundSpeedKt,
    bankDeg: s.bankDeg,
    gearPct: s.gearPct,
    flapsIndex: s.flapsIndex,
    xM: s.xM ?? null,
    yM: s.yM ?? null,
    onGround: s.onGround,
  };
}

/** Small strip beside the bar: the measured values at the cursor. */
export function ReplayValues({ analysis, approach }: { analysis: LandingAnalysis | null; approach: ApproachAnalysis | null }) {
  const tMs = useReplayCursor();
  const v = useMemo(() => cursorValues(analysis, approach, tMs), [analysis, approach, tMs]);
  const withRunway = (approach?.runway ?? analysis?.runway) != null;
  const rows: Array<[string, string]> = v
    ? [
        ["HAT", v.onGround ? "am Boden" : fmt(v.hatFt, 0, "ft")],
        ["IAS", `${fmt(v.iasKt, 0, "kt")}${v.iasDevKt != null ? ` (${fmtSigned(Math.round(v.iasDevKt), 0, "kt")})` : ""}`],
        ["V/S", fmtSigned(Math.round(v.vsFpm / 10) * 10, 0, "fpm")],
        ["GS", fmt(v.groundSpeedKt, 0, "kt")],
        ["Bank", `${fmt(Math.abs(v.bankDeg), 0, "°")}${Math.abs(v.bankDeg) >= 0.5 ? (v.bankDeg > 0 ? " R" : " L") : ""}`],
        ["Fahrwerk / Klappen", `${gearText(v.gearPct)} · ${fmtNum(Math.round(v.flapsIndex))}`],
        ["Schwelle (x)", !withRunway || v.xM == null ? "–" : `${distText(v.xM)} ${v.xM < 0 ? "davor" : "dahinter"}`],
        ["Querablage (y)", !withRunway || v.yM == null ? "–" : sideLabel(v.yM)],
      ]
    : [];
  return (
    <div className="replay-values" role="group" aria-label="Werte am Cursor">
      {v ? (
        <dl>
          {rows.map(([k, val]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{val}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="detail">Kein Zeitpunkt gewählt – im Diagramm zeigen oder ▶ drücken.</p>
      )}
      <p className="detail replay-source">gemessen (1{NNBSP}Hz, interpoliert)</p>
    </div>
  );
}
