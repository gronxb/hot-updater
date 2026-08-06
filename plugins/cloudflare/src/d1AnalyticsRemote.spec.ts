import { beforeEach, expect, it, vi } from "vitest";

import { d1AnalyticsIndexes, d1AnalyticsTableV2 } from "./d1AnalyticsSchema";
import { migrateD1Analytics } from "./d1Database";

type RecordedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

const state = vi.hoisted<{
  queries: RecordedQuery[];
  resolve: (sql: string) => readonly unknown[];
}>(() => ({ queries: [], resolve: () => [] }));

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
          const results = state.resolve(input.sql);
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
  state.resolve = () => [];
});

it("runs schema changes as one remote batch before writing its marker", async () => {
  let schemaCreated = false;
  let componentVersion: string | null = null;
  state.resolve = (sql) => {
    if (sql.includes("FROM sqlite_master WHERE type = 'table'")) {
      return [
        ...(schemaCreated
          ? [{ name: "bundle_events", sql: d1AnalyticsTableV2 }]
          : []),
        {
          name: "private_hot_updater_settings",
          sql: "CREATE TABLE private_hot_updater_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
        },
      ];
    }
    if (sql.includes("FROM private_hot_updater_settings")) {
      return [
        ...(componentVersion === null
          ? []
          : [{ key: "schema.analytics", value: componentVersion }]),
        { key: "version", value: "0.36.0" },
      ];
    }
    if (sql.includes("FROM sqlite_master WHERE type = 'index'")) {
      return d1AnalyticsIndexes.map((indexSql, index) => ({
        name: `analytics-index-${index}`,
        sql: indexSql,
      }));
    }
    if (sql.startsWith("CREATE TABLE bundle_events")) {
      schemaCreated = true;
    }
    if (sql.startsWith("INSERT INTO private_hot_updater_settings")) {
      componentVersion = "2";
    }
    return [];
  };

  await expect(
    migrateD1Analytics({
      accountId: "account",
      cloudflareApiToken: "token",
      databaseId: "database",
    }),
  ).resolves.toEqual({ kind: "created-v2" });

  const schemaBatch = state.queries.find(({ sql }) =>
    sql.startsWith("CREATE TABLE bundle_events"),
  );
  expect(schemaBatch?.sql).toContain(
    "CREATE INDEX bundle_events_received_at_idx",
  );
  expect(state.queries.at(-1)?.sql).toContain("'schema.analytics', '2'");
});
