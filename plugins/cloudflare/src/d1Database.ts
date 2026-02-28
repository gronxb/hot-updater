import type { SnakeCaseBundle } from "@hot-updater/core";
import type {
  Bundle,
  DeviceEvent,
  PaginationOptions,
  RolloutStats,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";
import minify from "pg-minify";
import { uuidv7 } from "uuidv7";

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

function parseTargetDeviceIds(value: unknown): string[] | null {
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
    rolloutPercentage: (row.rollout_percentage as number | null) ?? 100,
    targetDeviceIds: parseTargetDeviceIds(row.target_device_ids as unknown),
  };
}

export const d1Database = createDatabasePlugin<D1DatabaseConfig>({
  name: "d1Database",
  factory: (config) => {
    let bundles: Bundle[] = [];
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
        const found = bundles.find((b) => b.id === bundleId);
        if (found) {
          return found;
        }

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
        const { where = {}, limit, offset } = options;

        // 1. Get total count for pagination
        const totalCount = await getTotalCount(where);

        // 2. Get paginated bundles
        bundles = await getPaginatedBundles(where, limit, offset);

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
                metadata,
                rollout_percentage,
                target_device_ids
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
              bundle.rolloutPercentage ?? 100,
              bundle.targetDeviceIds
                ? JSON.stringify(bundle.targetDeviceIds)
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

      async trackDeviceEvent(event: DeviceEvent): Promise<void> {
        const id = uuidv7();
        const sql = minify(/* sql */ `
          INSERT INTO device_events (
            id,
            device_id,
            bundle_id,
            event_type,
            platform,
            app_version,
            channel,
            metadata
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        await cf.d1.database.query(config.databaseId, {
          account_id: config.accountId,
          sql,
          params: [
            id,
            event.deviceId,
            event.bundleId,
            event.eventType,
            event.platform,
            event.appVersion ?? "",
            event.channel,
            JSON.stringify(event.metadata ?? {}),
          ],
        });
      },

      async getRolloutStats(bundleId: string): Promise<RolloutStats> {
        const sql = minify(/* sql */ `
          WITH ranked AS (
            SELECT
              device_id,
              event_type,
              ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY id DESC) as rn
            FROM device_events
            WHERE bundle_id = ?
          ),
          latest AS (
            SELECT device_id, event_type
            FROM ranked
            WHERE rn = 1
          )
          SELECT
            COUNT(*) as total_devices,
            SUM(CASE WHEN event_type = 'PROMOTED' THEN 1 ELSE 0 END) as promoted_count,
            SUM(CASE WHEN event_type = 'RECOVERED' THEN 1 ELSE 0 END) as recovered_count
          FROM latest
        `);

        const result = await cf.d1.database.query(config.databaseId, {
          account_id: config.accountId,
          sql,
          params: [bundleId],
        });

        const rows = await resolvePage<{
          total_devices: number;
          promoted_count: number;
          recovered_count: number;
        }>(result);

        const row = rows[0] ?? {
          total_devices: 0,
          promoted_count: 0,
          recovered_count: 0,
        };

        const successRate =
          row.total_devices > 0
            ? (row.promoted_count / row.total_devices) * 100
            : 0;

        return {
          totalDevices: row.total_devices,
          promotedCount: row.promoted_count,
          recoveredCount: row.recovered_count,
          successRate: Number(successRate.toFixed(2)),
        };
      },
    };
  },
});
