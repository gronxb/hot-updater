import { describe, expect, it } from "vitest";

import {
  isConfigFeatureManifest,
  stampConfigFeatureManifest,
} from "./config-feature-manifest";

describe("config feature manifest carrier", () => {
  it("stamps and freezes a valid manifest", () => {
    const manifest = stampConfigFeatureManifest({
      id: "analytics",
      namespace: "analytics",
      version: "1.0.0",
    });

    expect(isConfigFeatureManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it("rejects structural and malformed branded values", () => {
    const structural = {
      id: "analytics",
      namespace: "analytics",
      version: "1.0.0",
    };
    const malformed = {
      ...structural,
      [Symbol.for("@hot-updater/plugin-core/config-feature-manifest/v1")]: true,
      version: 1,
    };

    expect(isConfigFeatureManifest(structural)).toBe(false);
    expect(isConfigFeatureManifest(malformed)).toBe(false);
  });
});
