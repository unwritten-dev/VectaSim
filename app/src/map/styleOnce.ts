// Idempotent style setup. Our sources and layers are (re-)added on every style load: the first
// load, a theme change (setStyle drops everything) and a WebGL context restore (MapLibre
// re-applies the serialized style – our plain layers come back, the custom WebGL layers do not).
// Two loads in quick succession, or a restore that already carries our layers, must not throw
// `Source "…" already exists`, so every add goes through these helpers.

import type * as maplibregl from "maplibre-gl";

/** The part of maplibregl.Map these helpers use (a plain fake in the tests). */
export interface StyleTarget {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addSource(id: string, source: maplibregl.SourceSpecification): unknown;
  addLayer(layer: maplibregl.AddLayerObject, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
}

/** Adds the source unless the style already has one of that id. */
export function addSourceOnce(map: StyleTarget, id: string, source: maplibregl.SourceSpecification): boolean {
  if (map.getSource(id)) return false;
  map.addSource(id, source);
  return true;
}

/**
 * Adds a style layer unless one of that id exists (then it is left as it is). A `before` layer
 * that does not exist (yet) puts the layer on top instead of failing.
 */
export function addLayerOnce(map: StyleTarget, layer: maplibregl.AddLayerObject, before?: string): boolean {
  if (map.getLayer(layer.id)) return false;
  map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
  return true;
}

/**
 * Adds a custom (WebGL) layer, replacing one of the same id first: a custom layer instance owns
 * GL resources of one context, so the new instance always wins. removeLayer calls the old
 * layer's onRemove with a valid context (frees its buffers and programs).
 */
export function replaceCustomLayer(map: StyleTarget, layer: maplibregl.CustomLayerInterface, before?: string): void {
  if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
}
