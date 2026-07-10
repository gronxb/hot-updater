// noqa: SIZE_OK - Existing Cloudflare Worker database regression suite; splitting belongs to a dedicated test-structure cleanup.
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";
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

const parseJsonArrayParameter = (value: unknown): unknown[] => {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array parameter");
  }
  return parsed;
};

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

const normalizeSql = (sql: string) =>
  sql.replace(/\s+/g, " ").replaceAll('"', "").trim();

const filterRows = (sql: string, params: unknown[]) => {
  const normalizedSql = normalizeSql(sql).toLowerCase();
  let filteredRows = Array.from(rows.values());
  let index = 0;
  const orderedConditions = [
    {
      token: "channel = ?",
      apply: () => {
        const channel = params[index++];
        filteredRows = filteredRows.filter((row) => row.channel === channel);
      },
    },
    {
      token: "platform = ?",
      apply: () => {
        const platform = params[index++];
        filteredRows = filteredRows.filter((row) => row.platform === platform);
      },
    },
    {
      token: "enabled = ?",
      apply: () => {
        const enabled = Number(params[index++]);
        filteredRows = filteredRows.filter((row) => row.enabled === enabled);
      },
    },
    {
      token: "id >= ?",
      apply: () => {
        const id = String(params[index++]);
        filteredRows = filteredRows.filter(
          (row) => row.id.localeCompare(id) >= 0,
        );
      },
    },
  ]
    .map((condition) => ({
      ...condition,
      position: normalizedSql.indexOf(condition.token),
    }))
    .filter((condition) => condition.position >= 0)
    .sort((left, right) => left.position - right.position);

  for (const condition of orderedConditions) {
    condition.apply();
  }

  if (normalizedSql.includes("target_app_version is not null")) {
    filteredRows = filteredRows.filter(
      (row) => row.target_app_version !== null,
    );
  }

  const inMatch = normalizedSql.match(/target_app_version in \(([^)]+)\)/);
  if (inMatch) {
    const body = inMatch[1] ?? "";
    const inValues = body.includes("json_each(")
      ? parseJsonArrayParameter(params[index++])
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

function createD1Binding(): D1Database {
  const createD1Result = <T>(results: T[]): D1Result<T> => ({
    results,
    success: true,
    meta: {
      changed_db: false,
      changes: 0,
      duration: 0,
      last_row_id: 0,
      rows_read: results.length,
      rows_written: 0,
      size_after: 0,
    },
  });

  const createPreparedStatement = (
    sql: string,
    boundParams: readonly unknown[] = [],
  ): D1PreparedStatement => {
    function raw<T = unknown[]>(options: {
      columnNames: true;
    }): Promise<[string[], ...T[]]>;
    function raw<T = unknown[]>(options?: {
      columnNames?: false;
    }): Promise<T[]>;
    async function raw<T = unknown[]>(options?: { columnNames?: boolean }) {
      if (options?.columnNames) {
        return [[]] as [string[], ...T[]];
      }
      return [] as T[];
    }

    return {
      bind(...params: unknown[]) {
        return createPreparedStatement(sql, params);
      },
      async all<T = Record<string, unknown>>() {
        const params = [...boundParams];
        if (params.length > 100) {
          throw new Error(
            "D1_ERROR: too many SQL variables at offset 386: SQLITE_ERROR",
          );
        }

        const normalizedSql = normalizeSql(sql).toLowerCase();

        if (
          normalizedSql.startsWith("select target_app_version from bundles")
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

          return createD1Result(targetAppVersions as T[]);
        }

        if (normalizedSql.startsWith("select count(*) as total from bundles")) {
          const { filteredRows } = filterRows(sql, params);
          return createD1Result([{ total: filteredRows.length }] as T[]);
        }

        if (normalizedSql.startsWith("select * from bundles")) {
          const { filteredRows, index } = filterRows(sql, params);
          const limit = Number(params[index] ?? filteredRows.length);
          const offset = Number(params[index + 1] ?? 0);
          const result = filteredRows
            .sort((left, right) => right.id.localeCompare(left.id))
            .slice(offset, offset + limit);

          return createD1Result(result as T[]);
        }

        if (
          normalizedSql.startsWith(
            "select * from bundle_patches where bundle_id in",
          )
        ) {
          const selectedBundleIds = new Set(
            normalizedSql.includes("json_each")
              ? parseJsonArrayParameter(params[0]).map(String)
              : params.map(String),
          );
          const result = Array.from(patchRows.values()).filter((row) =>
            selectedBundleIds.has(row.bundle_id),
          );

          return createD1Result(result as T[]);
        }

        throw new Error(`Unsupported SQL in D1 worker mock: ${sql}`);
      },
      async first<T = Record<string, unknown>>(colName?: string) {
        const row = (await this.all<Record<string, unknown>>()).results[0];
        if (!row) return null;
        if (colName) return row[colName] as T;
        return row as T;
      },
      async run<T = Record<string, unknown>>() {
        return createD1Result<T>([]);
      },
      raw,
    };
  };

  const binding: D1Database = {
    prepare: createPreparedStatement,
    async batch<T = unknown>(_statements: D1PreparedStatement[]) {
      return [] as D1Result<T>[];
    },
    async exec(_query: string) {
      return { count: 0, duration: 0 };
    },
    withSession() {
      return {
        prepare: binding.prepare,
        batch: binding.batch,
        getBookmark: () => null,
      };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };

  return binding;
}

describe("cloudflare worker d1Database", () => {
  let plugin: DatabasePluginRuntime;
  let context: RequestEnvContext<TestEnv>;

  beforeEach(async () => {
    rows.clear();
    patchRows.clear();
    context = {
      env: {
        DB: createD1Binding(),
        JWT_SECRET: "test-secret",
        BUCKET: {
          get: async () => null,
        },
      },
    };
    plugin = (await d1Database<RequestEnvContext<TestEnv>>()(
      context,
    )) as DatabasePluginRuntime;
  });

  it("creates a Kysely-backed SQLite runtime", () => {
    expect("adapterName" in plugin ? plugin.adapterName : undefined).toBe(
      "kysely",
    );
    expect("provider" in plugin ? plugin.provider : undefined).toBe("sqlite");
    expect(
      "createMigrator" in plugin ? plugin.createMigrator : undefined,
    ).toBeTypeOf("function");
  });

  it("queries getUpdateInfo with 200 distinct target_app_versions without exceeding D1's 100-bind cap", async () => {
    for (let index = 0; index < 200; index++) {
      const row = createBundleRow(index);
      rows.set(row.id, row);
    }

    const result = await plugin.updateInfo?.get({
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

    const result = await plugin.bundles.list({ limit: 200 });

    expect(result.data).toHaveLength(200);
    expect(result.pagination.total).toBe(200);
  });
});
