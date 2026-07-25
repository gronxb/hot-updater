import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("Cloudflare Worker package exports", () => {
  it("uses Better Auth for managed API-key authentication", () => {
    // Given: the published package manifest.
    const dependencies = packageJson.dependencies;

    // When: consumers install the Cloudflare managed provider.
    const betterAuthDependency = dependencies["@hot-updater/better-auth"];

    // Then: the Better Auth integration is installed from this workspace.
    expect(betterAuthDependency).toBe("workspace:*");
  });

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
