import { plugins as aws } from "@hot-updater/aws";
import {
  assembleServer,
  clientAuthOf,
  generateClientCredential,
  provisionClientCredential,
} from "@hot-updater/cli-tools";
import { plugins as cloudflare } from "@hot-updater/cloudflare";
import { plugins as firebase } from "@hot-updater/firebase";
import {
  createEngineDatabase,
  createMemoryAdapter,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { plugins as supabase } from "@hot-updater/supabase";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { describe, expect, it } from "vitest";

describe.each([
  ["hot-updater/plugins", [apiKeys(), insights(), remoteConfig()]],
  ["@hot-updater/aws", aws],
  ["@hot-updater/cloudflare", cloudflare],
  ["@hot-updater/firebase", firebase],
  ["@hot-updater/supabase", supabase],
])("%s's plugins", (_provider, plugins) => {
  it("are Hot Updater's own, so they assemble under their reserved ids", () => {
    // A copy of a plugin that takes a reserved id is refused at assembly.
    const server = assembleServer({
      database: createEngineDatabase({
        name: "memory",
        adapter: createMemoryAdapter(),
      }),
      plugins,
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
    const server = assembleServer({ database, plugins });
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
