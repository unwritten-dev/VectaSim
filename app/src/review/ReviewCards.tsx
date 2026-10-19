// Jahresrückblick: the seven story cards (plus the optional eighth, „Mit Sternchen“) as fixed SVGs – 1080×1920 (Story) or 1200×675
// (16:9) – rasterised to PNG by exportReview.ts and shown 1:1 as previews in the view.
// Like the landing card (landing/LandingCard.tsx) every colour is a concrete value of the
// active theme (`CardTheme`, readCardTheme) and the fonts come in as `fontCss`, because an
// SVG drawn as <img> sees neither CSS variables nor @font-face rules.
//
// Brand rules (docs/brand/README.md): no gradients or shadows; the lockup sits small at the
// bottom; the year at the top; one big number per card. Band colours are the theme's
// --band-* scale (approach bands use the same scale, themes.ts --aband-*).

import type { ReactNode } from "react";
import { maskRegistration } from "../format";
import { LOCALE, useLanguage, useT, type Language, type TFunction } from "../i18n";
import { NNBSP, fmt, fmtDate, fmtNum } from "../i18n/number";
import { LogoLockup } from "../ui/Logo";
import { shapePath } from "../landing/BandMark";
import { BAND_SHAPE, type BandShape } from "../landing/facts";
import type { CardTheme } from "../landing/LandingCard";
import type { Band } from "../landing/types";
import { WORLD, countryPaths, fitView, greatCircle, linePath, projector, type Box } from "./geo";
import { monthName, monthShort, periodLabel, type LonLat, type YearReview } from "./stats";
import {
  CARDS,
  FORMAT_SIZE,
  cardTitle,
  approachesWord,
  clip,
  earthText,
  flightsLabel,
  hoursNum,
  hoursText,
  landingsWord,
  percentNum,
  type CardFormat,
  type CardId,
} from "./text";

export interface CardProps {
  id: CardId;
  format: CardFormat;
  review: YearReview;
  colors: CardTheme;
  /** @font-face rules of the theme fonts (export); null in the app and in tests. */
  fontCss?: string | null;
  /** Registrations masked (Streamer-Modus / „Landekarte ohne Kennzeichen“). */
  hideReg?: boolean;
  /** Natural Earth outlines (`countries_geojson`); without them the maps show only the lines. */
  outlines?: GeoJSON.FeatureCollection | null;
  /** iso2 → country name in the UI language (`countries_list`). */
  countryNames?: Map<string, string>;
  /** Prefix of the SVG ids (clip paths), unique per card on a page. */
  idPrefix?: string;
}

const BANDS: Band[] = ["smooth", "normal", "firm", "hard"];
/** Legend columns of the approach bands (share of the width; „mit Abweichungen“ is long). */
const LEGEND_AT = [0, 0.27, 0.72];

interface Layout {
  W: number;
  H: number;
  M: number;
  portrait: boolean;
  /** Font scale of everything below the hero. */
  s: number;
  hero: Box;
  vis: Box;
}

const LAYOUT: Record<CardFormat, Layout> = {
  portrait: { W: 1080, H: 1920, M: 96, portrait: true, s: 1, hero: { x: 96, y: 470, w: 888, h: 420 }, vis: { x: 96, y: 930, w: 888, h: 760 } },
  landscape: { W: 1200, H: 675, M: 56, portrait: false, s: 0.6, hero: { x: 56, y: 140, w: 430, h: 430 }, vis: { x: 530, y: 150, w: 614, h: 420 } },
};

