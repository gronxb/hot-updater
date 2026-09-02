import { beforeEach, expect, it, vi } from "vitest";

import { d1Database } from "./d1Database";

type RecordedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

const state = vi.hoisted<{
  batches: RecordedQuery[][];
  queries: RecordedQuery[];
  results: unknown[];
}>(() => ({ batches: [], queries: [], results: [] }));

const bundleD1Row = {
  id: "bundle-1",
  platform: "ios",
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  archive_byte_size: 3_000_000_001,
  metadata: '{"version":1}',
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
          input:
            | { readonly sql: string; readonly params?: readonly string[] }
            | {
                readonly batch: readonly {
                  readonly sql: string;
                  readonly params?: readonly string[];
                }[];
              },
        ) => {
          if ("batch" in input) {
            state.batches.push(
              input.batch.map(({ sql, params }) => ({
                sql,
                params: params ?? [],
              })),
            );
          } else {
            state.queries.push({
              sql: input.sql,
              params: input.params ?? [],
            });
          }
          return {
            async *iterPages() {
              yield {
                result:
                  "batch" in input
                    ? input.batch.map(() => ({ results: [] }))
                    : [{ results: state.results }],
              };
            },
          };
        },
      },
    };
  },
}));

beforeEach(() => {
  state.batches.length = 0;
  state.queries.length = 0;
  state.results.length = 0;
});

it("queries bundles through domain filters", async () => {
  state.results.push(bundleD1Row);
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
    insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000501",
  });

  const rows = await plugin.models.bundles.findMany({
    where: { platform: "ios", id: { gte: "bundle-1" } },
    orderBy: { field: "id", direction: "desc" },
    limit: 10,
    offset: 0,
  });

  expect(rows).toEqual([
    {
      ...bundleD1Row,
      metadata: { version: 1 },
    },
  ]);
  expect(state.queries[0]?.sql).toContain("platform = json_extract(?, '$')");
  expect(state.queries[0]?.sql).toContain("id >= json_extract(?, '$')");
  expect(state.queries[0]?.sql).toContain("ORDER BY id DESC");
});

it("lists normalized channels without scanning bundles", async () => {
  state.results.push({ id: "channel-production", name: "production" });
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
    insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000501",
  });

  await expect(plugin.models.channels.list({})).resolves.toEqual({
    channels: [{ id: "channel-production", name: "production" }],
  });

  expect(state.queries[0]?.params).toEqual(["100", "0"]);
  expect(state.queries[0]?.sql).toBe(
    "SELECT * FROM channels ORDER BY name ASC LIMIT json_extract(?, '$') OFFSET json_extract(?, '$')",
  );
  expect(state.queries[0]?.sql).not.toContain("bundles");
});

it("counts domain-filtered bundle rows in SQL", async () => {
  state.results.push({ count: 3 });
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
    insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000501",
  });

  await plugin.models.bundles.count({
    platform: "ios",
  });

  expect(state.queries[0]?.sql).toContain(
    "SELECT COUNT(*) AS count FROM bundles",
  );
  expect(state.queries[0]?.sql).toContain("platform = json_extract(?, '$')");
});

it("sends parameterized commits through the D1 batch body", async () => {
  const plugin = d1Database({
    accountId: "account",
    cloudflareApiToken: "token",
    databaseId: "database",
    insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000501",
  });

  await expect(
    plugin.commit({
      changes: [
        {
          model: "channels",
          operation: "insert",
          row: {
            id: "00000000-0000-0000-0000-000000000001",
            name: "production",
          },
          onConflict: "ignore",
        },
        {
          model: "channels",
          operation: "insert",
          row: {
            id: "00000000-0000-0000-0000-000000000002",
            name: "beta",
          },
          onConflict: "ignore",
        },
      ],
    }),
  ).resolves.toEqual({ committed: true });

  expect(state.batches).toHaveLength(1);
  expect(state.batches[0]).toHaveLength(2);
  expect(state.batches[0]?.[0]?.params.length).toBeGreaterThan(0);
  expect(state.batches[0]?.[1]?.params.length).toBeGreaterThan(0);
});
