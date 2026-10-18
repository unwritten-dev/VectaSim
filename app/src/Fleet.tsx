import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AirframeEdit, AirframeRow, FlightRow } from "./types";
import { fmt, fmtDate, fmtDuration } from "./format";
import ErrorNotice from "./ErrorNotice";
import { setPref, usePrefs, usePrivacy } from "./prefs";
import Stat from "./ui/Stat";
import EmptyState from "./ui/EmptyState";
import { showToast } from "./ui/Toast";
import AirframeImage from "./airframes/AirframeImage";
import AirframePicker from "./airframes/AirframePicker";
import { VAPP_MAX_KT, VAPP_MIN_KT, airframeName, matchesAirframe, normalizeRegistration, parseVapp, shownAirframeName } from "./airframes/airframe";
import { useAirframes } from "./airframes/hooks";
import { navigate } from "./airframes/navigation";

const PLANE_ICON = (
  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
    <path d="M10.5 3.5c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5V9l8 5v2l-8-2.5V18l2.5 2v1.5L12 20.5l-4 1V20l2.5-2v-4.5l-8 2.5v-2l8-5z" />
  </svg>
);

interface Props {
  /** Select this airframe (from a flight's "In Flotte"); `n` re-triggers. */
  focus?: { registration: string; n: number } | null;
}

