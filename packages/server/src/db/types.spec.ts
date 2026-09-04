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
      models: {
        ...plugin.models,
        bundles: { ...plugin.models.bundles, findMany: null },
      },
    };
    const missingInsights = {
      ...plugin,
      models: { ...plugin.models, insights: undefined },
    };
    const malformedInsights = {
      ...plugin,
      models: {
        ...plugin.models,
        insights: { ...plugin.models.insights, pageEvents: null },
      },
    };
    const malformedChannels = {
      ...plugin,
      models: {
        ...plugin.models,
        channels: { ...plugin.models.channels, delete: null },
      },
    };
    const malformedApiKeys = {
      ...plugin,
      models: {
        ...plugin.models,
        apiKeys: {
          ...plugin.models.apiKeys,
          revoke: null,
        },
      },
    };
    const malformedDispose = { ...plugin, dispose: null };

    expect(isDatabasePlugin(factory)).toBe(false);
    expect(isDatabasePlugin(malformedBundles)).toBe(false);
    expect(isDatabasePlugin(missingInsights)).toBe(false);
    expect(isDatabasePlugin(malformedInsights)).toBe(false);
    expect(isDatabasePlugin(malformedChannels)).toBe(false);
    expect(isDatabasePlugin(malformedApiKeys)).toBe(false);
    expect(isDatabasePlugin(malformedDispose)).toBe(false);
  });
});