const bandColor = (t: CardTheme, b: Band) => ({ smooth: t.bandSoft, normal: t.bandNormal, firm: t.bandFirm, hard: t.bandHard })[b];
const px = (v: string, fallback: number) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Words wrapped to lines of at most `n` characters, at most `lines` lines (the last one clipped). */
export function wrapText(text: string, n: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if (`${cur} ${w}`.length <= n) cur = `${cur} ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = clip(`${kept[lines - 1]} ${out.slice(lines).join(" ")}`, n);
    return kept;
  }
  return out;
}

/** Font size so `text` fits `width` (digits ≈ 0.6 em, letters a little wider). */
const fitSize = (text: string, width: number, max: number, em = 0.62) => Math.min(max, width / Math.max(1, text.length * em));

function Mark({ shape, x, y, r, fill, hollow }: { shape: BandShape; x: number; y: number; r: number; fill: string; hollow?: boolean }) {
  const style = hollow ? { fill: "none", stroke: fill, strokeWidth: Math.max(1.5, r / 3) } : { fill };
  if (shape === "circle") return <circle cx={x} cy={y} r={r} style={style} />;
  return <path d={shapePath(shape, x, y, r)} style={style} />;
}

// ---- building blocks ----------------------------------------------------------------------

interface Ctx {
  t: CardTheme;
  L: Layout;
  sans: { fontFamily: string };
  num: { fontFamily: string };
  ls: string;
  r: number;
  id: string;
  /** Translate in the card's language. */
  tr: TFunction;
  lang: Language;
}

/** Big number with unit, label and an optional second line. */
function Hero({ c, value, unit, label, sub, text = false }: { c: Ctx; value: string; unit?: string; label: string; sub?: string; text?: boolean }) {
  const { t, L } = c;
  const big = L.portrait ? 250 : 124;
  const unitFs = L.portrait ? 64 : 32;
  const room = L.hero.w - (unit ? unit.length * unitFs * 0.62 + unitFs * 0.4 : 0);
  const fs = fitSize(value, room, big, text ? 0.66 : 0.6);
  const base = L.hero.y + (L.portrait ? 250 : 200);
  return (
    <g>
      <text x={L.hero.x - fs * 0.04} y={base} fill={t.text} fontSize={fs} fontWeight={700} style={text ? c.sans : c.num} letterSpacing="-0.02em">
        {value}
        {unit && (
          <tspan fill={t.accent} fontSize={unitFs} fontWeight={600} dx={unitFs * 0.3} style={c.sans}>
            {unit}
          </tspan>
        )}
      </text>
      <text x={L.hero.x} y={base + (L.portrait ? 90 : 46)} fill={t.text} fontSize={L.portrait ? 50 : 26} fontWeight={600} style={c.sans}>
        {clip(label, L.portrait ? 32 : 30)}
      </text>
      {sub && (
        <text x={L.hero.x} y={base + (L.portrait ? 150 : 80)} fill={t.textMuted} fontSize={L.portrait ? 36 : 19} style={c.sans}>
          {clip(sub, L.portrait ? 46 : 42)}
        </text>
      )}
    </g>
  );
}

/** Caps label as used above panels. */
function Caps({ c, x, y, children, anchor, color }: { c: Ctx; x: number; y: number; children: ReactNode; anchor?: "start" | "end" | "middle"; color?: string }) {
  return (
    <text x={x} y={y} fill={color ?? c.t.textMuted} fontSize={26 * c.L.s} fontWeight={600} letterSpacing={c.ls} textAnchor={anchor} style={c.sans}>
      {children}
    </text>
  );
}

/** Panel with label, value and sub line. */
function Tile({ c, box, label, value, unit, sub }: { c: Ctx; box: Box; label: string; value: string; unit?: string; sub?: string }) {
  const { t, L } = c;
  const s = L.s;
  const pad = 28 * s;
  const vfs = Math.min(fitSize(value, box.w - pad * 2 - (unit ? unit.length * 34 * s : 0), 92 * s), (box.h - pad * 2 - (22 + 26 + 28 + 18) * s) / 0.9);
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={c.r} fill={t.surface1} stroke={t.border} strokeWidth={1} />
      <Caps c={c} x={box.x + pad} y={box.y + pad + 22 * s}>
        {label.toUpperCase()}
      </Caps>
      <text x={box.x + pad} y={box.y + pad + 22 * s + 26 * s + vfs * 0.9} fill={t.text} fontSize={vfs} fontWeight={650} style={c.num}>
        {value}
        {unit && (
          <tspan fill={t.textMuted} fontSize={36 * s} fontWeight={500} dx={10 * s} style={c.sans}>
            {unit}
          </tspan>
        )}
      </text>
      {sub && (
        <text x={box.x + pad} y={box.y + box.h - pad} fill={t.textMuted} fontSize={28 * s} style={c.sans}>
          {clip(sub, Math.floor(box.w / (15 * s)))}
        </text>
      )}
    </g>
  );
}

/** Horizontal stacked bar of counts (no gradient: solid segments with a 2 px gap). */
function StackBar({ c, box, parts }: { c: Ctx; box: Box; parts: Array<{ n: number; color: string }> }) {
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (!total) return <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={box.h / 4} fill={c.t.surface2} />;
  let x = box.x;
  const gap = 3 * c.L.s;
  const shown = parts.filter((p) => p.n > 0);
  const w = box.w - gap * (shown.length - 1);
  return (
    <g>
      {shown.map((p, i) => {
        const pw = (p.n / total) * w;
        const r = <rect key={i} x={x} y={box.y} width={Math.max(2, pw)} height={box.h} rx={Math.min(box.h / 4, pw / 2)} fill={p.color} />;
        x += pw + gap;
        return r;
      })}
    </g>
  );
}

function Empty({ c, text }: { c: Ctx; text: string }) {
  const { L, t } = c;
  const lines = wrapText(text, L.portrait ? 40 : 46, 4);
  return (
    <g>
      <rect x={L.vis.x} y={L.vis.y} width={L.vis.w} height={L.portrait ? 300 : 180} rx={c.r} fill={t.surface1} stroke={t.border} strokeWidth={1} />
      {lines.map((l, i) => (
        <text key={i} x={L.vis.x + 40 * L.s} y={L.vis.y + (70 + i * 50) * L.s} fill={t.textMuted} fontSize={36 * L.s} style={c.sans}>
          {l}
        </text>
      ))}
    </g>
  );
}

/** Mini world map: outlines plus the year's great circles and airports, or country fills. */
function WorldMap({
  c,
  box,
  outlines,
  legs,
  fill,
  points,
}: {
  c: Ctx;
  box: Box;
  outlines: GeoJSON.FeatureCollection | null | undefined;
  legs?: YearReview["legs"];
  /** Country fill by iso2 (countries card). */
  fill?: (iso2: string) => string | null;
  points?: LonLat[];
}) {
  const { t, L } = c;
  const all: LonLat[] = legs ? legs.flatMap((l) => [l.from, l.to]) : [];
  const view = legs ? fitView(all) : WORLD;
  const { px: proj } = projector(view, box);
  const shapes = countryPaths(outlines, view, box);
  const clipId = `${c.id}-map`;
  const maxN = Math.max(1, ...(legs ?? []).map((l) => l.flights));
  const airports = new Map<string, LonLat>();
  for (const l of legs ?? []) {
    airports.set(l.dep, l.from);
    airports.set(l.arr, l.to);
  }
  return (
    <g>
      <defs>
        <clipPath id={clipId}>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={c.r} />
        </clipPath>
      </defs>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={c.r} fill={t.surface1} />
      <g clipPath={`url(#${clipId})`}>
        {shapes.map((s, i) => {
          const f = fill?.(s.iso2) ?? null;
          return <path key={i} d={s.d} fill={f ?? t.surface3} stroke={t.bg} strokeWidth={Math.max(0.6, 1 * L.s)} strokeLinejoin="round" />;
        })}
        {(legs ?? []).map((l, i) => (
          <path
            key={`l${i}`}
            d={linePath(greatCircle(l.from, l.to).map(proj))}
            fill="none"
            stroke={t.accent}
            strokeWidth={(2.4 + 3 * (l.flights / maxN)) * L.s}
            strokeLinecap="round"
            strokeOpacity={0.9}
          />
        ))}
        {[...airports.values(), ...(points ?? [])].map((p, i) => {
          const [x, y] = proj(p);
          return <circle key={`a${i}`} cx={x} cy={y} r={5 * L.s} fill={t.text} stroke={t.bg} strokeWidth={2 * L.s} />;
        })}
      </g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={c.r} fill="none" stroke={t.border} strokeWidth={1} />
    </g>
  );
}

