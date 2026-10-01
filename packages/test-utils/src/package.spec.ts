import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("@hot-updater/test-utils package", () => {
  it("is publishable so external providers can run the same contracts", () => {
    expect(Object.hasOwn(packageJson, "private")).toBe(false);
    expect(packageJson.publishConfig.access).toBe("public");
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

  it("advertises the client plugin helper in both module formats, for Vitest and Jest", () => {
    expect(packageJson.exports["./react-native"]).toEqual({
      import: {
        types: "./dist/react-native.d.mts",
        default: "./dist/react-native.mjs",
      },
      require: {
        types: "./dist/react-native.d.cts",
        default: "./dist/react-native.cjs",
      },
    });
  });

  it("needs no React Native SDK: client plugins run on protocol's plugin host", () => {
    expect(packageJson.peerDependencies["@hot-updater/protocol"]).toBe(
      "workspace:^",
    );
    expect(Object.keys(packageJson.peerDependencies)).not.toContain(
      "@hot-updater/react-native",
    );
    expect(Object.hasOwn(packageJson, "peerDependenciesMeta")).toBe(false);
  });

  it("publishes only built artifacts and package metadata", () => {
    expect(packageJson.files).toEqual(["dist", "package.json"]);
  });
});
