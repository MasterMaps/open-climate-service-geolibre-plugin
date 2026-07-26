# Open Climate Service — GeoLibre plugin

A [GeoLibre](https://geolibre.app/) Desktop plugin that browses an **Open Climate Service** (OCS) STAC catalog and renders its published GeoZarr datasets — taking the **CRS, time axis, and variable straight from STAC**, so projected national grids (e.g. seNorge on `EPSG:32633`) land in the right place with no manual entry.

It renders with [`@carbonplan/zarr-layer`](https://github.com/carbonplan/zarr-layer) and depends only on OCS's public HTTP contract (`/stac` + `/zarr/{id}/`), not on the OCS server internals. Tracking issue: [dhis2/open-climate-service#301](https://github.com/dhis2/open-climate-service/issues/301).

## Features

- Point at any OCS instance and browse its published collections (`<url>/stac`).
- Render a dataset from its `/zarr/{id}/` store as a MapLibre layer, registered in GeoLibre's Layers panel.
- **CRS from STAC** — `proj:code` + the `open_climate_service:proj4` hint OCS publishes, so non-WGS84 stores reproject correctly.
- **Time / ordinal slider** built from the STAC `cube:dimensions` (`values` or a temporal `extent` + ISO-8601 `step`).
- **Variable, colormap, rescale, nodata** read from the collection's `renders.default`.
- Deep-linkable via `?ocsUrl=…&dataset=…`; selection persists in the GeoLibre project state.

## Usage

1. Activate **Open Climate Service** from GeoLibre's Plugins menu.
2. In the panel, enter your OCS URL (e.g. `http://localhost:8002`) and click **Connect**.
3. Pick a dataset; step through time / other dimensions with the slider(s).

## Build

```bash
npm install
npm run package:geolibre   # typecheck + vite build + zip → geolibre-plugin/open-climate-service-<version>.zip
```

Then in GeoLibre Desktop: **Settings → Manage Plugins → Install from file** and select the generated zip (or add the unpacked `geolibre-plugin/` directory).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (STAC parsing helpers)
npm run build       # typecheck + bundle to geolibre-plugin/dist
```

## Notes / status

First cut per [#301](https://github.com/dhis2/open-climate-service/issues/301). Known follow-ups:

- **Bundle size / numcodecs WASM**: zarr-layer decodes `zstd` chunks via `numcodecs` (WASM). The vite bundle must inline or emit that wasm so it works inside the GeoLibre WebView — verify against a real GeoLibre build.
- **Identify** (click-to-value) is not wired yet.
- **CORS**: GeoLibre Desktop can fetch cross-origin; the browser build of GeoLibre needs CORS headers on the OCS `/zarr/` + `/stac` routers.
- Pins `@carbonplan/zarr-layer@0.6.1` (v0.6.0 was a breaking `customFrag` change).

## License

MIT.
