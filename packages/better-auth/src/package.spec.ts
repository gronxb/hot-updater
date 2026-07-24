import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

describe("@hot-updater/better-auth package", () => {
  it("publishes one dual-format entry with Better Auth as an optional peer", () => {
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
      "./package.json": "./package.json",
    });
    expect(packageJson.dependencies).toEqual({
      "@hot-updater/server": "workspace:*",
    });
    expect(packageJson.peerDependencies).toEqual({
      "better-auth": "^1.6.23",
    });
    expect(packageJson.peerDependenciesMeta).toEqual({
      "better-auth": { optional: true },
    });
  });
});
