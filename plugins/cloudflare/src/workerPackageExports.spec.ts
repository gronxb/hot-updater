import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("Cloudflare Worker package exports", () => {
  it("publishes the Worker entrypoint for ESM imports only", () => {
    // Given: the published package manifest.
    const workerExport = packageJson.exports["./worker"];

    // When: consumers resolve the Worker subpath conditions.
    const conditions = Object.keys(workerExport);

    // Then: types and runtime code are both scoped to ESM imports.
    expect(conditions).toEqual(["import"]);
    expect(workerExport).toEqual({
      import: {
        types: "./dist/worker/index.d.mts",
        default: "./dist/worker/index.mjs",
      },
    });
  });
});
