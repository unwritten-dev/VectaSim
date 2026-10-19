import { useMemo, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LandingFactsResult } from "../types";
import type { ApproachFact, ApproachFactsResult } from "./approachTypes";
import { NNBSP, fmt, fmtNum } from "../i18n/number";
import { useT, type TFunction } from "../i18n";
import { usePrefs } from "../prefs";
import {
  MIN_PEERS,
  SCOPES,
  approachFor,
  betterText,
  compareApproach,
  compareLanding,
  defaultScope,
  demoFilter,
  landingFor,
  peersPhrase,
  scopeOpts,
  scopePhrase,
  type HistLanding,
  type MetricCompare,
  type Scope,
} from "./history";
import "./trends.css";

// ---- shared facts store -------------------------------------------------------------------
// One request per list for every consumer (debrief, logbook detail, after-flight card, trends);
// reloaded on `logbook:changed` (landings + approaches) and `approach:facts` (approaches).

/** Upper limit of both commands. */
const FETCH_LIMIT = 200;

export interface HistoryFacts {
  /** Newest first, demo included (filtered per consumer). */
  landings: HistLanding[] | null;
  approaches: ApproachFact[] | null;
  error: string | null;
}

let state: HistoryFacts = { landings: null, approaches: null, error: null };
const subs = new Set<() => void>();
let unlisten: Array<Promise<() => void>> = [];
let stale = true;

function set(patch: Partial<HistoryFacts>) {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
}

function loadLandings() {
  invoke<LandingFactsResult>("landing_facts_recent", { limit: FETCH_LIMIT, includeDemo: true })
    .then((r) => set({ landings: r.facts, error: null }))
    .catch((e) => set({ landings: state.landings ?? [], error: String(e) }));
}

function loadApproaches() {
  invoke<ApproachFactsResult>("approach_facts_recent", { limit: FETCH_LIMIT, includeDemo: true })
    .then((r) => set({ approaches: r.facts }))
    // the approach is an extra; landings work without it
    .catch(() => set({ approaches: state.approaches ?? [] }));
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) {
    unlisten = [
      listen("logbook:changed", () => {
        loadLandings();
        loadApproaches();
      }),
      listen("approach:facts", loadApproaches),
    ];
    // events were missed while nobody listened
    if (stale) {
      stale = false;
      loadLandings();
      loadApproaches();
    }
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0) {
      unlisten.forEach((u) => u.then((f) => f()).catch(() => {}));
      unlisten = [];
      stale = true;
    }
  };
}

const snapshot = () => state;

