import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import * as edge from "./edge";

describe("Supabase Edge runtime exports", () => {
  it("publishes an isolated runtime entrypoint", () => {
    // Given: the published package manifest.
    const edgeExport = packageJson.exports["./edge"];

    // When: consumers resolve the Edge subpath.
    const conditions = Object.keys(edgeExport);

    // Then: both module systems resolve the standalone runtime bundle.
    expect(conditions).toEqual(["types", "import", "require"]);
    expect(edgeExport).toEqual({
      types: "./dist/edge/index.d.cts",
      import: "./dist/edge/index.mjs",
      require: "./dist/edge/index.cjs",
    });
  });

  it("uses provider names without leaking implementation names", () => {
    // Given: the Edge runtime entrypoint.
    const exportNames = Object.keys(edge);

    // When: consumers inspect the available plugin factories.
    // Then: the runtime exposes the same provider-facing names as the root.
    expect(exportNames).toEqual(
      expect.arrayContaining(["supabaseDatabase", "supabaseStorage"]),
    );
  });
});
