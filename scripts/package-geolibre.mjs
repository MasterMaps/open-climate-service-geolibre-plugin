import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const pluginDir = path.resolve("geolibre-plugin");
const manifestPath = path.join(pluginDir, "plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// package.json is the single source of truth for the version. Sync it into the
// committed manifest so plugin.json, the bundle (injected via Vite), and package.json
// can never disagree — the GeoLibre registry rejects a mismatch between the entry
// module's version and its manifest.
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Synced plugin.json version -> ${pkg.version}`);
}

const zipPath = path.join(pluginDir, `${manifest.id}-${manifest.version}.zip`);

for (const required of [manifest.entry, manifest.style]) {
  if (required && !fs.existsSync(path.join(pluginDir, required))) {
    throw new Error(`Missing packaged file: ${required} (run \`npm run build\` first)`);
  }
}

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath);
}

const output = fs.createWriteStream(zipPath);
const archive = archiver("zip", { zlib: { level: 9 } });

archive.on("warning", (error) => {
  throw error;
});
archive.on("error", (error) => {
  throw error;
});

archive.pipe(output);
archive.file(manifestPath, { name: "plugin.json" });
archive.directory(path.join(pluginDir, "dist"), "dist");
await archive.finalize();

await new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
});

console.log(`Wrote ${zipPath}`);
