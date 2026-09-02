import type {
  BundleEventRow,
  BundleRow,
  ChannelRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
} from "@hot-updater/plugin-core/internal";
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
import { createD1InsightsMaintenance } from "../../src/d1InsightsJobs";
import { createD1InsightsModel } from "../../src/d1InsightsModel";
import {
  createD1InsightsEventPages,
  createD1InsightsInstallationPages,
} from "../../src/d1InsightsPages";
import {
  assertD1InsightsLayout,
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
      "DELETE FROM private_hot_updater_insights_job_page_rows; DELETE FROM private_hot_updater_insights_job_sections; DELETE FROM private_hot_updater_insights_job_order; DELETE FROM private_hot_updater_insights_job_memberships; DELETE FROM private_hot_updater_insights_job_counts; DELETE FROM private_hot_updater_insights_job_latest; DELETE FROM private_hot_updater_insights_jobs; DELETE FROM private_hot_updater_insights_job_heads; DELETE FROM private_hot_updater_insights_installation_versions; DELETE FROM private_hot_updater_insights_installation_aliases; DELETE FROM private_hot_updater_insights_live_installations; DELETE FROM private_hot_updater_insights_installation_events; DELETE FROM private_hot_updater_insights_bundle_events; DELETE FROM private_hot_updater_insights_source_events; DELETE FROM private_hot_updater_insights_pending_events; DELETE FROM bundle_events; UPDATE private_hot_updater_insights_source_state SET database_namespace = NULL, generation = 0, status = 'ready', backfill_upper_received_at_ms = NULL, backfill_upper_id = NULL, backfill_after_received_at_ms = NULL, backfill_after_id = NULL WHERE id = 1; DELETE FROM api_keys; DELETE FROM bundle_patches; DELETE FROM release_catalogs; DELETE FROM releases; DELETE FROM bundles; DELETE FROM channels;",
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
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000502",
    }),
  reset,
  dispose: () => undefined,
});

