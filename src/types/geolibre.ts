// GeoLibre Desktop plugin API surface. Mirrors the public interface exposed by
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

export interface GeoLibreAppAPI {
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
}

export interface GeoLibreMapLike {
  addLayer: (layer: unknown, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  getLayer: (id: string) => unknown;
  moveLayer?: (id: string, beforeId?: string) => void;
  getStyle?: () => { layers?: Array<{ id: string; type: string }> };
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
