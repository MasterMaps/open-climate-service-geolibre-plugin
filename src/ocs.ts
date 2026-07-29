// Open Climate Service STAC client: list a catalog's collections and turn a
// collection document into everything zarr-layer needs to render it. Mirrors the
// logic in the OCS `/map` viewer so behaviour stays consistent across clients.

// STAC/JSON documents are dynamic; type them loosely at the boundary.
type StacJson = Record<string, any>;

export interface OcsCollectionSummary {
  id: string;
  title: string;
  href: string;
}

export type DimControl = "slider" | "dropdown";

export interface DimState {
  key: string;
  label: string;
  control: DimControl;
  steps: Array<string | number>;
  count: number;
  index: number;
  /** True for a real date axis — driven by GeoLibre's native Time Slider, not our panel. */
  isTemporal: boolean;
}

export interface RenderSpec {
  datasetId: string;
  zarrHref: string;
  variable: string;
  clim: [number, number];
  colormapName: string;
  fillValue: number | null;
  crs: string;
  proj4: string | null;
  bounds: [number, number, number, number] | null;
  zarrVersion: number | null;
  units: string;
  source: string | null;
  temporalResolution: string | null;
  dims: DimState[];
}

/** The instance's configured spatial extent (`<ocsUrl>/extent`). */
export interface InstanceExtent {
  name: string | null;
  bbox: [number, number, number, number];
}

const MAX_STEPS = 20000;

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** CRS84 aliases (CRS84, OGC:CRS84, CRS:84, CRS84 URIs) are geographic WGS84. zarr-layer
 * only resolves EPSG:4326/EPSG:3857 by code, so normalize the alias to EPSG:4326. */
export function normalizeCrs(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").endsWith("CRS84") ? "EPSG:4326" : code;
}

interface Duration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function parseDuration(iso: string): Duration | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    iso
  );
  if (!m) return null;
  const n = (v: string | undefined): number => (v ? Number(v) : 0);
  const d: Duration = {
    years: n(m[1]),
    months: n(m[2]),
    weeks: n(m[3]),
    days: n(m[4]),
    hours: n(m[5]),
    minutes: n(m[6]),
    seconds: n(m[7]),
  };
  if (Object.values(d).every((x) => x === 0)) return null;
  return d;
}

function advance(date: Date, d: Duration): Date {
  const dt = new Date(date.getTime());
  if (d.years) dt.setUTCFullYear(dt.getUTCFullYear() + d.years);
  if (d.months) dt.setUTCMonth(dt.getUTCMonth() + d.months);
  if (d.weeks || d.days) dt.setUTCDate(dt.getUTCDate() + d.weeks * 7 + d.days);
  if (d.hours) dt.setUTCHours(dt.getUTCHours() + d.hours);
  if (d.minutes) dt.setUTCMinutes(dt.getUTCMinutes() + d.minutes);
  if (d.seconds) dt.setUTCSeconds(dt.getUTCSeconds() + d.seconds);
  return dt;
}

/** Expand a temporal extent [start, end] by an ISO-8601 step into labelled dates. */
export function iterateTemporal(startISO: string, endISO: string, stepISO: string): string[] {
  const dur = parseDuration(stepISO);
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (!dur || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const subDaily = dur.hours > 0 || dur.minutes > 0 || dur.seconds > 0;
  const out: string[] = [];
  let cur = start;
  while (cur.getTime() <= end.getTime() && out.length < MAX_STEPS) {
    out.push(subDaily ? cur.toISOString().slice(0, 16).replace("T", " ") : cur.toISOString().slice(0, 10));
    const next = advance(cur, dur);
    if (next.getTime() <= cur.getTime()) break;
    cur = next;
  }
  return out;
}

/** Non-spatial dimensions the user steps through (skip the synthetic `bands` axis). */
function steppingDimKeys(dimensions: StacJson): string[] {
  return Object.entries(dimensions)
    .filter(([, v]) => {
      const dim = v as StacJson;
      return dim.type !== "spatial" && dim.type !== "bands" && (Array.isArray(dim.values) || dim.extent);
    })
    .map(([key]) => key);
}

function controlForDim(dim: StacJson): DimControl {
  const hint = dim["open_climate_service:control"];
  if (hint === "slider" || hint === "dropdown") return hint;
  if (dim.type === "temporal" || typeof dim.step === "number") return "slider";
  return "dropdown";
}

function dimLabel(key: string, dim: StacJson): string {
  if (dim.type === "temporal") return "Time step";
  if (key === "dayofyear") return "Day of year";
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

function buildSteps(dim: StacJson): Array<string | number> {
  if (Array.isArray(dim.values)) return dim.values;
  const ext = dim.extent;
  if (Array.isArray(ext) && ext.length === 2 && dim.step != null) {
    return iterateTemporal(String(ext[0]), String(ext[1]), String(dim.step));
  }
  return [];
}

const _ISO_STEP_LABELS: Record<string, string> = {
  PT1H: "Hourly",
  P1D: "Daily",
  P7D: "Weekly",
  P1M: "Monthly",
  P3M: "Seasonal",
  P1Y: "Yearly",
};

/** Human label for a dataset's temporal resolution, from its temporal dimension's ISO step. */
function temporalResolutionLabel(dimensions: StacJson): string | null {
  for (const v of Object.values(dimensions)) {
    const dim = v as StacJson;
    if (dim.type === "temporal" && typeof dim.step === "string" && dim.step) {
      return _ISO_STEP_LABELS[dim.step] ?? dim.step;
    }
  }
  return null;
}

/** Fetch the instance's configured extent from `<ocsUrl>/extent`; null if unavailable. */
export async function fetchInstanceExtent(ocsUrl: string): Promise<InstanceExtent | null> {
  try {
    const res = await fetch(`${stripTrailingSlashes(ocsUrl)}/extent`);
    if (!res.ok) return null;
    const data = (await res.json()) as StacJson;
    const bbox = data.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === "number")) return null;
    const name = typeof data.name === "string" && data.name ? data.name : null;
    return { name, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] };
  } catch {
    return null;
  }
}

