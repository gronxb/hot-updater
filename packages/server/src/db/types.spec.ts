import { describe, expect, it } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { isDatabasePlugin } from "./types";

describe("isDatabasePlugin", () => {
  it("accepts a direct fixed-model plugin object", () => {
    const plugin = createInMemoryDatabasePlugin();

    const result = isDatabasePlugin(plugin);

    expect(result).toBe(true);
  });

  it("rejects a v1 factory and malformed required domains", () => {
    const plugin = createInMemoryDatabasePlugin();
    const factory = () => plugin;
    const malformedBundles = {
      ...plugin,
      bundles: { ...plugin.bundles, findMany: null },
    };
    const missingAnalytics = {
      ...plugin,
      analytics: undefined,
    };
    const malformedClientAccessKeys = {
      ...plugin,
      clientAccessKeys: { ...plugin.clientAccessKeys, revoke: null },
    };

    expect(isDatabasePlugin(factory)).toBe(false);
    expect(isDatabasePlugin(malformedBundles)).toBe(false);
    expect(isDatabasePlugin(missingAnalytics)).toBe(false);
    expect(isDatabasePlugin(malformedClientAccessKeys)).toBe(false);
  });
});
