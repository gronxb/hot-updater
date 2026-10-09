import { assembleServer, clientAuthOf } from "@hot-updater/cli-tools";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  apiKeys as serverApiKeys,
  insights as serverInsights,
  remoteConfig as serverRemoteConfig,
} from "@hot-updater/server/plugins";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { describe, expect, it } from "vitest";

describe("hot-updater/plugins", () => {
  it("reuses the server factories so both entry points accept the same plugins and options", () => {
    expect(apiKeys).toBe(serverApiKeys);
    expect(insights).toBe(serverInsights);
    expect(remoteConfig).toBe(serverRemoteConfig);

    const plugins = [
      apiKeys({ headerName: "x-custom-key" }),
      insights({ retention: { rawDays: 7, dailyDays: 30 } }),
      remoteConfig(),
    ];
    const definition = {
      database: { name: "memory", adapter: createMemoryAdapter() },
      plugins,
    };
    const cli = assembleServer(definition);
    const server = createHotUpdater(definition);

    expect(clientAuthOf(cli)?.credential.header).toBe("x-custom-key");
    expect(cli.api).toHaveProperty("insights.retention", {
      rawDays: 7,
      dailyDays: 30,
    });
    expect(server.api.insights.retention).toEqual({
      rawDays: 7,
      dailyDays: 30,
    });
    expect(Object.keys(server.api)).toEqual(Object.keys(cli.api));
  });
});