/** Fetch a catalog's published collections (id + title) from `<ocsUrl>/stac`. */
export async function fetchCatalog(ocsUrl: string): Promise<OcsCollectionSummary[]> {
  const base = stripTrailingSlashes(ocsUrl);
  const res = await fetch(`${base}/stac`);
  if (!res.ok) throw new Error(`STAC catalog fetch failed (HTTP ${res.status})`);
  const cat = (await res.json()) as StacJson;
  const links: StacJson[] = Array.isArray(cat.links) ? cat.links : [];
  return links
    .filter((l) => l.rel === "child")
    .map((l) => {
      const id = stripTrailingSlashes(String(l.href)).split("/").pop() ?? "";
      return { id, title: typeof l.title === "string" && l.title ? l.title : id, href: String(l.href) };
    })
    .filter((c) => c.id.length > 0);
}

/** Fetch a single collection document from `<ocsUrl>/stac/collections/<id>`. */
export async function fetchCollection(ocsUrl: string, datasetId: string): Promise<StacJson> {
  const base = stripTrailingSlashes(ocsUrl);
  const res = await fetch(`${base}/stac/collections/${encodeURIComponent(datasetId)}`);
  if (!res.ok) throw new Error(`Collection '${datasetId}' fetch failed (HTTP ${res.status})`);
  return (await res.json()) as StacJson;
}

/** Turn a STAC collection into a render spec for zarr-layer. */
export function buildRenderSpec(collection: StacJson): RenderSpec {
  const renders: StacJson = collection.renders?.default ?? {};
  const zarr: StacJson | undefined = collection.assets?.zarr;
  if (!zarr?.href) throw new Error("No Zarr asset found in this collection");

  const clim: [number, number] = Array.isArray(renders.rescale?.[0])
    ? (renders.rescale[0] as [number, number])
    : [0, 100];
  const colormapName: string = renders.colormap_name ?? "viridis";
  const fillValue: number | null = renders.nodata ?? null;
  const variable: string =
    renders["open_climate_service:variable"] ?? Object.keys(collection["cube:variables"] ?? {})[0] ?? "data";

  const dimensions: StacJson = collection["cube:dimensions"] ?? {};
  const dims: DimState[] = steppingDimKeys(dimensions)
    .map((key): DimState => {
      const dim = dimensions[key] as StacJson;
      const steps = buildSteps(dim);
      const control = controlForDim(dim);
      const count = steps.length;
      // Sliders default to the last step (latest time); dropdowns to the first.
      const index = control === "slider" ? Math.max(0, count - 1) : 0;
      return { key, label: dimLabel(key, dim), control, steps, count, index, isTemporal: dim.type === "temporal" };
    })
    .filter((d) => d.count >= 1);

  const crs = normalizeCrs(collection["proj:code"] ?? "EPSG:4326");
  const proj4: string | null = collection["open_climate_service:proj4"] ?? null;
  // proj:bbox is the native-CRS extent; passing it as zarr-layer `bounds` avoids a
  // render-time fetch of the x/y coordinate arrays to derive them.
  const rawBbox = collection["proj:bbox"];
  const bounds: [number, number, number, number] | null =
    Array.isArray(rawBbox) && rawBbox.length === 4 && rawBbox.every((n) => typeof n === "number")
      ? [rawBbox[0], rawBbox[1], rawBbox[2], rawBbox[3]]
      : null;
  const zarrVersion: number | null = zarr["zarr:zarr_format"] ?? null;
  const units: string =
    renders["open_climate_service:units"] ?? collection["cube:variables"]?.[variable]?.unit ?? "";
  const keywords: string[] = Array.isArray(collection.keywords) ? collection.keywords : [];
  const source =
    keywords.find((k) => k !== "zarr" && k !== "stac" && k !== variable && k !== collection.id) ?? null;
  const temporalResolution = temporalResolutionLabel(dimensions);

  return { datasetId: collection.id, zarrHref: zarr.href, variable, clim, colormapName, fillValue, crs, proj4, bounds, zarrVersion, units, source, temporalResolution, dims };
}
