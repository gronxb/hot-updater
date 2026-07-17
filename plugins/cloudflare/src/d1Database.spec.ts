import { databaseBundleEventSupport } from "@hot-updater/plugin-core";
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

it("advertises bundle event analytics support", () => {
  // Given / When
  const adapter = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  // Then
  expect(adapter[databaseBundleEventSupport]).toBe(true);
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
    channel_id: "channel-production",
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
  const adapter = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  const rows = await adapter.findMany({
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

it("encodes channel ids and names as JSON-bound parameters", async () => {
  state.results.push({ id: "channel-production", name: "production" });
  const adapter = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
  });

  await adapter.create({
    model: "channels",
    data: { id: "channel-production", name: "production" },
  });

  expect(state.queries[0]).toMatchObject({
    params: ['"channel-production"', '"production"'],
  });
  expect(state.queries[0]?.sql).toContain("INSERT INTO channels (id, name)");
});
