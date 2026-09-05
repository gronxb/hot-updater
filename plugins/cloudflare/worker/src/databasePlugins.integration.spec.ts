import type {
  BundleRow,
  ChannelRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { toInsightsInstallationRow } from "@hot-updater/plugin-core";
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

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
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
          input:
            | { readonly sql: string; readonly params?: readonly string[] }
            | {
                readonly batch: readonly {
                  readonly sql: string;
                  readonly params?: readonly string[];
                }[];
              },
        ) => {
          const statements =
            "batch" in input
              ? input.batch.map(({ sql, params }) =>
                  getDb()
                    .prepare(sql)
                    .bind(...(params ?? [])),
                )
              : (() => {
                  const params = input.params ?? [];
                  let paramOffset = 0;
                  return input.sql
                    .split(";")
                    .map((sql) => sql.trim())
                    .filter(Boolean)
                    .map((sql) => {
                      const paramCount = sql.match(/\?/g)?.length ?? 0;
                      const statement = getDb()
                        .prepare(sql)
                        .bind(
                          ...params.slice(
                            paramOffset,
                            paramOffset + paramCount,
                          ),
                        );
                      paramOffset += paramCount;
                      return statement;
                    });
                })();
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
      "DELETE FROM bundle_events; DELETE FROM bundle_installations; DELETE FROM api_keys; DELETE FROM bundle_patches; DELETE FROM release_catalogs; DELETE FROM releases; DELETE FROM bundles; DELETE FROM channels;",
    )
    .run();
};

const createChannelRow = (name: string): ChannelRow => ({
  id: `channel-${name}`,
  name,
});

const createBundleRow = (): BundleRow => ({
  id: "00000000-0000-0000-0000-000000000902",
  platform: "ios",
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const createReleaseRow = (
  channel: ChannelRow,
  bundle: BundleRow,
): ReleaseRow => ({
  id: "00000000-0000-7000-8000-000000000903",
  revision: 1,
  scope_key: `v1:test:${channel.name}:ios:app-version`,
  channel_id: channel.id,
  platform: bundle.platform,
  kind: "BUNDLE",
  bundle_id: bundle.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 100,
  updated_at_ms: 100,
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

  it("rolls back the snapshot when the later event insert fails, then safely retries", async () => {
    const plugin = createPlugin();
    const event = createBundleEventRowFixture("9101", 100);
    const input = { event, installation: toInsightsInstallationRow(event) };
    await env.DB.prepare(`
      CREATE TRIGGER fail_insights_event BEFORE INSERT ON bundle_events
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;
    `).run();
    try {
      await expect(plugin.models.insights.record(input)).rejects.toThrow(
        "injected event failure",
      );
      expect(
        (await env.DB.prepare("SELECT * FROM bundle_events").all()).results,
      ).toEqual([]);
      expect(
        (await env.DB.prepare("SELECT * FROM bundle_installations").all())
          .results,
      ).toEqual([]);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_insights_event").run();
    }
    await plugin.models.insights.record(input);
    await plugin.models.insights.record(input);
    await expect(
      plugin.models.insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([input.installation]);
    expect(
      (await env.DB.prepare("SELECT id FROM bundle_events").all()).results,
    ).toEqual([{ id: event.id }]);
  });

  it("serializes concurrent snapshots and ignores a duplicate carrying a newer timestamp", async () => {
    const plugin = createPlugin();
    const first = {
      ...createBundleEventRowFixture("9201", 100),
      user_id: "former-user",
    };
    const latest = {
      ...first,
      id: createBundleEventRowFixture("9203", 100).id,
      user_id: null,
    };
    const stale = { ...first, id: createBundleEventRowFixture("9202", 100).id };
    await Promise.all(
      [latest, first, stale].map((event) =>
        plugin.models.insights.record({
          event,
          installation: toInsightsInstallationRow(event),
        }),
      ),
    );
    const reusedId = { ...first, received_at_ms: 200 };
    await plugin.models.insights.record({
      event: reusedId,
      installation: toInsightsInstallationRow(reusedId),
    });
    await expect(
      plugin.models.insights.findInstallations({ installId: first.install_id }),
    ).resolves.toEqual([toInsightsInstallationRow(latest)]);
    await expect(
      plugin.models.insights.findInstallations({
        userId: "former-user",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      plugin.models.insights.countEvents({
        filter: {
          type: "UPDATE_APPLIED",
          platform: "ios",
          channel: "production",
          toBundleId: first.to_bundle_id,
        },
        sinceMs: 100,
        beforeReceivedAtMs: 101,
      }),
    ).resolves.toBe(3);
  });

  it("rejects direct and committed deletion while a Release references the channel", async () => {
    const plugin = createPlugin();
    const channel = createChannelRow("active");
    const bundle = createBundleRow();
    const release = createReleaseRow(channel, bundle);
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        { model: "releases", operation: "insert", row: release },
      ],
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

  it("atomically deletes a Release before deleting its newly empty channel", async () => {
    const plugin = createPlugin();
    const channel = createChannelRow("retired");
    const bundle = createBundleRow();
    const release = createReleaseRow(channel, bundle);
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        { model: "releases", operation: "insert", row: release },
      ],
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "delete",
            where: { id: release.id },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      plugin.models.releases.findById(release.id),
    ).resolves.toBeNull();
    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
      bundle,
    );
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });
});