setupDatabasePluginTestSuite({
  name: "cloudflare worker d1 fixed-model database plugin",
  migrate: () => undefined,
  createPlugin: () =>
    d1RuntimeDatabase({
      database: env.DB,
      insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
    }),
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
        insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000502",
      }),
  },
  {
    name: "cloudflare worker d1",
    createPlugin: () =>
      d1RuntimeDatabase({
        database: env.DB,
        insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
      }),
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
        insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000502",
      }),
  },
  {
    name: "cloudflare worker d1",
    createPlugin: () =>
      d1RuntimeDatabase({
        database: env.DB,
        insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
      }),
  },
])("$name Insights v2 writer", ({ createPlugin }) => {
  beforeAll(() => {
    state.db = env.DB;
  });

  beforeEach(reset);

  afterAll(() => {
    state.db = undefined;
  });

  it("atomically appends raw, source, and latest rows", async () => {
    const plugin = createPlugin();
    const first = createBundleEventRowFixture("801", 100);
    const second = {
      ...createBundleEventRowFixture("802", 200),
      install_id: first.install_id,
    };

    await plugin.models.insights.append(first);
    await plugin.models.insights.append(second);

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
      { generation: 1, event_id: first.id },
      { generation: 2, event_id: second.id },
    ]);
    await expect(
      getDb()
        .prepare("SELECT id FROM bundle_events ORDER BY received_at_ms")
        .all(),
    ).resolves.toMatchObject({
      results: [{ id: first.id }, { id: second.id }],
    });
    const latest = await getDb()
      .prepare(
        "SELECT install_id, event_id, row_bytes FROM private_hot_updater_insights_live_installations",
      )
      .first<{ install_id: string; event_id: string; row_bytes: number }>();
    expect(latest?.install_id).toBe(first.install_id);
    expect(latest?.event_id).toBe(second.id);
    expect(latest?.row_bytes).toBeGreaterThan(0);
  });

  it("rejects noncanonical event IDs without writing raw or sidecar rows", async () => {
    const plugin = createPlugin();
    const canonical = createBundleEventRowFixture("805", 100);
    for (const id of [
      "",
      "event-805",
      "00000000-0000-7000-8000-00000000080A",
    ]) {
      await expect(
        plugin.models.insights.append({ ...canonical, id }),
      ).rejects.toThrow();
    }
    await expect(
      getDb()
        .prepare(
          `SELECT
            (SELECT count(*) FROM bundle_events) +
            (SELECT count(*) FROM private_hot_updater_insights_source_events) +
            (SELECT count(*) FROM private_hot_updater_insights_live_installations)
            AS count`,
        )
        .first<number>("count"),
    ).resolves.toBe(0);
  });

  it("rejects an oversized event without writing raw or sidecar rows", async () => {
    const plugin = createPlugin();
    const largeValue = "€".repeat(900);
    const invalid = {
      ...createBundleEventRowFixture("806", 100),
      type: "UPDATE_APPLIED" as const,
      update_strategy: "appVersion" as const,
      install_id: largeValue,
      user_id: largeValue,
      username: largeValue,
      from_bundle_id: largeValue,
      from_release_id: largeValue,
      to_bundle_id: largeValue,
      to_release_id: largeValue,
      app_version: largeValue,
    };
    expect(getCanonicalInsightsJsonByteLength(invalid)).toBeGreaterThan(
      INSIGHTS_EVENT_MAX_BYTES,
    );

    await expect(plugin.models.insights.append(invalid)).rejects.toThrow();
    await expect(
      getDb()
        .prepare(
          `SELECT
            (SELECT count(*) FROM bundle_events) +
            (SELECT count(*) FROM private_hot_updater_insights_source_events) +
            (SELECT count(*) FROM private_hot_updater_insights_live_installations)
            AS count`,
        )
        .first<number>("count"),
    ).resolves.toBe(0);
  });

  it("smokes event and installation pages through the D1 facades", async () => {
    const plugin = createPlugin();
    const first = createBundleEventRowFixture("811", 100);
    const second = createBundleEventRowFixture("812", 100);
    await plugin.models.insights.append(first);
    await plugin.models.insights.append(second);

    await expect(
      createD1InsightsEventPages(insightsExecutor, "d1-plugin-test").pageEvents(
        {
          selector: { kind: "all" },
          beforeReceivedAtMs: 200,
          limit: 1,
        },
      ),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [second], hasNext: true, nextCursor: expect.any(String) },
    });

    const installations = createD1InsightsInstallationPages(
      insightsExecutor,
      () => 300,
      "d1-live-primary",
    );
    const firstPage = await installations.pageInstallations({
      kind: "all",
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      state: "ready",
      data: {
        data: [expect.any(Object)],
        hasNext: true,
        nextCursor: expect.any(String),
      },
    });
    if (firstPage.state !== "ready") throw new Error("not ready");

    let crossNamespaceReads = 0;
    const otherNamespace = createD1InsightsInstallationPages(
      {
        async query(sql, params) {
          crossNamespaceReads += 1;
          return insightsExecutor.query(sql, params);
        },
        async batch(statements) {
          crossNamespaceReads += statements.length;
          return insightsExecutor.batch(statements);
        },
      },
      () => 300,
      "d1-live-other",
    );
    await expect(
      otherNamespace.pageInstallations({
        kind: "all",
        limit: 1,
        cursor: firstPage.data.nextCursor!,
      }),
    ).rejects.toThrow();
    expect(crossNamespaceReads).toBe(0);
  });

  it("roundtrips a canonical 20 KiB event with provider extensions", async () => {
    const plugin = createPlugin();
    const base = createBundleEventRowFixture("813", 100);
    let boundary:
      | (BundleEventRow & { readonly provider_extension: readonly string[] })
      | undefined;
    for (let full = 0; full < 32 && boundary === undefined; full += 1) {
      const providerExtension = [
        ...Array.from({ length: full }, () => "x".repeat(1_024)),
        "",
      ];
      const candidate = { ...base, provider_extension: providerExtension };
      const remaining =
        INSIGHTS_EVENT_MAX_BYTES -
        getCanonicalInsightsJsonByteLength(candidate);
      if (remaining >= 0 && remaining <= 1_024) {
        providerExtension[providerExtension.length - 1] = "x".repeat(remaining);
        boundary = candidate;
      }
    }
    expect(boundary).toBeDefined();
    expect(getCanonicalInsightsJsonByteLength(boundary)).toBe(
      INSIGHTS_EVENT_MAX_BYTES,
    );
    await plugin.models.insights.append(boundary!);

    const stored = await getDb()
      .prepare(`SELECT insights_event_json FROM bundle_events WHERE id = ?`)
      .bind(boundary!.id)
      .first<string>("insights_event_json");
    expect(stored).toBe(canonicalInsightsJson(boundary));
    const source = createD1InsightsSourceTools(insightsExecutor);
    const generation = await source.capture();
    await expect(
      source.readPage({ sourceGeneration: generation, limit: 100 }),
    ).resolves.toEqual([{ generation: 1, event: boundary }]);
    await expect(
      createD1InsightsEventPages(insightsExecutor, "d1-plugin-test").pageEvents(
        {
          selector: { kind: "all" },
          beforeReceivedAtMs: 200,
          limit: 100,
        },
      ),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [boundary] },
    });
  });

  it("advertises the same source snapshot used to select live pointers", async () => {
    const plugin = createPlugin();
    const first = createBundleEventRowFixture("814", 100);
    await plugin.models.insights.append(first);
    const appendAfterPointerRead = (late: BundleEventRow): D1Executor => {
      let appended = false;
      return {
        async query(sql, params) {
          const rows = await insightsExecutor.query(sql, params);
          if (
            !appended &&
            /WITH source_state AS/i.test(sql) &&
            /LEFT JOIN page ON TRUE/i.test(sql)
          ) {
            appended = true;
            await plugin.models.insights.append(late);
          }
          return rows;
        },
        batch: insightsExecutor.batch,
      };
    };
    const selectors = [
      { kind: "all" as const },
      { kind: "installationId" as const, installId: first.install_id },
      { kind: "bundleId" as const, bundleId: first.to_bundle_id },
    ];
    for (const [index, selector] of selectors.entries()) {
      const late = {
        ...createBundleEventRowFixture(String(815 + index), 200 + index),
        install_id: first.install_id,
        to_bundle_id: first.to_bundle_id,
      };
      const before = JSON.parse(
        await createD1InsightsSourceTools(insightsExecutor).capture(),
      ) as [number, string, number];
      const page = await createD1InsightsEventPages(
        appendAfterPointerRead(late),
        "d1-plugin-test",
      ).pageEvents({ selector, beforeReceivedAtMs: 1_000, limit: 100 });
      if (page.state !== "ready") throw new Error("not ready");
      expect(page.versions.sourceGeneration).toBe(JSON.stringify(before));
      expect(page.data.data.map(({ id }) => id)).not.toContain(late.id);
    }

    const late = {
      ...createBundleEventRowFixture("818", 300),
      install_id: first.install_id,
      to_bundle_id: first.to_bundle_id,
    };
    const before = JSON.parse(
      await createD1InsightsSourceTools(insightsExecutor).capture(),
    ) as [number, string, number];
    const page = await createD1InsightsInstallationPages(
      appendAfterPointerRead(late),
      () => 500,
      "d1-plugin-test",
    ).pageInstallations({
      kind: "installationId",
      installId: first.install_id,
      limit: 1,
    });
    if (page.state !== "ready") throw new Error("not ready");
    expect(page.versions.sourceGeneration).toBe(JSON.stringify(before));
    expect(page.data.data.map(({ id }) => id)).not.toContain(late.id);
    expect(page.data.consistency.cutoff).toMatchObject({
      kind: "projection",
      observedAtMs: 500,
      projectionGeneration: JSON.stringify(before),
    });
  });

  it("returns a short event page at the byte budget and resumes", async () => {
    const plugin = createPlugin();
    const largeValue = "€".repeat(900);
    const source = Array.from({ length: 60 }, (_, index) => ({
      ...createBundleEventRowFixture(String(821 + index), 100 + index),
      type: "UPDATE_APPLIED" as const,
      update_strategy: "appVersion" as const,
      install_id: largeValue,
      user_id: largeValue,
      username: largeValue,
      from_bundle_id: largeValue,
      from_release_id: largeValue,
      to_bundle_id: largeValue,
      to_release_id: largeValue,
    }));
    for (const event of source) await plugin.models.insights.append(event);

    const pages = createD1InsightsEventPages(
      insightsExecutor,
      "d1-plugin-test",
    );
    const input = {
      selector: { kind: "all" as const },
      beforeReceivedAtMs: 300,
      limit: 100,
    };
    const page = await pages.pageEvents(input);
    if (page.state !== "ready") throw new Error("not ready");
    expect(page.data.data.length).toBeGreaterThan(0);
    expect(page.data.data.length).toBeLessThan(source.length);
    expect(
      new TextEncoder().encode(JSON.stringify(page.data)).byteLength,
    ).toBeLessThanOrEqual(1_048_576);
    expect(page.data.nextCursor).toEqual(expect.any(String));
    const next = await pages.pageEvents({
      ...input,
      cursor: page.data.nextCursor!,
    });
    if (next.state !== "ready") throw new Error("not ready");
    expect([...page.data.data, ...next.data.data].map(({ id }) => id)).toEqual(
      source.toReversed().map(({ id }) => id),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(next.data)).byteLength,
    ).toBeLessThanOrEqual(1_048_576);
    expect(next.data.nextCursor).toBeNull();
  });

  it("fences the safe generation maximum and rejects full-identity digest collisions", async () => {
    const plugin = createPlugin();
    for (const vector of INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS) {
      await expect(d1InsightsInstallKey(vector.installId)).resolves.toBe(
        vector.sha256Hex,
      );
    }
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
  const plugin = d1RuntimeDatabase({
    database: env.DB,
    insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
  });
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
  const pages = createD1InsightsEventPages(guardedExecutor, "d1-plugin-test");
  const input = {
    selector: { kind: "all" as const },
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
      .prepare("DROP INDEX bundle_events_insights_backfill_idx")
      .run();
    await expect(pages.pageEvents(input)).rejects.toThrow();
    expect(rawReads).toBe(0);
    await getDb()
      .prepare(
        `CREATE INDEX bundle_events_insights_backfill_idx
        ON bundle_events(insights_write_version, received_at_ms, id)`,
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
      .prepare(
        "CREATE INDEX IF NOT EXISTS bundle_events_insights_backfill_idx ON bundle_events(insights_write_version, received_at_ms, id)",
      )
      .run();
    await getDb()
      .prepare("DROP TRIGGER IF EXISTS bundle_events_insights_writer_fence")
      .run();
    if (triggerSql !== null) await getDb().prepare(triggerSql).run();
    state.db = undefined;
  }
});

it("keeps live-installation lookahead pointers small within the event budget", async () => {
  state.db = env.DB;
  await reset();
  const plugin = d1RuntimeDatabase({
    database: env.DB,
    insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
  });
  const events = [
    {
      ...createBundleEventRowFixture("851", 100),
      install_id: `${"a".repeat(1_000)}-first`,
    },
    {
      ...createBundleEventRowFixture("852", 200),
      install_id: `${"b".repeat(1_000)}-second`,
    },
  ];
  for (const event of events) await plugin.models.insights.append(event);
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
      "d1-plugin-test",
    ).pageInstallations({ kind: "all", limit: 1 });
    if (page.state !== "ready") throw new Error("not ready");
    expect(page.data.data).toHaveLength(1);
    expect(page.data.data[0]!.install_id.length).toBeGreaterThan(900);
    expect(page.data.nextCursor).toEqual(expect.any(String));
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

it("surfaces durable source poison through reads and maintenance", async () => {
  state.db = env.DB;
  await reset();
  const sourceId = await getDb()
    .prepare(
      `UPDATE private_hot_updater_insights_source_state SET status = 'failed'
      WHERE id = 1 RETURNING source_id`,
    )
    .first<string>("source_id");
  const model = createD1InsightsModel(
    insightsExecutor,
    "00000000-0000-4000-8000-000000000301",
  );
  await expect(
    model.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 100,
      limit: 100,
    }),
  ).resolves.toMatchObject({
    state: "failed",
    error: { code: "migration-poison", jobId: sourceId },
  });
  const maintenance = await createD1InsightsMaintenance(
    insightsExecutor,
    "00000000-0000-4000-8000-000000000301",
  ).runStep({ maxItems: 256, maxRequests: 50 });
  expect(maintenance).toMatchObject({
    state: "failed",
    processed: 0,
    jobId: sourceId,
    error: { code: "migration-poison", jobId: sourceId },
  });
  expect(maintenance.requests).toBeLessThanOrEqual(4);
  state.db = undefined;
});

