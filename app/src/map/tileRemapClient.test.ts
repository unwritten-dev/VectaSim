import { describe, expect, it } from "vitest";
import { remapClient, type RemapWorker } from "./tileRemapClient";

/** A worker stand-in: records the posted jobs, the test answers them. */
function fakeWorker() {
  const handlers: { message?: (e: MessageEvent) => void; error?: () => void } = {};
  const posted: Array<{ msg: { id: number; clouds: boolean; scheme: string; bitmap: unknown }; transfer: Transferable[] }> = [];
  const w: RemapWorker = {
    postMessage: (msg, transfer) => void posted.push({ msg: msg as never, transfer }),
    addEventListener: ((type: "message" | "error", f: never) => {
      handlers[type] = f;
    }) as RemapWorker["addEventListener"],
  };
  return {
    w,
    posted,
    reply: (data: unknown) => handlers.message?.({ data } as MessageEvent),
    fail: () => handlers.error?.(),
  };
}

const bmp = (n: number) => ({ n }) as unknown as ImageBitmap;

describe("H-6: weather tiles are recoloured in a worker", () => {
  it("each tile goes to the worker (transferred) and comes back by its id, in any order", async () => {
    const f = fakeWorker();
    const c = remapClient(f.w);
    const a = c.remap(bmp(1), false, "dark");
    const b = c.remap(bmp(2), true, "light");
    expect(f.posted.map((p) => [p.msg.clouds, p.msg.scheme])).toEqual([
      [false, "dark"],
      [true, "light"],
    ]);
    // the bitmap is transferred, not copied
    expect(f.posted[0].transfer).toEqual([f.posted[0].msg.bitmap]);
    f.reply({ id: f.posted[1].msg.id, bitmap: bmp(20) });
    f.reply({ id: f.posted[0].msg.id, bitmap: bmp(10) });
    await expect(a).resolves.toEqual(bmp(10));
    await expect(b).resolves.toEqual(bmp(20));
    expect(c.broken()).toBe(false);
  });

  it("a failed tile rejects (the overlay shows it empty); a failed worker ends the worker path", async () => {
    const f = fakeWorker();
    const c = remapClient(f.w);
    const a = c.remap(bmp(1), false, "dark");
    f.reply({ id: f.posted[0].msg.id, error: "decode" });
    await expect(a).rejects.toThrow("decode");
    const b = c.remap(bmp(2), false, "dark");
    f.fail();
    await expect(b).rejects.toThrow();
    expect(c.broken()).toBe(true);
    // from now on the main thread recolours (no further jobs to the worker)
    const posted = f.posted.length;
    void c.remap(bmp(3), false, "dark").catch(() => {});
    expect(f.posted.length).toBe(posted);
  });

  it("without a worker (tests, old WebViews) the client says so", () => {
    expect(remapClient(null).broken()).toBe(true);
  });
});
