import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveEdgeFunctionDenoConfig } from "./index";

const require = createRequire(import.meta.url);

const resolveFileUrl = (packageName: string, relativePath: string) => {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);

  return pathToFileURL(path.join(path.dirname(packageJsonPath), relativePath))
    .href;
};

describe("resolveEdgeFunctionDenoConfig", () => {
  it("resolves imports from the currently installed package exports", async () => {
    const result = await resolveEdgeFunctionDenoConfig();

    expect(result).toEqual({
      imports: {
        "@hot-updater/server/runtime": resolveFileUrl(
          "@hot-updater/server",
          "dist/runtime.mjs",
        ),
        "@hot-updater/supabase": resolveFileUrl(
          "@hot-updater/supabase",
          "dist/edge.mjs",
        ),
      },
    });
  });
});
