// Main-thread side of the weather tile recolouring: hands each decoded tile to one dedicated
// worker (tileRemap.worker.ts) and waits for the recoloured bitmap. Where no worker can be started
// (tests, a WebView without module workers) or the worker fails, the tile is recoloured here as
// before (tileRemap.remapBitmap).

import { remapBitmap } from "./tileRemap";

/** The part of a Worker the client needs (a fake in the tests). */
export interface RemapWorker {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", f: (e: MessageEvent) => void): void;
  addEventListener(type: "error", f: () => void): void;
}

type Pending = { resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void };

/** Sends tiles to `worker`; `broken()` is true once it failed (then everything runs locally). */
export function remapClient(worker: RemapWorker | null) {
  let nextId = 1;
  let broken = !worker;
  const pending = new Map<number, Pending>();
  if (worker) {
    worker.addEventListener("message", (e: MessageEvent) => {
      const { id, bitmap, error } = e.data as { id: number; bitmap?: ImageBitmap; error?: string };
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (bitmap) p.resolve(bitmap);
      else p.reject(new Error(error ?? "tile remap failed"));
    });
    worker.addEventListener("error", () => {
      // the worker could not load or crashed: the tiles in flight are lost (empty), the next ones run locally
      broken = true;
      for (const p of pending.values()) p.reject(new Error("tile worker failed"));
      pending.clear();
    });
  }
  return {
    broken: () => broken,
    remap(bitmap: ImageBitmap, clouds: boolean, scheme: "dark" | "light"): Promise<ImageBitmap> {
      if (broken || !worker) return remapBitmap(bitmap, clouds, scheme);
      const id = nextId++;
      return new Promise<ImageBitmap>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ id, bitmap, clouds, scheme }, [bitmap]);
        } catch {
          // not transferable here: recolour locally
          pending.delete(id);
          broken = true;
          remapBitmap(bitmap, clouds, scheme).then(resolve, reject);
        }
      });
    },
  };
}

let shared: ReturnType<typeof remapClient> | null = null;

function startWorker(): RemapWorker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./tileRemap.worker.ts", import.meta.url), { type: "module" }) as unknown as RemapWorker;
  } catch {
    return null;
  }
}

/** Recoloured copy of a decoded weather tile (the input is consumed), off the main thread where possible. */
export function remapTile(bitmap: ImageBitmap, clouds: boolean, scheme: "dark" | "light"): Promise<ImageBitmap> {
  shared ??= remapClient(startWorker());
  return shared.remap(bitmap, clouds, scheme);
}
