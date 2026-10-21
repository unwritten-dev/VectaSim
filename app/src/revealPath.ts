// Shows a file or folder in Explorer through the backend command `reveal_path`, which accepts
// only existing local paths (no network shares, no `..`); see app/src-tauri/src/data.rs.
import { invoke } from "@tauri-apps/api/core";

export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}
