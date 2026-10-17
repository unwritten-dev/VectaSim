import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { FlightDetail as Detail, FlightRow, TrackSample } from "./types";
import { fmt, fmtClock, fmtDate, fmtDuration } from "./format";
import ErrorNotice from "./ErrorNotice";
import FlightDetail, { stateLabel } from "./FlightDetail";
import { setPref, usePrefs } from "./prefs";
import { computeTotals, countedFlights, isDemoRow } from "./totals";
import { QUICK_FILTERS, callsignOf, filterFlights, moveSelection, type QuickFilter } from "./logbookFilter";
import Stat from "./ui/Stat";
import EmptyState from "./ui/EmptyState";
import { showToast } from "./ui/Toast";
import { userMessage } from "./errors";
import { openDebrief } from "./landing/debriefStore";

/** Rows rendered in the list; the search narrows it down. */
const LIST_LIMIT = 300;
const FETCH_LIMIT = 100000;

interface Props {
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
export default function Logbook({ focus, onGoLive }: Props) {
  const [flights, setFlights] = useState<FlightRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [track, setTrack] = useState<TrackSample[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState<QuickFilter>("all");
  const [deleteRequest, setDeleteRequest] = useState(0);
  const { showDemo } = usePrefs();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    invoke<FlightRow[]>("list_flights", { limit: FETCH_LIMIT })
      .then((f) => {
        setFlights(f);
        setLoaded(true);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const un = listen("logbook:changed", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      un.then((u) => u());
      clearInterval(timer);
    };
  }, [refresh]);

  // Ctrl+F → search
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const counted = countedFlights(flights, showDemo);
  const totals = loaded ? computeTotals(counted) : null;
  const demoCount = flights.filter(isDemoRow).length;
  const rows = useMemo(() => filterFlights(flights, { query, quick, showDemo }), [flights, query, quick, showDemo]);
  const shown = rows.slice(0, LIST_LIMIT);
  const ids = useMemo(() => shown.map((r) => r.id), [shown]);
  const selectedRow = flights.find((f) => f.id === selectedId) ?? null;
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
  }, [selectedId, selectedUpdated]);

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
    } else if (e.key === "Enter" && selectedId && flights.find((r) => r.id === selectedId)?.landingVsFpm != null) {
      // Enter on a flight with a landing: straight to the landing debrief
      e.preventDefault();
      openDebrief(selectedId, null);
    } else if (e.key === "Delete" && selectedId) {
      e.preventDefault();
      setDeleteRequest((n) => n + 1);
    }
  };

  const remove = (id: string) => {
    const next = moveSelection(
      ids.filter((x) => x !== id),
      ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1] ?? null,
      0,
    );
    invoke("delete_flight", { id })
      .then(() => {
        setSelectedId(next);
        refresh();
        showToast({ tone: "ok", title: "Flug gelöscht" });
      })
      .catch((e) => setError(String(e)));
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
  };
  const filtered = query.trim() !== "" || quick !== "all";

  if (loaded && flights.length === 0) {
    return (
      <section className="logbook-view">
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
    <section className="logbook-view">
      {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} onDismiss={() => setError(null)} />}

      <div className="totals-strip">
        <Stat size="sm" label="Flüge" value={totals ? fmt(totals.flights) : "–"} sub={totals ? `${fmt(totals.completed)} gespeichert` : undefined} />
        <Stat size="sm" label="Blockzeit" value={fmtDuration(totals?.blockTimeMs, { seconds: false })} />
        <Stat size="sm" label="Flugzeit" value={fmtDuration(totals?.flightTimeMs, { seconds: false })} />
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
          placeholder="Suche: Route, Flugzeug, Rufzeichen, Datum (Strg+F)"
          aria-label="Logbuch durchsuchen"
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
            <button key={q.id} className={`chip${quick === q.id ? " active" : ""}`} aria-pressed={quick === q.id} onClick={() => setQuick(q.id)}>
              {q.label}
            </button>
          ))}
          <span className="chip-sep" aria-hidden="true" />
          <button
            className={`chip${showDemo ? " active" : ""}`}
            aria-pressed={showDemo}
            onClick={() => setPref("showDemo", !showDemo).catch((e) => setError(String(e)))}
            title="Demo-Flüge in Liste, Summen, Flotte und Aktivitäten einbeziehen (Einstellungen → Anzeige)"
          >
            Demo-Flüge{demoCount ? ` (${demoCount})` : ""}
          </button>
        </div>
        <div className="spacer" />
        <button onClick={exportLogbook} disabled={flights.length === 0} title="Das ganze Logbuch als CSV-Datei speichern (eine Zeile pro Flug, z. B. für Excel)">
          Logbuch exportieren
        </button>
      </div>

      <div className="master-detail">
        <div className="master">
          <div className="master-head detail num" aria-live="polite">
            {loaded ? (
              <>
                {fmt(rows.length)} von {fmt(flights.length)} Flügen
                {rows.length > LIST_LIMIT && ` · zeigt die neuesten ${LIST_LIMIT}, Suche grenzt ein`}
                {!showDemo && demoCount > 0 && ` · ${demoCount} Demo ausgeblendet`}
              </>
            ) : (
              "Logbuch wird geladen …"
            )}
          </div>
          {selectedHidden && (
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
          {loaded && rows.length === 0 ? (
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
            <div ref={listRef} className="flight-list" role="listbox" aria-label="Flüge" onKeyDown={onListKey}>
              {shown.map((f, i) => {
                const sel = f.id === selectedId;
                const hard = (f.landingVsFpm ?? 0) <= -600;
                const block = f.onBlockMs && f.offBlockMs ? f.onBlockMs - f.offBlockMs : null;
                return (
                  <div
                    key={f.id}
                    data-id={f.id}
                    role="option"
                    aria-selected={sel}
                    tabIndex={sel || (!selectedId && i === 0) || (selectedHidden && i === 0) ? 0 : -1}
                    className={`flight-item${sel ? " selected" : ""}`}
                    onClick={() => select(f.id)}
                    onFocus={() => !sel && select(f.id)}
                  >
                    <div className="fi-line1">
                      <strong className="num">
                        {f.depIcao ?? "····"} → {f.arrIcao ?? (f.state === "active" ? "…" : "····")}
                      </strong>
                      {isDemoRow(f) && <span className="badge badge-demo badge-inline">Demo</span>}
                      {f.state !== "completed" && <span className={`badge badge-inline state-${f.state}`}>{stateLabel(f.state)}</span>}
                      <span className="spacer" />
                      <span className="detail num">
                        {fmtDate(f.offBlockMs ?? f.createdMs)} {fmtClock(f.offBlockMs ?? f.createdMs)}
                      </span>
                    </div>
                    <div className="fi-line2 detail">
                      <span className="fi-aircraft">
                        {f.aircraft.title || "–"}
                        {callsignOf(f) && ` · ${callsignOf(f)}`}
                      </span>
                      <span className="spacer" />
                      <span className="num">{fmtDuration(block, { seconds: false })}</span>
                      {f.landingVsFpm != null ? (
                        <button
                          className={`num fi-landing${hard ? " warn-text" : ""}`}
                          tabIndex={-1}
                          title={`${hard ? "Harte Landung (ab 600 fpm). " : ""}Landeauswertung öffnen`}
                          onClick={(e) => {
                            e.stopPropagation();
                            select(f.id);
                            openDebrief(f.id, null);
                          }}
                        >
                          {hard && (
                            <span className="warn-icon" aria-label="Harte Landung">
                              !
                            </span>
                          )}
                          {fmt(f.landingVsFpm, 0, "fpm")}
                        </button>
                      ) : (
                        <span className="num fi-landing">–</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="detail-pane">
          {detailError && <ErrorNotice error={detailError} context="logbook" onDismiss={() => setDetailError(null)} compact />}
          {detail && detail.flight.id === selectedId ? (
            <FlightDetail detail={detail} track={track} onDelete={() => remove(detail.flight.id)} deleteRequest={deleteRequest} />
          ) : selectedId ? (
            <div className="detail detail-loading">Flug wird geladen …</div>
          ) : (
            <EmptyState compact title="Kein Flug ausgewählt" text="Wähle links einen Flug – mit ↑/↓ blätterst du durch die Liste." />
          )}
        </div>
      </div>
    </section>
  );
}
