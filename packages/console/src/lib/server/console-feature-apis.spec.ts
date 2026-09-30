// @vitest-environment node

import { describe, expect, it } from "vitest";

import { consoleFeatures } from "../console-features";
import { consoleFeatureApis } from "./console-feature-apis";

describe("consoleFeatureApis", () => {
  it("builds every feature, over the admin API exactly where the registry says a self-hosted server serves it", () => {
    expect(Object.keys(consoleFeatureApis)).toEqual(
      Object.keys(consoleFeatures),
    );
    for (const [feature, { remote }] of Object.entries(consoleFeatures)) {
      const api =
        consoleFeatureApis[feature as keyof typeof consoleFeatureApis];
      expect(typeof api.local, feature).toBe("function");
      expect(api.remote !== undefined, feature).toBe(remote);
    }
  });
});
