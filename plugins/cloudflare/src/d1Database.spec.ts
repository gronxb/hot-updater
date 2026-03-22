import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import { beforeEach, describe, vi } from "vitest";
import { d1Database } from "./d1Database";

type D1Row = {
  id: string;
  channel: string;
  enabled: number | boolean;
  should_force_update: number | boolean;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: "ios" | "android";
  target_app_version: string | null;
  storage_uri: string;
  fingerprint_hash: string | null;
  metadata: string;
  rollout_cohort_count: number | null;
  target_cohorts: string | null;
};

const { rows } = vi.hoisted(() => ({
  rows: new Map<string, D1Row>(),
}));

vi.mock("pg-minify", () => ({
  default: (sql: string) => sql.replace(/\s+/g, " ").trim(),
}));

const createPage = <T>(results: T[]) => ({
  async *iterPages() {
    yield {
      result: [{ results }],
    };
  },
});

const getFilteredRows = (sql: string, params: any[]) => {
  let filteredRows = Array.from(rows.values());
  let index = 0;

  if (sql.includes("channel = ?")) {
    const channel = params[index++];
    filteredRows = filteredRows.filter((row) => row.channel === channel);
  }

  if (sql.includes("platform = ?")) {
    const platform = params[index++];
    filteredRows = filteredRows.filter((row) => row.platform === platform);
  }

  return { filteredRows, index };
};

vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    d1 = {
      database: {
        query: async (
          _databaseId: string,
          {
            sql,
            params = [],
          }: {
            sql: string;
            params?: any[];
          },
        ) => {
          const normalizedSql = sql.replace(/\s+/g, " ").trim().toLowerCase();

          if (
            normalizedSql.startsWith("select count(*) as total from bundles")
          ) {
            const { filteredRows } = getFilteredRows(sql, params);
            return createPage([{ total: filteredRows.length }]);
          }

          if (normalizedSql.startsWith("select * from bundles where id = ?")) {
            const bundleId = params[0];
            const row = rows.get(bundleId);
            return createPage(row ? [row] : []);
          }

          if (normalizedSql.startsWith("select * from bundles")) {
            const { filteredRows, index } = getFilteredRows(sql, params);
            const limit = Number(params[index] ?? filteredRows.length);
            const offset = Number(params[index + 1] ?? 0);
            const result = filteredRows
              .sort((a, b) => b.id.localeCompare(a.id))
              .slice(offset, offset + limit);

            return createPage(result);
          }

          if (
            normalizedSql.startsWith(
              "select channel from bundles group by channel",
            )
          ) {
            const channels = Array.from(
              new Set(Array.from(rows.values()).map((row) => row.channel)),
            ).map((channel) => ({ channel }));
            return createPage(channels);
          }

          if (normalizedSql.startsWith("delete from bundles where id = ?")) {
            rows.delete(params[0]);
            return createPage([]);
          }

          if (normalizedSql.startsWith("insert or replace into bundles")) {
            const row: D1Row = {
              id: params[0],
              channel: params[1],
              enabled: params[2],
              should_force_update: params[3],
              file_hash: params[4],
              git_commit_hash: params[5],
              message: params[6],
              platform: params[7],
              target_app_version: params[8],
              storage_uri: params[9],
              fingerprint_hash: params[10],
              metadata: params[11],
              rollout_cohort_count: params[12],
              target_cohorts: params[13],
            };
            rows.set(row.id, row);
            return createPage([]);
          }

          throw new Error(`Unsupported SQL in D1 mock: ${sql}`);
        },
      },
    };
  },
}));

describe("d1Database plugin", () => {
  let plugin: DatabasePlugin;

  beforeEach(() => {
    rows.clear();
    plugin = d1Database({
      databaseId: "test-db-id",
      accountId: "test-account-id",
      cloudflareApiToken: "test-token",
    })();
  });

  setupBundleMethodsTestSuite({
    getBundleById: (id) => plugin.getBundleById(id),
    getChannels: () => plugin.getChannels(),
    insertBundle: async (bundle) => {
      await plugin.appendBundle(bundle);
      await plugin.commitBundle();
    },
    getBundles: (options) => plugin.getBundles(options),
    updateBundleById: async (bundleId, newBundle) => {
      await plugin.updateBundle(bundleId, newBundle);
      await plugin.commitBundle();
    },
    deleteBundleById: async (bundleId) => {
      const bundle = await plugin.getBundleById(bundleId);
      if (!bundle) {
        return;
      }
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();
    },
  });
});
