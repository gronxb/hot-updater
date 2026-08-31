import type {
  BundleRow,
  ChannelRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
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
import type { D1Executor, D1Statement } from "../../src/d1Implementation";
import {
  createD1InsightsEventPages,
  createD1InsightsInstallationPages,
} from "../../src/d1InsightsPages";
import {
  createD1InsightsSourceTools,
  d1InsightsInstallKey,
} from "../../src/d1InsightsSource";
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

const insightsExecutor: D1Executor = {
  async query(sql, params) {
    const result = await getDb()
      .prepare(sql)
      .bind(...params)
      .all();
    return result.results;
  },
  async batch(statements: readonly D1Statement[]) {
    const results = await getDb().batch(
      statements.map(({ sql, params }) =>
        getDb()
          .prepare(sql)
          .bind(...params),
      ),
    );
    return results.map(({ results }) => results ?? []);
  },
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
      "DELETE FROM private_hot_updater_insights_live_installations; DELETE FROM private_hot_updater_insights_installation_events; DELETE FROM private_hot_updater_insights_bundle_events; DELETE FROM private_hot_updater_insights_source_events; DELETE FROM bundle_events; UPDATE private_hot_updater_insights_source_state SET generation = 0, status = 'ready', backfill_upper_received_at_ms = NULL, backfill_upper_id = NULL, backfill_after_received_at_ms = NULL, backfill_after_id = NULL WHERE id = 1; DELETE FROM api_keys; DELETE FROM bundle_patches; DELETE FROM release_catalogs; DELETE FROM releases; DELETE FROM bundles; DELETE FROM channels;",
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
])("$name Insights v2 writer", ({ createPlugin }) => {
  beforeAll(() => {
    state.db = env.DB;
  });

  beforeEach(reset);

  afterAll(() => {
    state.db = undefined;
  });

  it("commits raw, source, and latest rows for direct and mixed writes", async () => {
    const plugin = createPlugin();
    const direct = {
      ...createBundleEventRowFixture("801", 100),
      id: "direct/event-801",
    };
    const mixed = {
      ...createBundleEventRowFixture("802", 200),
      id: "mixed:event:802",
      install_id: direct.install_id,
    };

    await plugin.models.insights.append(direct);
    await expect(
      plugin.commit({
        changes: [{ model: "insights", operation: "insert", row: mixed }],
      }),
    ).resolves.toEqual({ committed: true });

    const stateRow = await getDb()
      .prepare(
        "SELECT status, generation FROM private_hot_updater_insights_source_state WHERE id = 1",
      )
      .first();
    expect(stateRow).toEqual({ status: "ready", generation: 2 });
    const sourceRows = await getDb()
      .prepare(
        "SELECT generation, event_id FROM private_hot_updater_insights_source_events ORDER BY generation",
      )
      .all();
    expect(sourceRows.results).toEqual([
      { generation: 1, event_id: direct.id },
      { generation: 2, event_id: mixed.id },
    ]);
    const latest = await getDb()
      .prepare(
        "SELECT install_id, event_id, row_bytes FROM private_hot_updater_insights_live_installations",
      )
      .first<{ install_id: string; event_id: string; row_bytes: number }>();
    expect(latest?.install_id).toBe(direct.install_id);
    expect(latest?.event_id).toBe(mixed.id);
    expect(latest?.row_bytes).toBeGreaterThan(0);
  });

  it("rolls back unrelated mixed changes when an event is duplicated", async () => {
    const plugin = createPlugin();
    const event = createBundleEventRowFixture("803", 100);
    const bundle = createBundleRow();
    await plugin.models.insights.append(event);

    await expect(
      plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "insights", operation: "insert", row: event },
        ],
      }),
    ).rejects.toThrow();

    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toBeNull();
    const generation = await getDb()
      .prepare(
        "SELECT generation FROM private_hot_updater_insights_source_state WHERE id = 1",
      )
      .first<number>("generation");
    expect(generation).toBe(1);
  });

  it("rejects an empty event ID before direct or mixed D1 writes", async () => {
    const plugin = createPlugin();
    const invalid = { ...createBundleEventRowFixture("805", 100), id: "" };
    await expect(plugin.models.insights.append(invalid)).rejects.toThrow();
    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: "empty-id-guard", name: "empty-id-guard" },
            onConflict: "ignore",
          },
          { model: "insights", operation: "insert", row: invalid },
        ],
      }),
    ).rejects.toThrow();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
    await expect(
      getDb()
        .prepare("SELECT count(*) count FROM bundle_events")
        .first<number>("count"),
    ).resolves.toBe(0);
  });

  it("pages source, event scopes, and digest-ordered installations", async () => {
    const plugin = createPlugin();
    const first = createBundleEventRowFixture("811", 100);
    const second = createBundleEventRowFixture("812", 100);
    await plugin.commit({
      changes: [first, second].map((row) => ({
        model: "insights" as const,
        operation: "insert" as const,
        row,
      })),
    });

    const source = createD1InsightsSourceTools(insightsExecutor);
    const generation = await source.capture();
    await expect(
      source.readPage({ sourceGeneration: generation, limit: 100 }),
    ).resolves.toEqual([
      { generation: 1, event: first },
      { generation: 2, event: second },
    ]);

    const events = createD1InsightsEventPages(insightsExecutor);
    const allInput = {
      scope: { kind: "all" as const },
      beforeReceivedAtMs: 200,
      limit: 1,
    };
    const allFirst = await events.pageEvents(allInput);
    expect(allFirst.rows).toEqual([second]);
    expect(allFirst.nextCursor).toEqual(expect.any(String));
    await expect(
      events.pageEvents({ ...allInput, cursor: allFirst.nextCursor! }),
    ).resolves.toEqual({ rows: [first], nextCursor: null });
    await expect(
      events.pageEvents({
        ...allInput,
        scope: { kind: "installation", installId: first.install_id },
        limit: 10,
      }),
    ).resolves.toEqual({ rows: [first], nextCursor: null });
    await expect(
      events.pageEvents({
        ...allInput,
        scope: { kind: "bundle", bundleId: second.to_bundle_id },
        limit: 10,
      }),
    ).resolves.toEqual({ rows: [second], nextCursor: null });

    const installations = createD1InsightsInstallationPages(
      insightsExecutor,
      () => 300,
    );
    const firstInstallPage = await installations.pageAll({
      kind: "all",
      limit: 1,
    });
    expect(firstInstallPage).toMatchObject({
      state: "ready",
      consistency: "live",
      observedAtMs: 300,
    });
    if (firstInstallPage.state !== "ready") throw new Error("not ready");
    expect(firstInstallPage.rows).toHaveLength(1);
    expect(firstInstallPage.nextCursor).toEqual(expect.any(String));
    const secondInstallPage = await installations.pageAll({
      kind: "all",
      limit: 1,
      cursor: firstInstallPage.nextCursor!,
    });
    if (secondInstallPage.state !== "ready") throw new Error("not ready");
    expect(
      [...firstInstallPage.rows, ...secondInstallPage.rows]
        .map(({ install_id }) => install_id)
        .sort(),
    ).toEqual([first.install_id, second.install_id].sort());
    await expect(
      installations.pageInstallation({
        kind: "installation",
        installId: first.install_id,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: first.id })],
      nextCursor: null,
    });
  });

  it("returns a short event page at the byte budget and resumes", async () => {
    const plugin = createPlugin();
    const first = {
      ...createBundleEventRowFixture("821", 100),
      username: "a".repeat(1_100_000),
    };
    const second = {
      ...createBundleEventRowFixture("822", 200),
      username: "b".repeat(1_100_000),
    };
    await plugin.commit({
      changes: [first, second].map((row) => ({
        model: "insights" as const,
        operation: "insert" as const,
        row,
      })),
    });

    const pages = createD1InsightsEventPages(insightsExecutor);
    const input = {
      scope: { kind: "all" as const },
      beforeReceivedAtMs: 300,
      limit: 100,
    };
    const page = await pages.pageEvents(input);
    expect(page.rows.map(({ id }) => id)).toEqual([second.id]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await pages.pageEvents({
      ...input,
      cursor: page.nextCursor!,
    });
    expect(next.rows.map(({ id }) => id)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
  });

  it("fences the safe generation maximum and rejects full-identity digest collisions", async () => {
    const plugin = createPlugin();
    const first = {
      ...createBundleEventRowFixture("831", 100),
      install_id: "사용자/👩‍💻/e\u0301",
    };
    await plugin.models.insights.append(first);
    const firstKey = await d1InsightsInstallKey(first.install_id);
    await expect(
      getDb()
        .prepare(
          "SELECT install_key FROM private_hot_updater_insights_live_installations WHERE install_id = ?",
        )
        .bind(first.install_id)
        .first<string>("install_key"),
    ).resolves.toBe(firstKey);

    await getDb()
      .prepare(
        "UPDATE private_hot_updater_insights_source_state SET generation = 9007199254740991 WHERE id = 1",
      )
      .run();
    const rejected = createBundleEventRowFixture("832", 200);
    await expect(plugin.models.insights.append(rejected)).rejects.toThrow();
    await expect(
      getDb()
        .prepare("SELECT count(*) count FROM bundle_events WHERE id = ?")
        .bind(rejected.id)
        .first<number>("count"),
    ).resolves.toBe(0);

    await getDb()
      .prepare(
        "UPDATE private_hot_updater_insights_source_state SET generation = 1 WHERE id = 1",
      )
      .run();
    const second = createBundleEventRowFixture("833", 300);
    await plugin.models.insights.append(second);
    const secondPointer = await getDb()
      .prepare(
        "SELECT event_id, received_at_ms, row_bytes FROM private_hot_updater_insights_live_installations WHERE install_id = ?",
      )
      .bind(second.install_id)
      .first<{
        event_id: string;
        received_at_ms: number;
        row_bytes: number;
      }>();
    await expect(
      getDb()
        .prepare(
          `INSERT INTO private_hot_updater_insights_live_installations
            (install_key, install_id, event_id, received_at_ms, row_bytes)
          VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          firstKey,
          second.install_id,
          secondPointer!.event_id,
          secondPointer!.received_at_ms,
          secondPointer!.row_bytes,
        )
        .run(),
    ).rejects.toThrow(/HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION/);
  });
});

it("rejects tampered D1 layout before reading a raw event", async () => {
  state.db = env.DB;
  await reset();
  const plugin = d1RuntimeDatabase(env.DB);
  const event = createBundleEventRowFixture("841", 100);
  await plugin.models.insights.append(event);
  let rawReads = 0;
  const guardedExecutor: D1Executor = {
    async query(sql, params) {
      if (/FROM bundle_events/i.test(sql) && /json_each/i.test(sql)) {
        rawReads += 1;
      }
      return insightsExecutor.query(sql, params);
    },
    batch: insightsExecutor.batch,
  };
  const pages = createD1InsightsEventPages(guardedExecutor);
  const input = {
    scope: { kind: "all" as const },
    beforeReceivedAtMs: 200,
    limit: 100,
  };
  const triggerSql = await getDb()
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bundle_events_insights_writer_fence'",
    )
    .first<string>("sql");

  try {
    await getDb()
      .prepare("DROP INDEX private_hot_updater_insights_source_event_order_idx")
      .run();
    await expect(pages.pageEvents(input)).rejects.toThrow();
    expect(rawReads).toBe(0);
    await getDb()
      .prepare(
        `CREATE INDEX private_hot_updater_insights_source_event_order_idx
          ON private_hot_updater_insights_source_events(received_at_ms, event_id)`,
      )
      .run();

    await getDb()
      .prepare("DROP TRIGGER bundle_events_insights_writer_fence")
      .run();
    await getDb()
      .prepare(
        `CREATE TRIGGER bundle_events_insights_writer_fence
          BEFORE INSERT ON bundle_events BEGIN SELECT 1; END`,
      )
      .run();
    await expect(pages.pageEvents(input)).rejects.toThrow();
    expect(rawReads).toBe(0);
  } finally {
    await getDb()
      .prepare(
        "CREATE INDEX IF NOT EXISTS private_hot_updater_insights_source_event_order_idx ON private_hot_updater_insights_source_events(received_at_ms, event_id)",
      )
      .run();
    await getDb()
      .prepare("DROP TRIGGER IF EXISTS bundle_events_insights_writer_fence")
      .run();
    if (triggerSql !== null) await getDb().prepare(triggerSql).run();
    state.db = undefined;
  }
});

it("keeps live-installation lookahead pointers small for long identities", async () => {
  state.db = env.DB;
  await reset();
  const plugin = d1RuntimeDatabase(env.DB);
  const events = [
    {
      ...createBundleEventRowFixture("851", 100),
      install_id: `${"a".repeat(1_100_000)}-first`,
    },
    {
      ...createBundleEventRowFixture("852", 200),
      install_id: `${"b".repeat(1_100_000)}-second`,
    },
  ];
  await plugin.commit({
    changes: events.map((row) => ({
      model: "insights" as const,
      operation: "insert" as const,
      row,
    })),
  });
  let candidateBytes = 0;
  const measured: D1Executor = {
    async query(sql, params) {
      const rows = await insightsExecutor.query(sql, params);
      if (/FROM private_hot_updater_insights_live_installations/i.test(sql)) {
        expect(sql).not.toMatch(/SELECT[^]*install_id/i);
        candidateBytes = new TextEncoder().encode(JSON.stringify(rows)).length;
      }
      return rows;
    },
    batch: insightsExecutor.batch,
  };
  try {
    const page = await createD1InsightsInstallationPages(
      measured,
      () => 300,
    ).pageAll({ kind: "all", limit: 1 });
    if (page.state !== "ready") throw new Error("not ready");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.install_id.length).toBeGreaterThan(1_000_000);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(candidateBytes).toBeLessThan(1_024);
  } finally {
    state.db = undefined;
  }
});

it("rejects an old D1 event writer after the Insights v2 cutover", async () => {
  state.db = env.DB;
  await reset();
  const event = createBundleEventRowFixture("804", 100);
  const columns = Object.keys(event);
  await expect(
    getDb()
      .prepare(
        `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
          .map(() => "?")
          .join(",")})`,
      )
      .bind(...Object.values(event))
      .run(),
  ).rejects.toThrow();
  state.db = undefined;
});
