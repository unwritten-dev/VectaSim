import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AirframeEdit, AirframeRow, FlightRow } from "./types";
import { fmt, fmtDate, fmtDuration } from "./i18n/number";
import { useT } from "./i18n";
import ErrorNotice from "./ErrorNotice";
import { setPref, usePrefs, usePrivacy } from "./prefs";
import Stat from "./ui/Stat";
import EmptyState from "./ui/EmptyState";
import { showToast } from "./ui/Toast";
import AirframeImage from "./airframes/AirframeImage";
import AirframePicker from "./airframes/AirframePicker";
import { LANDING_FLAPS_MAX, VAPP_MAX_KT, VAPP_MIN_KT, airframeName, matchesAirframe, normalizeRegistration, parseLandingFlaps, parseVapp, shownAirframeName } from "./airframes/airframe";
import { useAirframes } from "./airframes/hooks";
import { navigate } from "./airframes/navigation";
import { errorToast } from "./ui/errorToast";

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
  const t = useT();
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
      showToast({ tone: "warn", title: t("logbook.fleet.invalidReg"), body: t("logbook.fleet.invalidRegBody") });
      return;
    }
    invoke("upsert_airframe", { edit: { registration: reg } satisfies AirframeEdit })
      .then(() => {
        setAdding(false);
        setNewReg("");
        setSelected(reg);
      })
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.fleet.addFailed"), e, "logbook") }));
  };

  if (rows && rows.length === 0 && !adding) {
    return (
      <section className="logbook-view">
        {error && <ErrorNotice error={error} context="logbook" onRetry={refresh} />}
        <EmptyState
          icon={PLANE_ICON}
          title={t("logbook.fleet.emptyTitle")}
          text={t("logbook.fleet.emptyText")}
          actions={<button onClick={() => setAdding(true)}>{t("logbook.fleet.add")}</button>}
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
          placeholder={t("logbook.fleet.searchPlaceholder")}
          aria-label={t("logbook.fleet.searchLabel")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="spacer" />
        {adding ? (
          <span className="af-add" role="group" aria-label={t("logbook.fleet.add")}>
            <input
              autoFocus
              value={newReg}
              placeholder={t("logbook.fleet.regPlaceholder")}
              aria-label={t("logbook.fleet.reg")}
              onChange={(e) => setNewReg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <button className="btn-primary" onClick={add}>
              {t("logbook.fleet.create")}
            </button>
            <button onClick={() => setAdding(false)}>{t("logbook.fleet.cancel")}</button>
          </span>
        ) : (
          <button onClick={() => setAdding(true)}>{t("logbook.fleet.add")}</button>
        )}
      </div>

      <div className="master-detail">
        <div className="master">
          <div className="master-head detail num" aria-live="polite">
            {rows ? (
              <>
                {t("logbook.fleet.count", { count: shown.length })}
                {demoOnly > 0 && (
                  <>
                    {" "}
                    · {t("logbook.fleet.demoOnlyHidden", { count: demoOnly })}{" "}
                    <button className="link-btn" onClick={() => setPref("showDemo", true).catch(() => {})}>
                      {t("logbook.fleet.show")}
                    </button>
                  </>
                )}
              </>
            ) : (
              t("logbook.fleet.loading")
            )}
          </div>
          <div className="flight-list" role="listbox" aria-label={t("logbook.fleet.listLabel")}>
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
                      <span>{t("count.flights", { count: r.flights })}</span>
                      <span>{t("logbook.fleet.block", { duration: fmtDuration(r.blockTimeMs, { seconds: false }) })}</span>
                      <span>{t("logbook.fleet.landings", { count: r.landings })}</span>
                      <span className="af-avg" title={t("logbook.fleet.avgTitle")}>Ø {fmt(r.avgLandingVsFpm, 0, "fpm")}</span>
                      <span className="spacer" />
                      <span className="af-last">{r.lastFlownMs ? fmtDate(r.lastFlownMs) : t("logbook.fleet.neverFlown")}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {rows && shown.length === 0 && <EmptyState compact title={t("logbook.fleet.noMatchTitle")} text={t("logbook.fleet.noMatchText")} />}
          </div>
        </div>
        <div className="detail-pane">
          {current ? <AirframeDetail key={current.registration} row={current} onSelect={setSelected} /> : <div className="detail-loading detail">{t("logbook.fleet.pick")}</div>}
        </div>
      </div>
    </section>
  );
}

function AirframeDetail({ row: a, onSelect }: { row: AirframeRow; onSelect: (reg: string | null) => void }) {
  const priv = usePrivacy();
  const t = useT();
  /** The registration as shown (D-•••• in the Streamer-Modus). */
  const reg = priv.mask(a.registration, "registration");
  const initial = () => ({
    customName: a.customName ?? "",
    icaoType: a.icaoType ?? "",
    airline: a.airline ?? "",
    notes: a.notes ?? "",
    vappKt: a.vappKt != null ? String(Math.round(a.vappKt)) : "",
    landingFlaps: a.landingFlaps != null ? String(a.landingFlaps) : "",
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
      showToast({ tone: "warn", title: t("logbook.fleet.vappInvalid"), body: t("logbook.fleet.vappInvalidBody", { min: VAPP_MIN_KT, max: VAPP_MAX_KT }) });
      return;
    }
    const flaps = parseLandingFlaps(form.landingFlaps);
    if (flaps === undefined) {
      showToast({ tone: "warn", title: t("logbook.fleet.flapsInvalid"), body: t("logbook.fleet.flapsInvalidBody", { max: LANDING_FLAPS_MAX }) });
      return;
    }
    const { customName, icaoType, airline, notes } = form;
    // 0 clears the stored Vapp, −1 the landing flaps (the backend's conventions)
    invoke("upsert_airframe", {
      edit: { registration: a.registration, customName, icaoType, airline, notes, vappKt: vapp ?? 0, landingFlaps: flaps ?? -1 } satisfies AirframeEdit,
    })
      .then(() => showToast({ tone: "ok", title: t("logbook.fleet.saved", { reg }) }))
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.fleet.saveFailed"), e, "logbook") }));
  };

  const refreshPhoto = () => {
    setBusy(true);
    invoke<AirframeRow | null>("airframe_photo", { registration: a.registration, refresh: true })
      .then((r) =>
        showToast(
          r?.imageSource === "planespotters"
            ? { tone: "ok", title: t("logbook.fleet.photoUpdated"), body: r.imageCredit ? `© ${r.imageCredit} · Planespotters.net` : undefined }
            : { tone: "info", title: t("logbook.fleet.noPhoto"), body: t("logbook.fleet.noPhotoBody", { reg }) },
        ),
      )
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.fleet.photoFailed"), e, "logbook") }))
      .finally(() => setBusy(false));
  };

  const pickImage = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: t("logbook.fleet.images"), extensions: ["jpg", "jpeg", "png", "webp", "gif"] }] });
    if (typeof path !== "string") return;
    invoke("set_airframe_image", { registration: a.registration, path })
      .then(() => showToast({ tone: "ok", title: t("logbook.fleet.imageSet") }))
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.fleet.imageFailed"), e, "logbook") }));
  };

  const merge = (into: string | null) => {
    setMerging(false);
    if (!into || into === a.registration) return;
    invoke<{ registration: string }>("merge_airframes", { from: a.registration, into })
      .then((r) => {
        onSelect(r.registration);
        showToast({ tone: "ok", title: t("logbook.fleet.merged", { reg, into: priv.mask(r.registration, "registration") }), body: t("logbook.fleet.mergedBody", { count: a.totalFlights }) });
      })
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.fleet.mergeFailed"), e, "logbook") }));
  };

  const remove = () =>
    invoke("delete_airframe", { registration: a.registration })
      .then(() => {
        onSelect(null);
        showToast({ tone: "ok", title: t("logbook.fleet.removed", { reg }), body: t("logbook.fleet.removedBody") });
      })
      .catch((e) => showToast({ tone: "err", ...errorToast(t("logbook.fleet.removeFailed"), e, "logbook") }));

  const field = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="af-field">
      <span className="stat-label">{label}</span>
      <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && dirty && save()} {...props} />
    </label>
  );

  return (
    <article className="flight-detail af-detail" aria-label={t("logbook.fleet.ariaLabel", { reg })}>
      <header className="detail-head">
        <div className="detail-title">
          <h2 className="num">{reg}</h2>
          <div className="detail">
            {[airframeName(a) !== a.registration ? shownAirframeName(a, priv.on) : null, a.icaoType, priv.mask(a.airline, "airline")].filter(Boolean).join(" · ") || t("logbook.fleet.typeUnknown")}
          </div>
        </div>
        <div className="detail-actions">
          <button onClick={refreshPhoto} disabled={busy} title={airframePhotos ? t("logbook.fleet.photoSearchTitle") : t("logbook.fleet.photoSearchOffTitle")}>
            {busy ? t("logbook.fleet.searching") : t("logbook.fleet.refreshPhoto")}
          </button>
          <button onClick={pickImage}>{t("logbook.fleet.pickImage")}</button>
        </div>
      </header>

      <AirframeImage airframe={a} size="large" credit />

      <div className="stat-grid detail-grid">
        <Stat size="sm" label={t("logbook.fleet.statFlights")} value={fmt(a.flights)} sub={a.totalFlights !== a.flights ? t("logbook.fleet.withDemo", { count: a.totalFlights }) : undefined} />
        <Stat size="sm" label={t("logbook.fleet.statBlock")} value={fmtDuration(a.blockTimeMs, { seconds: false })} />
        <Stat size="sm" label={t("logbook.fleet.statAir")} title={t("logbook.fleet.statAirTitle")} value={fmtDuration(a.flightTimeMs, { seconds: false })} />
        <Stat size="sm" label={t("logbook.fleet.statDistance")} value={fmt(a.distanceNm, 0)} unit="nm" />
        <Stat size="sm" label={t("logbook.fleet.statLandings")} value={fmt(a.landings)} />
        <Stat size="sm" label={t("logbook.fleet.statAvgRate")} value={fmt(a.avgLandingVsFpm, 0)} unit="fpm" />
        <Stat size="sm" label={t("logbook.fleet.statLast")} value={a.lastFlownMs ? fmtDate(a.lastFlownMs) : "–"} />
      </div>

      <div className="detail-section">
        <h3>{t("logbook.fleet.details")}</h3>
        <div className="af-form">
          {field("customName", t("logbook.fleet.customName"), { placeholder: t("logbook.fleet.customNamePlaceholder") })}
          {field("icaoType", t("logbook.fleet.icaoType"), { placeholder: t("logbook.fleet.icaoTypePlaceholder"), maxLength: 4, className: "mono" })}
          {field("airline", t("logbook.fleet.airline"), { placeholder: t("logbook.fleet.airlinePlaceholder"), ...(priv.on ? { type: "password", autoComplete: "off", title: t("logbook.fleet.streamerHidden") } : {}) })}
          {field("vappKt", t("logbook.fleet.vapp"), {
            placeholder: t("logbook.fleet.vappPlaceholder"),
            inputMode: "numeric",
            className: "num",
            title: t("logbook.fleet.vappTitle"),
          })}
          {field("landingFlaps", t("logbook.fleet.flaps"), {
            placeholder: t("logbook.fleet.flapsPlaceholder"),
            inputMode: "numeric",
            className: "num",
            title: t("logbook.fleet.flapsTitle"),
          })}
          <label className="af-field af-notes">
            <span className="stat-label">{t("logbook.fleet.notes")}</span>
            <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
        </div>
        {a.title && <div className="detail">{t("logbook.fleet.simTitle", { title: a.title })}</div>}
        <div className="af-form-actions">
          <button className="btn-primary" onClick={save} disabled={!dirty}>
            {t("logbook.fleet.save")}
          </button>
          {dirty && <button onClick={() => setForm(initial())}>{t("logbook.fleet.discard")}</button>}
          <span className="spacer" />
          <button className="btn-sm" onClick={() => setMerging(!merging)} aria-expanded={merging} title={t("logbook.fleet.mergeTitle")}>
            {t("logbook.fleet.merge")}
          </button>
          {confirmDelete ? (
            <span className="confirm-delete" role="group" aria-label={t("logbook.fleet.confirmRemoveLabel")}>
              <span className="detail">{t("logbook.fleet.confirmRemove")}</span>
              <button className="btn-sm danger" onClick={remove} autoFocus>
                {t("logbook.fleet.yes")}
              </button>
              <button className="btn-sm" onClick={() => setConfirmDelete(false)}>
                {t("logbook.fleet.no")}
              </button>
            </span>
          ) : (
            <button className="btn-sm danger" onClick={() => setConfirmDelete(true)}>
              {t("logbook.fleet.remove")}
            </button>
          )}
        </div>
        {merging && (
          <div className="af-merge">
            <div className="detail">{t("logbook.fleet.mergeInto", { reg })}</div>
            <AirframePicker current={a.registration} onPick={merge} onCancel={() => setMerging(false)} />
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>{t("logbook.fleet.flightsWith", { reg })}</h3>
        {flights === null ? (
          <div className="detail">{t("logbook.fleet.loadingShort")}</div>
        ) : flights.length === 0 ? (
          <div className="detail">{t("logbook.fleet.noFlights")}</div>
        ) : (
          <table className="mini-table af-flights">
            <thead>
              <tr>
                <th>{t("logbook.fleet.colDate")}</th>
                <th>{t("logbook.fleet.colRoute")}</th>
                <th className="right">{t("logbook.fleet.colBlock")}</th>
                <th className="right">{t("logbook.fleet.colRate")}</th>
              </tr>
            </thead>
            <tbody>
              {flights.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => navigate({ kind: "flight", id: f.id })} title={t("logbook.fleet.openInLogbook")}>
                  <td className="num">{fmtDate(f.offBlockMs ?? f.createdMs)}</td>
                  <td className="num">
                    {f.depIcao ?? "····"} → {f.arrIcao ?? "····"}
                    {f.provider === "mock" && <span className="badge badge-demo badge-inline">{t("logbook.detail.demo")}</span>}
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
