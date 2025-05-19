import type { SnakeCaseBundle } from "@hot-updater/core";
import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";
import minify from "pg-minify";

export interface D1DatabaseConfig {
  databaseId: string;
  accountId: string;
  cloudflareApiToken: string;
}

async function resolvePage<T>(singlePage: any): Promise<T[]> {
  const results: T[] = [];
  for await (const page of singlePage.iterPages()) {
    const data = page.result.flatMap((r: any) => r.results);
    results.push(...(data as T[]));
  }
  return results;
}

export const d1Database = (
  config: D1DatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  let bundles: Bundle[] = [];

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

        const sql = minify(
          /* sql */ `
          SELECT * FROM bundles WHERE id = ? LIMIT 1`,
        );
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

        const row = rows[0];
        return {
          channel: row.channel,
          enabled: Boolean(row.enabled),
          shouldForceUpdate: Boolean(row.should_force_update),
          fileHash: row.file_hash,
          gitCommitHash: row.git_commit_hash,
          id: row.id,
          message: row.message,
          platform: row.platform,
          targetAppVersion: row.target_app_version,
          storageUri: row.storage_uri,
          fingerprintHash: row.fingerprint_hash,
        } as Bundle;
      },

      async getBundles(context, options) {
        const { where, limit, offset = 0 } = options ?? {};

        let sql = "SELECT * FROM bundles";
        const params: any[] = [];

        const conditions: string[] = [];
        if (where?.channel) {
          conditions.push("channel = ?");
          params.push(where.channel);
        }

        if (where?.platform) {
          conditions.push("platform = ?");
          params.push(where.platform);
        }

        if (conditions.length > 0) {
          sql += ` WHERE ${conditions.join(" AND ")}`;
        }

        sql += " ORDER BY id DESC";

        if (limit) {
          sql += " LIMIT ?";
          params.push(limit);
        }

        if (offset) {
          sql += " OFFSET ?";
          params.push(offset);
        }

        const singlePage = await context.cf.d1.database.query(
          config.databaseId,
          {
            account_id: config.accountId,
            sql: minify(sql),
            params,
          },
        );

        const rows = await resolvePage<SnakeCaseBundle>(singlePage);

        if (rows.length === 0) {
          bundles = [];
        } else {
          bundles = rows.map((row) => ({
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
          }));
        }
        return bundles;
      },

      async getChannels(context) {
        const sql = minify(
          /* sql */ `
          SELECT channel FROM bundles GROUP BY channel
        `,
        );
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

        const bundles = changedSets.map((op) => op.data);

        const params: (string | number | boolean | null)[] = [];
        const valuesSql = bundles
          .map((b) => {
            params.push(
              b.id,
              b.channel,
              b.enabled ? 1 : 0,
              b.shouldForceUpdate ? 1 : 0,
              b.fileHash,
              b.gitCommitHash || null,
              b.message || null,
              b.platform,
              b.targetAppVersion,
              b.storageUri,
              b.fingerprintHash,
            );
            return "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
          })
          .join(",\n");

        const sql = minify(/* sql */ `
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
            fingerprint_hash
          )
          VALUES
          ${valuesSql};`);

        await context.cf.d1.database.query(config.databaseId, {
          account_id: config.accountId,
          sql,
          params: params as string[],
        });
      },
    },
    hooks,
  );
};
