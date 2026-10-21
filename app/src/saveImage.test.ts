import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { SAVE_IMAGE_PATH_HEADER, saveImage } from "./saveImage";

beforeEach(() => invokeMock.mockClear());

describe("saveImage", () => {
  it("sends the bytes as a raw body, not as a JSON number array", async () => {
    await saveImage("C:\\Users\\Jörg\\Bilder\\VectaSim\\Landung 1.png", new Uint8Array([137, 80, 78, 71]).buffer);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, body, opts] = invokeMock.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(cmd).toBe("save_image");
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body as Uint8Array)).toEqual([137, 80, 78, 71]);
    const header = opts.headers[SAVE_IMAGE_PATH_HEADER];
    expect(header).toMatch(/^[\x21-\x7e]+$/); // ASCII only
    expect(decodeURIComponent(header)).toBe("C:\\Users\\Jörg\\Bilder\\VectaSim\\Landung 1.png");
  });

  it("reads a Blob", async () => {
    await saveImage("a.png", new Blob([new Uint8Array([1, 2, 3])]));
    expect(Array.from(invokeMock.mock.calls[0][1] as Uint8Array)).toEqual([1, 2, 3]);
  });
});
