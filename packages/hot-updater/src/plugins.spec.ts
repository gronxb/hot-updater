import {
  assembleServer,
  clientAuthOf,
  generateClientCredential,
  provisionClientCredential,
} from "@hot-updater/cli-tools";
import {
  createEngineDatabase,
  createMemoryAdapter,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  apiKeys as serverApiKeys,
  insights as serverInsights,
  remoteConfig as serverRemoteConfig,
} from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
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
      storage: createReleaseCatalogTestStorage(),
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

  it("are Hot Updater's own, so they assemble under their reserved ids", () => {
    // A copy of a plugin that takes a reserved id is refused at assembly.
    const server = assembleServer({
      database: createEngineDatabase({
        name: "memory",
        adapter: createMemoryAdapter(),
      }),
      plugins: [apiKeys(), insights(), remoteConfig()],
    });

    expect(Object.keys(server.api).sort()).toEqual([
      "apiKeys",
      "insights",
      "remoteConfig",
    ]);
    expect(clientAuthOf(server)?.plugin).toBe("apiKeys");
    expect(server.clientPlugins).toEqual([
      { module: "@hot-updater/react-native", name: "insights" },
    ]);
  });

  it("provision the app's API key on the config's database, registering a saved one again", async () => {
    const database = createEngineDatabase({
      name: "memory",
      adapter: createMemoryAdapter(),
    });
    const server = assembleServer({
      database,
      plugins: [apiKeys(), insights(), remoteConfig()],
    });
    await database.createMigrator!(toolingTargetOf(server.plugins))
      .migrateToLatest({ mode: "from-schema", updateSettings: true })
      .then((result) => result.execute());

    expect(generateClientCredential(server)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const created = await provisionClientCredential(server, {
      env: {},
      name: "Init",
    });
    expect(created).toMatchObject({
      label: "API key",
      header: "x-api-key",
      env: "HOT_UPDATER_API_KEY",
      value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const again = await provisionClientCredential(server, {
      env: { HOT_UPDATER_API_KEY: ` ${created!.value}\n` },
      name: "Init again",
    });
    expect(again?.value).toBe(created!.value);
    await expect(
      (server.api["apiKeys"] as { list(): Promise<readonly unknown[]> }).list(),
    ).resolves.toHaveLength(1);
  });
});
