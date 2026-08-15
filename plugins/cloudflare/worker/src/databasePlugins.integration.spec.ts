import type { BundleRow, ChannelRow } from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import { d1Database } from "../../src/d1Database";
import { d1Database as d1RuntimeDatabase } from "../../src/worker";

const state = vi.hoisted<{ db: D1Database | undefined }>(() => ({
  db: undefined,
}));

class D1TestStateError extends Error {
  readonly name = "D1TestStateError";
}

const getDb = (): D1Database => {
  if (state.db === undefined) {
    throw new D1TestStateError();
  }
  return state.db;
};

vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    readonly d1 = {
      database: {
        query: async (
          _databaseId: string,
          input: { readonly sql: string; readonly params?: readonly string[] },
        ) => {
          const params = input.params ?? [];
          let paramOffset = 0;
          const statements = input.sql
            .split(";")
            .map((sql) => sql.trim())
            .filter(Boolean)
            .map((sql) => {
              const paramCount = sql.match(/\?/g)?.length ?? 0;
              const statement = getDb()
                .prepare(sql)
                .bind(...params.slice(paramOffset, paramOffset + paramCount));
              paramOffset += paramCount;
              return statement;
            });
          const results = await getDb().batch(statements);
          return {
            async *iterPages() {
              yield { result: results };
            },
          };
        },
      },
    };
  },
}));

const reset = async (): Promise<void> => {
  await getDb()
    .prepare(
      "DELETE FROM bundle_events; DELETE FROM client_access_keys; DELETE FROM bundle_patches; DELETE FROM bundles; DELETE FROM channels;",
    )
    .run();
};

const createChannelRow = (name: string): ChannelRow => ({
  id: `channel-${name}`,
  name,
});

const createBundleRow = (channel: ChannelRow): BundleRow => ({
  id: "00000000-0000-0000-0000-000000000902",
  platform: "ios",
  should_force_update: false,
  enabled: true,
  file_hash: "hash",
  git_commit_hash: null,
  message: null,
  channel: channel.name,
  channel_id: channel.id,
  storage_uri: "storage://bundle",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

setupDatabasePluginTestSuite({
  name: "cloudflare d1 http fixed-model database plugin",
  migrate: async () => {
    state.db = env.DB;
    await getDb().prepare(inject("prepareSql")).run();
  },
  createPlugin: () =>
    d1Database({
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    }),
  reset,
  dispose: () => undefined,
});

setupDatabasePluginTestSuite({
  name: "cloudflare worker d1 fixed-model database plugin",
  migrate: () => undefined,
  createPlugin: () => d1RuntimeDatabase(env.DB),
  reset,
  dispose: () => {
    state.db = undefined;
  },
});

describe.each([
  {
    name: "cloudflare d1 http",
    createPlugin: () =>
      d1Database({
        accountId: "account-id",
        cloudflareApiToken: "api-token",
        databaseId: "database-id",
      }),
  },
  {
    name: "cloudflare worker d1",
    createPlugin: () => d1RuntimeDatabase(env.DB),
  },
])("$name Channel deletion", ({ createPlugin }) => {
  beforeAll(() => {
    state.db = env.DB;
  });

  beforeEach(async () => {
    await reset();
  });

  afterAll(() => {
    state.db = undefined;
  });

  it("deletes only empty channels", async () => {
    const plugin = createPlugin();
    const channel = createChannelRow("empty");
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });

    await expect(
      plugin.models.channels.delete({ id: channel.id }),
    ).resolves.toEqual({ deleted: true });
    await expect(
      plugin.models.channels.delete({ id: channel.id }),
    ).resolves.toEqual({ deleted: false, reason: "not_found" });
  });

  it("rejects direct and committed deletion while a bundle references the channel", async () => {
    const plugin = createPlugin();
    const channel = createChannelRow("active");
    const bundle = createBundleRow(channel);
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row: bundle }],
    });

    await expect(
      plugin.models.channels.delete({ id: channel.id }),
    ).resolves.toEqual({ deleted: false, reason: "not_empty" });
    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ],
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 0, reason: "referenced" },
    });
    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
      bundle,
    );
  });

  it("atomically deletes a bundle before deleting its newly empty channel", async () => {
    const plugin = createPlugin();
    const channel = createChannelRow("retired");
    const bundle = createBundleRow(channel);
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row: bundle }],
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "delete",
            where: { id: bundle.id },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toBeNull();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });
});
