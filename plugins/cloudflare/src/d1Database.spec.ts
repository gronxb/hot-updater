import {
  defineUniversalComponentSchema,
  universalComponentDataAdapterCapability,
  type UniversalComponentDataAdapter,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { beforeEach, expect, it, vi } from "vitest";

import { d1Database } from "./d1Database";

type RecordedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

const state = vi.hoisted<{
  queries: RecordedQuery[];
  responses: unknown[][];
  results: unknown[];
}>(() => ({ queries: [], responses: [], results: [] }));

const remoteMigrationSchema = defineUniversalComponentSchema({
  id: "remote-history",
  versions: [
    {
      version: "1",
      tables: [
        {
          name: "remote_records",
          columns: [{ name: "id", primaryKey: true, type: "string" }],
        },
      ],
    },
  ],
});

const bundleD1Row = {
  id: "bundle-1",
  platform: "ios",
  should_force_update: 0,
  enabled: 1,
  file_hash: "hash",
  git_commit_hash: null,
  message: "Alpha Release",
  channel: "production",
  storage_uri: "storage://bundle",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: '{"version":1}',
  rollout_cohort_count: 1000,
  target_cohorts: '["stable"]',
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
} as const;

vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    readonly d1 = {
      database: {
        query: async (
          _databaseId: string,
          input: { readonly sql: string; readonly params?: readonly string[] },
        ) => {
          const results = state.responses.shift() ?? state.results;
          state.queries.push({
            sql: input.sql,
            params: input.params ?? [],
          });
          return {
            async *iterPages() {
              yield { result: [{ results }] };
            },
          };
        },
      },
    };
  },
}));

beforeEach(() => {
  state.queries.length = 0;
  state.responses.length = 0;
  state.results.length = 0;
});

const remoteAdapter = (): UniversalComponentDataAdapter => {
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });
  const contribution = getCapabilityContributions(plugin).find(
    ({ token }) => token.id === universalComponentDataAdapterCapability.id,
  );
  if (contribution === undefined) {
    throw new TypeError("Remote D1 component adapter is missing");
  }
  return universalComponentDataAdapterCapability.parse(
    contribution.create({ database: plugin, storages: [] }),
  );
};

it("sends a fresh component migration as one parameter-free remote batch", async () => {
  state.responses.push(
    [],
    [],
    [],
    [{ value: "1" }],
    [{ name: "id", notnull: 1, pk: 1, type: "TEXT" }],
    [
      {
        sql: "CREATE TABLE remote_records (id TEXT PRIMARY KEY NOT NULL)",
      },
    ],
    [],
    [],
  );
  const adapter = remoteAdapter();

  await expect(adapter.migrate?.(remoteMigrationSchema)).resolves.toEqual({
    changed: true,
    version: "1",
  });

  const batch = state.queries[2];
  expect(batch?.params).toEqual([]);
  expect(batch?.sql).toContain(
    'CREATE TABLE "remote_records" ("id" TEXT PRIMARY KEY NOT NULL);',
  );
  expect(
    batch?.sql.lastIndexOf("'schema.remote-history', '1'"),
  ).toBeGreaterThan(
    batch?.sql.lastIndexOf('CREATE TABLE "remote_records"') ?? -1,
  );
  expect(state.queries[3]?.sql).toContain(
    "SELECT value FROM private_hot_updater_settings",
  );
});

it("projects selected fields after querying physical bundle columns", async () => {
  state.results.push(bundleD1Row);
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  const rows = await plugin.findMany({
    model: "bundles",
    where: [
      {
        field: "message",
        operator: "contains",
        value: "release",
        mode: "insensitive",
      },
    ],
    orderBy: [
      { field: "channel", direction: "asc", nulls: "last" },
      { field: "id", direction: "desc" },
    ],
    select: ["id", "enabled"],
    limit: 10,
  });

  expect(rows).toEqual([{ id: "bundle-1", enabled: true }]);
  expect(state.queries[0]?.sql).toContain(
    "lower(message) LIKE lower(json_extract(?, '$'))",
  );
  expect(state.queries[0]?.sql).toContain(
    "ORDER BY channel ASC NULLS LAST, id DESC",
  );
});

it("uses a native distinct channel query", async () => {
  state.results.push({ channel: "production" });
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  await expect(plugin.getChannels?.()).resolves.toEqual(["production"]);

  expect(state.queries[0]?.params).toEqual([]);
  expect(state.queries[0]?.sql).toBe(
    "SELECT DISTINCT channel FROM bundles ORDER BY channel ASC",
  );
});

it("counts compound distinct tuples in SQL", async () => {
  state.results.push({ count: 3 });
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  await plugin.count({
    model: "bundles",
    distinct: ["platform", "channel"],
  });

  expect(state.queries[0]?.sql).toBe(
    "SELECT COUNT(*) AS count FROM (SELECT DISTINCT platform, channel FROM bundles) AS distinct_rows",
  );
});

it("selects one ordered row per distinct key in SQL", async () => {
  state.results.push(bundleD1Row);
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  await plugin.findMany({
    model: "bundles",
    distinctOn: { fields: ["channel"] },
    orderBy: [
      { field: "channel", direction: "asc" },
      { field: "id", direction: "asc" },
    ],
  });

  expect(state.queries[0]?.sql).toContain(
    "ROW_NUMBER() OVER (PARTITION BY channel ORDER BY channel ASC, id ASC)",
  );
  expect(state.queries[0]?.sql).toContain("WHERE __hot_updater_rank = 1");
});
