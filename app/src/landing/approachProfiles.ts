// Approach assessment profiles (`approach_profiles`, app/src-tauri/src/approach.rs; rules in
// crates/vectasim-core/src/approach_profile.rs, documented in docs/approach-profiles.md): a
// small set of thresholds over the generic FSF/EASA default. One shared list for every
// consumer, reloaded on `approach:profiles` (import / delete). Names of the built-ins come from
// i18n, custom profiles carry their own.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t, type TFunction } from "../i18n";
import { fmt, fmtNum } from "../i18n/number";

export const BUILTIN_PROFILES = ["generic", "airbus", "boeing", "turboprop", "ga_piston"] as const;
export type BuiltinProfileId = (typeof BUILTIN_PROFILES)[number];
export const GENERIC_PROFILE: BuiltinProfileId = "generic";

/** Every key a profile may set (OVERRIDE_KEYS in Rust, same order). */
export const PROFILE_KEYS = [
  "gateSpeedAboveKt",
  "gateSpeedBelowKt",
  "gateMaxVsFpm",
  "gateMaxBankDeg",
  "gateDots",
  "speedS1AboveKt",
  "speedS1BelowKt",
  "speedS2AboveKt",
  "speedS2BelowKt",
  "speedDurationS",
  "vsS1Fpm",
  "vsS2Fpm",
  "vsS1DurationS",
  "vsS2DurationS",
  "bankS1Deg",
  "bankS2Deg",
  "bankDurationS",
  "gsS1Dots",
  "gsS2Dots",
  "gsDurationS",
  "locS1Dots",
  "locS2Dots",
  "locDurationS",
  "momentaryS",
  "configGateFt",
  "hardGateFt",
  "windowTopFt",
  "thrustCheck",
  "thrustMinN1Pct",
  "thrustDurationS",
  "spoilersMaxPct",
  "statsSpeedAboveKt",
  "statsSpeedBelowKt",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export type OverrideValue = number | boolean;

export interface ProfileKeySpec {
  key: ProfileKey;
  kind: "number" | "bool";
  min?: number;
  max?: number;
  unit?: string;
}

export interface EffectiveValue {
  key: ProfileKey;
  value: OverrideValue;
  /** The generic value it replaces. */
  generic: OverrideValue | null;
}

export interface ApproachProfileInfo {
  id: string;
  name: string;
  basedOn?: string | null;
  source?: string | null;
  overrides: Partial<Record<ProfileKey, OverrideValue>>;
  /** Built-ins: source row per overridden key (docs/approach-profiles-sources.md). */
  sources?: Partial<Record<ProfileKey, string>>;
  builtin: boolean;
  /** Effective values that differ from generic (a custom profile's base included). */
  effective: EffectiveValue[];
}

export interface ApproachProfilesResult {
  profiles: ApproachProfileInfo[];
  keys: ProfileKeySpec[];
}

// ---- shared list ----------------------------------------------------------------------------

let list: ApproachProfilesResult | null = null;
const subs = new Set<() => void>();
let unlisten: Promise<() => void> | null = null;
let loading = false;

function load() {
  if (loading) return;
  loading = true;
  invoke<ApproachProfilesResult>("approach_profiles")
    .then((r) => {
      list = r;
      subs.forEach((s) => s());
    })
    // without the list the names fall back to the ids / built-in names
    .catch(() => {})
    .finally(() => {
      loading = false;
    });
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) {
    unlisten = listen("approach:profiles", load);
    load();
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0) {
      unlisten?.then((f) => f()).catch(() => {});
      unlisten = null;
    }
  };
}

const snapshot = () => list;

/** The built-in and imported profiles (null while loading), kept fresh by `approach:profiles`. */
export function useApproachProfiles(): ApproachProfilesResult | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Reload after an import / delete in this window (the event does it for the others too). */
export const reloadApproachProfiles = load;

// ---- texts ----------------------------------------------------------------------------------

export const isBuiltinProfile = (id: string): id is BuiltinProfileId => (BUILTIN_PROFILES as readonly string[]).includes(id);

/** Profile id of a fact / analysis; missing (cached before profiles) = generic. */
export const profileOf = (x: { profileId?: string | null } | null | undefined): string => x?.profileId || GENERIC_PROFILE;

/** "Airbus-style profile", a custom profile's own name, or its id when it is gone. */
export function profileName(id: string | null | undefined, profiles: ApproachProfilesResult | null, tr: TFunction = t): string {
  const pid = id || GENERIC_PROFILE;
  if (isBuiltinProfile(pid)) return tr(`approach.assessment.name.${pid}`);
  const p = profiles?.profiles.find((x) => x.id === pid);
  return p ? p.name : tr("approach.assessment.unknown", { id: pid });
}

const isProfileKey = (k: string): k is ProfileKey => (PROFILE_KEYS as readonly string[]).includes(k);

/** A value with its unit: "10 kt", "300 ft", "off". */
export function profileValueText(key: ProfileKey, v: OverrideValue | null | undefined, tr: TFunction = t): string {
  if (typeof v === "boolean") return tr(v ? "approach.assessment.on" : "approach.assessment.off");
  if (v == null) return "–";
  if (key.endsWith("Kt")) return fmt(v, 0, "kt");
  if (key.endsWith("Fpm")) return fmt(v, 0, "fpm");
  if (key.endsWith("Ft")) return fmt(v, 0, "ft");
  if (key.endsWith("Deg")) return fmt(v, 0, "°");
  if (key.endsWith("Dots")) return `${fmtNum(v, Number.isInteger(v) ? 0 : 2)} ${tr("approach.common.dots")}`;
  if (key.endsWith("Pct")) return fmt(v, 0, "%");
  if (key.endsWith("S")) return fmt(v, 0, "s");
  return fmtNum(v, 2);
}

/** "Gate speed above Vapp: 10 kt (generic 20 kt)" per value that differs from generic. */
export function profileDiffLines(p: ApproachProfileInfo | null | undefined, tr: TFunction = t): string[] {
  if (!p) return [];
  return p.effective
    .filter((e) => isProfileKey(e.key))
    .map((e) =>
      tr("approach.assessment.valueChange", {
        label: tr(`approach.assessment.key.${e.key}`),
        value: profileValueText(e.key, e.value, tr),
        generic: profileValueText(e.key, e.generic, tr),
      }),
    );
}

/** Tooltip of "Assessed with …": the values that differ from generic, or that there are none. */
export function profileTooltip(id: string | null | undefined, profiles: ApproachProfilesResult | null, tr: TFunction = t): string {
  const pid = id || GENERIC_PROFILE;
  const p = profiles?.profiles.find((x) => x.id === pid) ?? null;
  const head: string[] = [];
  if (p && !p.builtin && p.basedOn) head.push(tr("approach.assessment.basedOn", { name: profileName(p.basedOn, profiles, tr) }));
  const lines = profileDiffLines(p, tr);
  if (!p) return [tr("approach.assessment.assessedWith", { name: profileName(pid, profiles, tr) })].join("\n");
  if (lines.length === 0) return [...head, tr("approach.assessment.sameAsGeneric")].join("\n");
  return [...head, tr("approach.assessment.differs"), ...lines.map((l) => `· ${l}`)].join("\n");
}

/** Hard gate of an analysis / fact, ft (500 when not stated). */
export const hardGateOf = (x: { hardGateFt?: number | null } | null | undefined): number => x?.hardGateFt ?? 500;