/** The pilot's landing and approach facts (newest first, demo included), kept fresh by events. */
export function useHistoryFacts(): HistoryFacts {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ---- comparison ---------------------------------------------------------------------------

const scopeLabel = (t: TFunction, s: Scope): string => t(`landingHistory.scope.label.${s}`);

export interface Comparison {
  fact: HistLanding | null;
  approach: ApproachFact | null;
  scope: Scope;
  landing: ReturnType<typeof compareLanding> | null;
  approachCmp: ReturnType<typeof compareApproach> | null;
  /** Peer counts per scope (for the switch). */
  counts: Record<Scope, number>;
}

function useComparison(flightId: string, touchdownIndex: number | null | undefined, approachIndex: number | null | undefined, chosen: Scope | null): Comparison | null {
  const { landings, approaches } = useHistoryFacts();
  const { showDemo } = usePrefs();
  return useMemo(() => {
    if (!landings) return null;
    const fact = landingFor(landings, flightId, touchdownIndex);
    const approach = approaches ? approachFor(approaches, flightId, touchdownIndex ?? fact?.touchdownIndex, approachIndex) : null;
    if (!fact) return { fact: null, approach, scope: chosen ?? "all", landing: null, approachCmp: null, counts: { runway: 0, type: 0, all: 0 } };
    const peers = demoFilter(landings, fact, showDemo);
    const counts = Object.fromEntries(SCOPES.map((s) => [s, compareLanding(fact, peers, scopeOpts(s)).n])) as Record<Scope, number>;
    const scope = chosen ?? defaultScope(fact, peers);
    const aPeers = approaches ? demoFilter(approaches, fact, showDemo) : [];
    return {
      fact,
      approach,
      scope,
      counts,
      landing: compareLanding(fact, peers, scopeOpts(scope)),
      approachCmp: approach ? compareApproach(approach, aPeers, scopeOpts(scope)) : null,
    };
  }, [landings, approaches, showDemo, flightId, touchdownIndex, approachIndex, chosen]);
}

/** "25 fpm weicher", "40 m weiter", "150 ft höher"; null when there is nothing to compare. */
function deltaText(t: TFunction, m: MetricCompare, kind: "rate" | "distance" | "stable"): string | null {
  if (m.value == null || m.median == null) return null;
  if (kind === "rate") {
    const d = Math.abs(m.value) - Math.abs(m.median);
    if (Math.round(d) === 0) return t("landingHistory.delta.same");
    const value = `${fmtNum(Math.abs(d), 0)}${NNBSP}fpm`;
    return t(d < 0 ? "landingHistory.delta.softer" : "landingHistory.delta.harder", { value });
  }
  const d = m.value - m.median;
  if (Math.round(d) === 0) return t("landingHistory.delta.same");
  if (kind === "distance") return t(d > 0 ? "landingHistory.delta.longer" : "landingHistory.delta.shorter", { value: `${fmtNum(Math.abs(d), 0)}${NNBSP}m` });
  return t(d > 0 ? "landingHistory.delta.higher" : "landingHistory.delta.lower", { value: `${fmtNum(Math.abs(d), 0)}${NNBSP}ft` });
}

function Arrow({ up }: { up: boolean | null }) {
  if (up == null) return null;
  return (
    <svg className="hist-arrow" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d={up ? "M5 1.5 L9 7.5 H1 Z" : "M5 8.5 L9 2.5 H1 Z"} />
    </svg>
  );
}

interface TileProps {
  label: string;
  value: string;
  median: string;
  delta: string | null;
  /** Arrow direction of the value against the median (up = larger number). */
  up: boolean | null;
  better: string | null;
  n: number;
}

function Tile({ label, value, median, delta, up, better, n }: TileProps) {
  const t = useT();
  return (
    <div className="hist-tile">
      <div className="tile-label">{label}</div>
      <div className="hist-tile-value num">{value}</div>
      <div className="detail num">
        {t("landingHistory.median", { value: median })}
        {n > 0 && <span className="hist-n"> · n = {n}</span>}
      </div>
      {(delta || better) && (
        <div className="hist-delta num">
          <Arrow up={up} />
          {[delta, better].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

interface Props {
  flightId: string;
  /** Touchdown to compare; default the flight's last landing with a fact (the full stop). */
  touchdownIndex?: number | null;
  /** Approach to compare; default the one that ended in that touchdown. */
  approachIndex?: number | null;
}

/**
 * "Einordnung": this landing against the pilot's own history – one sentence, three tiles
 * (landing rate, touchdown point, "stabil ab") as value vs median with percentile, and a switch
 * same runway / same type / all. Loads the facts itself; below three comparable landings a
 * single sentence.
 */
export default function HistoryPanel({ flightId, touchdownIndex, approachIndex }: Props) {
  const [chosen, setChosen] = useState<Scope | null>(null);
  const { error } = useHistoryFacts();
  const c = useComparison(flightId, touchdownIndex, approachIndex, chosen);
  const t = useT();

  if (!c) return error ? null : <div className="hist hist-empty detail">{t("landingHistory.loading")}</div>;
  if (!c.fact) {
    return (
      <section className="hist hist-empty" aria-label={t("landingHistory.kicker")}>
        <span className="kicker">{t("landingHistory.kicker")}</span>
        <span className="detail">{t("landingHistory.noFact")}</span>
      </section>
    );
  }
  const { fact, landing: l, approachCmp: a, scope } = c;
  const enough = l != null && l.n >= MIN_PEERS;
  const where = scopePhrase(scope, fact);

  const switcher = (
    <div className="chips hist-scope" role="group" aria-label={t("landingHistory.scope.aria")}>
      {SCOPES.map((s) => (
        <button
          key={s}
          className={`chip${s === scope ? " active" : ""}`}
          aria-pressed={s === scope}
          disabled={c.counts[s] < MIN_PEERS && s !== scope}
          title={t("landingHistory.scope.count", { scope: scopeLabel(t, s), count: c.counts[s] })}
          onClick={() => setChosen(s)}
        >
          {scopeLabel(t, s)}
        </button>
      ))}
    </div>
  );

  if (!l || !enough) {
    return (
      <section className="hist hist-empty" aria-label={t("landingHistory.kicker")}>
        <span className="kicker">{t("landingHistory.kicker")}</span>
        <span className="detail">{where ? t("landingHistory.tooFewWhere", { where }) : t("landingHistory.tooFew")}</span>
        {SCOPES.some((s) => c.counts[s] >= MIN_PEERS) && switcher}
      </section>
    );
  }

  const better = betterText(l.rate.better);
  const youRate = fmt(l.rate.value, 0, "fpm");
  const you = better ? t("landingHistory.youBetter", { value: youRate, better }) : youRate;
  const median = fmt(l.rate.median, 0, "fpm");
  const sentence = where ? t("landingHistory.sentenceWhere", { count: l.n, where, median, you }) : t("landingHistory.sentence", { count: l.n, median, you });
  const absUp = (m: MetricCompare) => (m.value == null || m.median == null || Math.abs(m.value) === Math.abs(m.median) ? null : Math.abs(m.value) > Math.abs(m.median));
  const up = (m: MetricCompare) => (m.value == null || m.median == null || m.value === m.median ? null : m.value > m.median);
  const sf = a?.stableFrom;

  return (
    <section className="hist" aria-label={t("landingHistory.aria")}>
      <div className="hist-head">
        <span className="kicker">{t("landingHistory.kicker")}</span>
        {switcher}
      </div>
      <p className="hist-sentence num">{sentence}</p>
      <div className="hist-tiles">
        <Tile
          label={t("landingHistory.tile.rate")}
          value={fmt(l.rate.value, 0, "fpm")}
          median={fmt(l.rate.median, 0, "fpm")}
          delta={deltaText(t, l.rate, "rate")}
          up={absUp(l.rate)}
          better={better}
          n={l.rate.n}
        />
        <Tile
          label={t("landingHistory.tile.distance")}
          value={fmt(l.distance.value, 0, "m")}
          median={fmt(l.distance.median, 0, "m")}
          delta={deltaText(t, l.distance, "distance")}
          up={up(l.distance)}
          better={l.tdz.rate != null ? t(l.tdz.current ? "landingHistory.tile.tdzIn" : "landingHistory.tile.tdzOut", { yes: l.tdz.yes, total: l.tdz.total }) : null}
          n={l.distance.n}
        />
        {a && sf ? (
          <Tile
            label={t("landingHistory.tile.stableFrom")}
            value={sf.value != null ? fmt(sf.value, 0, "ft") : c.approach?.band ? t("landingHistory.tile.neverStable") : "–"}
            median={fmt(sf.median, 0, "ft")}
            delta={deltaText(t, sf, "stable")}
            up={up(sf)}
            better={a.n >= MIN_PEERS ? betterText(sf.better) : null}
            n={sf.n}
          />
        ) : (
          <div className="hist-tile">
            <div className="tile-label">{t("landingHistory.tile.stableFrom")}</div>
            <div className="hist-tile-value num">–</div>
            <div className="detail">{t("landingHistory.tile.notAssessed")}</div>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One line for the after-flight card: "besser als 70 % deiner letzten 20 Landungen auf EDDF 25C";
 * nothing without enough history.
 */
export function HistoryLine({ flightId }: { flightId: string }) {
  const c = useComparison(flightId, null, null, null);
  const t = useT();
  const l = c?.landing;
  if (!c?.fact || !l || l.n < MIN_PEERS) return null;
  const better = betterText(l.rate.better);
  if (!better) return null;
  return (
    <div className="after-history detail num" title={t("landingHistory.afterLineTitle", { median: fmt(l.rate.median, 0, "fpm") })}>
      {t("landingHistory.afterLine", { better, peers: peersPhrase(l.n, c.scope, c.fact) })}
    </div>
  );
}
