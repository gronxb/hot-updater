import { describe, expect, it } from "vitest";

import config from "./tsdown.config";

describe("Firebase Functions build configuration", () => {
  it("bundles plugin-core subpath imports needed by the deployed function", () => {
    const functionsConfig = config.find((entry) =>
      entry.entry?.includes("firebase/functions/index.ts"),
    );

    expect(functionsConfig?.deps?.alwaysBundle).toEqual(
      expect.arrayContaining([
        "@hot-updater/plugin-core",
        "@hot-updater/plugin-core/internal",
      ]),
    );
  });
});
