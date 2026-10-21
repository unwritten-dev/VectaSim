// Weather tile recolouring off the main thread (tileRemapClient.ts sends the decoded tiles here).
// Message in: { id, bitmap, clouds, scheme } with the bitmap transferred; out: { id, bitmap } (the
// recoloured one, transferred back) or { id, error }.

import { remapBitmap } from "./tileRemap";

interface Job {
  id: number;
  bitmap: ImageBitmap;
  clouds: boolean;
  scheme: "dark" | "light";
}

/** The worker's global scope, typed by hand (the project's lib is DOM, not WebWorker). */
const scope = self as unknown as {
  addEventListener(type: "message", f: (e: MessageEvent<Job>) => void): void;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

scope.addEventListener("message", (e) => {
  const { id, bitmap, clouds, scheme } = e.data;
  remapBitmap(bitmap, clouds, scheme).then(
    (out) => scope.postMessage({ id, bitmap: out }, [out]),
    (err: unknown) => scope.postMessage({ id, error: String(err) }),
  );
});
