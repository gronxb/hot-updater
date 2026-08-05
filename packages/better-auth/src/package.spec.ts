import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("@hot-updater/better-auth package", () => {
  it("publishes root, managed runtime, and Node provisioning entries", () => {
    expect(packageJson.name).toBe("@hot-updater/better-auth");
    expect(packageJson.exports).toEqual({
      ".": {
        import: {
          types: "./dist/index.d.mts",
          default: "./dist/index.mjs",
        },
        require: {
          types: "./dist/index.d.cts",
          default: "./dist/index.cjs",
        },
      },
      "./managed": {
        import: {
          types: "./dist/managed.d.mts",
          default: "./dist/managed.mjs",
        },
        require: {
          types: "./dist/managed.d.cts",
          default: "./dist/managed.cjs",
        },
      },
      "./managed/provisioning": {
        import: {
          types: "./dist/managed/provisioning.d.mts",
          default: "./dist/managed/provisioning.mjs",
        },
        require: {
          types: "./dist/managed/provisioning.d.cts",
          default: "./dist/managed/provisioning.cjs",
        },
      },
      "./package.json": "./package.json",
    });
    expect(packageJson.dependencies).toEqual({
      "@better-auth/api-key": "1.6.24",
      "@hot-updater/server": "workspace:*",
      "better-auth": "1.6.24",
    });
    expect(packageJson.devDependencies).toEqual({
      "@types/node": "catalog:",
    });
  });
});
