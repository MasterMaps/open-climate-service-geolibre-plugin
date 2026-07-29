import "./styles.css";
import { ZarrLayer } from "@carbonplan/zarr-layer";
import { buildColormap } from "./colormap";
import {
  buildRenderSpec,
  fetchCatalog,
  fetchCollection,
  fetchInstanceExtent,
  type DimState,
  type InstanceExtent,
  type OcsCollectionSummary,
  type RenderSpec,
} from "./ocs";
import type { GeoLibreAppAPI, GeoLibrePlugin, GeoLibreTimeGranularity, GeoLibreZarrLayerOptions } from "./types/geolibre";

const PLUGIN_ID = "open-climate-service";
const PANEL_ID = "ocs-panel";
const LAYER_ID = "ocs-zarr-layer";
const OCS_URL_PARAM = "ocsUrl";
const DATASET_PARAM = "dataset";

interface PluginState {
  app?: GeoLibreAppAPI;
  ocsUrl: string;
  collections: OcsCollectionSummary[];
  instanceExtent: InstanceExtent | null;
  datasetId: string | null;
  spec: RenderSpec | null;
  selector: Record<string, number>;
  layer: ZarrLayer | null; // fallback path: our bundled zarr-layer instance
  nativeLayerId: string | null; // native path: id returned by app.addZarrLayer
  native: boolean; // true when rendering via GeoLibre's native addZarrLayer
  temporalDetach: (() => void) | null; // unbinds the layer from the native Time Slider (#1448)
  style: { colormapName: string; clim: [number, number]; opacity: number };
}

/** The serializable subset of state persisted via getProjectState / restored via
 * applyProjectState. Deliberately excludes the live runtime fields (app, layer, detachers)
 * that must not round-trip through a saved project. */
interface OcsProjectState {
  ocsUrl?: string;
  datasetId?: string | null;
  selector?: Record<string, number>;
}

const state: PluginState = {
  ocsUrl: "",
  collections: [],
  instanceExtent: null,
  datasetId: null,
  spec: null,
  selector: {},
  layer: null,
  nativeLayerId: null,
  native: false,
  temporalDetach: null,
  style: { colormapName: "viridis", clim: [0, 100], opacity: 1 },
};

// Curated colormaps offered in the panel (chroma/ColorBrewer names); the dataset's
// own default is prepended when it isn't already in the list.
const COLORMAP_NAMES = [
  "viridis",
  "turbo",
  "magma",
  "plasma",
  "inferno",
  "cividis",
  "RdBu_r",
  "RdYlBu_r",
  "Spectral_r",
  "Blues",
  "Reds",
  "Greens",
  "YlGnBu",
  "YlOrRd",
];

// --- tiny DOM helpers -------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "ocs-btn", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

// Panel DOM references, rebuilt on each render(container).
interface PanelRefs {
  status: HTMLElement;
  collectionSelect: HTMLSelectElement;
  meta: HTMLElement;
  dims: HTMLElement;
  legend: HTMLElement;
  styleControls: HTMLElement;
}
let panel: PanelRefs | null = null;

function setStatus(msg: string, isError = false): void {
  if (!panel) return;
  panel.status.textContent = msg;
  panel.status.classList.toggle("ocs-error", isError);
}

// --- rendering --------------------------------------------------------------

function nativeName(spec: RenderSpec): string {
  return `OCS: ${spec.datasetId}`;
}

/** Map our render spec + live style into GeoLibre's native addZarrLayer options. */
function buildZarrOptions(spec: RenderSpec): GeoLibreZarrLayerOptions {
  const zarrVersion = spec.zarrVersion === 2 || spec.zarrVersion === 3 ? spec.zarrVersion : undefined;
  return {
    variable: spec.variable,
    selector: { ...state.selector },
    clim: state.style.clim,
    colormap: buildColormap(state.style.colormapName),
    opacity: state.style.opacity,
    ...(zarrVersion != null ? { zarrVersion } : {}),
    ...(spec.crs ? { crs: spec.crs } : {}),
    ...(spec.proj4 != null ? { proj4: spec.proj4 } : {}),
    ...(spec.bounds ? { bounds: spec.bounds } : {}),
  };
}

