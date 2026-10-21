import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { DeletedFlight, FlightCounts, FlightDetail as Detail, FlightRow, MergeCandidate, MergeReport, TrackSample } from "./types";
import { fmt, fmtDuration } from "./i18n/number";
import { useT } from "./i18n";
import ErrorNotice from "./ErrorNotice";
import FlightDetail from "./FlightDetail";
import FlightStrip, { type StripFact } from "./FlightStrip";
import { setPref, usePrefs } from "./prefs";
import { computeTotals, countedFlights, isDemoRow } from "./totals";
import { QUICK_FILTERS, TRASH_DAYS, filterFlights, moveSelection, tagCounts, type QuickFilter } from "./logbookFilter";
import Stat from "./ui/Stat";
import EmptyState from "./ui/EmptyState";
import { showToast } from "./ui/Toast";
import { userMessage } from "./errors";
import { isDebriefOpen, openDebrief } from "./landing/debriefStore";
import { isModalOpen } from "./ui/modalStack";
import type { ApproachFactsResult } from "./landing/approachTypes";
import { stripFactsFrom, type LandingStripFact } from "./stripFacts";
import { mergeHint, mergeKey } from "./resume";
import { loadFlightDetail, sleep } from "./logbookDetail";
import { latestOnly } from "./latest";
import { handleMenuKey, menuItems } from "./ui/menu";
import { useDebouncedValue } from "./ui/useDebouncedValue";

/** Merge hints dismissed with "Ignorieren" (per viewer, best effort). */
const MERGE_IGNORED_KEY = "vectasim.mergeIgnored";
/** Hints shown above the list at most. */
const MERGE_HINTS_MAX = 3;