// ---- the cards --------------------------------------------------------------------------

function Overview({ c, r }: { c: Ctx; r: YearReview }) {
  const { L, tr, lang } = c;
  const v = L.vis;
  const gap = 24 * L.s;
  const tw = (v.w - gap) / 2;
  const th = L.portrait ? 330 : (v.h - gap) / 2;
  const cell = (i: number): Box => ({ x: v.x + (i % 2) * (tw + gap), y: v.y + Math.floor(i / 2) * (th + gap), w: tw, h: th });
  const newC = r.newCountries;
  return (
    <>
      <Hero
        c={c}
        value={fmtNum(r.flights, 0, lang)}
        label={tr("review.overview.flights", { count: r.flights })}
        sub={r.imported ? tr("review.overview.imported", { n: r.imported }) : tr("review.overview.routes", { count: r.routeCount })}
      />
      <Tile
        c={c}
        box={cell(0)}
        label={tr("review.overview.blockHours")}
        value={hoursNum(r.blockMs, lang)}
        unit="h"
        sub={r.flights ? tr("review.overview.perFlight", { time: hoursText(r.blockMs / r.flights, lang) }) : undefined}
      />
      <Tile c={c} box={cell(1)} label={tr("review.overview.distance")} value={fmtNum(Math.round(r.distanceNm), 0, lang)} unit="nm" sub={earthText(r.earthLaps, lang)} />
      <Tile
        c={c}
        box={cell(2)}
        label={tr("review.overview.countries")}
        value={fmtNum(r.countries.length, 0, lang)}
        sub={newC ? tr("review.overview.newCountries", { n: newC }) : tr("review.overview.noNewCountries")}
      />
      <Tile c={c} box={cell(3)} label={tr("review.overview.airports")} value={fmtNum(r.airports, 0, lang)} sub={tr("review.overview.airportsSub")} />
    </>
  );
}

function Routes({ c, r, outlines }: { c: Ctx; r: YearReview; outlines: CardProps["outlines"] }) {
  const { L, t, tr, lang } = c;
  const v = L.vis;
  const lg = r.longest;
  const mapH = L.portrait ? 420 : 210;
  const rowH = L.portrait ? 62 : 38;
  const top = v.y + mapH + (L.portrait ? 110 : 56);
  return (
    <>
      <Hero
        c={c}
        value={lg ? fmtNum(Math.round(lg.distanceNm), 0, lang) : "–"}
        unit={lg ? "nm" : undefined}
        label={tr("review.routes.longest")}
        sub={
          lg
            ? [lg.dep && lg.arr ? `${lg.dep} → ${lg.arr}` : null, fmtDate(lg.ms, { lang }), lg.blockMs ? hoursText(lg.blockMs, lang) : null].filter(Boolean).join(" · ")
            : tr("review.routes.noRoute")
        }
      />
      <WorldMap c={c} box={{ x: v.x, y: v.y, w: v.w, h: mapH }} outlines={outlines} legs={r.legs} />
      <Caps c={c} x={v.x} y={top - rowH * 0.55}>
        {(r.routes.length ? tr("review.routes.top", { n: Math.min(5, r.routes.length) }) : tr("review.routes.topNone")).toLocaleUpperCase(LOCALE[lang])}
      </Caps>
      {r.routes.length === 0 && (
        <text x={v.x} y={top + rowH * 0.4} fill={t.textMuted} fontSize={32 * L.s} style={c.sans}>
          {tr("review.routes.none")}
        </text>
      )}
      {r.routes.map((x, i) => {
        const y = top + i * rowH + rowH * 0.4;
        return (
          <g key={i}>
            <text x={v.x} y={y} fill={t.textFaint} fontSize={34 * L.s} fontWeight={600} style={c.num}>
              {i + 1}
            </text>
            <text x={v.x + 50 * L.s} y={y} fill={t.text} fontSize={38 * L.s} fontWeight={600} style={c.num}>
              {x.dep}
              <tspan fill={t.textMuted}>{" → "}</tspan>
              {x.arr}
            </text>
            <text x={v.x + v.w} y={y} fill={t.textMuted} fontSize={30 * L.s} textAnchor="end" style={c.sans}>
              {`${flightsLabel(x.flights, lang)} · ${fmt(Math.round(x.distanceNm), 0, "nm", lang)}`}
            </text>
          </g>
        );
      })}
    </>
  );
}

