import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("@hot-updater/test-utils package", () => {
  it("is publishable as a public package", () => {
    expect(Object.hasOwn(packageJson, "private")).toBe(false);
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  it("advertises the Vitest-dependent root as ESM-only", () => {
    expect(packageJson.main).toBe("./dist/index.mjs");
    expect(packageJson.module).toBe("./dist/index.mjs");
    expect(packageJson.types).toBe("./dist/index.d.mts");
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.mts",
      import: "./dist/index.mjs",
    });
  });

  it("advertises the Node-only entrypoint in both module formats", () => {
    expect(packageJson.exports["./node"]).toEqual({
      import: {
        types: "./dist/node.d.mts",
        default: "./dist/node.mjs",
      },
      require: {
        types: "./dist/node.d.cts",
        default: "./dist/node.cjs",
      },
    });
  });

  it("publishes only built artifacts and package metadata", () => {
    expect(packageJson.files).toEqual(["dist", "package.json"]);
  });
});
