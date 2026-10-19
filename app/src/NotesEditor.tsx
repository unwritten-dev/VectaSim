import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FlightRow, FlightUserEdit, TagCount } from "./types";
import { showToast } from "./ui/Toast";
import { NOTES_MAX_CHARS, TAG_MAX_CHARS, TAGS_MAX, normalizeTags, recordedCallsignOf } from "./logbookFilter";
import { t as tr, useT, type TKey } from "./i18n";
import { errorToast } from "./ui/errorToast";

interface Props {
  flight: FlightRow;
  /** Flight in the Papierkorb: shown, not editable. */
  readOnly?: boolean;
}

/** Stored notes for a draft: line endings as LF, no trailing whitespace (same as the backend). */
function cleanNotes(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/\s+$/, "").replace(/^\n+/, "");
}

const ICAO_RE = /^[A-Za-z0-9]{4}$/;
const REG_RE = /^[A-Za-z0-9-]{3,8}$/;

/** Saves one edit; the backend emits `logbook:changed`, the logbook then reloads the flight. */
async function saveEdit(id: string, edit: FlightUserEdit): Promise<FlightRow | null> {
  try {
    return await invoke<FlightRow>("update_flight_user", { id, edit });
  } catch (e) {
    showToast({ tone: "err", ...errorToast(tr("logbook.notes.saveFailed"), e, "logbook") });
    return null;
  }
}

/**
 * "Notizen & Tags" of a flight in the logbook: free-text notes (autosave on leaving the field
 * and with Strg/⌘+S, plain text – no Markdown), tag chips with autocomplete, a personal
 * rating 1–5 and "Korrigieren …" for wrongly recorded callsign, airports, aircraft name or
 * registration (the display uses the correction, the recorded value stays).
 */