function FleetList({ c, box, title, rows, hideReg }: { c: Ctx; box: Box; title: string; rows: YearReview["types"]; hideReg: boolean }) {
  const { t, L, tr, lang } = c;
  const rowH = L.portrait ? 64 : 92;
  const max = Math.max(1, ...rows.map((x) => x.blockMs));
  return (
    <g>
      <Caps c={c} x={box.x} y={box.y + 26 * L.s}>
        {title}
      </Caps>
      {rows.length === 0 && (
        <text x={box.x} y={box.y + 90 * L.s} fill={t.textMuted} fontSize={30 * L.s} style={c.sans}>
          {tr("review.fleet.noEntry")}
        </text>
      )}
      {rows.map((x, i) => {
        const y = box.y + (60 + i * rowH) * L.s + 30 * L.s;
        const name = x.registration ? (hideReg ? maskRegistration(x.registration) : x.registration) : x.key;
        const right = hoursText(x.blockMs, lang);
        const barW = ((box.w * 0.62) * x.blockMs) / max;
        return (
          <g key={i}>
            <text x={box.x} y={y} fill={t.text} fontSize={36 * L.s} fontWeight={600} style={c.num}>
              {clip(name, L.portrait ? 12 : 9)}
              {x.registration && x.detail && (
                <tspan fill={t.textMuted} fontWeight={400} fontSize={28 * L.s} dx={14 * L.s} style={c.sans}>
                  {clip(x.detail, 8)}
                </tspan>
              )}
            </text>
            <text x={box.x + box.w} y={y} fill={t.textMuted} fontSize={30 * L.s} textAnchor="end" style={c.sans}>
              {right}
            </text>
            <rect x={box.x} y={y + 12 * L.s} width={Math.max(4, barW)} height={8 * L.s} rx={4 * L.s} fill={i === 0 ? t.accent : t.textFaint} />
          </g>
        );
      })}
    </g>
  );
}

function Fleet({ c, r, hideReg }: { c: Ctx; r: YearReview; hideReg: boolean }) {
  const { L, tr, lang } = c;
  const v = L.vis;
  const top = r.types[0];
  const half = L.portrait ? { a: { ...v, h: v.h / 2 - 10 }, b: { ...v, y: v.y + v.h / 2 + 10, h: v.h / 2 - 10 } } : { a: { ...v, w: v.w / 2 - 18 }, b: { ...v, x: v.x + v.w / 2 + 18, w: v.w / 2 - 18 } };
  return (
    <>
      <Hero
        c={c}
        value={top ? top.key : "–"}
        text
        label={top ? `${hoursText(top.blockMs, lang)} · ${flightsLabel(top.flights, lang)}` : tr("review.fleet.noType")}
        sub={top && !hideReg && top.detail ? top.detail : tr("review.fleet.mostFlown")}
      />
      <FleetList c={c} box={half.a} title={tr("review.fleet.types").toLocaleUpperCase(LOCALE[lang])} rows={r.types} hideReg={hideReg} />
      <FleetList c={c} box={half.b} title={tr("review.fleet.registrations").toLocaleUpperCase(LOCALE[lang])} rows={r.registrations} hideReg={hideReg} />
    </>
  );
}

/** The year's Streubild: normalised 3000 m runway seen from above, points by band. */
function Scatter({ c, box, r }: { c: Ctx; box: Box; r: YearReview }) {
  const { t, L, tr, lang } = c;
  const X0 = -150;
  const X1 = 3000;
  const Y = 15;
  const pad = 16 * L.s;
  const rw = { x: box.x + pad, y: box.y + box.h * 0.2, w: box.w - pad * 2, h: box.h * 0.6 };
  const sx = (m: number) => rw.x + ((Math.max(X0, Math.min(X1, m)) - X0) / (X1 - X0)) * rw.w;
  const sy = (m: number) => rw.y + rw.h / 2 + (Math.max(-Y, Math.min(Y, m)) / Y) * (rw.h / 2);
  const thr = sx(0);
  const stripes = 8;
  const pts = r.landings.points;
  const rr = (pts.length > 120 ? 6 : pts.length > 40 ? 8 : 10) * L.s;
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={c.r} fill={t.surface1} stroke={t.border} strokeWidth={1} />
      <rect x={thr} y={rw.y} width={sx(X1) - thr} height={rw.h} fill={t.surface3} />
      <rect x={thr} y={rw.y} width={sx(900) - thr} height={rw.h} fill={t.ok} fillOpacity={0.16} />
      {Array.from({ length: stripes }, (_, i) => (
        <rect key={i} x={thr + 6 * L.s} y={rw.y + ((i + 0.5) * rw.h) / stripes - rw.h / stripes / 4} width={30 * L.s} height={rw.h / stripes / 2} fill={t.textFaint} />
      ))}
      <line x1={sx(400)} x2={sx(X1) - 10} y1={rw.y + rw.h / 2} y2={rw.y + rw.h / 2} stroke={t.textFaint} strokeWidth={2 * L.s} strokeDasharray={`${24 * L.s} ${18 * L.s}`} />
      {[400, 900].map((m) => (
        <line key={m} x1={sx(m)} x2={sx(m)} y1={rw.y} y2={rw.y + rw.h} stroke={t.textFaint} strokeWidth={1.5 * L.s} strokeDasharray={`${6 * L.s} ${6 * L.s}`} />
      ))}
      {pts.map((p, i) => (
        <Mark key={i} shape={BAND_SHAPE[p.band]} x={sx(p.x)} y={sy(p.y ?? 0)} r={rr} fill={bandColor(t, p.band)} hollow={p.y == null} />
      ))}
      <text x={thr} y={rw.y - 12 * L.s} fill={t.textMuted} fontSize={22 * L.s} style={c.sans}>
        {tr("review.landings.threshold")}
      </text>
      <text x={sx(900)} y={rw.y - 12 * L.s} fill={t.textMuted} fontSize={22 * L.s} textAnchor="middle" style={c.num}>
        900{NNBSP}m
      </text>
      <text x={sx(X1)} y={rw.y - 12 * L.s} fill={t.textMuted} fontSize={22 * L.s} textAnchor="end" style={c.num}>
        3000{NNBSP}m
      </text>
      <text x={box.x + pad} y={box.y + box.h - 14 * L.s} fill={t.textMuted} fontSize={24 * L.s} style={c.sans}>
        {tr("review.landings.scatter", { rate: r.landings.tdz.total ? `${percentNum(r.landings.tdz.rate, lang)}${NNBSP}%` : "–", count: pts.length })}
      </text>
    </g>
  );
}

