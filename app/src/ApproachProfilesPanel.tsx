import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useT, type TFunction, type TKey } from "./i18n";
import Panel from "./ui/Panel";
import { showToast } from "./ui/Toast";
import { rawText, userMessage } from "./errors";
import { errorToast } from "./ui/errorToast";
import { focusAfter } from "./ui/focusAfter";
import { usePrivacy } from "./prefs";
import {
  isBuiltinProfile,
  profileDiffLines,
  profileName,
  profileValueText,
  reloadApproachProfiles,
  useApproachProfilesState,
  type ApproachProfileInfo,
  type BuiltinProfileId,
  type ProfileKey,
} from "./landing/approachProfiles";

interface ProfileImport {
  profile: ApproachProfileInfo;
  replaced: boolean;
}

/** Source line of a built-in profile (approach_profile.rs BUILTINS), in the UI language. */
const BUILTIN_SOURCE: Record<BuiltinProfileId, TKey> = {
  generic: "approach.assessment.source.generic",
  airbus: "approach.assessment.source.airbus",
  boeing: "approach.assessment.source.boeing",
  turboprop: "approach.assessment.source.turboprop",
  ga_piston: "approach.assessment.source.ga_piston",
};

/** Source of each built-in value (the rows of docs/approach-profiles-sources.md, by their ids). */
const BUILTIN_KEY_SOURCE: Partial<Record<BuiltinProfileId, Partial<Record<ProfileKey, TKey>>>> = {
  airbus: { gateSpeedAboveKt: "approach.assessment.sourceKey.airbus.gateSpeedAboveKt" },
  turboprop: {
    gateSpeedAboveKt: "approach.assessment.sourceKey.turboprop.gateSpeedAboveKt",
    thrustCheck: "approach.assessment.sourceKey.turboprop.thrustCheck",
  },
  ga_piston: {
    gateSpeedAboveKt: "approach.assessment.sourceKey.ga_piston.gateSpeedAboveKt",
    speedS1AboveKt: "approach.assessment.sourceKey.ga_piston.speedS1AboveKt",
    speedS2AboveKt: "approach.assessment.sourceKey.ga_piston.speedS2AboveKt",
    vsS1Fpm: "approach.assessment.sourceKey.ga_piston.vsS1Fpm",
    vsS2Fpm: "approach.assessment.sourceKey.ga_piston.vsS2Fpm",
    configGateFt: "approach.assessment.sourceKey.ga_piston.configGateFt",
    hardGateFt: "approach.assessment.sourceKey.ga_piston.hardGateFt",
  },
};

/**
 * Where a profile's values come from: the i18n text for a built-in (the backend's English line
 * with its internal row shorthand only as a fallback for an id the frontend does not know), a
 * custom profile's own `source` as written.
 */
export function profileSourceText(p: ApproachProfileInfo, t: TFunction): string | null {
  if (p.builtin && isBuiltinProfile(p.id)) return t(BUILTIN_SOURCE[p.id]);
  return p.source || null;
}

/** Source of one built-in value; null without one. */
export function profileKeySourceText(p: ApproachProfileInfo, key: ProfileKey, t: TFunction): string | null {
  const k = p.builtin && isBuiltinProfile(p.id) ? BUILTIN_KEY_SOURCE[p.id]?.[key] : undefined;
  if (k) return t(k);
  return p.sources?.[key] || null;
}

/** "Profile not imported: …" from the store (lang::ui_error, already in the UI language). */
const PROFILE_INVALID_RE = /^\s*(Profil nicht importiert|Profile not imported)\s*:\s*/i;

/**
 * Toast for a failed import: a refused profile (unknown key, value out of range …) keeps its
 * readable reason as the text; a file error gets a plain explanation, the technical text (with
 * the path, masked in the Streamer-Modus) only behind "Details".
 */
export function importErrorToast(e: unknown, t: TFunction, maskPath: (s: string) => string) {
  const title = t("settings.approachProfiles.importFailed");
  const raw = rawText(e);
  if (PROFILE_INVALID_RE.test(raw)) {
    const reason = maskPath(raw.replace(PROFILE_INVALID_RE, ""));
    return { title, body: reason, announce: `${title}. ${reason}` };
  }
  // a recognised cause (path not allowed, access denied) keeps its own next step
  const known = userMessage(e, "settings").hint !== t("errors.unexpected.hint");
  return errorToast(title, e, "settings", { hint: known ? undefined : t("settings.approachProfiles.importFileError"), maskDetail: maskPath });
}

