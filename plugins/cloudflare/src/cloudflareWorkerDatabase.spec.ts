import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import { d1Database, type RequestEnvContext } from "./worker";

type WorkerBundleRow = {
  id: string;
  channel: string;
  enabled: number;
  should_force_update: number;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: "ios" | "android";
  target_app_version: string | null;
  storage_uri: string;
  fingerprint_hash: string | null;
  metadata: string;
  manifest_storage_uri: string | null;
  manifest_file_hash: string | null;
  asset_base_storage_uri: string | null;
  rollout_cohort_count: number | null;
  target_cohorts: string | null;
};

type WorkerPatchRow = {
  id: string;
  bundle_id: string;
  base_bundle_id: string;
  base_file_hash: string;
  patch_file_hash: string;
  patch_storage_uri: string;
  order_index: number | null;
};

type TestEnv = {
  DB: ReturnType<typeof createD1Binding>;
  JWT_SECRET: string;
  BUCKET: {
    get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
  };
};

const rows = new Map<string, WorkerBundleRow>();
const patchRows = new Map<string, WorkerPatchRow>();

const createBundleRow = (index: number): WorkerBundleRow => {
  const id = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
  return {
    id,
    channel: "production",
    enabled: 1,
    should_force_update: 0,
    file_hash: `hash-${index}`,
    git_commit_hash: null,
    message: null,
    platform: "ios",
    target_app_version: `>=0.${index}.0`,
    storage_uri: `r2://bucket/${id}.zip`,
    fingerprint_hash: null,
    metadata: "{}",
    manifest_storage_uri: null,
    manifest_file_hash: null,
    asset_base_storage_uri: null,
    rollout_cohort_count: 1000,
    target_cohorts: null,
  };
};

const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim();

const filterRows = (sql: string, params: unknown[]) => {
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

  if (sql.includes("enabled = ?")) {
    const enabled = Number(params[index++]);
    filteredRows = filteredRows.filter((row) => row.enabled === enabled);
  }

  if (sql.includes("id >= ?")) {
    const id = String(params[index++]);
    filteredRows = filteredRows.filter((row) => row.id.localeCompare(id) >= 0);
  }

  if (sql.includes("target_app_version IS NOT NULL")) {
    filteredRows = filteredRows.filter(
      (row) => row.target_app_version !== null,
    );
  }

  const inMatch = sql.match(/target_app_version IN \(([^)]+)\)/);
  if (inMatch) {
    const body = inMatch[1] ?? "";
    const inValues = body.includes("json_each(")
      ? (JSON.parse(String(params[index++])) as unknown[])
      : params.slice(index, index + (body.match(/\?/g) ?? []).length);
    const values = new Set(inValues);
    filteredRows = filteredRows.filter((row) =>
      values.has(row.target_app_version),
    );
    if (!body.includes("json_each(")) {
      index += inValues.length;
    }
  }

  return { filteredRows, index };
};

function createD1Binding() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          if (params.length > 100) {
            throw new Error(
              "D1_ERROR: too many SQL variables at offset 386: SQLITE_ERROR",
            );
          }

          return {
            async all<T>() {
              const normalizedSql = normalizeSql(sql).toLowerCase();

              if (
                normalizedSql.startsWith(
                  "select target_app_version from bundles",
                )
              ) {
                const { filteredRows } = filterRows(sql, params);
                const targetAppVersions = Array.from(
                  new Set(
                    filteredRows
                      .map((row) => row.target_app_version)
                      .filter(
                        (targetAppVersion): targetAppVersion is string =>
                          targetAppVersion !== null,
                      ),
                  ),
                ).map((targetAppVersion) => ({
                  target_app_version: targetAppVersion,
                }));

                return { results: targetAppVersions as T[] };
              }

              if (
                normalizedSql.startsWith(
                  "select count(*) as total from bundles",
                )
              ) {
                const { filteredRows } = filterRows(sql, params);
                return { results: [{ total: filteredRows.length }] as T[] };
              }

              if (normalizedSql.startsWith("select * from bundles")) {
                const { filteredRows, index } = filterRows(sql, params);
                const limit = Number(params[index] ?? filteredRows.length);
                const offset = Number(params[index + 1] ?? 0);
                const result = filteredRows
                  .sort((left, right) => right.id.localeCompare(left.id))
                  .slice(offset, offset + limit);

                return { results: result as T[] };
              }

              if (
                normalizedSql.startsWith(
                  "select * from bundle_patches where bundle_id in",
                )
              ) {
                const selectedBundleIds = new Set(
                  normalizedSql.includes("json_each")
                    ? (JSON.parse(String(params[0])) as unknown[]).map(String)
                    : params.map(String),
                );
                const result = Array.from(patchRows.values()).filter((row) =>
                  selectedBundleIds.has(row.bundle_id),
                );

                return { results: result as T[] };
              }

              throw new Error(`Unsupported SQL in D1 worker mock: ${sql}`);
            },
            async first<T>() {
              return (await this.all<T>()).results?.[0] ?? null;
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
}

describe("cloudflare worker d1Database", () => {
  let plugin: DatabasePlugin<RequestEnvContext<TestEnv>>;
  let context: RequestEnvContext<TestEnv>;

  beforeEach(() => {
    rows.clear();
    patchRows.clear();
    plugin = d1Database<RequestEnvContext<TestEnv>>()();
    context = {
      env: {
        DB: createD1Binding(),
        JWT_SECRET: "test-secret",
        BUCKET: {
          get: async () => null,
        },
      },
    };
  });

  it("queries getUpdateInfo with 200 distinct target_app_versions without exceeding D1's 100-bind cap", async () => {
    for (let index = 0; index < 200; index++) {
      const row = createBundleRow(index);
      rows.set(row.id, row);
    }

    const result = await plugin.updates?.check(context, {
      appVersion: "1.0.0",
      bundleId: "00000000-0000-0000-0000-000000000000",
      platform: "ios",
      channel: "production",
      minBundleId: "00000000-0000-0000-0000-000000000000",
      _updateStrategy: "appVersion",
    });

    expect(result).not.toBeNull();
  });

  it("queries patches for 200 listed bundles without exceeding D1's 100-bind cap", async () => {
    for (let index = 0; index < 200; index++) {
      const row = createBundleRow(index);
      rows.set(row.id, row);
    }

    const result = await plugin.bundles.list(context, { limit: 200 });

    expect(result.data).toHaveLength(200);
    expect(result.pagination.total).toBe(200);
  });
});