export default function NotesEditor({ flight: f, readOnly = false }: Props) {
  const ids = useId();
  const t = useT();
  return (
    <section className="detail-section notes-editor" aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`}>{t("logbook.notes.heading")}</h3>
      <div className="notes-grid">
        <NotesField flight={f} readOnly={readOnly} />
        <div className="notes-side">
          <TagsField flight={f} readOnly={readOnly} />
          <RatingField flight={f} readOnly={readOnly} />
          {!readOnly && <CorrectionForm flight={f} />}
        </div>
      </div>
    </section>
  );
}

// ---- notes ----------------------------------------------------------------------------

function NotesField({ flight: f, readOnly }: { flight: FlightRow; readOnly: boolean }) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(f.notes ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const t = useT();
  const saved = f.notes ?? "";

  // another flight, or the stored notes changed elsewhere: take them unless the pilot is typing
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(f.notes ?? "");
  }, [f.id, f.notes]);
  useEffect(() => setStatus("idle"), [f.id]);

  const save = async () => {
    const next = cleanNotes(draft);
    if (next === cleanNotes(saved)) return;
    setStatus("saving");
    const row = await saveEdit(f.id, { notes: next });
    setStatus(row ? "saved" : "idle");
  };

  if (readOnly) {
    return (
      <div className="notes-field">
        <span className="notes-label">{t("logbook.notes.notes")}</span>
        {saved ? <p className="notes-text">{saved}</p> : <span className="detail">{t("logbook.notes.noNotes")}</span>}
      </div>
    );
  }
  const left = NOTES_MAX_CHARS - draft.length;
  return (
    <div className="notes-field">
      <label className="notes-label" htmlFor={id}>
        {t("logbook.notes.notes")}
      </label>
      <textarea
        id={id}
        ref={ref}
        className="notes-textarea"
        value={draft}
        maxLength={NOTES_MAX_CHARS}
        rows={4}
        placeholder={t("logbook.notes.placeholder")}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setDraft(e.target.value);
          setStatus("idle");
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div id={`${id}-hint`} className="notes-hint detail" aria-live="polite">
        <span>{status === "saving" ? t("logbook.notes.saving") : status === "saved" ? t("logbook.notes.saved") : t("logbook.notes.hint")}</span>
        <span className={`num${left < 100 ? " warn-text" : ""}`}>{left < 500 ? t("logbook.notes.charsLeft", { count: left }) : ""}</span>
      </div>
    </div>
  );
}

// ---- tags -----------------------------------------------------------------------------

function TagsField({ flight: f, readOnly }: { flight: FlightRow; readOnly: boolean }) {
  const id = useId();
  const [tags, setTags] = useState<string[]>(f.tags ?? []);
  const [input, setInput] = useState("");
  const [all, setAll] = useState<TagCount[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagsKey = (f.tags ?? []).join("\u0000");
  const tt = useT();

  useEffect(() => {
    setTags(f.tags ?? []);
  }, [f.id, tagsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAll = () =>
    invoke<TagCount[]>("list_tags")
      .then(setAll)
      .catch(() => {});

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    const own = new Set(tags.map((t) => t.toLowerCase()));
    return all.filter((t) => !own.has(t.tag.toLowerCase()) && (!q || t.tag.toLowerCase().includes(q))).slice(0, 8);
  }, [all, input, tags]);

  const commit = async (next: string[]) => {
    const norm = normalizeTags(next);
    const before = tags;
    if (norm.join("\u0000") === before.join("\u0000")) return;
    setTags(norm);
    const row = await saveEdit(f.id, { tags: norm });
    if (!row) setTags(before);
    else void loadAll();
  };

  const add = (raw: string) => {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    setInput("");
    setActive(-1);
    if (!parts.length) return;
    if (tags.length >= TAGS_MAX) {
      showToast({ tone: "warn", title: tt("logbook.notes.tagsMax", { max: TAGS_MAX }) });
      return;
    }
    void commit([...tags, ...parts]);
  };

  const remove = (tag: string) => {
    void commit(tags.filter((t) => t !== tag));
    inputRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (active >= 0 && suggestions[active]) add(suggestions[active].tag);
      else add(input);
    } else if (e.key === "Backspace" && input === "" && tags.length) {
      e.preventDefault();
      void commit(tags.slice(0, -1));
    } else if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  const showList = open && suggestions.length > 0;
  return (
    <div className="notes-tags">
      <label className="notes-label" htmlFor={`${id}-in`}>
        {tt("logbook.notes.tags")}
      </label>
      <div className="tag-box" onClick={() => !readOnly && inputRef.current?.focus()}>
        <ul className="tag-chips" aria-label={tt("logbook.notes.tagsOfFlight")}>
          {tags.map((t) => (
            <li key={t} className="tag-chip">
              <span>{t}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="tag-chip-x"
                  aria-label={tt("logbook.notes.removeTag", { tag: t })}
                  title={tt("logbook.notes.remove")}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(t);
                  }}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {readOnly && tags.length === 0 && <li className="detail">{tt("logbook.notes.noTags")}</li>}
        </ul>
        {!readOnly && (
          <div className="tag-input-wrap">
            <input
              id={`${id}-in`}
              ref={inputRef}
              className="tag-input"
              value={input}
              maxLength={TAG_MAX_CHARS * 3}
              placeholder={tags.length ? "" : tt("logbook.notes.tagPlaceholder")}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showList}
              aria-controls={`${id}-list`}
              aria-activedescendant={showList && active >= 0 ? `${id}-opt-${active}` : undefined}
              aria-describedby={`${id}-hint`}
              onChange={(e) => {
                const v = e.target.value;
                // pasted "a, b": every complete part becomes a tag
                if (v.includes(",")) {
                  const last = v.slice(v.lastIndexOf(",") + 1);
                  add(v.slice(0, v.lastIndexOf(",")));
                  setInput(last.trimStart());
                } else setInput(v);
                setOpen(true);
                setActive(-1);
              }}
              onFocus={() => {
                setOpen(true);
                void loadAll();
              }}
              onBlur={() => {
                setOpen(false);
                if (input.trim()) add(input);
              }}
              onKeyDown={onKey}
            />
            {showList && (
              <ul id={`${id}-list`} className="tag-suggest" role="listbox" aria-label={tt("logbook.notes.existingTags")}>
                {suggestions.map((s, i) => (
                  <li
                    key={s.tag}
                    id={`${id}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "active" : undefined}
                    // mousedown: before the input's blur
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(s.tag);
                    }}
                  >
                    {s.tag}
                    <span className="detail num">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {!readOnly && (
        <span id={`${id}-hint`} className="sr-only">
          {tt("logbook.notes.tagHint")}
        </span>
      )}
    </div>
  );
}

