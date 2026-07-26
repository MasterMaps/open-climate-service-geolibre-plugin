import chroma from "chroma-js";

// Build a 256-entry colour ramp from a chroma/ColorBrewer scale name. A trailing
// `_r` reverses the ramp (matplotlib convention). Falls back to viridis on an
// unknown name. Returns hex strings, which zarr-layer accepts as its `colormap`.
export function buildColormap(name = "viridis"): string[] {
  const reversed = name.endsWith("_r");
  const scaleName = reversed ? name.slice(0, -2) : name;
  try {
    const colors = chroma.scale(scaleName).colors(256);
    return reversed ? colors.reverse() : colors;
  } catch {
    return chroma.scale("viridis").colors(256);
  }
}