function Landings({ c, r }: { c: Ctx; r: YearReview }) {
  const { L, t, tr, lang } = c;
  const v = L.vis;
  const ld = r.landings;
  if (!ld.count) {
    return (
      <>
        <Hero c={c} value="–" label={tr("review.landings.none")} sub={tr("review.landings.inPeriod")} />
        <Empty c={c} text={tr("review.landings.emptyText")} />
      </>
    );
  }
  const s = L.s;
  const barH = 44 * s;
  const legendY = v.y + barH + 52 * s;
  const rowsY = legendY + (L.portrait ? 90 : 62) * s;
  const rowH = 70 * s;
  const scatterY = rowsY + rowH * 2 + 20 * s;
  const pickLine = (p: NonNullable<typeof ld.best>) => [p.airport && p.runway ? `${p.airport} ${p.runway}` : p.airport, fmtDate(p.ms, { lang })].filter(Boolean).join(" · ");
  const colW = v.w / 4;
  return (
    <>
      <Hero c={c} value={fmtNum(Math.round(ld.medianFpm ?? 0), 0, lang)} unit="fpm" label={tr("review.landings.median")} sub={landingsWord(ld.count, lang)} />
      <StackBar c={c} box={{ x: v.x, y: v.y, w: v.w, h: barH }} parts={BANDS.map((b) => ({ n: ld.bands[b], color: bandColor(t, b) }))} />
      {BANDS.map((b, i) => (
        <g key={b}>
          <Mark shape={BAND_SHAPE[b]} x={v.x + i * colW + 12 * s} y={legendY - 10 * s} r={10 * s} fill={bandColor(t, b)} />
          <text x={v.x + i * colW + 32 * s} y={legendY} fill={t.text} fontSize={30 * s} style={c.sans}>
            {tr(`band.${b}`)}
            <tspan fill={t.textMuted} dx={8 * s} style={c.num}>
              {fmtNum(ld.bands[b], 0, lang)}
            </tspan>
          </text>
        </g>
      ))}
      {(
        [
          [tr("review.landings.smoothest"), ld.best],
          [tr("review.landings.hardest"), ld.hardest],
        ] as const
      ).map(([label, p], i) =>
        p ? (
          <g key={label}>
            <text x={v.x} y={rowsY + i * rowH} fill={t.textMuted} fontSize={30 * s} style={c.sans}>
              {label}
            </text>
            <text x={v.x + v.w * 0.3} y={rowsY + i * rowH} fill={t.text} fontSize={40 * s} fontWeight={650} style={c.num}>
              {fmt(Math.round(Math.abs(p.fpm)), 0, "fpm", lang)}
            </text>
            <text x={v.x + v.w} y={rowsY + i * rowH} fill={t.textMuted} fontSize={28 * s} textAnchor="end" style={c.sans}>
              {clip(pickLine(p), L.portrait ? 26 : 22)}
            </text>
          </g>
        ) : null,
      )}
      {ld.points.length > 0 ? (
        <Scatter c={c} box={{ x: v.x, y: scatterY, w: v.w, h: v.y + v.h - scatterY }} r={r} />
      ) : (
        <text x={v.x} y={scatterY + 50 * s} fill={t.textMuted} fontSize={28 * s} style={c.sans}>
          {tr("review.landings.noScatter")}
        </text>
      )}
    </>
  );
}

