import { plugins as aws } from "@hot-updater/aws";
import { plugins as cloudflare } from "@hot-updater/cloudflare";
import { plugins as firebase } from "@hot-updater/firebase";
import {
  createEngineDatabase,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import {
  clientAuthOf,
  createDatabasePluginApis,
  isOfficialPlugin,
  pluginCommandsOf,
} from "@hot-updater/server/db";
import { plugins as supabase } from "@hot-updater/supabase";
import { describe, expect, it } from "vitest";

describe.each([
  ["@hot-updater/aws", aws],
  ["@hot-updater/cloudflare", cloudflare],
  ["@hot-updater/firebase", firebase],
  ["@hot-updater/supabase", supabase],
])("%s's plugins", (_provider, plugins) => {
  it("are Hot Updater's own, so they assemble under their reserved ids", () => {
    expect(plugins.every(isOfficialPlugin)).toBe(true);
    const database = createEngineDatabase({
      name: "memory",
      adapter: createMemoryAdapter(),
    });

    expect(Object.keys(createDatabasePluginApis(database, plugins))).toEqual([
      "insights",
      "apiKeys",
    ]);
    expect(clientAuthOf(plugins)?.plugin).toBe("apiKeys");
    expect(pluginCommandsOf(plugins).map(({ plugin }) => plugin)).toContain(
      "apiKeys",
    );
  });
});
