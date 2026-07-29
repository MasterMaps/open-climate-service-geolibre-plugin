import { defineConfig } from "vite";

// Single-file ES bundle for GeoLibre. zarr-layer and its deps (zarrita,
// numcodecs, proj4, chroma-js) are bundled in; MapLibre is provided by the GeoLibre
// host and is never imported here (we drive the map through the app API).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    lib: {
      entry: "src/plugin.ts",
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "style"
    },
    rollupOptions: {
      output: {
        // Emit one self-contained index.js: numcodecs lazily dynamic-imports its
        // zstd/blosc/lz4 codecs (WASM base64-inlined), which would otherwise code-split
        // into sibling chunks. A single file is safer for the GeoLibre plugin loader and
        // keeps the bundle fully offline (no runtime chunk/CDN fetch).
        inlineDynamicImports: true,
        assetFileNames: (assetInfo) =>
          (assetInfo.names ?? []).includes("style.css") ? "style.css" : "[name][extname]"
      }
    }
  }
});