function Approaches({ c, r }: { c: Ctx; r: YearReview }) {
  const { L, t, tr, lang } = c;
  const v = L.vis;
  const a = r.approaches;
  const s = L.s;
  if (!a.count) {
    return (
      <>
        <Hero c={c} value="–" label={tr("review.approaches.none")} sub={tr("review.approaches.inPeriod")} />
        <Empty c={c} text={tr("review.approaches.emptyText")} />
      </>
    );
  }
  const parts = [
    { n: a.bands.stable, color: t.bandSoft, label: tr("review.approaches.stable") },
    { n: a.bands.deviations, color: t.bandFirm, label: tr("review.approaches.deviations") },
    { n: a.bands.unstable, color: t.bandHard, label: tr("review.approaches.unstable") },
  ];
  const shapes: BandShape[] = ["circle", "diamond", "triangle"];
  const barH = 44 * s;
  const legendY = v.y + barH + 52 * s;
  const gap = 24 * s;
  const tileY = legendY + 60 * s;
  const tiles: Box[] = L.portrait
    ? [
        { x: v.x, y: tileY, w: v.w, h: 250 },
        { x: v.x, y: tileY + 250 + gap, w: v.w, h: 250 },
      ]
    : [
        { x: v.x, y: tileY, w: (v.w - gap) / 2, h: Math.min(200, v.y + v.h - tileY) },
        { x: v.x + (v.w + gap) / 2, y: tileY, w: (v.w - gap) / 2, h: Math.min(200, v.y + v.h - tileY) },
      ];
  return (
    <>
      <Hero
        c={c}
        value={percentNum(a.stableRate, lang)}
        unit="%"
        label={tr("review.approaches.stableRate")}
        sub={a.assessed ? tr("review.approaches.stableOf", { stable: a.stable, count: a.assessed }) : approachesWord(a.count, lang)}
      />
      <StackBar c={c} box={{ x: v.x, y: v.y, w: v.w, h: barH }} parts={parts} />
      {parts.map((p, i) => (
        <g key={p.label}>
          <Mark shape={shapes[i]} x={v.x + LEGEND_AT[i] * v.w + 12 * s} y={legendY - 10 * s} r={10 * s} fill={p.color} />
          <text x={v.x + LEGEND_AT[i] * v.w + 32 * s} y={legendY} fill={t.text} fontSize={28 * s} style={c.sans}>
            {p.label}
            <tspan fill={t.textMuted} dx={8 * s} style={c.num}>
              {fmtNum(p.n, 0, lang)}
            </tspan>
          </text>
        </g>
      ))}
      <Tile
        c={c}
        box={tiles[0]}
        label={tr("review.approaches.stableFrom")}
        value={fmtNum(a.meanStableFromFt == null ? null : Math.round(a.meanStableFromFt / 10) * 10, 0, lang)}
        unit="ft"
        sub={tr("review.approaches.stableFromSub")}
      />
      <Tile
        c={c}
        box={tiles[1]}
        label={tr("review.approaches.goArounds")}
        value={fmtNum(a.goArounds, 0, lang)}
        sub={a.goArounds ? (a.goArounds === 1 ? tr("review.approaches.goAroundOne") : tr("review.approaches.goAroundMany")) : tr("review.approaches.goAroundNone")}
      />
    </>
  );
}

function Months({ c, r }: { c: Ctx; r: YearReview }) {
  const { L, t, tr, lang } = c;
  const v = L.vis;
  const s = L.s;
  const bm = r.busiestMonth != null ? r.months[r.busiestMonth] : null;
  const chartH = L.portrait ? 440 : 250;
  const labelH = 70 * s;
  const max = Math.max(1, ...r.months.map((m) => m.flights));
  const slot = v.w / r.months.length;
  const bw = slot * 0.62;
  const base = v.y + chartH - labelH;
  const day = r.busiestDay;
  return (
    <>
      <Hero
        c={c}
        value={bm ? monthName(bm.month, lang) : "–"}
        text
        label={tr("review.months.busiest")}
        sub={bm ? `${flightsLabel(bm.flights, lang)} · ${hoursText(bm.blockMs, lang)}` : tr("review.months.noFlight")}
      />
      {r.months.map((m, i) => {
        const h = ((chartH - labelH - 50 * s) * m.flights) / max;
        const x = v.x + i * slot + (slot - bw) / 2;
        const top = i === r.busiestMonth;
        return (
          <g key={m.key}>
            <rect x={x} y={base - h} width={bw} height={Math.max(m.flights ? 4 : 2, h)} rx={Math.min(6 * s, bw / 4)} fill={m.flights ? (top ? t.accent : t.textFaint) : t.surface3} />
            {m.flights > 0 && (
              <text x={x + bw / 2} y={base - h - 12 * s} fill={top ? t.text : t.textMuted} fontSize={26 * s} textAnchor="middle" style={c.num}>
                {m.flights}
              </text>
            )}
            <text x={x + bw / 2} y={base + 36 * s} fill={top ? t.text : t.textMuted} fontSize={24 * s} fontWeight={top ? 650 : 400} textAnchor="middle" style={c.sans}>
              {monthShort(m.month, lang).slice(0, L.portrait ? 3 : 1)}
            </text>
            <text x={x + bw / 2} y={base + 64 * s} fill={t.textFaint} fontSize={20 * s} textAnchor="middle" style={c.num}>
              {m.blockMs ? `${Math.round(m.blockMs / 3_600_000)}` : ""}
            </text>
          </g>
        );
      })}
      <line x1={v.x} x2={v.x + v.w} y1={base} y2={base} stroke={t.border} strokeWidth={1} />
      <text x={v.x} y={v.y + chartH + 40 * s} fill={t.textFaint} fontSize={22 * s} style={c.sans}>
        {tr("review.months.legend")}
      </text>
      {day && (
        <Tile
          c={c}
          box={{ x: v.x, y: v.y + chartH + 70 * s, w: v.w, h: v.y + v.h - (v.y + chartH + 70 * s) }}
          label={tr("review.months.busiestDay")}
          value={fmtDate(day.ms, { local: r.period.local, lang })}
          sub={`${flightsLabel(day.flights, lang)} · ${hoursText(day.blockMs, lang)}`}
        />
      )}
    </>
  );
}

