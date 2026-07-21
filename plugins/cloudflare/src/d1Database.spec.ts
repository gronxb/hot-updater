import { databaseAnalyticsSupport } from "@hot-updater/plugin-core";
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

it("advertises Analytics support", () => {
  // Given / When
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  // Then
  expect(plugin[databaseAnalyticsSupport]).toBe(true);
});

it("projects selected fields after querying physical bundle columns", async () => {
  state.results.push({
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
  });
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
