import { useEffect, useMemo, type KeyboardEvent } from "react";
import { NNBSP, fmt, fmtClock, fmtNum, fmtSigned } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import { sideLabel } from "./geometry";
import { sampleAt, useReplay, useReplayCursor, useReplayStore, type ReplayStore } from "./replayStore";
import type { ApproachAnalysis } from "./approachTypes";
import type { LandingAnalysis } from "./types";
import { Segmented } from "../ui/Segmented";

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
  const tr = useT();
  const store = useReplayStore();
  const { tMs, playing, speed, range, markers } = useReplay(store);
  usePlaybackLoop(store, playing);

  if (!range) return null;
  const t = tMs ?? range.startMs;
  const dur = range.endMs - range.startMs;
  const atMarker = markers.reduce<string | null>((k, m) => (Math.abs(m.tMs - t) < 500 ? m.key : k), null);
  const atLabel = atMarker ? markers.find((m) => m.key === atMarker)?.label : undefined;
  const elapsedS = Math.round((t - range.startMs) / 1000);
  const elapsed = `${Math.floor(elapsedS / 60)}:${String(elapsedS % 60).padStart(2, "0")}`;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // buttons and the speed group keep their own Space/arrow behaviour
    const el = e.target as HTMLElement;
    if (el.tagName === "BUTTON" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (replayKey(store, e)) e.preventDefault();
  };

  return (
    <div className="replay" role="group" aria-label={tr("replay.aria")} onKeyDown={onKey}>
      <div className="replay-row">
        <button className="btn-sm replay-step" onClick={() => store.step(-1)} aria-label={tr("replay.back")} title={tr("replay.backTitle")}>
          −1{NNBSP}s
        </button>
        <button className="btn-sm replay-play" onClick={() => store.toggle()} aria-label={playing ? tr("replay.pause") : tr("replay.play")} title={tr("replay.playTitle")}>
          <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        </button>
        <button className="btn-sm replay-step" onClick={() => store.step(1)} aria-label={tr("replay.forward")} title={tr("replay.forwardTitle")}>
          +1{NNBSP}s
        </button>
        <Segmented
          inline
          className="replay-speed"
          aria-label={tr("replay.speed")}
          options={store.speeds.map((s) => ({ value: s, label: `${s}×`, ariaLabel: tr("replay.speedOption", { speed: s }) }))}
          value={speed}
          onChange={(s) => store.setSpeed(s)}
        />
        <input
          type="range"
          className="replay-slider"
          min={0}
          max={dur}
          step={100}
          value={Math.round(t - range.startMs)}
          onChange={(e) => store.setCursor(range.startMs + Number(e.currentTarget.value))}
          aria-label={tr("replay.slider")}
          aria-valuetext={atLabel ? tr("replay.sliderValueMarker", { clock: clock(t), elapsed, marker: atLabel }) : tr("replay.sliderValue", { clock: clock(t), elapsed })}
        />
        <span className="replay-time num" aria-hidden="true">
          {clock(t)}
        </span>
      </div>
      {markers.length > 0 && (
        <div className="replay-marks" role="group" aria-label={tr("replay.jumpGroup")}>
          <span className="detail">{tr("replay.jump")}</span>
          {markers.map((m) => (
            <button
              key={m.key}
              className={`btn-sm replay-mark${atMarker === m.key ? " active" : ""}`}
              onClick={() => store.jumpTo(m)}
              aria-label={tr("replay.jumpTo", { label: m.label, clock: clock(m.tMs) })}
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

function gearText(t: TFunction, pct: number): string {
  return pct >= 95 ? t("replay.gearDown") : pct <= 5 ? t("replay.gearUp") : `${fmtNum(pct)}${NNBSP}%`;
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
  const t = useT();
  const tMs = useReplayCursor();
  const v = useMemo(() => cursorValues(analysis, approach, tMs), [analysis, approach, tMs]);
  const withRunway = (approach?.runway ?? analysis?.runway) != null;
  const rows: Array<[string, string]> = v
    ? [
        ["HAT", v.onGround ? t("replay.onGround") : fmt(v.hatFt, 0, "ft")],
        ["IAS", `${fmt(v.iasKt, 0, "kt")}${v.iasDevKt != null ? ` (${fmtSigned(Math.round(v.iasDevKt), 0, "kt")})` : ""}`],
        ["V/S", fmtSigned(Math.round(v.vsFpm / 10) * 10, 0, "fpm")],
        ["GS", fmt(v.groundSpeedKt, 0, "kt")],
        [t("replay.row.bank"), `${fmt(Math.abs(v.bankDeg), 0, "°")}${Math.abs(v.bankDeg) >= 0.5 ? (v.bankDeg > 0 ? " R" : " L") : ""}`],
        [t("replay.row.gearFlaps"), `${gearText(t, v.gearPct)} · ${fmtNum(Math.round(v.flapsIndex))}`],
        [t("replay.row.threshold"), !withRunway || v.xM == null ? "–" : t(v.xM < 0 ? "replay.before" : "replay.past", { distance: distText(v.xM) })],
        [t("replay.row.lateral"), !withRunway || v.yM == null ? "–" : sideLabel(v.yM)],
      ]
    : [];
  return (
    <div className="replay-values" role="group" aria-label={t("replay.valuesAria")}>
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
        <p className="detail">{t("replay.noCursor")}</p>
      )}
      <p className="detail replay-source">{t("replay.source")}</p>
    </div>
  );
}
