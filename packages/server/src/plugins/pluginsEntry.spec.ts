import { createRequire } from "node:module";

import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import * as plugins from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("@hot-updater/server/plugins", () => {
  it.each([
    ["ESM", plugins],
    ["CommonJS", require("@hot-updater/server/plugins") as typeof plugins],
  ])(
    "assembles official plugins from the %s entry with their options",
    (_, entry) => {
      const server = createHotUpdater({
        database: { name: "memory", adapter: createMemoryAdapter() },
        storage: createReleaseCatalogTestStorage(),
        plugins: [
          entry.apiKeys({ headerName: "x-client-key" }),
          entry.insights({ retention: { rawDays: 7, dailyDays: 30 } }),
          entry.remoteConfig(),
        ],
      });

      expect(Object.keys(server.api)).toEqual([
        "apiKeys",
        "insights",
        "remoteConfig",
      ]);
      expect(server.clientAuth?.varyHeaders).toEqual(["x-client-key"]);
      expect(server.api.insights.retention).toEqual({
        rawDays: 7,
        dailyDays: 30,
      });
      expect(server.clientPlugins).toEqual([
        { module: "@hot-updater/react-native", name: "insights" },
      ]);
      expect(entry.createInsightsModel).toBeTypeOf("function");
      expect(entry.createApiKeyModel).toBeTypeOf("function");
      expect(entry.validateRemoteConfigTemplate).toBeTypeOf("function");
      expect(entry).not.toHaveProperty("definePlugin");
    },
  );
});
