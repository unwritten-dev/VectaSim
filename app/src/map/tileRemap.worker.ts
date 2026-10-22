// Weather tile recolouring off the main thread (tileRemapClient.ts sends the decoded tiles here).
// Message in: { id, bitmap, clouds, scheme } with the bitmap transferred, or { cancel: id } (the
// tile was aborted); out: { id, bitmap } (the recoloured one, transferred back) or { id, error }.
// Jobs run one at a time from a queue, yielding between them, so a cancel that arrives while
// earlier tiles are recoloured still removes its job before the work starts.

import { remapBitmap } from "./tileRemap";

interface Job {
  id: number;
  bitmap: ImageBitmap;
  clouds: boolean;
  scheme: "dark" | "light";
}

type Msg = Job | { cancel: number };

/** The worker's global scope, typed by hand (the project's lib is DOM, not WebWorker). */
const scope = self as unknown as {
  addEventListener(type: "message", f: (e: MessageEvent<Msg>) => void): void;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

const queue: Job[] = [];
let running = false;
/** Yields to the message queue between jobs (a channel message: no timer clamping). */
const tick = new MessageChannel();
tick.port1.onmessage = () => pump();

function pump() {
  const job = queue.shift();
  if (!job) {
    running = false;
    return;
  }
  running = true;
  const { id, bitmap, clouds, scheme } = job;
  remapBitmap(bitmap, clouds, scheme)
    .then(
      (out) => scope.postMessage({ id, bitmap: out }, [out]),
      (err: unknown) => scope.postMessage({ id, error: String(err) }),
    )
    // a task between the jobs: queued cancel messages are handled first
    .finally(() => tick.port2.postMessage(0));
}

scope.addEventListener("message", (e) => {
  const m = e.data;
  if ("cancel" in m) {
    const at = queue.findIndex((j) => j.id === m.cancel);
    if (at >= 0) queue.splice(at, 1)[0].bitmap.close();
    return;
  }
  queue.push(m);
  if (!running) pump();
});
