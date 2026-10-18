// MapLibre GL JS 6 is ESM-only and loads its worker from a real URL. Bundled by Vite, the
// auto-detection (relative to import.meta.url) points at a file that is not emitted, so the
// worker is bundled explicitly: `?worker&url` yields one self-contained, same-origin script
// (shared chunk included), which also keeps the CSP at `worker-src 'self'`.
// Imported for its side effect by every component that creates a map.
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
