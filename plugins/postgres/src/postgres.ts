import type {
  Bundle,
  DatabasePluginHooks,
  Platform,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./types";

export interface PostgresConfig extends PoolConfig {}

export const postgres = (
  config: PostgresConfig,
  hooks?: DatabasePluginHooks,
) => {
  const pool = new Pool(config);

  const dialect = new PostgresDialect({
    pool,
  });

  const db = new Kysely<Database>({
    dialect,
  });

  const isUnmount = false;

  return createDatabasePlugin(
    "postgres",
    {
      async getBundleById(bundleId) {
        const data = await db
          .selectFrom("bundles")
          .selectAll()
          .where("id", "=", bundleId)
          .executeTakeFirst();

        if (!data) {
          return null;
        }
        return {
          enabled: data.enabled,
          fileUrl: data.file_url,
          shouldForceUpdate: data.should_force_update,
          fileHash: data.file_hash,
          gitCommitHash: data.git_commit_hash,
          id: data.id,
          message: data.message,
          platform: data.platform,
          targetAppVersion: data.target_app_version,
          channel: data.channel,
        } as Bundle;
      },

      async getBundles(options: {
        where: {
          channel?: string;
          platform?: Platform;
        };
        limit?: number;
        offset?: number;
        refresh?: boolean;
      }) {
        let query = db.selectFrom("bundles").orderBy("id", "desc");

        if (options?.where?.channel) {
          query = query.where("channel", "=", options.where.channel);
        }

        if (options?.where?.platform) {
          query = query.where("platform", "=", options.where.platform);
        }

        if (options?.limit) {
          query = query.limit(options.limit);
        }

        if (options?.offset) {
          query = query.offset(options.offset);
        }

        const data = await query.selectAll().execute();

        return data.map((bundle) => ({
          enabled: bundle.enabled,
          fileUrl: bundle.file_url,
          shouldForceUpdate: bundle.should_force_update,
          fileHash: bundle.file_hash,
          gitCommitHash: bundle.git_commit_hash,
          id: bundle.id,
          message: bundle.message,
          platform: bundle.platform,
          targetAppVersion: bundle.target_app_version,
          channel: bundle.channel,
        })) as Bundle[];
      },

      async getChannels() {
        const data = await db
          .selectFrom("bundles")
          .select("channel")
          .groupBy("channel")
          .execute();
        return data.map((bundle) => bundle.channel);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.size === 0) {
          return;
        }

        const operations = Array.from(changedSets);
        const bundles = operations.map((op) => op.data);

        await db.transaction().execute(async (tx) => {
          for (const bundle of bundles) {
            await tx
              .insertInto("bundles")
              .values({
                id: bundle.id,
                enabled: bundle.enabled,
                file_url: bundle.fileUrl,
                should_force_update: bundle.shouldForceUpdate,
                file_hash: bundle.fileHash,
                git_commit_hash: bundle.gitCommitHash,
                message: bundle.message,
                platform: bundle.platform,
                target_app_version: bundle.targetAppVersion,
                channel: bundle.channel,
              })
              .onConflict((oc) =>
                oc.column("id").doUpdateSet({
                  enabled: bundle.enabled,
                  file_url: bundle.fileUrl,
                  should_force_update: bundle.shouldForceUpdate,
                  file_hash: bundle.fileHash,
                  git_commit_hash: bundle.gitCommitHash,
                  message: bundle.message,
                  platform: bundle.platform,
                  target_app_version: bundle.targetAppVersion,
                  channel: bundle.channel,
                }),
              )
              .execute();
          }
        });
      },
    },
    hooks,
  );
};
