import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  type SnakeCaseBundle,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  PaginationOptions,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";
import minify from "pg-minify";

export interface D1DatabaseConfig {
  databaseId: string;
  accountId: string;
  cloudflareApiToken: string;
}

// Helper interfaces for clarity
type QueryConditions = DatabaseBundleQueryWhere;

interface BuildQueryResult {
  sql: string;
  params: any[];
}

async function resolvePage<T>(singlePage: any): Promise<T[]> {
  const results: T[] = [];
  for await (const page of singlePage.iterPages()) {
    const data = page.result.flatMap((r: any) => r.results);
    results.push(...(data as T[]));
  }
  return results;
}

// Helper function to build WHERE clause
function buildWhereClause(conditions: QueryConditions): BuildQueryResult {
  const clauses: string[] = [];
  const params: any[] = [];

  if (conditions.channel) {
    clauses.push("channel = ?");
    params.push(conditions.channel);
  }

  if (conditions.platform) {
    clauses.push("platform = ?");
    params.push(conditions.platform);
  }

  if (conditions.enabled !== undefined) {
    clauses.push("enabled = ?");
    params.push(conditions.enabled ? 1 : 0);
  }

  if (conditions.id?.in) {
    if (conditions.id.in.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`id IN (${conditions.id.in.map(() => "?").join(", ")})`);
      params.push(...conditions.id.in);
    }
  }

  if (conditions.id?.eq) {
    clauses.push("id = ?");
    params.push(conditions.id.eq);
  }

  if (conditions.id?.gt) {
    clauses.push("id > ?");
    params.push(conditions.id.gt);
  }

  if (conditions.id?.gte) {
    clauses.push("id >= ?");
    params.push(conditions.id.gte);
  }

  if (conditions.id?.lt) {
    clauses.push("id < ?");
    params.push(conditions.id.lt);
  }

  if (conditions.id?.lte) {
    clauses.push("id <= ?");
    params.push(conditions.id.lte);
  }

  if (conditions.targetAppVersionNotNull) {
    clauses.push("target_app_version IS NOT NULL");
  }

  if (conditions.targetAppVersion !== undefined) {
    if (conditions.targetAppVersion === null) {
      clauses.push("target_app_version IS NULL");
    } else {
      clauses.push("target_app_version = ?");
      params.push(conditions.targetAppVersion);
    }
  }

  if (conditions.targetAppVersionIn) {
    if (conditions.targetAppVersionIn.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(
        `target_app_version IN (${conditions.targetAppVersionIn
          .map(() => "?")
          .join(", ")})`,
      );
      params.push(...conditions.targetAppVersionIn);
    }
  }

  if (conditions.fingerprintHash !== undefined) {
    if (conditions.fingerprintHash === null) {
      clauses.push("fingerprint_hash IS NULL");
    } else {
      clauses.push("fingerprint_hash = ?");
      params.push(conditions.fingerprintHash);
    }
  }

  const whereClause =
    clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

  return { sql: whereClause, params };
}

