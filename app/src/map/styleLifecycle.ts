// The live map's style life cycle: every style load (the first one, a theme change, a WebGL
// context restore) runs the layer setup once, serialised by a generation counter, and a newer load
// abandons an older setup still awaiting something. A theme change and a context restore take the
// same path: a fresh basemap style, our custom WebGL layers removed first (their GL resources are
// freed while the context is valid), then `setStyle` – whose `style.load` re-adds every layer.
//
// Context loss (GPU reset, WebView2's GPU process restarted next to the sim): MapLibre drops the
// style with every custom layer and re-applies the serialized style on restore, without our WebGL
// layers (curtain, own model, traffic models). The loss itself marks the map not ready and
// abandons a running setup; the restore loads a fresh style like a theme change.

import type { StyleSpecification } from "maplibre-gl";
import { removeCustomLayers } from "./styleOnce";

/** The part of a MapLibre map the life cycle needs (a fake in the tests). */
export interface StyleLifecycleMap {
  on(type: "style.load" | "webglcontextlost" | "webglcontextrestored", f: () => void): unknown;
  off(type: "style.load" | "webglcontextlost" | "webglcontextrestored", f: () => void): unknown;
  setStyle(style: StyleSpecification | string, opts: { diff: boolean }): unknown;
  getLayersOrder(): string[];
  getLayer(id: string): unknown;
  removeLayer(id: string): unknown;
}

export interface StyleLifecycleHooks {
  /** Adds our sources and layers to the loaded style; false (or `isCurrent()` false) = abandoned. */
  setup(isCurrent: () => boolean): Promise<boolean>;
  /** The setup of the current style is complete (`first`: the map's very first one). */
  ready(first: boolean): void;
  /** The map is not ready any more (a new style is coming, the context is gone). */
  unready(): void;
  /** Our custom WebGL layers are gone (removed before setStyle, or with the lost context). */
  dropped(): void;
  /** A fresh basemap style (theme colours, projection). */
  loadStyle(): Promise<StyleSpecification | string>;
  /** Still the map of the component (not torn down meanwhile). */
  alive(): boolean;
  /** A setup that threw. */
  onError?(e: unknown): void;
}

/** Wires the life cycle to `map`; `reload()` is the theme change. dispose removes the listeners. */
export function attachStyleLifecycle(map: StyleLifecycleMap, hooks: StyleLifecycleHooks): { reload(): void; dispose(): void } {
  let gen = 0;
  let initialised = false;
  let reloadSeq = 0;
  const onStyleLoad = async () => {
    const mine = ++gen;
    const isCurrent = () => mine === gen && hooks.alive();
    hooks.unready();
    try {
      if (!(await hooks.setup(isCurrent)) || !isCurrent()) return;
    } catch (e) {
      hooks.onError?.(e);
      return;
    }
    const first = !initialised;
    initialised = true;
    hooks.ready(first);
  };
  const reload = () => {
    const mine = ++reloadSeq;
    void hooks.loadStyle().then(
      (style) => {
        if (mine !== reloadSeq || !hooks.alive()) return;
        hooks.unready();
        // a layer setup still running for the old style stops at its next check
        gen++;
        // free the WebGL layers' buffers and programs now (setStyle drops them without onRemove);
        // the new style load adds fresh instances
        removeCustomLayers(map);
        hooks.dropped();
        map.setStyle(style, { diff: false });
      },
      // no basemap (offline and no cached copy): the old style stays
      (e) => hooks.onError?.(e),
    );
  };
  const onLost = () => {
    hooks.unready();
    gen++;
    hooks.dropped();
  };
  map.on("style.load", onStyleLoad);
  map.on("webglcontextlost", onLost);
  map.on("webglcontextrestored", reload);
  return {
    reload,
    dispose() {
      reloadSeq++;
      gen++;
      map.off("style.load", onStyleLoad);
      map.off("webglcontextlost", onLost);
      map.off("webglcontextrestored", reload);
    },
  };
}
