import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { fmt, fmtDate, fmtNum } from "../format";
import { showToast } from "../ui/Toast";
import { RUNWAY_SOURCE_SHORT, runwaySourceOf } from "./facts";
import { isDerivedSource, type LandingAnalysis, type UserRunway, type UserRunwayEdit } from "./types";

const EARTH_R_M = 6_371_008.8;
/** Aiming point a derived threshold assumes (vectasim_core::landing::DERIVE_DEFAULT_AIM_M). */
const DERIVE_AIM_M = 300;
/** Shortest ground run a runway is taken from (DERIVE_MIN_GROUND_RUN_M). */
const MIN_GROUND_RUN_M = 150;

interface Form {
  ident: string;
  latThr: string;
  lonThr: string;
  latEnd: string;
  lonEnd: string;
  widthM: string;
  elevationFt: string;
}

interface Geometry {
  latThr: number;
  lonThr: number;
  latEnd: number;
  lonEnd: number;
  lengthEstimated: boolean;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function offset(lat: number, lon: number, course: number, dist: number): [number, number] {
  const d = dist / EARTH_R_M;
  const p1 = rad(lat);
  const t = rad(course);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = rad(lon) + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/**
 * The runway this landing implies: a derived match as it is; otherwise the axis from the
 * touchdown to the end of the rollout and the threshold 300 m before the touchdown (the
 * same assumption as the backend), the far end at the database length or the rollout end.
 */
function geometryFromLanding(a: LandingAnalysis): Geometry | null {
  const rwy = a.runway;
  if (rwy && isDerivedSource(rwy.source)) {
    return { latThr: rwy.thresholdLat, lonThr: rwy.thresholdLon, latEnd: rwy.endLat, lonEnd: rwy.endLon, lengthEstimated: !!rwy.lengthEstimated };
  }
  const td = a.touchdown;
  const end = a.rollout ? { lat: a.rollout.endLat, lon: a.rollout.endLon } : null;
  if (!end) return null;
  const roll = distanceM(td.latitude, td.longitude, end.lat, end.lon);
  if (roll < MIN_GROUND_RUN_M) return null;
  const course = bearingDeg(td.latitude, td.longitude, end.lat, end.lon);
  const [latThr, lonThr] = offset(td.latitude, td.longitude, course, -DERIVE_AIM_M);
  const known = rwy && !rwy.lengthEstimated && rwy.lengthM >= DERIVE_AIM_M + roll ? rwy.lengthM : null;
  const [latEnd, lonEnd] = offset(latThr, lonThr, course, known ?? DERIVE_AIM_M + roll);
  return { latThr, lonThr, latEnd, lonEnd, lengthEstimated: known == null };
}

const coord = (v: number) => v.toFixed(6);
const num = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};

/** Everything focusable inside the editor. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * "Piste korrigieren": a modal over the debrief to set threshold and far end of the matched
 * runway (`save_user_runway`), take over what this landing implies, or forget a remembered
 * runway (`delete_user_runway`, back to OurAirports / derivation). Rendered into the debrief
 * overlay (a sibling of `.debrief`, which is made inert while it is open), so the debrief's
 * focus trap keeps Tab inside it; Esc closes the editor only.
 */
export default function RunwayEditor({ analysis: a, airportIcao, onClose, onChanged }: { analysis: LandingAnalysis; airportIcao: string; onClose: () => void; onChanged: () => void }) {
  const rwy = a.runway;
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [rows, setRows] = useState<UserRunway[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lengthEstimated, setLengthEstimated] = useState(!!rwy?.lengthEstimated);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(() => ({
    ident: rwy?.ident ?? "",
    latThr: rwy ? coord(rwy.thresholdLat) : "",
    lonThr: rwy ? coord(rwy.thresholdLon) : "",
    latEnd: rwy ? coord(rwy.endLat) : "",
    lonEnd: rwy ? coord(rwy.endLon) : "",
    widthM: rwy?.widthM != null ? fmtNum(rwy.widthM, 0) : "",
    elevationFt: a.touchdownElevationFt != null ? String(Math.round(a.touchdownElevationFt)) : "",
  }));
  const fromLanding = useMemo(() => geometryFromLanding(a), [a]);
  // the latest onClose, so the modal setup below runs once
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // the overlay hosts the editor; the debrief behind it goes inert
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const overlay = (before?.closest(".debrief-overlay") ?? document.querySelector(".debrief-overlay")) as HTMLElement | null;
    const behind = overlay?.querySelector<HTMLElement>(":scope > .debrief") ?? null;
    behind?.setAttribute("inert", "");
    setHost(overlay ?? document.body);
    // capture on document: before the debrief's window handler, which would close the debrief
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      behind?.removeAttribute("inert");
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (host) ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [host]);

