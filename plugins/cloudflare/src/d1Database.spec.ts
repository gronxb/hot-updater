import { beforeEach, expect, it, vi } from "vitest";

import { d1Database } from "./d1Database";

type RecordedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

const state = vi.hoisted<{
  queries: RecordedQuery[];
  results: unknown[];
}>(() => ({ queries: [], results: [] }));

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
          state.queries.push({
            sql: input.sql,
            params: input.params ?? [],
          });
          return {
            async *iterPages() {
              yield { result: [{ results: state.results }] };
            },
          };
        },
      },
    };
  },
}));

beforeEach(() => {
  state.queries.length = 0;
  state.results.length = 0;
});

it("queries bundles through domain filters", async () => {
  state.results.push(bundleD1Row);
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  const rows = await plugin.bundles.findMany({
    where: { channel: "production", id: { gte: "bundle-1" } },
    orderBy: { field: "id", direction: "desc" },
    limit: 10,
    offset: 0,
  });

  expect(rows).toEqual([
    {
      ...bundleD1Row,
      enabled: true,
      metadata: { version: 1 },
      should_force_update: false,
      target_cohorts: ["stable"],
    },
  ]);
  expect(state.queries[0]?.sql).toContain("channel = json_extract(?, '$')");
  expect(state.queries[0]?.sql).toContain("id >= json_extract(?, '$')");
  expect(state.queries[0]?.sql).toContain("ORDER BY id DESC");
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

it("counts domain-filtered bundle rows in SQL", async () => {
  state.results.push({ count: 3 });
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  await plugin.bundles.count({ platform: "ios", channel: "production" });

  expect(state.queries[0]?.sql).toContain(
    "SELECT COUNT(*) AS count FROM bundles",
  );
  expect(state.queries[0]?.sql).toContain("platform = json_extract(?, '$')");
  expect(state.queries[0]?.sql).toContain("channel = json_extract(?, '$')");
});
