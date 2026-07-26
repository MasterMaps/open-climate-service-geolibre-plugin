import "./styles.css";
import { ZarrLayer } from "@carbonplan/zarr-layer";
import { buildColormap } from "./colormap";
import { buildRenderSpec, fetchCatalog, fetchCollection, type DimState, type OcsCollectionSummary, type RenderSpec } from "./ocs";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "./types/geolibre";

const PLUGIN_ID = "open-climate-service";
const PANEL_ID = "ocs-panel";
const LAYER_ID = "ocs-zarr-layer";
const OCS_URL_PARAM = "ocsUrl";
const DATASET_PARAM = "dataset";

interface PluginState {
  app?: GeoLibreAppAPI;
  ocsUrl: string;
  collections: OcsCollectionSummary[];
  datasetId: string | null;
  spec: RenderSpec | null;
  selector: Record<string, number>;
  layer: ZarrLayer | null;
  style: { colormapName: string; clim: [number, number]; opacity: number };
}

const state: PluginState = {
  ocsUrl: "",
  collections: [],
  datasetId: null,
  spec: null,
  selector: {},
  layer: null,
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

function removeLayer(): void {
  const map = state.app?.getMap?.();
  if (state.layer && map) {
    try {
      map.removeLayer(LAYER_ID);
    } catch {
      /* already gone */
    }
    state.app?.unregisterExternalNativeLayer?.(LAYER_ID);
  }
  state.layer = null;
}

function applySelector(): void {
  state.layer?.setSelector({ ...state.selector });
}

function renderLayer(spec: RenderSpec, bbox: [number, number, number, number] | null): void {
  const app = state.app;
  const map = app?.getMap?.();
  if (!app || !map) {
    setStatus("GeoLibre map is not available.", true);
    return;
  }
  removeLayer();

  state.selector = {};
  for (const d of spec.dims) state.selector[d.key] = d.index;

  const zarrVersion = spec.zarrVersion === 2 || spec.zarrVersion === 3 ? spec.zarrVersion : undefined;
  const layer = new ZarrLayer({
    id: LAYER_ID,
    source: spec.zarrHref,
    variable: spec.variable,
    clim: spec.clim,
    colormap: buildColormap(spec.colormapName),
    opacity: 1,
    selector: { ...state.selector },
    crs: spec.crs,
    ...(zarrVersion != null ? { zarrVersion } : {}),
    ...(spec.fillValue != null ? { fillValue: spec.fillValue } : {}),
    ...(spec.proj4 != null ? { proj4: spec.proj4 } : {}),
  });

  map.addLayer(layer);
  app.registerExternalNativeLayer?.({
    id: LAYER_ID,
    name: `OCS: ${spec.datasetId}`,
    // Declare a plugin-painted raster: `type: "raster"` keeps GeoLibre from showing its
    // vector fill/stroke editor, and `controlOwnsPaint` tells it this plugin owns the
    // rendering (colours come from the zarr-layer colormap, not MapLibre paint).
    type: "raster",
    nativeLayerIds: [LAYER_ID],
    opacity: 1,
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

  if (bbox && app.fitBounds) app.fitBounds(bbox);
}

async function loadDataset(datasetId: string): Promise<void> {
  if (!state.ocsUrl) return;
  setStatus(`Loading ${datasetId}…`);
  try {
    const collection = await fetchCollection(state.ocsUrl, datasetId);
    const spec = buildRenderSpec(collection);
    const bbox = collection.extent?.spatial?.bbox?.[0] ?? null;
    state.datasetId = datasetId;
    state.spec = spec;
    state.style = { colormapName: spec.colormapName, clim: spec.clim, opacity: 1 };
    renderLayer(spec, bbox);
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
    const collections = await fetchCatalog(state.ocsUrl);
    state.collections = collections;
    renderCollectionOptions();
    setStatus(collections.length ? `${collections.length} datasets found.` : "No published datasets found.");
    if (collections.length && !state.datasetId) {
      // don't auto-load; let the user pick (deep-link path loads explicitly)
    }
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
  const stepping = spec.dims.filter((d) => d.count > 1);
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

// Interactive raster styling — owned here (our panel), driving zarr-layer's real
// methods, because GeoLibre's right-panel raster paint doesn't reach a custom layer.
function renderStyleControls(spec: RenderSpec): void {
  if (!panel) return;
  const host = panel.styleControls;
  host.replaceChildren();

  // Opacity slider → layer.setOpacity
  const opBlock = el("div", "ocs-dim");
  const opHeader = el("div", "ocs-dim-header");
  opHeader.appendChild(el("span", "ocs-dim-label", "Opacity"));
  const opValue = el("span", "ocs-dim-value", state.style.opacity.toFixed(2));
  opHeader.appendChild(opValue);
  opBlock.appendChild(opHeader);
  const opSlider = el("input", "ocs-slider");
  opSlider.type = "range";
  opSlider.min = "0";
  opSlider.max = "1";
  opSlider.step = "0.05";
  opSlider.value = String(state.style.opacity);
  opSlider.addEventListener("input", () => {
    const v = Number(opSlider.value);
    state.style.opacity = v;
    opValue.textContent = v.toFixed(2);
    state.layer?.setOpacity(v);
  });
  opBlock.appendChild(opSlider);
  host.appendChild(opBlock);

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
    state.layer?.setColormap(buildColormap(cmSelect.value));
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
      state.layer?.setClim([mn, mx]);
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
  version: "0.1.0",
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
    const s = (raw ?? {}) as Partial<PluginState>;
    if (typeof s.ocsUrl === "string" && s.ocsUrl) {
      void connect(s.ocsUrl).then(() => {
        if (s.datasetId) return loadDataset(s.datasetId);
      });
    }
  },
};

export default plugin;
