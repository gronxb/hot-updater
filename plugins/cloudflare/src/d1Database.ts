import type { SnakeCaseBundle } from "@hot-updater/core";
import type {
  Bundle,
  DatabasePluginHooks,
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
interface QueryConditions {
  channel?: string;
  platform?: string;
}

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

  const whereClause =
    clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

  return { sql: whereClause, params };
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
    compressionStrategy:
      (row.compression_strategy as "zip" | "tarBrotli" | "tarGzip") ?? "zip",
  };
}

export const d1Database = (
  config: D1DatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  let bundles: Bundle[] = [];

  // Helper function to get total count
  async function getTotalCount(
    context: { cf: Cloudflare },
    conditions: QueryConditions,
  ): Promise<number> {
    const { sql: whereClause, params } = buildWhereClause(conditions);
    const countSql = minify(
      `SELECT COUNT(*) as total FROM bundles${whereClause}`,
    );

    const countResult = await context.cf.d1.database.query(config.databaseId, {
      account_id: config.accountId,
      sql: countSql,
      params,
    });

    const rows = await resolvePage<{ total: number }>(countResult);
    return rows[0]?.total || 0;
  }

  // Helper function to get paginated bundles
  async function getPaginatedBundles(
    context: { cf: Cloudflare },
    conditions: QueryConditions,
    limit: number,
    offset: number,
  ): Promise<Bundle[]> {
    const { sql: whereClause, params } = buildWhereClause(conditions);

    // Build the complete query
    const sql = minify(`
      SELECT * FROM bundles
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
      OFFSET ?
    `);

    // Add pagination params
    params.push(limit, offset);

    const result = await context.cf.d1.database.query(config.databaseId, {
      account_id: config.accountId,
      sql,
      params,
    });

    const rows = await resolvePage<SnakeCaseBundle>(result);
    return rows.map(transformRowToBundle);
  }

  return createDatabasePlugin(
    "d1Database",
    {
      getContext: () => ({
        cf: new Cloudflare({
          apiToken: config.cloudflareApiToken,
        }),
      }),

      async getBundleById(context, bundleId) {
        const found = bundles.find((b) => b.id === bundleId);
        if (found) {
          return found;
        }

        const sql = minify(/* sql */ `
          SELECT * FROM bundles WHERE id = ? LIMIT 1`);
        const singlePage = await context.cf.d1.database.query(
          config.databaseId,
          {
            account_id: config.accountId,
            sql,
            params: [bundleId],
          },
        );

        const rows = await resolvePage<SnakeCaseBundle>(singlePage);

        if (rows.length === 0) {
          return null;
        }

        return transformRowToBundle(rows[0]);
      },

      async getBundles(
        context,
        options: {
          where?: QueryConditions;
          limit: number;
          offset: number;
        },
      ) {
        const { where = {}, limit, offset } = options;

        // 1. Get total count for pagination
        const totalCount = await getTotalCount(context, where);

        // 2. Get paginated bundles
        bundles = await getPaginatedBundles(context, where, limit, offset);

        // 3. Calculate pagination metadata
        const paginationOptions: PaginationOptions = { limit, offset };
        const pagination = calculatePagination(totalCount, paginationOptions);

        return {
          data: bundles,
          pagination,
        };
      },

      async getChannels(context) {
        const sql = minify(/* sql */ `
          SELECT channel FROM bundles GROUP BY channel
        `);
        const singlePage = await context.cf.d1.database.query(
          config.databaseId,
          {
            account_id: config.accountId,
            sql,
            params: [],
          },
        );

        const rows = await resolvePage<{ channel: string }>(singlePage);
        return rows.map((row) => row.channel);
      },

      async commitBundle(context, { changedSets }) {
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

            await context.cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: deleteSql,
              params: [op.data.id],
            });

            // Update local bundles array
            bundles = bundles.filter((b) => b.id !== op.data.id);
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
                metadata
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ];

            await context.cf.d1.database.query(config.databaseId, {
              account_id: config.accountId,
              sql: upsertSql,
              params: params as string[],
            });
          }
        }

        // Trigger hooks after all operations
        hooks?.onDatabaseUpdated?.();
      },
    },
    hooks,
  );
};