it("rejects hostile source schemas while preserving quoted literals", async () => {
  state.db = env.DB;
  await reset();
  const tableName = "private_hot_updater_insights_source_events";
  const indexName = "private_hot_updater_insights_source_event_order_idx";
  const tableSql = await getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(tableName)
    .first<string>("sql");
  const indexSql = await getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .bind(indexName)
    .first<string>("sql");
  if (tableSql === null || indexSql === null) {
    throw new Error("source schema fixture missing");
  }
  await getDb().prepare(`DROP TABLE ${tableName}`).run();
  await getDb()
    .prepare(
      tableSql.replace(
        "  CONSTRAINT insights_source_generation_check",
        "  hostile_extension TEXT,\n  CONSTRAINT insights_source_generation_check",
      ),
    )
    .run();
  await getDb().prepare(indexSql).run();
  await expect(assertD1InsightsLayout(insightsExecutor)).rejects.toThrow();
  await getDb().prepare(`DROP TABLE ${tableName}`).run();
  await getDb().prepare(tableSql).run();
  await getDb().prepare(indexSql).run();
  await expect(
    assertD1InsightsLayout(insightsExecutor),
  ).resolves.toBeUndefined();

  const stateTable = "private_hot_updater_insights_source_state";
  const stateSql = await getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(stateTable)
    .first<string>("sql");
  if (stateSql === null) throw new Error("source state schema fixture missing");
  await getDb().prepare(`DROP TABLE ${stateTable}`).run();
  await getDb().prepare(stateSql.replace("'ready'", "'READY'")).run();
  await expect(assertD1InsightsLayout(insightsExecutor)).rejects.toThrow();
  await getDb().prepare(`DROP TABLE ${stateTable}`).run();
  await getDb().prepare(stateSql).run();
  await getDb()
    .prepare(
      `INSERT INTO ${stateTable} (id, version, source_id, status, generation)
      VALUES (1, 2, '00000000000000000000000000000000', 'ready', 0)`,
    )
    .run();
  await expect(
    assertD1InsightsLayout(insightsExecutor),
  ).resolves.toBeUndefined();
  state.db = undefined;
});
