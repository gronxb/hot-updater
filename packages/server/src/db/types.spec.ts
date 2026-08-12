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
    const missingAnalytics = {
      ...plugin,
      models: { ...plugin.models, analytics: undefined },
    };
    const malformedChannels = {
      ...plugin,
      models: {
        ...plugin.models,
        channels: { ...plugin.models.channels, delete: null },
      },
    };
    const malformedClientAccessKeys = {
      ...plugin,
      models: {
        ...plugin.models,
        clientAccessKeys: {
          ...plugin.models.clientAccessKeys,
          revoke: null,
        },
      },
    };
    const malformedQueries = {
      ...plugin,
      queries: { getUpdateInfo: null },
    };
    const malformedDispose = { ...plugin, dispose: null };

    expect(isDatabasePlugin(factory)).toBe(false);
    expect(isDatabasePlugin(malformedBundles)).toBe(false);
    expect(isDatabasePlugin(missingAnalytics)).toBe(false);
    expect(isDatabasePlugin(malformedChannels)).toBe(false);
    expect(isDatabasePlugin(malformedClientAccessKeys)).toBe(false);
    expect(isDatabasePlugin(malformedQueries)).toBe(false);
    expect(isDatabasePlugin(malformedDispose)).toBe(false);
  });
});
