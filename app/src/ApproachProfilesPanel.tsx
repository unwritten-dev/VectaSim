import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useT, type TFunction } from "./i18n";
import Panel from "./ui/Panel";
import { showToast } from "./ui/Toast";
import { rawText } from "./errors";
import {
  profileDiffLines,
  profileName,
  profileValueText,
  reloadApproachProfiles,
  useApproachProfiles,
  type ApproachProfileInfo,
} from "./landing/approachProfiles";

interface ProfileImport {
  profile: ApproachProfileInfo;
  replaced: boolean;
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
          {p.sources?.[e.key] && <span className="detail"> – {p.sources[e.key]}</span>}
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
  const profiles = useApproachProfiles();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

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
      // the store names the reason (unknown key, value out of range, invalid id …)
      .catch((e) => showToast({ tone: "err", title: t("settings.approachProfiles.importFailed"), body: rawText(e), durationMs: 10000 }))
      .finally(() => setBusy(false));
  };

  const remove = (p: ApproachProfileInfo) => {
    setConfirm(null);
    invoke<boolean>("delete_approach_profile", { id: p.id })
      .then(() => {
        reloadApproachProfiles();
        showToast({ tone: "ok", title: t("settings.approachProfiles.deleted", { name: p.name }) });
      })
      .catch((e) => showToast({ tone: "err", title: t("settings.approachProfiles.deleteFailed"), body: rawText(e) }));
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
        <div className="detail">{t("settings.approachProfiles.loading")}</div>
      ) : (
        <div className="ap-list">
          {builtins.map((p) => (
            <div key={p.id} className="ap-item">
              <div className="ap-head">
                <strong>{profileName(p.id, profiles, t)}</strong>
              </div>
              <ProfileValues p={p} t={t} />
              {p.source && <div className="detail">{t("settings.approachProfiles.source", { source: p.source })}</div>}
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
                    <button className="btn-sm" onClick={() => setConfirm(null)}>
                      {t("settings.approachProfiles.keep")}
                    </button>
                  </span>
                ) : (
                  <button className="btn-sm" onClick={() => setConfirm(p.id)}>
                    {t("settings.approachProfiles.delete")}
                  </button>
                )}
              </div>
              {p.basedOn && <div className="detail">{t("approach.assessment.basedOn", { name: profileName(p.basedOn, profiles, t) })}</div>}
              <ProfileValues p={p} t={t} />
              {p.source && <div className="detail">{t("settings.approachProfiles.source", { source: p.source })}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="setting-row">
        <button onClick={() => void importFile()} disabled={busy} title={t("settings.approachProfiles.importTitle")}>
          {t("settings.approachProfiles.import")}
        </button>
        <span className="detail">{t("settings.approachProfiles.format")}</span>
      </div>
    </Panel>
  );
}