function parseTargetCohorts(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Helper function to transform snake_case row to Bundle
function transformRowToBundle(row: SnakeCaseBundle): Bundle {
  return {
    id: row.id,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    shouldForceUpdate: Boolean(row.should_force_update),
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash,
    message: row.message,
    platform: row.platform,
    targetAppVersion: row.target_app_version,
    storageUri: row.storage_uri,
    fingerprintHash: row.fingerprint_hash,
    metadata: row?.metadata ? JSON.parse(row?.metadata as string) : {},
    rolloutCohortCount:
      (row.rollout_cohort_count as number | null) ??
      DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: parseTargetCohorts(row.target_cohorts as unknown),
  };
}

export const d1Database = createDatabasePlugin<D1DatabaseConfig>({
  name: "d1Database",
  factory: (config) => {
    const cf = new Cloudflare({
      apiToken: config.cloudflareApiToken,
    });

    // Helper function to get total count
    async function getTotalCount(conditions: QueryConditions): Promise<number> {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const countSql = minify(
        `SELECT COUNT(*) as total FROM bundles${whereClause}`,
      );

      const countResult = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql: countSql,
        params,
      });

      const rows = await resolvePage<{ total: number }>(countResult);
      return rows[0]?.total || 0;
    }

    // Helper function to get paginated bundles
    async function getPaginatedBundles(
      conditions: QueryConditions,
      limit: number,
      offset: number,
      orderBy?: DatabaseBundleQueryOrder,
    ): Promise<Bundle[]> {
      const { sql: whereClause, params } = buildWhereClause(conditions);
      const orderBySql =
        orderBy?.direction === "asc" ? "ORDER BY id ASC" : "ORDER BY id DESC";

      // Build the complete query
      const sql = minify(`
      SELECT * FROM bundles
      ${whereClause}
      ${orderBySql}
      LIMIT ?
      OFFSET ?
    `);

      // Add pagination params
      params.push(limit, offset);

      const result = await cf.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        sql,
        params,
      });

      const rows = await resolvePage<SnakeCaseBundle>(result);
      return rows.map(transformRowToBundle);
    }

    return {
      async getBundleById(bundleId) {
        const sql = minify(/* sql */ `
          SELECT * FROM bundles WHERE id = ? LIMIT 1`);
        const singlePage = await cf.d1.database.query(config.databaseId, {
          account_id: config.accountId,
          sql,
          params: [bundleId],
        });

        const rows = await resolvePage<SnakeCaseBundle>(singlePage);

        if (rows.length === 0) {
          return null;
        }

        return transformRowToBundle(rows[0]);
      },

      async getBundles(options) {
        const { where = {}, limit, offset, orderBy } = options;

        // 1. Get total count for pagination
        const totalCount = await getTotalCount(where);

        // 2. Get paginated bundles
        const bundles = await getPaginatedBundles(
          where,
          limit,
          offset,
          orderBy,
        );

        // 3. Calculate pagination metadata
        const paginationOptions: PaginationOptions = { limit, offset };
        const pagination = calculatePagination(totalCount, paginationOptions);

        return {
          data: bundles,
          pagination,
        };
      },

      async getChannels() {
        const sql = minify(/* sql */ `
          SELECT channel FROM bundles GROUP BY channel
        `);
        const singlePage = await cf.d1.database.query(config.databaseId, {
          account_id: config.accountId,
          sql,
          params: [],
        });

        const rows = await resolvePage<{ channel: string }>(singlePage);
        return rows.map((row) => row.channel);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            // Handle delete operation
            const deleteSql = minify(/* sql */ `
              DELETE FROM bundles WHERE id = ?
            `);

            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: deleteSql,
              params: [op.data.id],
            });
          } else if (op.operation === "insert" || op.operation === "update") {
            // Handle insert and update operations
            const bundle = op.data;
            const upsertSql = minify(/* sql */ `
              INSERT OR REPLACE INTO bundles (
                id,
                channel,
                enabled,
                should_force_update,
                file_hash,
                git_commit_hash,
                message,
                platform,
                target_app_version,
                storage_uri,
                fingerprint_hash,
                metadata,
                rollout_cohort_count,
                target_cohorts
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const params = [
              bundle.id,
              bundle.channel,
              bundle.enabled ? 1 : 0,
              bundle.shouldForceUpdate ? 1 : 0,
              bundle.fileHash,
              bundle.gitCommitHash || null,
              bundle.message || null,
              bundle.platform,
              bundle.targetAppVersion,
              bundle.storageUri,
              bundle.fingerprintHash,
              bundle.metadata
                ? JSON.stringify(bundle.metadata)
                : JSON.stringify({}),
              bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
              bundle.targetCohorts
                ? JSON.stringify(bundle.targetCohorts)
                : null,
            ];

            await cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: upsertSql,
              params: params as string[],
            });
          }
        }
      },
    };
  },
});
