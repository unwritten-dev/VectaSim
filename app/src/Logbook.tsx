import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { DeletedFlight, FlightCounts, FlightDetail as Detail, FlightRow, MergeCandidate, MergeReport, TrackSample } from "./types";
import { fmt, fmtDuration } from "./format";
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
import type { ApproachFactsResult } from "./landing/approachTypes";
import { stripFactsFrom, type LandingStripFact } from "./stripFacts";
import { mergeHint, mergeKey } from "./resume";

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
function TagFilter({ tags, selected, disabled, onChange }: { tags: Array<{ tag: string; count: number }>; selected: string[]; disabled?: boolean; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const isOn = (t: string) => selected.some((s) => s.toLowerCase() === t.toLowerCase());
  const toggle = (t: string) => onChange(isOn(t) ? selected.filter((s) => s.toLowerCase() !== t.toLowerCase()) : [...selected, t]);
  const active = !disabled && selected.length > 0;
  return (
    <div
      className="export-menu tag-filter"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        className={`chip${active ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={active}
        onClick={() => setOpen((o) => !o)}
        title={tags.length ? "Nach Tags filtern (mehrere: mindestens einer passt)" : "Noch keine Tags – im Flugdetail unter „Notizen & Tags“ vergeben"}
      >
        Tags{active ? ` (${selected.length})` : ""} ▾
      </button>
      {open && (
        <div className="export-menu-list tag-filter-list" role="menu" aria-label="Tags">
          {tags.length === 0 ? (
            <span className="detail tag-filter-empty">Noch keine Tags vergeben.</span>
          ) : (
            tags.map((t) => (
              <button key={t.tag} role="menuitemcheckbox" aria-checked={isOn(t.tag)} onClick={() => toggle(t.tag)}>
                <span className="tag-filter-check" aria-hidden="true">
                  {isOn(t.tag) ? "✓" : ""}
                </span>
                {t.tag}
                <span className="detail num">{t.count}</span>
              </button>
            ))
          )}
          {selected.length > 0 && (
            <>
              <div className="export-menu-sep" role="separator" />
              <button role="menuitem" onClick={() => onChange([])}>
                Tag-Filter aufheben
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Logbook({ active = true, focus, onGoLive }: Props) {
  const [flights, setFlights] = useState<FlightRow[]>([]);
  const [loaded, setLoaded] = useState(false);
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
    const landings = invoke<{ facts: LandingStripFact[] }>("landing_facts_recent", { limit: LIST_LIMIT, includeDemo: true })
      .then((r) => r.facts)
      .catch(() => null);
    // the backend caps the approach facts at 200
    const approaches = invoke<ApproachFactsResult>("approach_facts_recent", { limit: Math.min(LIST_LIMIT, 200), includeDemo: true })
      .then((r) => r.facts)
      .catch(() => null);
    // both failed (e.g. backend busy): keep what the strips show
    Promise.all([landings, approaches]).then(([l, a]) => (l || a) && setFacts(stripFactsFrom(l ?? [], a ?? [])));
  }, []);

  const loadTrash = useCallback(() => {
    invoke<DeletedFlight[]>("list_deleted_flights")
      .then(setDeleted)
      .catch(() => {});
  }, []);

  const loadMergeCandidates = useCallback(() => {
    invoke<MergeCandidate[]>("list_merge_candidates")
      .then(setMergeCandidates)
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    loadFacts();
    loadTrash();
    loadMergeCandidates();
    invoke<FlightRow[]>("list_flights", { limit: FETCH_LIMIT })
      .then((f) => {
        setFlights(f);
        setLoaded(true);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [loadFacts, loadTrash, loadMergeCandidates]);

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
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f" && !isDebriefOpen()) {
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
  const shown = rows.slice(0, LIST_LIMIT);
  const ids = useMemo(() => shown.map((r) => r.id), [shown]);
  const selectedRow = source.find((f) => f.id === selectedId) ?? null;
  const selectedHidden = !!selectedId && !!selectedRow && !ids.includes(selectedId);

  // external selection request (landing notice)
  useEffect(() => {
    if (!focus) return;
    setSelectedId(focus.id);
  }, [focus?.id, focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

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
    invoke<Detail | null>("get_flight", { id: selectedId })
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);
        if (!d) return;
        const active = d.flight.state === "active";
        // preview first (tiny), then the full track
        if (d.hasTrack && !keepTrack) {
          const p = await invoke<TrackSample[] | null>("get_track", { id: selectedId, preview: true });
          if (!cancelled && p) setTrack(p);
        }
        let full = d.hasTrack ? await invoke<TrackSample[] | null>("get_track", { id: selectedId, preview: false }) : null;
        // the running flight's track may not be written yet: use the recorder's live buffer
        if ((!full || full.length === 0) && active) full = await invoke<TrackSample[]>("get_live_track");
        if (!cancelled && full) setTrack(full);
      })
      .catch((e) => !cancelled && setDetailError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          showToast({ tone: "ok", title: "Flug wiederhergestellt", body: "Er steht wieder im Logbuch." });
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
          showToast({ tone: "ok", title: "Flug endgültig gelöscht" });
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
          title: "Flug im Papierkorb",
          body: `${TRASH_DAYS} Tage wiederherstellbar (Logbuch → Papierkorb).`,
          durationMs: 10_000,
          actions: [{ label: "Rückgängig", onClick: () => void restore(id, true) }],
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
          title: "Flüge zusammengeführt",
          body: `Ein Flug mit Lücke ${fmtDuration(c.gapMs, { seconds: false })}. Der zweite Teil liegt im Papierkorb (${TRASH_DAYS} Tage).`,
          durationMs: 8000,
        });
      })
      .catch((e) => {
        const m = userMessage(e, "logbook");
        showToast({ tone: "warn", title: "Zusammenführen nicht möglich", body: m.detail || m.hint, durationMs: 10_000 });
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
      const path = await save({ defaultPath: `vectasim-logbuch_${date}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      const n = await invoke<number>("export_logbook_csv", { path });
      showToast({ tone: "ok", title: `Logbuch exportiert · ${fmt(n)} Flüge`, body: path });
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
          title="Noch keine Flüge"
          text="Dein erster Flug erscheint hier automatisch, sobald du im Simulator losrollst – mit Track, Profil und Landedaten."
          actions={onGoLive && (
            <button className="btn-primary" onClick={onGoLive}>
              Zur Karte
            </button>
          )}
        />
      </section>
    );
  }

  return (
    <section className="logbook-view" hidden={!active}>
      <span id={STRIP_HINT_ID} className="sr-only">
        Eingabetaste öffnet die Landeauswertung, Entf legt den Flug in den Papierkorb.
      </span>
      {/* first load failed: the list itself offers "Erneut versuchen", the notice keeps the details */}
      {error && <ErrorNotice error={error} context="logbook" onRetry={loaded ? refresh : undefined} onDismiss={loaded ? () => setError(null) : undefined} />}

      <div className="totals-strip">
        <Stat size="sm" label="Flüge" value={totals ? fmt(totals.flights) : "–"} sub={totals ? `${fmt(totals.completed)} abgeschlossen` : undefined} />
        <Stat size="sm" label="Blockzeit" value={fmtDuration(totals?.blockTimeMs, { seconds: false })} />
        <Stat size="sm" label="Luftzeit" title="Abheben bis Aufsetzen – für das Flugbuch zählt die Blockzeit" value={fmtDuration(totals?.flightTimeMs, { seconds: false })} />
        <Stat size="sm" label="Distanz" value={fmt(totals?.distanceNm, 0)} unit="nm" />
        <Stat size="sm" label="Landungen" value={totals ? fmt(totals.landings) : "–"} />
        <Stat
          size="sm"
          label="Ø Landung"
          value={fmt(totals?.avgLandingVsFpm, 0)}
          unit="fpm"
          sub={totals?.landings ? `aus ${totals.landings} Landung${totals.landings === 1 ? "" : "en"}` : undefined}
        />
      </div>

      <div className="logbook-toolbar">
        <input
          ref={searchRef}
          type="search"
          className="logbook-search"
          placeholder="Suchen (Strg+F)"
          title="Route, Flugzeug, Registrierung, Rufzeichen, Datum, Notizen oder Tags (Strg+F)"
          aria-label="Logbuch durchsuchen: Route, Flugzeug, Registrierung, Rufzeichen, Datum, Notizen oder Tags"
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
        <div className="chips" role="group" aria-label="Filter">
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
              {q.label}
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
            title="Demo-Flüge in Liste, Summen, Flotte und Aktivitäten einbeziehen (Einstellungen → Anzeige)"
          >
            Demo-Flüge{demoCount ? ` (${demoCount})` : ""}
          </button>
          <button
            className={`chip chip-trash${trash ? " active" : ""}`}
            aria-pressed={trash}
            onClick={toggleTrash}
            title={`Gelöschte Flüge – ${TRASH_DAYS} Tage wiederherstellbar, danach endgültig weg`}
          >
            Papierkorb{deleted.length ? ` (${deleted.length})` : ""}
          </button>
        </div>
        <div className="spacer" />
        <button
          className="btn-icon-text logbook-export"
          onClick={exportLogbook}
          disabled={flights.length === 0}
          aria-label="Logbuch exportieren"
          title="Das ganze Logbuch als CSV-Datei speichern (eine Zeile pro Flug, z. B. für Excel)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          <span className="label-long">Logbuch exportieren</span>
          <span className="label-short" aria-hidden="true">
            Export
          </span>
        </button>
      </div>

      <div className="master-detail">
        <div className="master">
          <div className="master-head detail num" aria-live="polite">
            {loaded && trash ? (
              <>
                Papierkorb · {fmt(rows.length)} von {fmt(deleted.length)} Flügen · nach {TRASH_DAYS} Tagen endgültig gelöscht
              </>
            ) : loaded ? (
              <>
                {fmt(rows.length)} von {fmt(flights.length)} Flügen
                {rows.length > LIST_LIMIT && ` · zeigt die neuesten ${LIST_LIMIT}, Suche grenzt ein`}
                {!showDemo && demoCount > 0 && ` · ${demoCount} Demo ausgeblendet`}
              </>
            ) : error ? (
              "Logbuch nicht geladen"
            ) : (
              "Logbuch wird geladen …"
            )}
          </div>
          {!trash && visibleMerges.length > 0 && (
            <div className="merge-hints" role="group" aria-label="Unterbrochene Flüge zusammenführen">
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
                            {merging ? "Wird zusammengeführt …" : "Ja, zusammenführen"}
                          </button>
                          <button className="btn-sm" disabled={merging} onClick={() => setMergeConfirm(null)}>
                            Abbrechen
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-sm"
                            onClick={() => setMergeConfirm(key)}
                            title="Beide Teile werden ein Flug (Zeiten, Track, Landung); der zweite Teil kommt in den Papierkorb"
                          >
                            Zusammenführen
                          </button>
                          <button className="link-btn" onClick={() => select(c.first.id, true)}>
                            Anzeigen
                          </button>
                          <button className="link-btn" onClick={() => ignoreMerge(c)} title="Diesen Hinweis nicht mehr zeigen">
                            Ignorieren
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
              Der ausgewählte Flug ist durch den Filter ausgeblendet.{" "}
              <button
                className="link-btn"
                onClick={() => {
                  resetFilters();
                  if (selectedRow && isDemoRow(selectedRow) && !showDemo) setPref("showDemo", true).catch((e) => setError(String(e)));
                }}
              >
                Einblenden
              </button>
            </div>
          )}
          {!loaded && error ? (
            <EmptyState
              compact
              title="Logbuch konnte nicht geladen werden"
              text="Deine Flüge sind nicht verloren – das Lesen ist gerade fehlgeschlagen."
              actions={
                <button className="btn-primary" onClick={refresh}>
                  Erneut versuchen
                </button>
              }
            />
          ) : loaded && trash && rows.length === 0 ? (
            <EmptyState
              compact
              title={deleted.length ? "Kein gelöschter Flug passt zur Suche" : "Der Papierkorb ist leer"}
              text={`Gelöschte Flüge bleiben ${TRASH_DAYS} Tage hier und lassen sich wiederherstellen.`}
              actions={<button onClick={toggleTrash}>Zum Logbuch</button>}
            />
          ) : loaded && rows.length === 0 ? (
            <EmptyState
              compact
              title="Keine Flüge passen zum Filter"
              text={!showDemo && demoCount > 0 && !filtered ? `${demoCount} Demo-Flüge sind ausgeblendet.` : "Ändere die Suche oder setze die Filter zurück."}
              actions={
                <>
                  {filtered && <button onClick={resetFilters}>Filter zurücksetzen</button>}
                  {!showDemo && demoCount > 0 && <button onClick={() => setPref("showDemo", true).catch((e) => setError(String(e)))}>Demo-Flüge zeigen</button>}
                </>
              }
            />
          ) : (
            <div
              ref={listRef}
              className="flight-list strip-list"
              role="listbox"
              aria-label="Flüge"
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
            !detailError && <div className="detail detail-loading">Flug wird geladen …</div>
          ) : (
            <EmptyState compact title="Kein Flug ausgewählt" text="Wähle links einen Flug – mit ↑/↓ blätterst du durch die Liste." />
          )}
        </div>
      </div>
    </section>
  );
}
