import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("Cloudflare Worker package exports", () => {
  it("publishes the Worker entrypoint for ESM imports only", () => {
    // Given: the published package manifest.
    const workerExport = packageJson.exports["./worker"];

    // When: consumers resolve the Worker subpath conditions.
    const conditions = Object.keys(workerExport);

    // Then: only types and ESM import targets are advertised.
    expect(conditions).toEqual(["types", "import"]);
    expect(workerExport).toEqual({
      types: "./dist/worker/index.d.cts",
      import: "./dist/worker/index.mjs",
    });
  });
});