function Countries({ c, r, outlines, names }: { c: Ctx; r: YearReview; outlines: CardProps["outlines"]; names?: Map<string, string> }) {
  const { L, t, tr, lang } = c;
  const v = L.vis;
  const s = L.s;
  const mapH = L.portrait ? 470 : 270;
  const state = new Map(r.countries.map((x) => [x.iso2, x.isNew]));
  const fresh = r.countries.filter((x) => x.isNew).map((x) => names?.get(x.iso2) ?? x.iso2);
  const legendY = v.y + mapH + 50 * s;
  const listY = legendY + 64 * s;
  const lines = wrapText(fresh.join(", "), L.portrait ? 52 : 58, L.portrait ? 4 : 2);
  return (
    <>
      <Hero
        c={c}
        value={fmtNum(r.countries.length, 0, lang)}
        label={tr("review.countries.visited", { count: r.countries.length })}
        sub={r.newCountries ? tr("review.countries.newOnes", { n: r.newCountries }) : tr("review.countries.noneNew")}
      />
      <WorldMap c={c} box={{ x: v.x, y: v.y, w: v.w, h: mapH }} outlines={outlines} fill={(iso) => (state.has(iso) ? (state.get(iso) ? t.accent : t.textMuted) : null)} />
      <rect x={v.x} y={legendY - 22 * s} width={26 * s} height={26 * s} rx={4 * s} fill={t.accent} />
      <text x={v.x + 38 * s} y={legendY} fill={t.text} fontSize={28 * s} style={c.sans}>
        {tr("review.countries.firstTime")}
      </text>
      <rect x={v.x + v.w * 0.42} y={legendY - 22 * s} width={26 * s} height={26 * s} rx={4 * s} fill={t.textMuted} />
      <text x={v.x + v.w * 0.42 + 38 * s} y={legendY} fill={t.text} fontSize={28 * s} style={c.sans}>
        {tr("review.countries.again")}
      </text>
      {lines.map((l, i) => (
        <text key={i} x={v.x} y={listY + i * 44 * s} fill={t.textMuted} fontSize={30 * s} style={c.sans}>
          {l}
        </text>
      ))}
    </>
  );
}

/** „Mit Sternchen“: recorded flights with pause, time acceleration, slew or a position jump. */
function Flags({ c, r }: { c: Ctx; r: YearReview }) {
  const { L, t, tr, lang } = c;
  const v = L.vis;
  const s = L.s;
  const fl = r.flags;
  const rowH = L.portrait ? 150 : 88;
  const rows: Array<{ key: "pause" | "timeAccel" | "slew" | "teleport"; n: number; sub: string | null }> = [
    { key: "pause", n: fl.paused, sub: fl.pausedMs > 0 ? tr("review.flags.pausedTotal", { time: hoursText(fl.pausedMs, lang) }) : null },
    { key: "timeAccel", n: fl.timeAccel, sub: fl.timeAccel && fl.maxSimRate > 1 ? tr("review.flags.maxRate", { rate: fmtNum(fl.maxSimRate, fl.maxSimRate < 10 && fl.maxSimRate % 1 ? 1 : 0, lang) }) : null },
    { key: "slew", n: fl.slew, sub: tr("review.flags.slewSub") },
    { key: "teleport", n: fl.teleport, sub: tr("review.flags.teleportSub") },
  ];
  const clean = Math.max(0, fl.recorded - fl.flights);
  const noteY = v.y + rows.length * rowH + (L.portrait ? 50 : 24) * s;
  const note = wrapText(`${tr("review.flags.clean", { count: clean })} · ${tr("review.flags.note")}`, L.portrait ? 46 : 64, L.portrait ? 4 : 3);
  return (
    <>
      <Hero c={c} value={fmtNum(fl.flights, 0, lang)} label={tr("review.flags.flights", { count: fl.flights })} sub={tr("review.flags.of", { count: fl.recorded })} />
      {rows.map((row, i) => {
        const y0 = v.y + i * rowH;
        const w = fl.recorded ? (v.w * row.n) / fl.recorded : 0;
        return (
          <g key={row.key}>
            <text x={v.x} y={y0 + 40 * s} fill={row.n ? t.text : t.textMuted} fontSize={38 * s} fontWeight={600} style={c.sans}>
              {tr(`review.flags.${row.key}`)}
            </text>
            <text x={v.x + v.w} y={y0 + 44 * s} fill={row.n ? t.text : t.textFaint} fontSize={52 * s} fontWeight={650} textAnchor="end" style={c.num}>
              {fmtNum(row.n, 0, lang)}
            </text>
            {row.sub && row.n > 0 && (
              <text x={v.x} y={y0 + 80 * s} fill={t.textMuted} fontSize={28 * s} style={c.sans}>
                {clip(row.sub, L.portrait ? 48 : 56)}
              </text>
            )}
            <rect x={v.x} y={y0 + 100 * s} width={v.w} height={12 * s} rx={6 * s} fill={t.surface2} />
            {row.n > 0 && <rect x={v.x} y={y0 + 100 * s} width={Math.max(12 * s, w)} height={12 * s} rx={6 * s} fill={i === 0 ? t.accent : t.textMuted} />}
          </g>
        );
      })}
      {note.map((l, i) => (
        <text key={i} x={v.x} y={noteY + i * 42 * s} fill={t.textMuted} fontSize={30 * s} style={c.sans}>
          {l}
        </text>
      ))}
    </>
  );
}

