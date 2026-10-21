// PNG/JPEG bytes to `save_image` as a raw IPC body instead of a JSON number array: one
// ArrayBuffer instead of ~4 characters of JSON per byte (a 1080 × 15 360 px review stack is
// several MB). The target path rides along as a percent-encoded header, since the raw body
// has no room for named arguments; the backend decodes it and checks it like before.

import { invoke } from "@tauri-apps/api/core";

/** Header with the encodeURIComponent()-encoded target path (HTTP headers are ASCII only). */
export const SAVE_IMAGE_PATH_HEADER = "x-vectasim-path";

/** Writes `data` to `path` (from a save dialog or the card folder) via `save_image`. */
export async function saveImage(path: string, data: Blob | ArrayBuffer): Promise<void> {
  const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  await invoke("save_image", new Uint8Array(buf), { headers: { [SAVE_IMAGE_PATH_HEADER]: encodeURIComponent(path) } });
}
