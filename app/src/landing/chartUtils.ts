// Small helpers shared by the hand-written SVG charts of the debrief.

import { useEffect, useState } from "react";

export function niceStep(range: number, count: number): number {
  if (range <= 0) return 1;
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

export function ticks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Width of the wrapping element (for the hand-written SVG), min. 360 px. */
export function useWidth(initial = 900): [(el: HTMLDivElement | null) => void, number] {
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!wrap) return;
    const measure = () => setWidth(Math.max(360, Math.floor(wrap.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);
  return [setWrap, width];
}