function loadIgnored(): Set<string> {
  try {
    const raw = localStorage.getItem(MERGE_IGNORED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveIgnored(keys: Set<string>) {
  try {
    localStorage.setItem(MERGE_IGNORED_KEY, JSON.stringify([...keys].slice(-200)));
  } catch {
    // private window / storage blocked: the hint comes back next time
  }
}

/** Rows rendered in the list; the search narrows it down. */
const LIST_LIMIT = 300;
const FETCH_LIMIT = 100000;

interface Props {
  /**
   * The logbook is on screen. App keeps it mounted (hidden) once opened, so search, filters,
   * selection and scroll position survive a view change; Ctrl+F only works while shown.
   */
  active?: boolean;
  /** Select this flight (landing notice "Details"); `n` changes on every request. */
  focus?: { id: string; n: number } | null;
  onGoLive?: () => void;
}

const BOOK_ICON = (
  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
    <path d="M5 3h11l3 3v15H5zM8 9h8M8 13h8M8 17h5" />
  </svg>
);

/** Logbook as master-detail: filterable list on the left, the selected flight on the right. */
/** Screen-reader hint of the strips with a landing (aria-describedby). */
const STRIP_HINT_ID = "logbook-strip-hint";

/** Chip „Tags“ with a dropdown of the logbook's tags (multiple choice: at least one must match). */
export function TagFilter({
  tags,
  selected,
  disabled,
  onChange,
  defaultOpen = false,
}: {
  tags: Array<{ tag: string; count: number }>;
  selected: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  /** Tests: render the list open. */
  defaultOpen?: boolean;
}) {
  const tr = useT();
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    // menu pattern: the focus moves into the menu (ui/menu.ts)
    menuItems(listRef.current)[0]?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const isOn = (t: string) => selected.some((s) => s.toLowerCase() === t.toLowerCase());
  const toggle = (t: string) => onChange(isOn(t) ? selected.filter((s) => s.toLowerCase() !== t.toLowerCase()) : [...selected, t]);
  const active = !disabled && selected.length > 0;
  const hasTags = tags.length > 0;
  const hintId = useId();
  // the item under the focus goes with the filter: close and give the focus to the trigger
  const clearAll = () => {
    onChange([]);
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <div
      className="export-menu tag-filter"
      ref={ref}
      onKeyDown={(e) => handleMenuKey(e, open, listRef.current, triggerRef.current, () => setOpen(false))}
    >
      {/* one semantic: a menu button (the count in its label says whether a filter is on); no
          tags yet: a plain button showing a hint, no empty role="menu" */}
      <button
        ref={triggerRef}
        className={`chip${active ? " active" : ""}`}
        aria-haspopup={hasTags ? "menu" : undefined}
        aria-expanded={hasTags ? open : undefined}
        aria-describedby={!hasTags && open ? hintId : undefined}
        onClick={() => setOpen((o) => !o)}
        title={tags.length ? tr("logbook.tagFilter.titleSome") : tr("logbook.tagFilter.titleNone")}
      >
        {active ? tr("logbook.tagFilter.buttonCount", { count: selected.length }) : tr("logbook.tagFilter.button")} ▾
      </button>
      {open && !hasTags && (
        <div className="export-menu-list tag-filter-list">
          <span className="detail tag-filter-empty" id={hintId}>
            {tr("logbook.tagFilter.empty")}
          </span>
        </div>
      )}
      {open && hasTags && (
        <div ref={listRef} className="export-menu-list tag-filter-list" role="menu" aria-label={tr("logbook.tagFilter.menu")}>
          {tags.map((t) => (
            <button key={t.tag} role="menuitemcheckbox" aria-checked={isOn(t.tag)} onClick={() => toggle(t.tag)}>
              <span className="tag-filter-check" aria-hidden="true">
                {isOn(t.tag) ? "✓" : ""}
              </span>
              {t.tag}
              <span className="detail num">{t.count}</span>
            </button>
          ))}
          {selected.length > 0 && (
            <>
              <div className="export-menu-sep" role="separator" />
              <button role="menuitem" onClick={clearAll}>
                {tr("logbook.tagFilter.clear")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Logbook({ active = true, focus, onGoLive }: Props) {
  const t = useT();
  const [flights, setFlights] = useState<FlightRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [latestList] = useState(latestOnly);
  // the side loads overlap the same way on every logbook:changed: only the newest answer counts
  const [latestFacts] = useState(latestOnly);
  const [latestTrash] = useState(latestOnly);
  const [latestMerge] = useState(latestOnly);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [track, setTrack] = useState<TrackSample[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState<QuickFilter>("all");
  /** Chip filter „Tags“: flights with at least one of these. */
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [deleteRequest, setDeleteRequest] = useState(0);
  /** Papierkorb: the list shows the deleted flights instead of the logbook. */
  const [trash, setTrash] = useState(false);
  const [deleted, setDeleted] = useState<DeletedFlight[]>([]);
  const { showDemo } = usePrefs();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Touchdown position and approach values per flight for the strips (best effort). */
  const [facts, setFacts] = useState<Map<string, StripFact>>(new Map());
  /** Interrupted flights directly followed by their likely continuation ("Zusammenführen"). */
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([]);
  const [mergeIgnored, setMergeIgnored] = useState<Set<string>>(loadIgnored);
  /** Key of the hint whose "Zusammenführen" asks for confirmation / is running. */
  const [mergeConfirm, setMergeConfirm] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  /** Landing + approach facts for the strips (best effort: the strips work without them). */
  const loadFacts = useCallback(() => {
    const isLatest = latestFacts();
    const landings = invoke<{ facts: LandingStripFact[] }>("landing_facts_recent", { limit: LIST_LIMIT, includeDemo: true })
      .then((r) => r.facts)
      .catch(() => null);
    // the backend caps the approach facts at 200
    const approaches = invoke<ApproachFactsResult>("approach_facts_recent", { limit: Math.min(LIST_LIMIT, 200), includeDemo: true })
      .then((r) => r.facts)
      .catch(() => null);
    // both failed (e.g. backend busy): keep what the strips show
    Promise.all([landings, approaches]).then(([l, a]) => isLatest() && (l || a) && setFacts(stripFactsFrom(l ?? [], a ?? [])));
  }, [latestFacts]);

  const loadTrash = useCallback(() => {
    const isLatest = latestTrash();
    invoke<DeletedFlight[]>("list_deleted_flights")
      .then((d) => isLatest() && setDeleted(d))
      .catch(() => {});
  }, [latestTrash]);

  const loadMergeCandidates = useCallback(() => {
    const isLatest = latestMerge();
    invoke<MergeCandidate[]>("list_merge_candidates")
      .then((m) => isLatest() && setMergeCandidates(m))
      .catch(() => {});
  }, [latestMerge]);

  const refresh = useCallback(() => {
    loadFacts();
    loadTrash();
    loadMergeCandidates();
    const isLatest = latestList();
    invoke<FlightRow[]>("list_flights", { limit: FETCH_LIMIT })
      .then((f) => {
        if (!isLatest()) return;
        setFlights(f);
        setLoaded(true);
        setError(null);
      })
      .catch((e) => isLatest() && setError(String(e)));
  }, [loadFacts, loadTrash, loadMergeCandidates, latestList]);

  useEffect(() => {
    refresh();
    const un = listen("logbook:changed", refresh);
    // approach facts are cached after the flight ended, shortly after logbook:changed
    const unApproach = listen("approach:facts", loadFacts);
    // safety net next to the events: a cheap count query, the full list only when it changed
    let lastKey: string | null = null;
    const check = () =>
      invoke<FlightCounts>("flight_summary_counts")
        .then((c) => {
          const key = `${c.flights}|${c.deleted}|${c.lastUpdatedMs ?? ""}|${c.lastDeletedMs ?? ""}`;
          if (lastKey != null && key !== lastKey) refresh();
          lastKey = key;
        })
        .catch(() => refresh());
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      un.then((u) => u());
      unApproach.then((u) => u());
      clearInterval(timer);
    };
  }, [refresh, loadFacts]);

  // Ctrl+F → search (only while shown and nothing modal is open)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f" && !isDebriefOpen() && !isModalOpen()) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // scroll positions of list and detail, put back when the logbook is shown again
  // (hiding with display:none may drop them)
  const detailRef = useRef<HTMLDivElement>(null);
  const scrollMemo = useRef({ list: 0, detail: 0 });
  useLayoutEffect(() => {
    if (!active) return;
    if (listRef.current) listRef.current.scrollTop = scrollMemo.current.list;
    if (detailRef.current) detailRef.current.scrollTop = scrollMemo.current.detail;
  }, [active]);

  const counted = countedFlights(flights, showDemo);
  const totals = loaded ? computeTotals(counted) : null;
  const demoCount = flights.filter(isDemoRow).length;
  const trashRows = useMemo(() => deleted.map((d) => d.flight), [deleted]);
  const deletedAt = useMemo(() => new Map(deleted.map((d) => [d.flight.id, d.deletedMs])), [deleted]);
  /** What the list works on: the logbook, or the Papierkorb (all of it, demo flights included). */
  const source = trash ? trashRows : flights;
  const rows = useMemo(
    () => (trash ? filterFlights(trashRows, { query, quick: "all", showDemo: true }) : filterFlights(flights, { query, quick, showDemo, tags: tagFilter })),
    [trash, trashRows, flights, query, quick, showDemo, tagFilter],
  );
  /** Tags of the flights the list can show (demo setting respected), for the „Tags“ dropdown. */
  const allTags = useMemo(() => tagCounts(showDemo ? flights : flights.filter((f) => !isDemoRow(f))), [flights, showDemo]);
  const shown = useMemo(() => rows.slice(0, LIST_LIMIT), [rows]);
  const ids = useMemo(() => shown.map((r) => r.id), [shown]);
  /** List head: count (or trash/loading/error state); a polite live region repeats it debounced. */
  const headText =
    loaded && trash
      ? t("logbook.list.headTrash", { shown: rows.length, total: deleted.length, days: TRASH_DAYS })
      : loaded
        ? [
            t("logbook.list.headCount", { shown: rows.length, total: flights.length }),
            rows.length > LIST_LIMIT ? t("logbook.list.headLimited", { limit: LIST_LIMIT }) : null,
            !showDemo && demoCount > 0 ? t("logbook.list.headDemoHidden", { count: demoCount }) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : error
          ? t("logbook.list.headError")
          : t("logbook.list.headLoading");
  const headAnnounce = useDebouncedValue(headText, 800);
  const selectedRow = source.find((f) => f.id === selectedId) ?? null;
  const selectedHidden = !!selectedId && !!selectedRow && !ids.includes(selectedId);

  // external selection request (landing notice)
  // (`n` repeats a request for the same flight; the effect only needs the id)
  const focusId = focus?.id;
  const focusN = focus?.n;
  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId, focusN]);

  // nothing selected (first visit, filter change): take the newest visible flight
  useEffect(() => {
    if (!selectedId && ids.length) setSelectedId(ids[0]);
  }, [ids, selectedId]);

  // load the selected flight; reload when it changed in the store (running flight)
  const selectedUpdated = selectedRow?.updatedMs ?? 0;
  /** "Erneut versuchen" on a failed detail load re-runs the effect below. */
  const [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setTrack([]);
      return;
    }
    let cancelled = false;
    setDetailError(null);
    const keepTrack = detail?.flight.id === selectedId;
    if (!keepTrack) setTrack([]);
    loadFlightDetail(selectedId, keepTrack, { invoke, cancelled: () => cancelled, wait: sleep, onDetail: setDetail, onTrack: setTrack })
      .catch((e) => !cancelled && setDetailError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `detail` is read once to keep the drawn track of the same flight; as a dependency every loaded detail would start a new load
  }, [selectedId, selectedUpdated, detailAttempt]);

  const select = (id: string | null, focusRow = false) => {
    setSelectedId(id);
    if (focusRow && id)
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
        el?.focus();
        el?.scrollIntoView({ block: "nearest" });
      });
  };

  const onListKey = (e: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, Home: -1e9, End: 1e9 };
    if (e.key in step) {
      e.preventDefault();
      select(moveSelection(ids, selectedId, step[e.key]), true);
    } else if (e.key === "Enter" && !trash && selectedId && flights.find((r) => r.id === selectedId)?.landingVsFpm != null) {
      // Enter on a flight with a landing: straight to the landing debrief
      e.preventDefault();
      openDebrief(selectedId, null);
    } else if (e.key === "Delete" && selectedId) {
      e.preventDefault();
      setDeleteRequest((n) => n + 1);
    }
  };

  /** The row after `id` (or before it) – the selection once `id` leaves the list. */
  const neighbour = (id: string) => moveSelection(ids.filter((x) => x !== id), ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1] ?? null, 0);

  const focusSelected = () => {
    if (selectedId) select(selectedId, true);
  };

  const restore = (id: string, fromToast = false) =>
    invoke<boolean>("restore_flight", { id })
      .then(() => {
        refresh();
        if (fromToast) {
          // back where it was: in the logbook, selected
          setTrash(false);
          setSelectedId(id);
        } else {
          setSelectedId(neighbour(id));
          showToast({ tone: "ok", title: t("logbook.list.toastRestored"), body: t("logbook.list.toastRestoredBody") });
        }
      })
      .catch((e) => setError(String(e)));

  /** Logbook: into the Papierkorb (with „Rückgängig“). Papierkorb: delete for good. */
  const remove = (id: string) => {
    const next = neighbour(id);
    if (trash) {
      invoke("delete_flight_permanently", { id })
        .then(() => {
          setSelectedId(next);
          refresh();
          showToast({ tone: "ok", title: t("logbook.list.toastDeletedForGood") });
        })
        .catch((e) => setError(String(e)));
      return;
    }
    invoke("delete_flight", { id })
      .then(() => {
        setSelectedId(next);
        refresh();
        showToast({
          id: `trash-${id}`,
          tone: "ok",
          title: t("logbook.list.toastTrashed"),
          body: t("logbook.list.toastTrashedBody", { days: TRASH_DAYS }),
          durationMs: 10_000,
          actions: [{ label: t("logbook.list.undo"), onClick: () => void restore(id, true) }],
        });
      })
      .catch((e) => setError(String(e)));
  };

  const visibleMerges = useMemo(() => mergeCandidates.filter((c) => !mergeIgnored.has(mergeKey(c))), [mergeCandidates, mergeIgnored]);
  /** Gap to the following flight, per interrupted flight with a merge candidate (strip tooltip). */
  const gapToNext = useMemo(() => new Map(mergeCandidates.map((c) => [c.first.id, c.gapMs])), [mergeCandidates]);

  const ignoreMerge = (c: MergeCandidate) => {
    const next = new Set(mergeIgnored).add(mergeKey(c));
    setMergeIgnored(next);
    saveIgnored(next);
  };

  const merge = (c: MergeCandidate) => {
    setMerging(true);
    invoke<MergeReport>("merge_flights", { firstId: c.first.id, secondId: c.second.id })
      .then(() => {
        setMergeConfirm(null);
        setSelectedId(c.first.id);
        refresh();
        showToast({
          tone: "ok",
          title: t("logbook.list.toastMerged"),
          body: t("logbook.list.toastMergedBody", { gap: fmtDuration(c.gapMs, { seconds: false }), days: TRASH_DAYS }),
          durationMs: 8000,
        });
      })
      .catch((e) => {
        const m = userMessage(e, "logbook");
        showToast({ tone: "warn", title: t("logbook.list.toastMergeFailed"), body: m.detail || m.hint, durationMs: 10_000 });
      })
      .finally(() => setMerging(false));
  };

  const toggleTrash = () => {
    setTrash((t) => !t);
    setSelectedId(null);
  };

  const exportLogbook = async () => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const path = await save({ defaultPath: t("logbook.list.exportFileName", { date }), filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      const n = await invoke<number>("export_logbook_csv", { path });
      showToast({ tone: "ok", title: t("logbook.list.toastExported", { count: n }), body: path });
    } catch (e) {
      const m = userMessage(e, "export");
      showToast({ tone: "err", title: m.title, body: m.hint });
    }
  };

  const resetFilters = () => {
    setQuery("");
    setQuick("all");
    setTagFilter([]);
  };
  const filtered = query.trim() !== "" || (!trash && (quick !== "all" || tagFilter.length > 0));

  if (loaded && flights.length === 0 && deleted.length === 0) {
    return (
      <section className="logbook-view" hidden={!active}>
        {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} onDismiss={() => setError(null)} />}
        <EmptyState
          icon={BOOK_ICON}
          title={t("logbook.list.emptyTitle")}
          text={t("logbook.list.emptyText")}
          actions={onGoLive && (
            <button className="btn-primary" onClick={onGoLive}>
              {t("logbook.list.goLive")}
            </button>
          )}
        />
      </section>
    );
  }

  return (
    <section className="logbook-view" hidden={!active}>
      <span id={STRIP_HINT_ID} className="sr-only">
        {t("logbook.list.stripHint")}
      </span>
      {/* first load failed: the list itself offers "Erneut versuchen", the notice keeps the details */}
      {error && <ErrorNotice error={error} context="logbook" onRetry={loaded ? refresh : undefined} onDismiss={loaded ? () => setError(null) : undefined} />}

      <div className="totals-strip">
        <Stat size="sm" label={t("logbook.list.statFlights")} value={totals ? fmt(totals.flights) : "–"} sub={totals ? t("logbook.list.statCompleted", { count: totals.completed }) : undefined} />
        <Stat size="sm" label={t("logbook.list.statBlockTime")} value={fmtDuration(totals?.blockTimeMs, { seconds: false })} />
        <Stat size="sm" label={t("logbook.list.statAirTime")} title={t("logbook.list.statAirTimeTitle")} value={fmtDuration(totals?.flightTimeMs, { seconds: false })} />
        <Stat size="sm" label={t("logbook.list.statDistance")} value={fmt(totals?.distanceNm, 0)} unit="nm" />
        <Stat size="sm" label={t("logbook.list.statLandings")} value={totals ? fmt(totals.landings) : "–"} />
        <Stat
          size="sm"
          label={t("logbook.list.statAvgLanding")}
          value={fmt(totals?.avgLandingVsFpm, 0)}
          unit="fpm"
          sub={totals?.landings ? t("logbook.list.statAvgLandingSub", { count: totals.landings }) : undefined}
        />
      </div>

      <div className="logbook-toolbar">
        <input
          ref={searchRef}
          type="search"
          className="logbook-search"
          placeholder={t("logbook.list.searchPlaceholder")}
          title={t("logbook.list.searchTitle")}
          aria-label={t("logbook.list.searchLabel")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              select(moveSelection(ids, selectedId, 1), true);
            } else if (e.key === "Escape" && query) {
              setQuery("");
            }
          }}
        />
        <div className="chips" role="group" aria-label={t("logbook.list.filterGroup")}>
          {QUICK_FILTERS.map((q) => (
            <button
              key={q.id}
              className={`chip${!trash && quick === q.id ? " active" : ""}`}
              aria-pressed={!trash && quick === q.id}
              onClick={() => {
                if (trash) toggleTrash();
                setQuick(q.id);
              }}
            >
              {t(q.label)}
            </button>
          ))}
          <TagFilter
            tags={allTags}
            selected={tagFilter}
            disabled={trash}
            onChange={(next) => {
              if (trash) toggleTrash();
              setTagFilter(next);
            }}
          />
          <span className="chip-sep" aria-hidden="true" />
          <button
            className={`chip${showDemo ? " active" : ""}`}
            aria-pressed={showDemo}
            onClick={() => setPref("showDemo", !showDemo).catch((e) => setError(String(e)))}
            title={t("logbook.list.demoTitle")}
          >
            {demoCount ? t("logbook.list.demoCount", { count: demoCount }) : t("logbook.list.demo")}
          </button>
          <button
            className={`chip chip-trash${trash ? " active" : ""}`}
            aria-pressed={trash}
            onClick={toggleTrash}
            title={t("logbook.list.trashTitle", { days: TRASH_DAYS })}
          >
            {deleted.length ? t("logbook.list.trashCount", { count: deleted.length }) : t("logbook.list.trash")}
          </button>
        </div>
        <div className="spacer" />
        <button
          className="btn-icon-text logbook-export"
          onClick={exportLogbook}
          disabled={flights.length === 0}
          aria-label={t("logbook.list.export")}
          title={t("logbook.list.exportTitle")}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          <span className="label-long">{t("logbook.list.export")}</span>
          <span className="label-short" aria-hidden="true">
            {t("logbook.list.exportShort")}
          </span>
        </button>
      </div>

      <div className="master-detail">
        <div className="master">
          <div className="master-head detail num">{headText}</div>
          {/* the count is announced once typing in the search pauses, not on every key */}
          <span className="sr-only" aria-live="polite">
            {headAnnounce}
          </span>
          {!trash && visibleMerges.length > 0 && (
            <div className="merge-hints" role="group" aria-label={t("logbook.list.mergeGroup")}>
              {visibleMerges.slice(0, MERGE_HINTS_MAX).map((c) => {
                const key = mergeKey(c);
                const h = mergeHint(c);
                const confirm = mergeConfirm === key;
                return (
                  <div key={key} className="merge-hint detail">
                    <span className="merge-hint-text">
                      {h.text} <span className="num">· {h.detail}</span>
                    </span>
                    <span className="merge-hint-actions">
                      {confirm ? (
                        <>
                          <button className="btn-sm btn-primary" disabled={merging} onClick={() => merge(c)}>
                            {merging ? t("logbook.list.merging") : t("logbook.list.mergeConfirm")}
                          </button>
                          <button className="btn-sm" disabled={merging} onClick={() => setMergeConfirm(null)}>
                            {t("logbook.list.cancel")}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-sm"
                            onClick={() => setMergeConfirm(key)}
                            title={t("logbook.list.mergeTitle")}
                          >
                            {t("logbook.list.merge")}
                          </button>
                          <button className="link-btn" onClick={() => select(c.first.id, true)}>
                            {t("logbook.list.mergeShow")}
                          </button>
                          <button className="link-btn" onClick={() => ignoreMerge(c)} title={t("logbook.list.mergeIgnoreTitle")}>
                            {t("logbook.list.mergeIgnore")}
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {selectedHidden && !trash && (
            <div className="master-hint detail">
              {t("logbook.list.hiddenSelected")}{" "}
              <button
                className="link-btn"
                onClick={() => {
                  resetFilters();
                  if (selectedRow && isDemoRow(selectedRow) && !showDemo) setPref("showDemo", true).catch((e) => setError(String(e)));
                }}
              >
                {t("logbook.list.showHidden")}
              </button>
            </div>
          )}
          {!loaded && error ? (
            <EmptyState
              compact
              title={t("logbook.list.loadFailedTitle")}
              text={t("logbook.list.loadFailedText")}
              actions={
                <button className="btn-primary" onClick={refresh}>
                  {t("logbook.list.retry")}
                </button>
              }
            />
          ) : loaded && trash && rows.length === 0 ? (
            <EmptyState
              compact
              title={deleted.length ? t("logbook.list.trashNoMatch") : t("logbook.list.trashEmpty")}
              text={t("logbook.list.trashText", { days: TRASH_DAYS })}
              actions={<button onClick={toggleTrash}>{t("logbook.list.backToLogbook")}</button>}
            />
          ) : loaded && rows.length === 0 ? (
            <EmptyState
              compact
              title={t("logbook.list.noMatchTitle")}
              text={!showDemo && demoCount > 0 && !filtered ? t("logbook.list.noMatchDemo", { count: demoCount }) : t("logbook.list.noMatchText")}
              actions={
                <>
                  {filtered && <button onClick={resetFilters}>{t("logbook.list.resetFilters")}</button>}
                  {!showDemo && demoCount > 0 && <button onClick={() => setPref("showDemo", true).catch((e) => setError(String(e)))}>{t("logbook.list.showDemo")}</button>}
                </>
              }
            />
          ) : (
            <div
              ref={listRef}
              className="flight-list strip-list"
              role="listbox"
              aria-label={t("logbook.list.listLabel")}
              onKeyDown={onListKey}
              onScroll={(e) => active && (scrollMemo.current.list = e.currentTarget.scrollTop)}
            >
              {shown.map((f, i) => {
                const sel = f.id === selectedId;
                return (
                  <FlightStrip
                    key={f.id}
                    flight={f}
                    fact={facts.get(f.id) ?? null}
                    selected={sel}
                    tabIndex={sel || (!selectedId && i === 0) || (selectedHidden && i === 0) ? 0 : -1}
                    onSelect={() => select(f.id)}
                    onDebrief={() => openDebrief(f.id, null)}
                    describedBy={!trash && f.landingVsFpm != null ? STRIP_HINT_ID : undefined}
                    gapToNextMs={trash ? null : (gapToNext.get(f.id) ?? null)}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div ref={detailRef} className="detail-pane" onScroll={(e) => active && (scrollMemo.current.detail = e.currentTarget.scrollTop)}>
          {detailError && <ErrorNotice error={detailError} context="logbook" onRetry={() => setDetailAttempt((n) => n + 1)} onDismiss={() => setDetailError(null)} compact />}
          {detail && detail.flight.id === selectedId ? (
            <FlightDetail
              detail={detail}
              track={track}
              onDelete={() => remove(detail.flight.id)}
              deleteRequest={deleteRequest}
              onCancelDelete={focusSelected}
              deletedMs={trash ? (deletedAt.get(detail.flight.id) ?? null) : null}
              onRestore={trash ? () => void restore(detail.flight.id) : undefined}
            />
          ) : selectedId ? (
            // after an error the notice above says it; no endless "wird geladen"
            !detailError && <div className="detail detail-loading">{t("logbook.list.detailLoading")}</div>
          ) : (
            <EmptyState compact title={t("logbook.list.noSelectionTitle")} text={t("logbook.list.noSelectionText")} />
          )}
        </div>
      </div>
    </section>
  );
}
