import { plugins as aws } from "@hot-updater/aws";
import {
  clientAuthOf,
  generateClientCredential,
  pluginCommandsOf,
  provisionClientCredential,
} from "@hot-updater/cli-tools";
import { plugins as cloudflare } from "@hot-updater/cloudflare";
import { plugins as firebase } from "@hot-updater/firebase";
import {
  createEngineDatabase,
  createMemoryAdapter,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { plugins as supabase } from "@hot-updater/supabase";
import { describe, expect, it } from "vitest";

describe.each([
  ["@hot-updater/aws", aws],
  ["@hot-updater/cloudflare", cloudflare],
  ["@hot-updater/firebase", firebase],
  ["@hot-updater/supabase", supabase],
])("%s's plugins", (_provider, plugins) => {
  it("are Hot Updater's own, so they assemble under their reserved ids", () => {
    // A copy of a plugin that takes a reserved id is refused at startup.
    const definition = createHotUpdater({
      database: createEngineDatabase({
        name: "memory",
        adapter: createMemoryAdapter(),
      }),
      plugins,
    });

    expect(Object.keys(definition.api)).toEqual(["insights", "apiKeys"]);
    expect(clientAuthOf(definition)?.plugin).toBe("apiKeys");
    expect(pluginCommandsOf(definition).map(({ plugin }) => plugin)).toContain(
      "apiKeys",
    );
  });

  it("provision the app's API key on the definition's tables, registering a saved one again", async () => {
    const definition = createHotUpdater({
      database: createEngineDatabase({
        name: "memory",
        adapter: createMemoryAdapter(),
      }),
      plugins,
    });
    await definition.database.createMigrator!(
      toolingTargetOf(definition.plugins),
    )
      .migrateToLatest({ mode: "from-schema", updateSettings: true })
      .then((result) => result.execute());

    expect(generateClientCredential(definition)).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    const created = await provisionClientCredential(definition, {
      env: {},
      name: "Init",
    });
    expect(created).toMatchObject({
      label: "API key",
      header: "x-api-key",
      env: "HOT_UPDATER_API_KEY",
      value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const again = await provisionClientCredential(definition, {
      env: { HOT_UPDATER_API_KEY: ` ${created!.value}\n` },
      name: "Init again",
    });
    expect(again?.value).toBe(created!.value);
    await expect(definition.api.apiKeys.list()).resolves.toHaveLength(1);
  });
});