function removeLayer(): void {
  if (state.temporalDetach) {
    state.temporalDetach();
    state.temporalDetach = null;
  }
  const map = state.app?.getMap?.();
  if (state.native && state.nativeLayerId) {
    if (map) {
      try {
        map.removeLayer(state.nativeLayerId);
      } catch {
        /* already gone */
      }
    }
    state.app?.unregisterExternalNativeLayer?.(state.nativeLayerId);
  } else if (state.layer && map) {
    try {
      map.removeLayer(LAYER_ID);
    } catch {
      /* already gone */
    }
    state.app?.unregisterExternalNativeLayer?.(LAYER_ID);
  }
  state.layer = null;
  state.nativeLayerId = null;
}

function applySelector(): void {
  if (state.native && state.nativeLayerId) {
    // In-place re-select on the host's layer (no rebuild) — GeoLibre #1447.
    void state.app?.setZarrLayerSelector?.(state.nativeLayerId, { ...state.selector });
  } else {
    state.layer?.setSelector({ ...state.selector });
  }
}

/** Parse a STAC time-step string ("2026-01-01" or "2026-01-01 00:00") to epoch ms. */
function stepTime(step: string | number): number {
  return new Date(String(step).replace(" ", "T")).getTime();
}

/** Nearest time-step index to a Date, for the Time Slider adapter. */
function nearestTimeIndex(steps: Array<string | number>, date: Date): number {
  const target = date.getTime();
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const t = stepTime(steps[i]);
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/** The dataset's period type as a Time Slider stepping granularity (undefined → let GeoLibre
 * auto-pick from the span). Honored once GeoLibre supports adapter granularity (see issue). */
function granularityForPeriod(period: string | null): GeoLibreTimeGranularity | undefined {
  switch (period) {
    case "Hourly":
      return "hour";
    case "Daily":
    case "Weekly":
      return "day";
    case "Monthly":
    case "Seasonal":
      return "month";
    case "Yearly":
      return "year";
    default:
      return undefined;
  }
}

/** Bind the dataset's time dimension to GeoLibre's native Time Slider (#1448), so the
 * timeline drives the layer's time selector. Replaces our own in-panel time slider. */
function bindToTimeSlider(spec: RenderSpec, layerId: string): void {
  const app = state.app;
  if (!app?.registerTemporalLayer) return;
  const timeDim = spec.dims.find((d) => d.isTemporal && d.count > 1);
  if (!timeDim) {
    // No periods (e.g. a single-year dataset like WorldPop population): drop the
    // temporal adapter GeoLibre's addZarrLayer auto-registers from the store's time
    // axis, so the layer isn't treated as temporal / bindable to the Time Slider.
    app.unregisterTemporalLayer?.(layerId);
    return;
  }
  // ISO strings (index-aligned with the store's time axis) for the Time Slider to parse.
  const values = timeDim.steps.map((s) => String(s).replace(" ", "T"));
  const granularity = granularityForPeriod(spec.temporalResolution);
  state.temporalDetach = app.registerTemporalLayer(
    layerId,
    {
      dimension: timeDim.key,
      getTimeValues: () => values,
      setTime: (date) => {
        const index = nearestTimeIndex(timeDim.steps, date);
        if (index < 0) return;
        state.selector[timeDim.key] = index;
        applySelector();
      },
      // Step by the dataset's period type, and constrain the slider's unit controls to it
      // (e.g. a daily cube shows a day-only track). Honored once GeoLibre #1502 lands.
      ...(granularity ? { granularity, displayUnits: [granularity] } : {}),
    },
    { bind: true },
  );
}

let _styleDebounce: number | undefined;

/** Apply live colormap/clim/opacity. Fallback layer has in-place setters; the native
 * layer has no style setter yet, so we rebuild it (debounced) with fresh options. */
function applyStyle(): void {
  if (state.native) {
    window.clearTimeout(_styleDebounce);
    _styleDebounce = window.setTimeout(() => void rebuildNative(), 200);
  } else {
    // Opacity is owned by GeoLibre's Style panel (via paintBridge), so we don't touch it
    // here — re-applying it on a colormap/clim change would fight the user's setting.
    state.layer?.setColormap(buildColormap(state.style.colormapName));
    state.layer?.setClim(state.style.clim);
  }
}

async function rebuildNative(): Promise<void> {
  const app = state.app;
  const spec = state.spec;
  if (!app?.addZarrLayer || !spec) return;
  const map = app.getMap?.();
  if (state.nativeLayerId && map) {
    try {
      map.removeLayer(state.nativeLayerId);
    } catch {
      /* already gone */
    }
    app.unregisterExternalNativeLayer?.(state.nativeLayerId);
  }
  // The rebuild mints a new layer id, so re-bind it to the Time Slider (#1448).
  if (state.temporalDetach) {
    state.temporalDetach();
    state.temporalDetach = null;
  }
  state.nativeLayerId = await app.addZarrLayer(nativeName(spec), spec.zarrHref, buildZarrOptions(spec));
  bindToTimeSlider(spec, state.nativeLayerId);
}

async function renderLayer(spec: RenderSpec, bbox: [number, number, number, number] | null): Promise<void> {
  const app = state.app;
  const map = app?.getMap?.();
  if (!app || !map) {
    setStatus("GeoLibre map is not available.", true);
    return;
  }
  removeLayer();

  state.selector = {};
  for (const d of spec.dims) state.selector[d.key] = d.index;

  if (app.addZarrLayer) {
    // Native path (GeoLibre >= #1447): render through the host's own zarr-layer — no
    // bundled second copy, native Layers/Style-panel integration, CRS from proj4.
    state.native = true;
    state.nativeLayerId = await app.addZarrLayer(nativeName(spec), spec.zarrHref, buildZarrOptions(spec));
    bindToTimeSlider(spec, state.nativeLayerId);
  } else {
    // Fallback path (older GeoLibre): our bundled zarr-layer as a custom MapLibre layer,
    // registered so it appears in the Layers panel; paintMode/paintBridge (also #1447)
    // let GeoLibre's Style panel drop inert controls and bridge opacity to our layer.
    state.native = false;
    const zarrVersion = spec.zarrVersion === 2 || spec.zarrVersion === 3 ? spec.zarrVersion : undefined;
    const layer = new ZarrLayer({
      id: LAYER_ID,
      source: spec.zarrHref,
      variable: spec.variable,
      clim: state.style.clim,
      colormap: buildColormap(state.style.colormapName),
      opacity: state.style.opacity,
      selector: { ...state.selector },
      crs: spec.crs,
      ...(zarrVersion != null ? { zarrVersion } : {}),
      ...(spec.fillValue != null ? { fillValue: spec.fillValue } : {}),
      ...(spec.proj4 != null ? { proj4: spec.proj4 } : {}),
      ...(spec.bounds ? { bounds: spec.bounds } : {}),
    });
    map.addLayer(layer);
    app.registerExternalNativeLayer?.({
      id: LAYER_ID,
      name: nativeName(spec),
      type: "raster",
      nativeLayerIds: [LAYER_ID],
      opacity: state.style.opacity,
      paintMode: "plugin",
      paintBridge: { setOpacity: (o) => layer.setOpacity(o) },
      metadata: {
        datasetId: spec.datasetId,
        source: spec.source,
        ocsUrl: state.ocsUrl,
        pluginId: PLUGIN_ID,
        externalNativeLayer: true,
        controlOwnsPaint: true,
      },
    });
    state.layer = layer;
  }

  // Keep the current view while the instance extent is reasonably framed (the user is
  // looking at the country); re-frame the dataset if we've navigated off it or zoomed so
  // far out it's tiny. Right after connect the view is the instance extent, so selecting a
  // dataset won't jump the camera.
  if (bbox && app.fitBounds && shouldFitToDataset()) app.fitBounds(bbox);
}

function currentViewBbox(): [number, number, number, number] | null {
  const bounds = state.app?.getMap?.()?.getBounds?.();
  if (!bounds) return null;
  const [[west, south], [east, north]] = bounds.toArray();
  return [west, south, east, north];
}

function bboxesIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// Re-frame on the dataset once the instance extent fills less than ~1/this of the view's
// tighter axis — i.e. the country has shrunk to a speck from zooming out.
const MAX_EXTENT_ZOOM_OUT = 2.5;

/** Whether to re-frame on the dataset: when we've navigated off the instance extent, or
 * zoomed so far out that the extent is tiny. Otherwise keep the current view. */
function shouldFitToDataset(): boolean {
  const ext = state.instanceExtent;
  if (!ext) return true;
  const view = currentViewBbox();
  if (!view) return true;
  if (!bboxesIntersect(view, ext.bbox)) return true; // navigated off the extent
  const extW = ext.bbox[2] - ext.bbox[0];
  const extH = ext.bbox[3] - ext.bbox[1];
  if (extW <= 0 || extH <= 0) return false;
  const zoomOut = Math.min((view[2] - view[0]) / extW, (view[3] - view[1]) / extH);
  return zoomOut > MAX_EXTENT_ZOOM_OUT; // extent too small in view → re-frame
}

/** Restore a persisted dimension selection onto the spec's dims. renderLayer seeds
 * state.selector (and the panel controls read `dim.index`), so applying it here is what
 * makes a restored project open at the saved step. Keys absent from the current store, or
 * indices out of range, are ignored — a saved project may predate a dataset change. */
function applySavedSelector(spec: RenderSpec, saved: Record<string, number>): void {
  for (const dim of spec.dims) {
    const v = saved[dim.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < dim.count) {
      dim.index = v;
    }
  }
}

async function loadDataset(datasetId: string, savedSelector?: Record<string, number>): Promise<void> {
  if (!state.ocsUrl) return;
  setStatus(`Loading ${datasetId}…`);
  try {
    const collection = await fetchCollection(state.ocsUrl, datasetId);
    const spec = buildRenderSpec(collection);
    if (savedSelector) applySavedSelector(spec, savedSelector);
    const bbox = collection.extent?.spatial?.bbox?.[0] ?? null;
    state.datasetId = datasetId;
    state.spec = spec;
    state.style = { colormapName: spec.colormapName, clim: spec.clim, opacity: 1 };
    await renderLayer(spec, bbox);
    renderMeta(spec);
    renderDimControls(spec);
    renderLegend(spec);
    renderStyleControls(spec);
    setStatus("");
  } catch (err) {
    setStatus(`Failed to load ${datasetId}: ${(err as Error).message}`, true);
  }
}

async function connect(ocsUrl: string): Promise<void> {
  state.ocsUrl = ocsUrl.trim();
  if (!state.ocsUrl) {
    setStatus("Enter an Open Climate Service URL.", true);
    return;
  }
  setStatus("Connecting…");
  try {
    const [collections, extent] = await Promise.all([
      fetchCatalog(state.ocsUrl),
      fetchInstanceExtent(state.ocsUrl),
    ]);
    state.collections = collections;
    state.instanceExtent = extent;
    renderCollectionOptions();
    // Frame the instance extent up front, before any dataset is selected.
    if (extent && state.app?.fitBounds) state.app.fitBounds(extent.bbox);
    const where = extent?.name ? `${extent.name} — ` : "";
    setStatus(collections.length ? `${where}${collections.length} datasets` : `${where}no published datasets`);
  } catch (err) {
    setStatus(`Could not reach ${state.ocsUrl}/stac: ${(err as Error).message}`, true);
  }
}

// --- panel sub-renders ------------------------------------------------------

function renderCollectionOptions(): void {
  if (!panel) return;
  const sel = panel.collectionSelect;
  sel.replaceChildren();
  const placeholder = el("option", undefined, "Select a dataset…");
  placeholder.value = "";
  sel.appendChild(placeholder);
  for (const c of state.collections) {
    const opt = el("option", undefined, c.title);
    opt.value = c.id;
    sel.appendChild(opt);
  }
  sel.value = state.datasetId ?? "";
  sel.disabled = state.collections.length === 0;
}

function renderMeta(spec: RenderSpec): void {
  if (!panel) return;
  panel.meta.replaceChildren();
  const row = (label: string, value: string) => {
    const r = el("div", "ocs-meta-row");
    r.appendChild(el("span", "ocs-meta-label", label));
    r.appendChild(el("span", "ocs-meta-value", value || "—"));
    return r;
  };
  panel.meta.appendChild(row("Variable", spec.variable));
  panel.meta.appendChild(row("Units", spec.units));
  if (spec.temporalResolution) panel.meta.appendChild(row("Period type", spec.temporalResolution));
  panel.meta.appendChild(row("CRS", spec.crs));
  if (spec.source) panel.meta.appendChild(row("Source", spec.source));
}

function stepLabel(dim: DimState, i: number): string {
  const v = dim.steps[i];
  return v == null ? String(i) : String(v);
}

function renderDimControls(spec: RenderSpec): void {
  if (!panel) return;
  panel.dims.replaceChildren();
  // The temporal axis, when bound to GeoLibre's Time Slider (#1448), is driven there — not
  // here — so drop it from our panel to avoid a duplicate time control.
  const stepping = spec.dims.filter((d) => d.count > 1 && !(d.isTemporal && state.temporalDetach != null));
  panel.dims.classList.toggle("ocs-hidden", stepping.length === 0);

  for (const dim of stepping) {
    const block = el("div", "ocs-dim");
    const header = el("div", "ocs-dim-header");
    header.appendChild(el("span", "ocs-dim-label", dim.label));
    const valueEl = el("span", "ocs-dim-value", stepLabel(dim, dim.index));
    header.appendChild(valueEl);
    block.appendChild(header);

    if (dim.control === "slider") {
      const slider = el("input", "ocs-slider");
      slider.type = "range";
      slider.min = "0";
      slider.max = String(dim.count - 1);
      slider.step = "1";
      slider.value = String(dim.index);
      let debounce: number | undefined;
      slider.addEventListener("input", () => {
        const idx = Number(slider.value);
        state.selector[dim.key] = idx;
        valueEl.textContent = stepLabel(dim, idx);
        window.clearTimeout(debounce);
        debounce = window.setTimeout(applySelector, 120);
      });
      block.appendChild(slider);
    } else {
      const select = el("select", "ocs-select");
      dim.steps.forEach((s, i) => {
        const opt = el("option", undefined, String(s));
        opt.value = String(i);
        select.appendChild(opt);
      });
      select.value = String(dim.index);
      select.addEventListener("change", () => {
        const idx = Number(select.value);
        state.selector[dim.key] = idx;
        valueEl.textContent = stepLabel(dim, idx);
        applySelector();
      });
      block.appendChild(select);
    }
    panel.dims.appendChild(block);
  }
}

function renderLegend(spec: RenderSpec): void {
  if (!panel) return;
  panel.legend.replaceChildren();
  const colors = buildColormap(state.style.colormapName);
  const bar = el("div", "ocs-legend-bar");
  bar.style.background = `linear-gradient(to right, ${colors.join(",")})`;
  const scale = el("div", "ocs-legend-scale");
  scale.appendChild(el("span", undefined, String(state.style.clim[0])));
  scale.appendChild(el("span", undefined, spec.units || ""));
  scale.appendChild(el("span", undefined, String(state.style.clim[1])));
  panel.legend.appendChild(bar);
  panel.legend.appendChild(scale);
}

// Colormap + rescale styling — owned here because GeoLibre's right-panel raster controls
// don't reach zarr-layer's colormap/clim. Opacity is intentionally NOT offered here: it's
// driven by GeoLibre's Style panel (the native addZarrLayer layer, or the fallback's
// paintBridge.setOpacity), so exposing our own slider would duplicate that control.
function renderStyleControls(spec: RenderSpec): void {
  if (!panel) return;
  const host = panel.styleControls;
  host.replaceChildren();

  // Colormap dropdown → layer.setColormap
  const cmRow = el("div", "ocs-row");
  cmRow.appendChild(el("label", "ocs-field-label", "Colormap"));
  const cmSelect = el("select", "ocs-select");
  for (const name of [state.style.colormapName, ...COLORMAP_NAMES.filter((n) => n !== state.style.colormapName)]) {
    const opt = el("option", undefined, name);
    opt.value = name;
    cmSelect.appendChild(opt);
  }
  cmSelect.value = state.style.colormapName;
  cmSelect.addEventListener("change", () => {
    state.style.colormapName = cmSelect.value;
    applyStyle();
    renderLegend(spec);
  });
  cmRow.appendChild(cmSelect);
  host.appendChild(cmRow);

  // Min / max rescale → layer.setClim
  const climRow = el("div", "ocs-row");
  climRow.appendChild(el("label", "ocs-field-label", "Range (min / max)"));
  const climInputs = el("div", "ocs-clim");
  const minInput = el("input", "ocs-input");
  minInput.type = "number";
  minInput.value = String(state.style.clim[0]);
  const maxInput = el("input", "ocs-input");
  maxInput.type = "number";
  maxInput.value = String(state.style.clim[1]);
  const applyClim = () => {
    const mn = Number(minInput.value);
    const mx = Number(maxInput.value);
    if (Number.isFinite(mn) && Number.isFinite(mx) && mn < mx) {
      state.style.clim = [mn, mx];
      applyStyle();
      renderLegend(spec);
    }
  };
  minInput.addEventListener("change", applyClim);
  maxInput.addEventListener("change", applyClim);
  climInputs.appendChild(minInput);
  climInputs.appendChild(maxInput);
  climRow.appendChild(climInputs);
  host.appendChild(climRow);
}

// --- panel shell ------------------------------------------------------------

function renderPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  const root = el("div", "ocs-panel");

  const urlRow = el("div", "ocs-row");
  const urlInput = el("input", "ocs-input");
  urlInput.type = "text";
  urlInput.placeholder = "https://my-climate-service.org";
  urlInput.value = state.ocsUrl;
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void connect(urlInput.value);
  });
  urlRow.appendChild(el("label", "ocs-field-label", "Open Climate Service URL"));
  urlRow.appendChild(urlInput);
  urlRow.appendChild(button("Connect", () => void connect(urlInput.value)));
  root.appendChild(urlRow);

  const status = el("div", "ocs-status");
  root.appendChild(status);

  const collectionSelect = el("select", "ocs-select");
  collectionSelect.disabled = true;
  collectionSelect.addEventListener("change", () => {
    if (collectionSelect.value) void loadDataset(collectionSelect.value);
  });
  root.appendChild(collectionSelect);

  const meta = el("div", "ocs-meta");
  const dims = el("div", "ocs-dims ocs-hidden");
  const legend = el("div", "ocs-legend");
  const styleControls = el("div", "ocs-style");
  root.appendChild(meta);
  root.appendChild(dims);
  root.appendChild(legend);
  root.appendChild(styleControls);

  container.appendChild(root);
  panel = { status, collectionSelect, meta, dims, legend, styleControls };

  // Restore state if the panel is reopened after being built once.
  if (state.collections.length) renderCollectionOptions();
  if (state.spec) {
    renderMeta(state.spec);
    renderDimControls(state.spec);
    renderLegend(state.spec);
    renderStyleControls(state.spec);
  }

  return () => {
    panel = null;
  };
}

