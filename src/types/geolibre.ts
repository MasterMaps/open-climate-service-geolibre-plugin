// GeoLibre plugin API surface. Mirrors the public interface exposed by
// GeoLibre (see helsharif/geolibre-netcdf-loader-plugin). Only the members this
// plugin uses need to be present at runtime; the app may not implement every
// optional method, so all calls are guarded.

export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  urlParameterNames?: string[];
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  handleUrlParameters?: (app: GeoLibreAppAPI, params: URLSearchParams) => void | Promise<void>;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}

/** Options for the native `addZarrLayer` (GeoLibre #1447), mirroring `addCogLayer`. */
export interface GeoLibreZarrLayerOptions {
  variable: string;
  selector?: Record<string, number | string>;
  clim?: [number, number];
  colormap?: string | string[];
  opacity?: number;
  zarrVersion?: 2 | 3;
  crs?: string;
  proj4?: string;
  bounds?: [number, number, number, number];
  headers?: Record<string, string>;
}

export type GeoLibreTimeGranularity = "hour" | "day" | "month" | "year";

/** Adapter that drives a layer's internal time dimension from the Time Slider (GeoLibre #1448). */
export interface GeoLibreTemporalLayerAdapter {
  /** The layer's time coordinate, in index order (Dates, epoch ms, or ISO strings). */
  getTimeValues: () => ReadonlyArray<Date | number | string>;
  /** Apply the time nearest to `date` (typically by stepping the store's time selector). */
  setTime: (date: Date) => void | Promise<void>;
  /** The internal dimension name, if known. */
  dimension?: string;
  /** The dataset's stepping cadence (period type). When honored by GeoLibre, overrides the
   * span-derived granularity so a long daily series steps by day, not year (GeoLibre #1501/#1502). */
  granularity?: GeoLibreTimeGranularity;
  /** Units the Time Slider's granularity controls should offer — e.g. `["day"]` to keep a
   * daily cube's track and labels at its cadence (GeoLibre #1501/#1502). */
  displayUnits?: GeoLibreTimeGranularity[];
}

export interface GeoLibreAppAPI {
  // Native Zarr rendering through GeoLibre's own @carbonplan/zarr-layer (GeoLibre #1447).
  addZarrLayer?: (name: string, url: string, options: GeoLibreZarrLayerOptions) => Promise<string>;
  setZarrLayerSelector?: (layerId: string, selector: Record<string, number | string>) => Promise<boolean>;
  // Bind a data-cube layer's time dimension to the native Time Slider (GeoLibre #1448).
  // `{ bind: true }` binds it immediately and opens the slider dock. Returns a detacher.
  registerTemporalLayer?: (
    layerId: string,
    adapter: GeoLibreTemporalLayerAdapter,
    options?: { bind?: boolean },
  ) => () => void;
  unregisterTemporalLayer?: (layerId: string) => void;
  // Activate/deactivate another installed plugin (GeoLibre #1515). A plugin may not
  // deactivate itself. GeoLibre already auto-closes the Time Slider dock when the last
  // temporal binding is removed, so we don't need deactivatePlugin for that — it's here
  // to keep the vendored surface in sync with GeoLibreAppAPI.
  activatePlugin?: (pluginId: string, state?: unknown) => Promise<boolean>;
  deactivatePlugin?: (pluginId: string) => boolean;
  registerExternalNativeLayer?: (layer: GeoLibreExternalNativeLayerRegistration) => void;
  unregisterExternalNativeLayer?: (id: string) => void;
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  getMap?: () => GeoLibreMapLike;
  setMapProjection?: (projection: "globe" | "mercator") => void;
  getMapProjection?: () => "globe" | "mercator";
  getIdentifyLayerId?: () => string | null;
  addMapControl?: (control: GeoLibreMapControl, position?: GeoLibreMapControlPosition) => boolean;
  removeMapControl?: (control: GeoLibreMapControl) => void;
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;
}

export interface GeoLibreMapControl {
  onAdd: (map: unknown) => HTMLElement;
  onRemove: () => void;
}

export interface GeoLibreExternalNativeLayerRegistration {
  id: string;
  name: string;
  type?: string;
  nativeLayerIds: string[];
  sourceIds?: string[];
  beforeId?: string;
  opacity?: number;
  metadata?: Record<string, unknown>;
  // GeoLibre #1447: declare that the plugin paints the layer so the Style panel drops the
  // controls it can't reach, and optionally bridge opacity/visibility to the custom layer.
  paintMode?: "plugin";
  paintBridge?: {
    setOpacity?: (opacity: number) => void;
    setVisibility?: (visible: boolean) => void;
  };
}

export interface GeoLibreMapLike {
  addLayer: (layer: unknown, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  getLayer: (id: string) => unknown;
  moveLayer?: (id: string, beforeId?: string) => void;
  getStyle?: () => { layers?: Array<{ id: string; type: string }> };
  getBounds?: () => { toArray: () => [[number, number], [number, number]] };
  fitBounds?: (bounds: [[number, number], [number, number]], options?: unknown) => void;
  on?: (type: string, listener: (event: unknown) => void) => void;
  off?: (type: string, listener: (event: unknown) => void) => void;
}

export interface GeoLibreRightPanelRegistration {
  id: string;
  title: string;
  dock?: "left-of-layers" | "right-of-layers" | "left-of-style" | "right-of-style";
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}