/** The values of one profile that differ from generic, with the source row of each built-in value. */
function ProfileValues({ p, t }: { p: ApproachProfileInfo; t: TFunction }) {
  if (p.effective.length === 0) return <div className="detail">{t("approach.assessment.sameAsGeneric")}</div>;
  if (!p.builtin) {
    return (
      <ul className="ap-values">
        {profileDiffLines(p, t).map((l) => (
          <li key={l} className="num">
            {l}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="ap-values">
      {p.effective.map((e) => (
        <li key={e.key} className="num">
          {t("approach.assessment.valueChange", {
            label: t(`approach.assessment.key.${e.key}`),
            value: profileValueText(e.key, e.value, t),
            generic: profileValueText(e.key, e.generic, t),
          })}
          {profileKeySourceText(p, e.key, t) && <span className="detail"> – {profileKeySourceText(p, e.key, t)}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings → "Approach assessment": the built-in profiles with the values that differ from the
 * generic FSF/EASA set and their sources, how the automatic choice works, and the imported
 * custom profiles (import a JSON file, delete). The format: docs/approach-profiles.md.
 */
export default function ApproachProfilesPanel() {
  const t = useT();
  const { status, list: profiles } = useApproachProfilesState();
  const priv = usePrivacy();
  const maskPath = (s: string) => priv.mask(s, "path");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  // the confirmation replaces the focused button: "Behalten" goes back to the entry's
  // "Löschen", a deletion (the entry goes away) to "Importieren"
  const importRef = useRef<HTMLButtonElement>(null);
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());

  const importFile = async () => {
    const path = await openFileDialog({ multiple: false, directory: false, filters: [{ name: t("settings.approachProfiles.fileFilter"), extensions: ["json"] }] });
    if (typeof path !== "string") return;
    setBusy(true);
    invoke<ProfileImport>("import_approach_profile", { path })
      .then((r) => {
        reloadApproachProfiles();
        showToast({
          tone: "ok",
          title: t(r.replaced ? "settings.approachProfiles.replaced" : "settings.approachProfiles.imported", { name: r.profile.name }),
          body: t("settings.approachProfiles.importedBody"),
        });
      })
      // the store names the reason (unknown key, value out of range, invalid id …); file errors carry the path
      .catch((e) => showToast({ tone: "err", ...importErrorToast(e, t, maskPath), durationMs: 10000 }))
      .finally(() => setBusy(false));
  };

  const remove = (p: ApproachProfileInfo) => {
    focusAfter(
      () => setConfirm(null),
      () => importRef.current,
    );
    invoke<boolean>("delete_approach_profile", { id: p.id })
      .then(() => {
        reloadApproachProfiles();
        showToast({ tone: "ok", title: t("settings.approachProfiles.deleted", { name: p.name }) });
      })
      .catch((e) => showToast({ tone: "err", ...errorToast(t("settings.approachProfiles.deleteFailed"), e, "settings", { maskDetail: maskPath }) }));
  };

  const builtins = profiles?.profiles.filter((p) => p.builtin) ?? [];
  const custom = profiles?.profiles.filter((p) => !p.builtin) ?? [];

  return (
    <Panel title={t("settings.approachProfiles.title")} description={t("settings.approachProfiles.description")} collapsible defaultOpen={false} className="settings-wide">
      <h3 className="data-head">{t("settings.approachProfiles.autoTitle")}</h3>
      <p className="detail">{t("settings.approachProfiles.auto")}</p>
      <p className="detail">{t("settings.approachProfiles.vapp")}</p>

      <h3 className="data-head">{t("settings.approachProfiles.builtinTitle")}</h3>
      {!profiles ? (
        status === "error" ? (
          <div className="setting-row" role="alert">
            <span className="detail warn-text">{t("settings.approachProfiles.loadFailed")}</span>
            <button className="btn-sm" onClick={() => reloadApproachProfiles()}>
              {t("settings.approachProfiles.retry")}
            </button>
          </div>
        ) : (
          <div className="detail" role="status">
            {t("settings.approachProfiles.loading")}
          </div>
        )
      ) : (
        <div className="ap-list">
          {builtins.map((p) => (
            <div key={p.id} className="ap-item">
              <div className="ap-head">
                <strong>{profileName(p.id, profiles, t)}</strong>
              </div>
              <ProfileValues p={p} t={t} />
              {profileSourceText(p, t) && <div className="detail">{t("settings.approachProfiles.source", { source: profileSourceText(p, t)! })}</div>}
            </div>
          ))}
        </div>
      )}

      <h3 className="data-head">{t("settings.approachProfiles.customTitle")}</h3>
      {profiles && custom.length === 0 && <p className="detail">{t("settings.approachProfiles.customEmpty")}</p>}
      {profiles && custom.length > 0 && (
        <div className="ap-list">
          {custom.map((p) => (
            <div key={p.id} className="ap-item">
              <div className="ap-head">
                <strong>{p.name}</strong> <span className="detail mono">{p.id}</span>
                <span className="spacer" />
                {confirm === p.id ? (
                  <span className="confirm-delete" role="group" aria-label={t("settings.approachProfiles.confirmDelete", { name: p.name })}>
                    <span className="detail">{t("settings.approachProfiles.confirmDelete", { name: p.name })}</span>
                    <button className="btn-sm danger" onClick={() => remove(p)} autoFocus>
                      {t("settings.approachProfiles.delete")}
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() =>
                        focusAfter(
                          () => setConfirm(null),
                          () => deleteRefs.current.get(p.id),
                        )
                      }
                    >
                      {t("settings.approachProfiles.keep")}
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn-sm"
                    ref={(el) => {
                      if (el) deleteRefs.current.set(p.id, el);
                      else deleteRefs.current.delete(p.id);
                    }}
                    onClick={() => setConfirm(p.id)}
                  >
                    {t("settings.approachProfiles.delete")}
                  </button>
                )}
              </div>
              {p.basedOn && <div className="detail">{t("approach.assessment.basedOn", { name: profileName(p.basedOn, profiles, t) })}</div>}
              <ProfileValues p={p} t={t} />
              {profileSourceText(p, t) && <div className="detail">{t("settings.approachProfiles.source", { source: profileSourceText(p, t)! })}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="setting-row">
        <button ref={importRef} onClick={() => void importFile()} disabled={busy} title={t("settings.approachProfiles.importTitle")}>
          {t("settings.approachProfiles.import")}
        </button>
        <span className="detail">{t("settings.approachProfiles.format")}</span>
      </div>
    </Panel>
  );
}
