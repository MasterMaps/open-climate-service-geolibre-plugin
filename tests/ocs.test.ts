import { describe, expect, it } from "vitest";
import { buildRenderSpec, iterateTemporal, normalizeCrs, stepLabel } from "../src/ocs";

describe("normalizeCrs", () => {
  it("collapses CRS84 aliases to EPSG:4326", () => {
    for (const c of ["CRS84", "OGC:CRS84", "CRS:84", "urn:ogc:def:crs:OGC:1.3:CRS84"]) {
      expect(normalizeCrs(c)).toBe("EPSG:4326");
    }
  });
  it("passes projected codes through unchanged", () => {
    expect(normalizeCrs("EPSG:32633")).toBe("EPSG:32633");
    expect(normalizeCrs("EPSG:4326")).toBe("EPSG:4326");
  });
});

describe("iterateTemporal", () => {
  it("expands a daily extent into ISO dates", () => {
    const steps = iterateTemporal("2026-01-01", "2026-01-04", "P1D");
    expect(steps).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
  });
  it("expands a monthly extent", () => {
    const steps = iterateTemporal("2026-01-01", "2026-03-01", "P1M");
    expect(steps).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
  it("returns empty for an unparseable step", () => {
    expect(iterateTemporal("2026-01-01", "2026-02-01", "nope")).toEqual([]);
  });
});

describe("buildRenderSpec", () => {
  const collection = {
    id: "era5land_temperature_daily",
    keywords: ["stac", "zarr", "ERA5-Land", "t2m"],
    assets: { zarr: { href: "http://host/zarr/era5land_temperature_daily/", "zarr:zarr_format": 3 } },
    "proj:code": "EPSG:4326",
    renders: {
      default: {
        rescale: [[-30, 40]],
        colormap_name: "RdBu_r",
        "open_climate_service:variable": "t2m",
      },
    },
    "cube:variables": { t2m: { unit: "degC" } },
    "cube:dimensions": {
      x: { type: "spatial", axis: "x" },
      y: { type: "spatial", axis: "y" },
      t: { type: "temporal", extent: ["2026-01-01", "2026-01-05"], step: "P1D" },
    },
  };

  it("derives variable, clim, crs, units and a temporal slider", () => {
    const spec = buildRenderSpec(collection);
    expect(spec.variable).toBe("t2m");
    expect(spec.clim).toEqual([-30, 40]);
    expect(spec.crs).toBe("EPSG:4326");
    expect(spec.units).toBe("degC");
    expect(spec.zarrVersion).toBe(3);
    expect(spec.source).toBe("ERA5-Land");
    const t = spec.dims.find((d) => d.key === "t");
    expect(t?.control).toBe("slider");
    expect(t?.count).toBe(5);
    expect(t?.index).toBe(4); // slider defaults to the latest step
  });

  it("prefers a published proj4 hint for projected stores", () => {
    const utm = {
      ...collection,
      "proj:code": "EPSG:32633",
      "open_climate_service:proj4": "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs",
    };
    const spec = buildRenderSpec(utm);
    expect(spec.crs).toBe("EPSG:32633");
    expect(spec.proj4).toContain("proj=utm");
  });

  it("throws when the collection has no zarr asset", () => {
    const noAsset = { ...collection, assets: {} };
    expect(() => buildRenderSpec(noAsset)).toThrow(/Zarr asset/);
  });
});

describe("irregular temporal axis (a dekadal store)", () => {
  // A cadence with unequal periods cannot be an ISO duration, so STAC gives it `step: null`
  // and lists explicit values. Shaped exactly as OCS publishes it.
  const dekadal = (values: string[]) => ({
    id: "clms_gpp_dekad",
    assets: { zarr: { href: "http://x/zarr/clms_gpp_dekad", "zarr:zarr_format": 3 } },
    "cube:dimensions": {
      t: { type: "temporal", extent: [values[0], values[values.length - 1]], step: null, values },
      x: { type: "spatial", axis: "x" },
      y: { type: "spatial", axis: "y" },
    },
  });
  const year2024 = ["01-01", "01-11", "01-21", "02-01", "02-11", "02-21"].map(
    (md) => `2024-${md}T00:00:00Z`,
  );

  it("keeps every dekad as a slider step", () => {
    const spec = buildRenderSpec(dekadal(year2024));
    const t = spec.dims.find((d) => d.isTemporal);
    expect(t).toBeTruthy();
    expect(t!.control).toBe("slider");
    expect(t!.count).toBe(6);
    // Regression: with no `values` and a null step there would be no steps at all, so the
    // control would be filtered out and the axis would be unreachable.
    expect(t!.steps[1]).toBe("2024-01-11T00:00:00Z");
  });

  it("names the cadence instead of reporting none", () => {
    expect(buildRenderSpec(dekadal(year2024)).temporalResolution).toBe("10-daily (dekad)");
  });

  it("does not mistake other irregular axes for dekads", () => {
    const odd = ["2024-01-03", "2024-02-07", "2024-03-19"].map((d) => `${d}T00:00:00Z`);
    expect(buildRenderSpec(dekadal(odd)).temporalResolution).toBe("Irregular");
  });

  it("still reports the ISO label when there is a real step", () => {
    const monthly = dekadal(year2024) as Record<string, any>;
    monthly["cube:dimensions"].t = {
      type: "temporal",
      extent: ["2024-01-01", "2024-12-01"],
      step: "P1M",
    };
    expect(buildRenderSpec(monthly).temporalResolution).toBe("Monthly");
  });
});

describe("stepLabel", () => {
  const dim = (steps: Array<string | number>) =>
    ({ key: "t", label: "Time step", control: "slider", steps, count: steps.length, index: 0, isTemporal: true }) as const;

  it("trims a midnight timestamp to its date, matching the generated path", () => {
    // `iterateTemporal` already yields "2024-12-21"; explicit `values` arrive full-length.
    const d = dim(["2024-12-21T00:00:00Z", "2024-12-21T00:00Z", "2024-12-21T00:00:00.000Z"]);
    expect(stepLabel(d, 0)).toBe("2024-12-21");
    expect(stepLabel(d, 1)).toBe("2024-12-21");
    expect(stepLabel(d, 2)).toBe("2024-12-21");
  });

  it("keeps the time of day when there is one", () => {
    expect(stepLabel(dim(["2024-12-21T06:00:00Z"]), 0)).toBe("2024-12-21 06:00");
  });

  it("passes ordinal and category steps through untouched", () => {
    expect(stepLabel(dim([1, 32, 60]), 1)).toBe("32");
    expect(stepLabel(dim(["female", "male"]), 0)).toBe("female");
    expect(stepLabel(dim(["2024-12-21"]), 0)).toBe("2024-12-21");
  });

  it("falls back to the index when a step is missing", () => {
    expect(stepLabel(dim([]), 3)).toBe("3");
  });
});
