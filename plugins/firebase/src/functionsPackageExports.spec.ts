import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("Firebase Functions package exports", () => {
  it("separates the public runtime plugins from the managed handler", () => {
    // Given: the published package manifest.
    const functionsExport = packageJson.exports["./functions"];
    const handlerExport = packageJson.exports["./functions/handler"];

    // When: consumers resolve the Functions subpaths.
    const runtimeConditions = Object.keys(functionsExport);

    // Then: the public subpath exposes plugins and the handler stays internal.
    expect(runtimeConditions).toEqual(["types", "import", "require"]);
    expect(functionsExport).toEqual({
      types: "./dist/functions.d.cts",
      import: "./dist/functions.mjs",
      require: "./dist/functions.cjs",
    });
    expect(handlerExport).toEqual({
      require: "./dist/firebase/functions/index.cjs",
    });
  });

  it("uses the Better Auth integration for managed authentication", () => {
    // Given: the published Firebase provider manifest.
    const dependencies = packageJson.dependencies;

    // When: managed authentication dependencies are inspected.
    const betterAuthVersion = dependencies["@hot-updater/better-auth"];

    // Then: Firebase consumes the shared Better Auth integration only.
    expect(betterAuthVersion).toBe("workspace:*");
    expect(dependencies).not.toHaveProperty("@hot-updater/api-key");
  });
});