  const loadRows = useCallback(
    () =>
      invoke<UserRunway[]>("list_user_runways", { icao: airportIcao })
        .then(setRows)
        .catch((e) => {
          setRows([]);
          setError(String(e));
        }),
    [airportIcao],
  );
  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  const initialIdent = rwy?.ident ?? "";
  const ownRow = rows?.find((r) => r.ident === initialIdent) ?? null;
  // the shown landing direction may be the reverse end of a runway the pilot set
  const reverseRow = !ownRow && rwy ? (rows?.find((r) => r.source === "user" && r.ident === rwy.oppositeIdent) ?? null) : null;
  const rowOfMatch = ownRow ?? reverseRow;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const take = () => {
    if (!fromLanding) return;
    setForm((f) => ({ ...f, latThr: coord(fromLanding.latThr), lonThr: coord(fromLanding.lonThr), latEnd: coord(fromLanding.latEnd), lonEnd: coord(fromLanding.lonEnd) }));
    setLengthEstimated(fromLanding.lengthEstimated);
    setNote(
      `Aus dieser Landung übernommen: Achse aus deiner Rollspur, Schwelle ${fmt(DERIVE_AIM_M, 0, "m")} vor dem Aufsetzpunkt angenommen` +
        (fromLanding.lengthEstimated ? ", Pistenende am Ende des Rollouts (Länge unbekannt)." : "."),
    );
  };

  const parsed = (() => {
    const v = { latThr: num(form.latThr), lonThr: num(form.lonThr), latEnd: num(form.latEnd), lonEnd: num(form.lonEnd), widthM: num(form.widthM), elevationFt: num(form.elevationFt) };
    const ident = form.ident.trim().toUpperCase();
    if (!/^[0-9A-Z-]{1,4}$/.test(ident)) return { error: "Pistenbezeichnung: 1–4 Zeichen, z. B. 09 oder 27L" };
    const coords = [v.latThr, v.lonThr, v.latEnd, v.lonEnd];
    if (coords.some((c) => c == null || Number.isNaN(c))) return { error: "Schwelle und Ende brauchen Breite und Länge in Dezimalgrad" };
    if ([v.latThr!, v.latEnd!].some((x) => Math.abs(x) > 90) || [v.lonThr!, v.lonEnd!].some((x) => Math.abs(x) > 180)) return { error: "Koordinaten außerhalb des Erdballs" };
    const len = distanceM(v.latThr!, v.lonThr!, v.latEnd!, v.lonEnd!);
    if (len < 100 || len > 8000) return { error: `Schwelle und Ende liegen ${fmt(len, 0, "m")} auseinander – erlaubt sind 100 m bis 8 km` };
    if (Number.isNaN(v.widthM) || (v.widthM != null && (v.widthM < 1 || v.widthM > 200))) return { error: "Breite: 1–200 m oder leer" };
    if (Number.isNaN(v.elevationFt)) return { error: "Höhe: Zahl in ft oder leer" };
    return { ident, len, course: bearingDeg(v.latThr!, v.lonThr!, v.latEnd!, v.lonEnd!), v };
  })();