// ---- rating ---------------------------------------------------------------------------

/** Index = stars (0 is never shown). */
const RATING_TEXT: TKey[] = ["logbook.notes.rating1", "logbook.notes.rating1", "logbook.notes.rating2", "logbook.notes.rating3", "logbook.notes.rating4", "logbook.notes.rating5"];

function RatingField({ flight: f, readOnly }: { flight: FlightRow; readOnly: boolean }) {
  const id = useId();
  const [rating, setRating] = useState<number>(f.rating ?? 0);
  const [hover, setHover] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const t = useT();
  useEffect(() => setRating(f.rating ?? 0), [f.id, f.rating]);

  const set = async (n: number, focus = false) => {
    const before = rating;
    if (n === before) return;
    setRating(n);
    if (focus && n > 0) refs.current[n - 1]?.focus();
    const row = await saveEdit(f.id, { rating: n });
    if (!row) setRating(before);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, n: number) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in step) {
      e.preventDefault();
      void set(Math.max(1, Math.min(5, n + step[e.key])), true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      void set(e.key === "Home" ? 1 : 5, true);
    } else if (e.key === "Delete" || e.key === "Backspace" || e.key === "0") {
      e.preventDefault();
      void set(0);
    }
  };

  const shown = hover || rating;
  return (
    <div className="notes-rating">
      <span className="notes-label" id={`${id}-l`}>
        {t("logbook.notes.rating")}
      </span>
      <div
        className="star-group"
        role="radiogroup"
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-d`}
        aria-readonly={readOnly || undefined}
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            ref={(el) => {
              refs.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={t("logbook.notes.stars", { count: n, text: t(RATING_TEXT[n]) })}
            tabIndex={(rating || 1) === n ? 0 : -1}
            disabled={readOnly}
            className={`star${n <= shown ? " on" : ""}`}
            onMouseEnter={() => !readOnly && setHover(n)}
            onClick={() => void set(n)}
            onKeyDown={(e) => onKey(e, n)}
          >
            ★
          </button>
        ))}
        {!readOnly && rating > 0 && (
          <button type="button" className="link-btn star-clear" onClick={() => void set(0)} title={t("logbook.notes.clearRatingTitle")}>
            {t("logbook.notes.clearRating")}
          </button>
        )}
      </div>
      <span id={`${id}-d`} className="detail notes-rating-text">
        {shown ? t(RATING_TEXT[shown]) : t("logbook.notes.ratingHint")}
      </span>
    </div>
  );
}

// ---- corrections ------------------------------------------------------------------------

interface Draft {
  callsign: string;
  depIcao: string;
  arrIcao: string;
  aircraftTitle: string;
  registration: string;
}

function draftOf(f: FlightRow): Draft {
  return {
    callsign: f.userCallsign ?? "",
    depIcao: f.userDepIcao ?? "",
    arrIcao: f.userArrIcao ?? "",
    aircraftTitle: f.userAircraftTitle ?? "",
    registration: f.userRegistration ?? "",
  };
}

/** Field errors of a draft (UI language, for the form); empty = valid. Empty fields clear the correction. */
function correctionErrors(d: Draft): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {};
  if (d.callsign.trim().length > 16) e.callsign = tr("logbook.notes.errMaxChars", { max: 16 });
  if (d.depIcao.trim() && !ICAO_RE.test(d.depIcao.trim())) e.depIcao = tr("logbook.notes.errIcao", { example: "EDDF" });
  if (d.arrIcao.trim() && !ICAO_RE.test(d.arrIcao.trim())) e.arrIcao = tr("logbook.notes.errIcao", { example: "EDDM" });
  if (d.aircraftTitle.trim().length > 120) e.aircraftTitle = tr("logbook.notes.errMaxChars", { max: 120 });
  const reg = d.registration.replace(/\s+/g, "");
  if (reg && !REG_RE.test(reg)) e.registration = tr("logbook.notes.errReg");
  return e;
}

function CorrectionForm({ flight: f }: { flight: FlightRow }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(f));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = useT();
  useEffect(() => {
    setOpen(false);
    setTouched(false);
  }, [f.id]);
  useEffect(() => {
    if (!open) setDraft(draftOf(f));
  }, [f, open]);

  const corrected = [
    f.userCallsign && t("logbook.notes.fieldCallsign"),
    f.userDepIcao && t("logbook.notes.fieldDep"),
    f.userArrIcao && t("logbook.notes.fieldArr"),
    f.userAircraftTitle && t("logbook.notes.fieldAircraft"),
    f.userRegistration && t("logbook.notes.fieldReg"),
  ].filter(Boolean) as string[];
  const errors = correctionErrors(draft);
  const invalid = Object.keys(errors).length > 0;

  const submit = async (e: { preventDefault(): void }, d: Draft = draft) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(correctionErrors(d)).length) return;
    setBusy(true);
    const row = await saveEdit(f.id, {
      callsign: d.callsign.trim(),
      depIcao: d.depIcao.trim().toUpperCase(),
      arrIcao: d.arrIcao.trim().toUpperCase(),
      aircraftTitle: d.aircraftTitle.trim(),
      registration: d.registration.replace(/\s+/g, "").toUpperCase(),
    });
    setBusy(false);
    if (row) {
      setOpen(false);
      showToast({ tone: "ok", title: t("logbook.notes.correctionSaved"), body: t("logbook.notes.correctionSavedBody") });
    }
  };

  const field = (key: keyof Draft, label: string, recorded: string | null | undefined, opts: { upper?: boolean; maxLength: number }) => (
    <label className="corr-field">
      <span>{label}</span>
      <input
        value={draft[key]}
        maxLength={opts.maxLength}
        placeholder={recorded || "–"}
        className={opts.upper ? "num upper" : undefined}
        aria-invalid={touched && !!errors[key]}
        aria-describedby={`${id}-${key}`}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => setTouched(true)}
      />
      <span id={`${id}-${key}`} className={`detail corr-help${touched && errors[key] ? " warn-text" : ""}`}>
        {touched && errors[key] ? errors[key] : t("logbook.recorded", { value: recorded || "–" })}
      </span>
    </label>
  );

  return (
    <div className="notes-correct">
      <div className="notes-correct-head">
        <button type="button" className="btn-sm" aria-expanded={open} aria-controls={`${id}-form`} onClick={() => setOpen((o) => !o)}>
          {t("logbook.notes.correct")}
        </button>
        {corrected.length > 0 && <span className="detail">{t("logbook.notes.corrected", { fields: corrected.join(", ") })}</span>}
      </div>
      {open && (
        <form
          id={`${id}-form`}
          className="corr-form"
          aria-label={t("logbook.notes.formLabel")}
          onSubmit={(e) => void submit(e)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <p className="detail corr-intro">{t("logbook.notes.intro")}</p>
          <div className="corr-grid">
            {field("callsign", t("logbook.notes.fieldCallsign"), recordedCallsignOf(f), { upper: true, maxLength: 16 })}
            {field("depIcao", t("logbook.notes.fieldDepIcao"), f.depIcao, { upper: true, maxLength: 4 })}
            {field("arrIcao", t("logbook.notes.fieldArrIcao"), f.arrIcao, { upper: true, maxLength: 4 })}
            {field("aircraftTitle", t("logbook.notes.fieldAircraft"), f.aircraft.title, { maxLength: 120 })}
            {field("registration", t("logbook.notes.fieldReg"), f.aircraft.atcId, { upper: true, maxLength: 10 })}
          </div>
          <p className="detail corr-intro">{t("logbook.notes.regHint")}</p>
          <div className="corr-actions">
            <button type="submit" className="btn-sm btn-primary" disabled={busy || (touched && invalid)}>
              {busy ? t("logbook.notes.saving") : t("logbook.notes.save")}
            </button>
            <button type="button" className="btn-sm" onClick={() => setOpen(false)}>
              {t("logbook.notes.cancel")}
            </button>
            {corrected.length > 0 && (
              <button
                type="button"
                className="link-btn"
                disabled={busy}
                onClick={(e) => {
                  const empty: Draft = { callsign: "", depIcao: "", arrIcao: "", aircraftTitle: "", registration: "" };
                  setDraft(empty);
                  void submit(e, empty);
                }}
              >
                {t("logbook.notes.clearAll")}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
