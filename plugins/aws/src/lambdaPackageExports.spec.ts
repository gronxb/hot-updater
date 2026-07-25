import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("AWS Lambda package exports", () => {
  it("separates the public runtime plugins from the managed handler", () => {
    // Given: the published package manifest.
    const lambdaExport = packageJson.exports["./lambda"];
    const handlerExport = packageJson.exports["./lambda/handler"];

    // When: consumers resolve the Lambda subpaths.
    const runtimeConditions = Object.keys(lambdaExport);

    // Then: the public subpath exposes plugins and the handler stays internal.
    expect(runtimeConditions).toEqual(["types", "import", "require"]);
    expect(lambdaExport).toEqual({
      types: "./dist/lambda.d.cts",
      import: "./dist/lambda.mjs",
      require: "./dist/lambda.cjs",
    });
    expect(handlerExport).toEqual({
      require: "./dist/lambda/index.cjs",
    });
  });

  it("declares the managed Better Auth plugin as a runtime dependency", () => {
    // Given: the Lambda handler imports the managed Better Auth plugin.
    // When: package runtime dependencies are inspected.
    const dependency = packageJson.dependencies["@hot-updater/better-auth"];

    // Then: published installs always include Better Auth authentication.
    expect(dependency).toBe("workspace:*");
    expect(packageJson.dependencies).not.toHaveProperty("@hot-updater/api-key");
  });
});
