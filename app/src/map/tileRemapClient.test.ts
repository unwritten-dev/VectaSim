import { afterEach, describe, expect, it, vi } from "vitest";
import { REMAP_TIMEOUT_MS, remapClient, type RemapWorker } from "./tileRemapClient";

/** A worker stand-in: records the posted jobs, the test answers them. */
function fakeWorker() {
  const handlers: { message?: (e: MessageEvent) => void; error?: () => void; messageerror?: () => void } = {};
  const posted: Array<{ msg: { id: number; clouds: boolean; scheme: string; bitmap: unknown; cancel?: number }; transfer?: Transferable[] }> = [];
  const w: RemapWorker = {
    postMessage: (msg, transfer) => void posted.push({ msg: msg as never, transfer }),
    addEventListener: ((type: "message" | "error" | "messageerror", f: never) => {
      handlers[type] = f;
    }) as RemapWorker["addEventListener"],
  };
  return {
    w,
    posted,
    reply: (data: unknown) => handlers.message?.({ data } as MessageEvent),
    fail: () => handlers.error?.(),
    messageError: () => handlers.messageerror?.(),
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

describe("H-8: weather worker – abort, unreadable messages, timeout", () => {
  afterEach(() => vi.useRealTimers());
  it("an aborted tile rejects with AbortError, is cancelled in the worker, and a late answer is closed", async () => {
    const f = fakeWorker();
    const c = remapClient(f.w);
    const ac = new AbortController();
    const a = c.remap(bmp(1), false, "dark", ac.signal);
    const id = f.posted[0].msg.id;
    ac.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(f.posted[1].msg).toEqual({ cancel: id });
    const late = { close: vi.fn() } as unknown as ImageBitmap;
    f.reply({ id, bitmap: late });
    expect(late.close).toHaveBeenCalled();
    expect(c.broken()).toBe(false);
    // already aborted: not even sent
    const done = new AbortController();
    done.abort();
    await expect(c.remap({ close() {} } as unknown as ImageBitmap, false, "dark", done.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.posted).toHaveLength(2);
  });
  it("messageerror ends the worker path like a crash", async () => {
    const f = fakeWorker();
    const c = remapClient(f.w);
    const a = c.remap(bmp(1), false, "dark");
    f.messageError();
    await expect(a).rejects.toThrow();
    expect(c.broken()).toBe(true);
  });
  it("a job without an answer times out and the next tiles run locally", async () => {
    vi.useFakeTimers();
    const f = fakeWorker();
    const c = remapClient(f.w);
    const a = c.remap(bmp(1), false, "dark");
    const caught = a.catch((e: Error) => e.message);
    vi.advanceTimersByTime(REMAP_TIMEOUT_MS + 1);
    expect(await caught).toMatch(/timed out/);
    expect(c.broken()).toBe(true);
  });
  it("an answered job clears its timer", async () => {
    vi.useFakeTimers();
    const f = fakeWorker();
    const c = remapClient(f.w);
    const a = c.remap(bmp(1), false, "dark");
    f.reply({ id: f.posted[0].msg.id, bitmap: bmp(10) });
    await expect(a).resolves.toEqual(bmp(10));
    vi.advanceTimersByTime(REMAP_TIMEOUT_MS + 1);
    expect(c.broken()).toBe(false);
  });
});
