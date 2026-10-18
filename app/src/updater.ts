// In-app updates via tauri-plugin-updater: the app polls latest.json on GitHub
// Releases (signed with the key in tauri.conf.json → plugins.updater.pubkey),
// downloads the NSIS installer and relaunches. State lives in a tiny module
// store so Einstellungen and the start-up toast share one source of truth.

import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./ui/Toast";
import { userMessage } from "./errors";

export type UpdatePhase = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** Version offered by the server, when one is available. */
  version?: string;
  notes?: string;
  date?: string;
  /** 0–1 while downloading. */
  progress?: number;
  error?: string;
  checkedMs?: number;
}

let state: UpdateState = { phase: "idle" };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/**
 * Ask GitHub for a newer release. `silent` suppresses the "already current" and
 * error toasts (used for the automatic check at start-up).
 */
export async function checkForUpdate(opts: { silent?: boolean } = {}): Promise<UpdateState> {
  if (state.phase === "checking" || state.phase === "downloading") return state;
  set({ phase: "checking", error: undefined });
  try {
    const update = await check({ timeout: 15_000 });
    const checkedMs = Date.now();
    if (!update) {
      pending = null;
      set({ phase: "none", version: undefined, checkedMs });
      if (!opts.silent) showToast({ id: "update", tone: "ok", title: "VectaSim ist aktuell", durationMs: 4000 });
      return state;
    }
    pending = update;
    set({ phase: "available", version: update.version, notes: update.body ?? undefined, date: update.date ?? undefined, checkedMs });
    showToast({
      id: "update",
      tone: "info",
      title: `Update ${update.version} verfügbar`,
      body: "Der Download läuft im Hintergrund; danach startet VectaSim neu.",
      durationMs: null,
      actions: [{ label: "Jetzt installieren", onClick: () => void installUpdate() }],
    });
    return state;
  } catch (e) {
    const msg = String(e);
    set({ phase: "error", error: msg, checkedMs: Date.now() });
    if (!opts.silent) {
      showToast({ id: "update", tone: "err", title: "Update-Prüfung fehlgeschlagen", body: userMessage(msg, "settings").hint });
    }
    return state;
  }
}

let recordingActive: () => boolean = () => false;

/** App registers how to tell whether a flight is being recorded (installing restarts VectaSim). */
export function setRecordingCheck(fn: () => boolean): void {
  recordingActive = fn;
}

/** Download the pending update, install it and relaunch – never in the middle of a recorded flight. */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  if (recordingActive()) {
    showToast({
      id: "update",
      tone: "warn",
      title: "Aufzeichnung läuft – Update nach dem Flug",
      body: `Die Installation startet VectaSim neu. Installiere Version ${state.version ?? ""} nach dem Flug unter Einstellungen → Updates.`,
      durationMs: 8000,
    });
    return;
  }
  let total = 0;
  let got = 0;
  set({ phase: "downloading", progress: 0 });
  // safety copy of the logbook first (Einstellungen → Daten); a failure does not stop the update –
  // a new schema version makes its own copy before migrating at the next start
  try {
    await invoke("create_backup", { kind: "update" });
  } catch (e) {
    showToast({
      id: "update-backup",
      tone: "warn",
      title: "Sicherung vor dem Update fehlgeschlagen",
      body: `${String(e)} – das Update läuft trotzdem.`,
      durationMs: 8000,
    });
  }
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total > 0) set({ progress: Math.min(1, got / total) });
      } else if (ev.event === "Finished") set({ progress: 1 });
    });
    set({ phase: "ready" });
    showToast({
      id: "update",
      tone: "ok",
      title: "Update installiert",
      body: "VectaSim startet jetzt neu.",
      durationMs: 3000,
    });
    await relaunch();
  } catch (e) {
    const msg = String(e);
    set({ phase: "error", error: msg });
    showToast({ id: "update", tone: "err", title: "Update fehlgeschlagen", body: userMessage(msg, "settings").hint });
  }
}