// --- plugin object ----------------------------------------------------------

let unregisterPanel: (() => void) | undefined;

export const plugin: GeoLibrePlugin = {
  id: PLUGIN_ID,
  name: "Open Climate Service",
  version: "0.1.11",
  urlParameterNames: [OCS_URL_PARAM, DATASET_PARAM],

  activate(app) {
    state.app = app;
    unregisterPanel = app.registerRightPanel?.({
      id: PANEL_ID,
      title: "Open Climate Service",
      dock: "right-of-layers",
      defaultWidth: 320,
      render: (container) => renderPanel(container),
    });
    app.openRightPanel?.(PANEL_ID);
  },

  deactivate(app) {
    removeLayer();
    unregisterPanel?.();
    unregisterPanel = undefined;
    app.unregisterRightPanel?.(PANEL_ID);
    panel = null;
    state.app = undefined;
  },

  async handleUrlParameters(app, params) {
    state.app = app;
    const ocsUrl = params.get(OCS_URL_PARAM);
    const dataset = params.get(DATASET_PARAM);
    if (ocsUrl) {
      await connect(ocsUrl);
      if (dataset) await loadDataset(dataset);
    }
  },

  getProjectState() {
    return { ocsUrl: state.ocsUrl, datasetId: state.datasetId, selector: state.selector };
  },

  applyProjectState(app, raw) {
    state.app = app;
    const s = (raw ?? {}) as OcsProjectState;
    if (typeof s.ocsUrl === "string" && s.ocsUrl) {
      const savedSelector = s.selector && typeof s.selector === "object" ? s.selector : undefined;
      void connect(s.ocsUrl).then(() => {
        if (s.datasetId) return loadDataset(s.datasetId, savedSelector);
      });
    }
  },
};

export default plugin;
