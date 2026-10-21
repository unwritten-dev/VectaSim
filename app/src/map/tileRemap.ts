// Pixel recolouring of the weather tiles (weatherOverlay.ts): the IR satellite image into clouds,
// RainViewer's magenta radar step into white. Pure on the pixel arrays, plus `remapBitmap`, which
// does the canvas round trip – used by the tile worker (tileRemap.worker.ts) and, where no worker
// can be started, on the main thread (tileRemapClient.ts). No MapLibre import: the worker bundle
// stays small.

/**
 * Cloud opacity (0–255) for an IR grey value: warm ground and low cloud (dark) transparent,
 * cold high cloud tops (bright) opaque, a smooth ramp in between.
 */
export function cloudAlpha(grey: number, lo = 105, hi = 205): number {
  if (grey <= lo) return 0;
  if (grey >= hi) return 255;
  const x = (grey - lo) / (hi - lo);
  return Math.round(x * x * (3 - 2 * x) * 255);
}

/** Cloud colour per map scheme: white on the dark maps, slate on paper. */
export const CLOUD_RGB: Record<"dark" | "light", [number, number, number]> = { dark: [238, 242, 246], light: [84, 98, 116] };

/** Recolours an RGBA IR image in place into clouds (pure on the pixel array). */
export function irToClouds(px: Uint8ClampedArray, scheme: "dark" | "light") {
  const [r, g, b] = CLOUD_RGB[scheme];
  for (let i = 0; i < px.length; i += 4) {
    const grey = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const a = (px[i + 3] * cloudAlpha(grey)) / 255;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
}

/**
 * RainViewer's "Universal Blue" (the only scheme of the free API) paints 55–64 dBZ magenta
 * (#ffaaff … #ff4eff, RainViewer colour table) – a colour the app does not use. Those pixels (and
 * the smoothed red→magenta blends next to them) become white: the scale's next step (65+ dBZ),
 * so the top of the scale reads yellow → amber → red → white. Alpha stays. Pure on the array.
 */
export function radarWithoutMagenta(px: Uint8ClampedArray) {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    // magenta / violet / pink: red and blue both above green, saturated
    if (d < 40 || g >= r || g >= b) continue;
    const hue = max === r ? (60 * ((g - b) / d) + 360) % 360 : 60 * ((r - g) / d + 4);
    if (hue < 250 || hue > 345) continue;
    px[i] = px[i + 1] = px[i + 2] = 255;
  }
}

/**
 * The recoloured copy of a decoded tile (`clouds`: IR → clouds, else radar without magenta); the
 * input bitmap is closed. Without a 2D context the bitmap comes back as it is.
 */
export async function remapBitmap(bitmap: ImageBitmap, clouds: boolean, scheme: "dark" | "light"): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  // read back once per tile: a CPU-side canvas spares the GPU round trip of getImageData
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return bitmap;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (clouds) irToClouds(img.data, scheme);
  else radarWithoutMagenta(img.data);
  return createImageBitmap(img);
}