/** Fleet: one entry per airframe (registration) with photo, hours and landings; detail on the right. */
export default function Fleet({ focus }: Props) {
  const { showDemo } = usePrefs();
  const priv = usePrivacy();
  const { rows, error, refresh } = useAirframes(showDemo);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newReg, setNewReg] = useState("");

  useEffect(() => {
    if (focus) setSelected(focus.registration);
  }, [focus]);

  // airframes known only from (hidden) demo flights are left out like the demo flights themselves
  const visible = useMemo(() => (rows ?? []).filter((r) => showDemo || r.flights > 0 || r.totalFlights === 0), [rows, showDemo]);
  const demoOnly = (rows?.length ?? 0) - visible.length;
  const shown = visible.filter((r) => matchesAirframe(r, query));
  const current = rows?.find((r) => r.registration === selected) ?? null;

  useEffect(() => {
    if (rows && !selected && shown.length) setSelected(shown[0].registration);
  }, [rows, selected, shown]);

  const add = () => {
    const reg = normalizeRegistration(newReg);
    if (!reg) {
      showToast({ tone: "warn", title: "Keine gültige Registrierung", body: "3–8 Zeichen: Buchstaben, Ziffern, Bindestrich – z. B. D-AINA." });
      return;
    }
    invoke("upsert_airframe", { edit: { registration: reg } satisfies AirframeEdit })
      .then(() => {
        setAdding(false);
        setNewReg("");
        setSelected(reg);
      })
      .catch((e) => showToast({ tone: "err", title: "Flugzeug nicht angelegt", body: String(e) }));
  };

  if (rows && rows.length === 0 && !adding) {
    return (
      <section className="logbook-view">
        {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
        <EmptyState
          icon={PLANE_ICON}
          title="Noch keine Flugzeuge"
          text="Jede Registrierung wird zu einem Flugzeug – aus dem SimBrief-Flugplan oder dem Simulator. Du kannst auch selbst eins anlegen."
          actions={<button onClick={() => setAdding(true)}>Flugzeug hinzufügen</button>}
        />
      </section>
    );
  }

  return (
    <section className="logbook-view">
      {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
      <div className="logbook-toolbar">
        <input
          type="search"
          className="logbook-search"
          placeholder="Suche: Registrierung, Name, Typ, Airline"
          aria-label="Flotte durchsuchen"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="spacer" />
        {adding ? (
          <span className="af-add" role="group" aria-label="Flugzeug hinzufügen">
            <input
              autoFocus
              value={newReg}
              placeholder="Registrierung, z. B. D-AINA"
              aria-label="Registrierung"
              onChange={(e) => setNewReg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <button className="btn-primary" onClick={add}>
              Anlegen
            </button>
            <button onClick={() => setAdding(false)}>Abbrechen</button>
          </span>
        ) : (
          <button onClick={() => setAdding(true)}>Flugzeug hinzufügen</button>
        )}
      </div>

      <div className="master-detail">
        <div className="master">
          <div className="master-head detail num" aria-live="polite">
            {rows ? (
              <>
                {fmt(shown.length)} Flugzeug{shown.length === 1 ? "" : "e"}
                {demoOnly > 0 && (
                  <>
                    {" "}
                    · {demoOnly} nur aus Demo-Flügen ausgeblendet{" "}
                    <button className="link-btn" onClick={() => setPref("showDemo", true).catch(() => {})}>
                      zeigen
                    </button>
                  </>
                )}
              </>
            ) : (
              "Flotte wird geladen …"
            )}
          </div>
          <div className="flight-list" role="listbox" aria-label="Flugzeuge">
            {shown.map((r) => {
              const sel = r.registration === selected;
              const name = airframeName(r);
              const shownName = shownAirframeName(r, priv.on);
              return (
                <div
                  key={r.registration}
                  role="option"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  className={`flight-item af-item${sel ? " selected" : ""}`}
                  onClick={() => setSelected(r.registration)}
                  onKeyDown={(e) => {
                    const i = shown.findIndex((x) => x.registration === r.registration);
                    const next = e.key === "ArrowDown" ? shown[i + 1] : e.key === "ArrowUp" ? shown[i - 1] : null;
                    if (next) {
                      e.preventDefault();
                      setSelected(next.registration);
                      (e.currentTarget.parentElement?.children[i + (e.key === "ArrowDown" ? 1 : -1)] as HTMLElement | undefined)?.focus();
                    }
                  }}
                >
                  <AirframeImage airframe={r} />
                  <div className="af-item-text">
                    <div className="fi-line1">
                      <strong className="num">{priv.mask(r.registration, "registration")}</strong>
                      {r.icaoType && <span className="badge badge-inline">{r.icaoType}</span>}
                      <span className="fi-aircraft detail" title={shownName}>
                        {name !== r.registration ? shownName : ""}
                        {r.airline && name !== r.airline && !name.includes(r.airline) ? ` · ${priv.mask(r.airline, "airline")}` : ""}
                      </span>
                    </div>
                    <div className="fi-line2 detail num">
                      <span>
                        {fmt(r.flights)} Flug{r.flights === 1 ? "" : "e"}
                      </span>
                      <span>{fmtDuration(r.blockTimeMs, { seconds: false })} Block</span>
                      <span>{fmt(r.landings)} Ldg.</span>
                      <span className="af-avg" title="Ø Landerate">Ø {fmt(r.avgLandingVsFpm, 0, "fpm")}</span>
                      <span className="spacer" />
                      <span className="af-last">{r.lastFlownMs ? fmtDate(r.lastFlownMs) : "nie geflogen"}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {rows && shown.length === 0 && <EmptyState compact title="Keine Treffer" text="Ändere die Suche." />}
          </div>
        </div>
        <div className="detail-pane">
          {current ? <AirframeDetail key={current.registration} row={current} onSelect={setSelected} /> : <div className="detail-loading detail">Wähle ein Flugzeug.</div>}
        </div>
      </div>
    </section>
  );
}

function AirframeDetail({ row: a, onSelect }: { row: AirframeRow; onSelect: (reg: string | null) => void }) {
  const priv = usePrivacy();
  /** The registration as shown (D-•••• in the Streamer-Modus). */
  const reg = priv.mask(a.registration, "registration");
  const initial = () => ({
    customName: a.customName ?? "",
    icaoType: a.icaoType ?? "",
    airline: a.airline ?? "",
    notes: a.notes ?? "",
    vappKt: a.vappKt != null ? String(Math.round(a.vappKt)) : "",
  });
  const [form, setForm] = useState(initial);
  const [flights, setFlights] = useState<FlightRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { airframePhotos } = usePrefs();

  useEffect(() => {
    invoke<FlightRow[]>("airframe_flights", { registration: a.registration, limit: 200 })
      .then(setFlights)
      .catch(() => setFlights([]));
  }, [a.registration, a.totalFlights]);

  const start = initial();
  const dirty = (Object.keys(start) as Array<keyof typeof start>).some((k) => form[k] !== start[k]);
  const save = () => {
    const vapp = parseVapp(form.vappKt);
    if (vapp === undefined) {
      showToast({ tone: "warn", title: "Vapp nicht gespeichert", body: `Bitte eine Geschwindigkeit zwischen ${VAPP_MIN_KT} und ${VAPP_MAX_KT} kt eintragen – oder das Feld leeren.` });
      return;
    }
    const { customName, icaoType, airline, notes } = form;
    // 0 clears the stored Vapp (the backend's convention)
    invoke("upsert_airframe", { edit: { registration: a.registration, customName, icaoType, airline, notes, vappKt: vapp ?? 0 } satisfies AirframeEdit })
      .then(() => showToast({ tone: "ok", title: `${reg} gespeichert` }))
      .catch((e) => showToast({ tone: "err", title: "Nicht gespeichert", body: String(e) }));
  };

  const refreshPhoto = () => {
    setBusy(true);
    invoke<AirframeRow | null>("airframe_photo", { registration: a.registration, refresh: true })
      .then((r) =>
        showToast(
          r?.imageSource === "planespotters"
            ? { tone: "ok", title: "Foto aktualisiert", body: r.imageCredit ? `© ${r.imageCredit} · Planespotters.net` : undefined }
            : { tone: "info", title: "Kein Foto gefunden", body: `Planespotters.net kennt kein Foto von ${reg}.` },
        ),
      )
      .catch((e) => showToast({ tone: "err", title: "Foto nicht geladen", body: String(e) }))
      .finally(() => setBusy(false));
  };

  const pickImage = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Bilder", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }] });
    if (typeof path !== "string") return;
    invoke("set_airframe_image", { registration: a.registration, path })
      .then(() => showToast({ tone: "ok", title: "Bild übernommen" }))
      .catch((e) => showToast({ tone: "err", title: "Bild nicht übernommen", body: String(e) }));
  };

  const merge = (into: string | null) => {
    setMerging(false);
    if (!into || into === a.registration) return;
    invoke<{ registration: string }>("merge_airframes", { from: a.registration, into })
      .then((r) => {
        onSelect(r.registration);
        showToast({ tone: "ok", title: `${reg} mit ${priv.mask(r.registration, "registration")} zusammengeführt`, body: `${a.totalFlights} Flüge umgebucht.` });
      })
      .catch((e) => showToast({ tone: "err", title: "Nicht zusammengeführt", body: String(e) }));
  };

  const remove = () =>
    invoke("delete_airframe", { registration: a.registration })
      .then(() => {
        onSelect(null);
        showToast({ tone: "ok", title: `${reg} entfernt`, body: "Die Flüge bleiben im Logbuch, ohne Flugzeug-Zuordnung." });
      })
      .catch((e) => showToast({ tone: "err", title: "Nicht entfernt", body: String(e) }));

  const field = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="af-field">
      <span className="stat-label">{label}</span>
      <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && dirty && save()} {...props} />
    </label>
  );

  return (
    <article className="flight-detail af-detail" aria-label={`Flugzeug ${reg}`}>
      <header className="detail-head">
        <div className="detail-title">
          <h2 className="num">{reg}</h2>
          <div className="detail">
            {[airframeName(a) !== a.registration ? shownAirframeName(a, priv.on) : null, a.icaoType, priv.mask(a.airline, "airline")].filter(Boolean).join(" · ") || "Typ unbekannt"}
          </div>
        </div>
        <div className="detail-actions">
          <button onClick={refreshPhoto} disabled={busy} title={airframePhotos ? "Foto bei Planespotters.net neu suchen" : "Planespotters-Fotos sind in den Einstellungen aus – manuell trotzdem suchen"}>
            {busy ? "Sucht …" : "Foto aktualisieren"}
          </button>
          <button onClick={pickImage}>Bild wählen …</button>
        </div>
      </header>

      <AirframeImage airframe={a} size="large" credit />

      <div className="stat-grid detail-grid">
        <Stat size="sm" label="Flüge" value={fmt(a.flights)} sub={a.totalFlights !== a.flights ? `${a.totalFlights} mit Demo` : undefined} />
        <Stat size="sm" label="Blockzeit" value={fmtDuration(a.blockTimeMs, { seconds: false })} />
        <Stat size="sm" label="Luftzeit" title="Abheben bis Aufsetzen" value={fmtDuration(a.flightTimeMs, { seconds: false })} />
        <Stat size="sm" label="Distanz" value={fmt(a.distanceNm, 0)} unit="nm" />
        <Stat size="sm" label="Landungen" value={fmt(a.landings)} />
        <Stat size="sm" label="Ø Landerate" value={fmt(a.avgLandingVsFpm, 0)} unit="fpm" />
        <Stat size="sm" label="Zuletzt" value={a.lastFlownMs ? fmtDate(a.lastFlownMs) : "–"} />
      </div>

      <div className="detail-section">
        <h3>Angaben</h3>
        <div className="af-form">
          {field("customName", "Eigener Name", { placeholder: "z. B. „Kranich“" })}
          {field("icaoType", "ICAO-Typ", { placeholder: "z. B. A20N", maxLength: 4, className: "mono" })}
          {field("airline", "Airline", { placeholder: "z. B. DLH oder Lufthansa", ...(priv.on ? { type: "password", autoComplete: "off", title: "Im Streamer-Modus verdeckt" } : {}) })}
          {field("vappKt", "Vapp (kt) – für die Anflugbewertung", {
            placeholder: "leer = geflogener Wert",
            inputMode: "numeric",
            className: "num",
            title: "Anfluggeschwindigkeit dieses Flugzeugs. Leer: VectaSim nimmt den Median der geflogenen IAS als Referenz.",
          })}
          <label className="af-field af-notes">
            <span className="stat-label">Notizen</span>
            <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
        </div>
        {a.title && <div className="detail">Simulator-Titel: {a.title}</div>}
        <div className="af-form-actions">
          <button className="btn-primary" onClick={save} disabled={!dirty}>
            Speichern
          </button>
          {dirty && <button onClick={() => setForm(initial())}>Verwerfen</button>}
          <span className="spacer" />
          <button className="btn-sm" onClick={() => setMerging(!merging)} aria-expanded={merging} title="Alle Flüge auf ein anderes Flugzeug umbuchen und dieses entfernen">
            Zusammenführen …
          </button>
          {confirmDelete ? (
            <span className="confirm-delete" role="group" aria-label="Entfernen bestätigen">
              <span className="detail">Flugzeug entfernen?</span>
              <button className="btn-sm danger" onClick={remove} autoFocus>
                Ja
              </button>
              <button className="btn-sm" onClick={() => setConfirmDelete(false)}>
                Nein
              </button>
            </span>
          ) : (
            <button className="btn-sm danger" onClick={() => setConfirmDelete(true)}>
              Entfernen
            </button>
          )}
        </div>
        {merging && (
          <div className="af-merge">
            <div className="detail">Flüge von {reg} umbuchen auf:</div>
            <AirframePicker current={a.registration} onPick={merge} onCancel={() => setMerging(false)} />
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>Flüge mit {reg}</h3>
        {flights === null ? (
          <div className="detail">Lädt …</div>
        ) : flights.length === 0 ? (
          <div className="detail">Noch keine Flüge mit diesem Flugzeug. Im Logbuch kannst du Flüge über „Flugzeug ändern“ zuordnen.</div>
        ) : (
          <table className="mini-table af-flights">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Route</th>
                <th className="right">Block</th>
                <th className="right">Landerate</th>
              </tr>
            </thead>
            <tbody>
              {flights.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => navigate({ kind: "flight", id: f.id })} title="Im Logbuch öffnen">
                  <td className="num">{fmtDate(f.offBlockMs ?? f.createdMs)}</td>
                  <td className="num">
                    {f.depIcao ?? "····"} → {f.arrIcao ?? "····"}
                    {f.provider === "mock" && <span className="badge badge-demo badge-inline">Demo</span>}
                  </td>
                  <td className="num right">{f.onBlockMs && f.offBlockMs ? fmtDuration(f.onBlockMs - f.offBlockMs, { seconds: false }) : "–"}</td>
                  <td className={`num right${(f.landingVsFpm ?? 0) <= -600 ? " warn-text" : ""}`}>{fmt(f.landingVsFpm, 0, "fpm")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </article>
  );
}