/** One story card as SVG. */
export default function ReviewCard({ id, format, review: r, colors: t, fontCss, hideReg = false, outlines, countryNames, idPrefix = "rv" }: CardProps) {
  const tr = useT();
  const lang = useLanguage();
  const L = LAYOUT[format];
  const { w: W, h: H } = FORMAT_SIZE[format];
  const c: Ctx = {
    t,
    L,
    sans: { fontFamily: t.fontSans },
    num: { fontFamily: t.fontNum },
    ls: t.labelLs || "0.14em",
    r: Math.max(4, px(t.radius, 3) * (L.portrait ? 3 : 2)),
    id: `${idPrefix}-${id}-${format}`,
    tr,
    lang,
  };
  // „n / total“ counts the cards shown for this review (the eighth only with flagged flights)
  const shown = visibleCards(r);
  const pos = shown.indexOf(id);
  const idx = pos >= 0 ? pos : CARDS.findIndex((x) => x.id === id);
  const total = pos >= 0 ? shown.length : CARDS.length;
  const title = cardTitle(id, lang);
  const head = tr(r.period.mode === "year" ? "review.head.year" : "review.head.last12").toLocaleUpperCase(LOCALE[lang]);
  const period = periodLabel(r.period, lang);
  const lockH = L.portrait ? 48 : 26;
  const footY = L.portrait ? 1836 : 642;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} · ${period}`}>
      {fontCss && (
        <defs>
          <style>{fontCss}</style>
        </defs>
      )}
      <rect x={0} y={0} width={W} height={H} fill={t.bg} />
      <rect x={0} y={0} width={W} height={L.portrait ? 8 : 4} fill={t.accent} />

      {/* head: period on top, then the card's title */}
      {L.portrait ? (
        <>
          <Caps c={c} x={L.M} y={150}>
            {head}
          </Caps>
          <text x={L.M} y={268} fill={t.text} fontSize={r.period.mode === "year" ? 104 : 72} fontWeight={700} style={r.period.mode === "year" ? c.num : c.sans} letterSpacing="-0.01em">
            {period}
          </text>
          <text x={L.M} y={362} fill={t.accent} fontSize={50} fontWeight={600} style={c.sans}>
            {title}
          </text>
          <text x={W - L.M} y={150} fill={t.textFaint} fontSize={28} textAnchor="end" style={c.num}>
            {`${idx + 1} / ${total}`}
          </text>
        </>
      ) : (
        <>
          <Caps c={c} x={L.M} y={62}>
            {`${head} ${period.toLocaleUpperCase(LOCALE[lang])}`}
          </Caps>
          <text x={L.M} y={110} fill={t.accent} fontSize={34} fontWeight={600} style={c.sans}>
            {title}
          </text>
          <text x={W - L.M} y={62} fill={t.textFaint} fontSize={16} textAnchor="end" style={c.num}>
            {`${idx + 1} / ${total}`}
          </text>
        </>
      )}

      {id === "overview" && <Overview c={c} r={r} />}
      {id === "routes" && <Routes c={c} r={r} outlines={outlines} />}
      {id === "fleet" && <Fleet c={c} r={r} hideReg={hideReg} />}
      {id === "landings" && <Landings c={c} r={r} />}
      {id === "approaches" && <Approaches c={c} r={r} />}
      {id === "months" && <Months c={c} r={r} />}
      {id === "countries" && <Countries c={c} r={r} outlines={outlines} names={countryNames} />}
      {id === "flags" && <Flags c={c} r={r} />}

      {/* foot: small lockup, what this is */}
      <line x1={L.M} x2={W - L.M} y1={footY - lockH - (L.portrait ? 36 : 18)} y2={footY - lockH - (L.portrait ? 36 : 18)} stroke={t.border} strokeWidth={1} />
      <g>
        <title>VectaSim</title>
        <LogoLockup x={L.M} y={footY - lockH * (54 / 64)} height={lockH} text={t.text} muted={t.textMuted} scheme={t.scheme} id={`${c.id}-logo`} />
      </g>
      <text x={W - L.M} y={footY} fill={t.textMuted} fontSize={L.portrait ? 28 : 16} textAnchor="end" style={c.sans}>
        {tr("review.footer")}
      </text>
    </svg>
  );
}

/** Whether a card has something to show (empty cards are left out of „Alle speichern“). */
export function cardHasData(id: CardId, r: YearReview): boolean {
  switch (id) {
    case "landings":
      return r.landings.count > 0;
    case "approaches":
      return r.approaches.count > 0;
    case "countries":
      return r.countries.length > 0;
    case "fleet":
      return r.types.length > 0;
    case "flags":
      return r.flags.flights > 0;
    default:
      return r.flights > 0;
  }
}

/** The cards of this review in order: the optional „Mit Sternchen“ only with flagged flights. */
export const visibleCards = (r: YearReview): CardId[] => CARDS.filter((c) => !c.optional || cardHasData(c.id, r)).map((c) => c.id);
