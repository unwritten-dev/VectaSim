// Main-thread side of the weather tile recolouring: hands each decoded tile to one dedicated
// worker (tileRemap.worker.ts) and waits for the recoloured bitmap. Where no worker can be started
// (tests, a WebView without module workers) or the worker fails, the tile is recoloured here as
// before (tileRemap.remapBitmap). A tile MapLibre aborted (panned away) is cancelled in the
// worker's queue; a job without an answer in REMAP_TIMEOUT_MS (a message that could not be
// (de)serialised, a wedged worker) rejects and ends the worker path.

import { remapBitmap } from "./tileRemap";

/** No answer for this long: the job is given up and the worker treated as failed. */
export const REMAP_TIMEOUT_MS = 10_000;

/** The part of a Worker the client needs (a fake in the tests). */
export interface RemapWorker {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", f: (e: MessageEvent) => void): void;
  addEventListener(type: "error" | "messageerror", f: () => void): void;
}

type Pending = { resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout>; off?: () => void };

const abortError = () => new DOMException("tile aborted", "AbortError");

/** Sends tiles to `worker`; `broken()` is true once it failed (then everything runs locally). */
export function remapClient(worker: RemapWorker | null) {
  let nextId = 1;
  let broken = !worker;
  const pending = new Map<number, Pending>();
  const settle = (id: number): Pending | undefined => {
    const p = pending.get(id);
    if (!p) return undefined;
    pending.delete(id);
    clearTimeout(p.timer);
    p.off?.();
    return p;
  };
  const fail = (why: string) => {
    // the worker could not load, crashed or sent something unreadable: the tiles in flight are
    // lost (empty), the next ones run locally
    broken = true;
    for (const id of [...pending.keys()]) settle(id)?.reject(new Error(why));
  };
  if (worker) {
    worker.addEventListener("message", (e: MessageEvent) => {
      const { id, bitmap, error } = e.data as { id: number; bitmap?: ImageBitmap; error?: string };
      const p = settle(id);
      if (!p) {
        // answered after an abort or a timeout: nobody waits for it
        bitmap?.close?.();
        return;
      }
      if (bitmap) p.resolve(bitmap);
      else p.reject(new Error(error ?? "tile remap failed"));
    });
    worker.addEventListener("error", () => fail("tile worker failed"));
    // an answer that cannot be deserialised carries no readable id: same as a crash
    worker.addEventListener("messageerror", () => fail("tile worker message unreadable"));
  }
  return {
    broken: () => broken,
    remap(bitmap: ImageBitmap, clouds: boolean, scheme: "dark" | "light", signal?: AbortSignal): Promise<ImageBitmap> {
      if (signal?.aborted) {
        bitmap.close?.();
        return Promise.reject(abortError());
      }
      if (broken || !worker) return remapBitmap(bitmap, clouds, scheme);
      const id = nextId++;
      return new Promise<ImageBitmap>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          fail("tile worker timed out");
        }, REMAP_TIMEOUT_MS);
        const p: Pending = { resolve, reject, timer };
        if (signal) {
          const onAbort = () => {
            if (!settle(id)) return;
            // dropped from the worker's queue if it has not started on it yet
            worker.postMessage({ cancel: id });
            reject(abortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
          p.off = () => signal.removeEventListener("abort", onAbort);
        }
        pending.set(id, p);
        try {
          worker.postMessage({ id, bitmap, clouds, scheme }, [bitmap]);
        } catch {
          // not transferable here: recolour locally
          settle(id);
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
export function remapTile(bitmap: ImageBitmap, clouds: boolean, scheme: "dark" | "light", signal?: AbortSignal): Promise<ImageBitmap> {
  shared ??= remapClient(startWorker());
  return shared.remap(bitmap, clouds, scheme, signal);
}