  const save = async () => {
    if ("error" in parsed) return;
    const { ident, v } = parsed;
    // the reverse end of a runway the pilot set is saved into that row (ends swapped)
    const swap = reverseRow != null && ident === initialIdent;
    const edit: UserRunwayEdit = swap
      ? {
          airportIcao,
          ident: reverseRow.ident,
          latThr: v.latEnd!,
          lonThr: v.lonEnd!,
          latEnd: v.latThr!,
          lonEnd: v.lonThr!,
          widthM: v.widthM,
          elevationFt: v.elevationFt,
          lengthEstimated,
        }
      : {
          airportIcao,
          ident,
          latThr: v.latThr!,
          lonThr: v.lonThr!,
          latEnd: v.latEnd!,
          lonEnd: v.lonEnd!,
          widthM: v.widthM,
          elevationFt: v.elevationFt,
          lengthEstimated,
          previousIdent: ownRow && ownRow.ident !== ident ? ownRow.ident : null,
        };
    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<UserRunway>("save_user_runway", { edit });
      showToast({ tone: "ok", title: `${saved.airportIcao} RWY ${saved.ident} gespeichert`, body: "Landungen an diesem Platz werden mit deiner Piste neu ausgewertet." });
      void emit("logbook:changed");
      onChanged();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (row: UserRunway) => {
    setBusy(true);
    setError(null);
    try {
      await invoke<boolean>("delete_user_runway", { icao: row.airportIcao, ident: row.ident });
      showToast({
        tone: "ok",
        title: `${row.airportIcao} RWY ${row.ident} vergessen`,
        body: "Es gelten wieder die Datenbank-Piste bzw. eine neu aus der Rollspur abgeleitete.",
      });
      void emit("logbook:changed");
      onChanged();
      if (row === rowOfMatch) onClose();
      else await loadRows();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!host) return null;
  const src = runwaySourceOf(rwy);
  return createPortal(
    <div className="rwe-backdrop">
      <div ref={ref} className="rwe" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="rwe-head">
          <h3 id={titleId}>
            Piste korrigieren · {airportIcao}
            {rwy ? ` RWY ${rwy.ident}` : ""}
          </h3>
          <span className="detail">jetzt: {RUNWAY_SOURCE_SHORT[src]}</span>
        </header>
        <p className="detail rwe-intro">
          Trag die Schwelle (Beginn der Landestrecke) und das Ende der Piste in Landerichtung ein, z. B. aus der Bodenkarte des Simulators. Deine Piste hat Vorrang vor
          OurAirports und wird für alle Landungen an diesem Platz verwendet.
        </p>
        <form
          className="rwe-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="af-field rwe-ident">
            <span className="stat-label">Bezeichnung</span>
            <input value={form.ident} onChange={set("ident")} maxLength={4} autoComplete="off" spellCheck={false} />
          </label>
          <fieldset className="rwe-pair">
            <legend className="stat-label">Schwelle (Dezimalgrad)</legend>
            <label className="af-field">
              <span className="sr-only">Schwelle Breite</span>
              <input value={form.latThr} onChange={set("latThr")} inputMode="decimal" placeholder="Breite" aria-label="Schwelle Breite" />
            </label>
            <label className="af-field">
              <span className="sr-only">Schwelle Länge</span>
              <input value={form.lonThr} onChange={set("lonThr")} inputMode="decimal" placeholder="Länge" aria-label="Schwelle Länge" />
            </label>
          </fieldset>
          <fieldset className="rwe-pair">
            <legend className="stat-label">Ende in Landerichtung (Dezimalgrad)</legend>
            <label className="af-field">
              <span className="sr-only">Ende Breite</span>
              <input value={form.latEnd} onChange={set("latEnd")} inputMode="decimal" placeholder="Breite" aria-label="Ende Breite" />
            </label>
            <label className="af-field">
              <span className="sr-only">Ende Länge</span>
              <input value={form.lonEnd} onChange={set("lonEnd")} inputMode="decimal" placeholder="Länge" aria-label="Ende Länge" />
            </label>
          </fieldset>
          <label className="af-field">
            <span className="stat-label">Breite (m)</span>
            <input value={form.widthM} onChange={set("widthM")} inputMode="decimal" placeholder="unbekannt" />
          </label>
          <label className="af-field">
            <span className="stat-label">Höhe der Schwelle (ft)</span>
            <input value={form.elevationFt} onChange={set("elevationFt")} inputMode="decimal" placeholder="Platzhöhe" />
          </label>
          <div className="rwe-check detail num" aria-live="polite">
            {"error" in parsed ? parsed.error : `Länge ${fmt(parsed.len, 0, "m")}${lengthEstimated ? " (Mindestlänge, Ende geschätzt)" : ""} · Richtung ${fmt(parsed.course, 0, "°")} rechtweisend`}
          </div>
          {note && <div className="detail rwe-note">{note}</div>}
          {error && (
            <div className="rwe-error" role="alert">
              {error}
            </div>
          )}
          <div className="rwe-actions">
            <button type="button" className="btn-sm" onClick={take} disabled={!fromLanding || busy} title={fromLanding ? "Achse und Schwelle aus der Rollspur dieser Landung" : "Diese Landung hat keinen auswertbaren Rollout"}>
              Aus aktueller Landung übernehmen
            </button>
            {rowOfMatch && (
              <button type="button" className="btn-sm danger" onClick={() => void forget(rowOfMatch)} disabled={busy} title="Gemerkte Piste löschen – danach gilt wieder OurAirports bzw. eine neu abgeleitete Piste">
                Zurücksetzen auf Datenbank
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn-sm" onClick={onClose} disabled={busy}>
              Abbrechen
            </button>
            <button type="submit" className="btn-sm btn-primary" disabled={busy || "error" in parsed}>
              {busy ? "Speichert …" : "Speichern"}
            </button>
          </div>
        </form>

        <section className="rwe-list" aria-label={`Gemerkte Pisten von ${airportIcao}`}>
          <h4 className="stat-label">Gemerkte Pisten von {airportIcao}</h4>
          {rows == null ? (
            <div className="detail">Wird geladen …</div>
          ) : rows.length === 0 ? (
            <div className="detail">Keine – es gelten die Pisten aus OurAirports.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Piste</th>
                  <th scope="col">Quelle</th>
                  <th scope="col" className="num-col">
                    Landungen
                  </th>
                  <th scope="col" className="num-col">
                    Länge
                  </th>
                  <th scope="col">Geändert</th>
                  <th scope="col">
                    <span className="sr-only">Aktion</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.ident}>
                    <td className="num">{r.ident}</td>
                    <td>{r.source === "user" ? "von dir festgelegt" : "aus deiner Rollspur abgeleitet"}</td>
                    <td className="num num-col">{r.source === "user" ? "–" : fmtNum(r.uses)}</td>
                    <td className="num num-col">
                      {r.lengthEstimated ? "≥ " : ""}
                      {fmt(distanceM(r.latThr, r.lonThr, r.latEnd, r.lonEnd), 0, "m")}
                    </td>
                    <td className="num">{fmtDate(r.updatedMs)}</td>
                    <td>
                      <button type="button" className="btn-sm" onClick={() => void forget(r)} disabled={busy} aria-label={`RWY ${r.ident} vergessen`}>
                        Vergessen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>,
    host,
  );
}
