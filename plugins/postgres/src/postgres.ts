import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
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

  return createDatabasePlugin(
    "postgres",
    {
      async onUnmount() {
        await db.destroy();
        await pool.end();
      },
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
          shouldForceUpdate: data.should_force_update,
          fileHash: data.file_hash,
          gitCommitHash: data.git_commit_hash,
          id: data.id,
          message: data.message,
          platform: data.platform,
          targetAppVersion: data.target_app_version,
          channel: data.channel,
          storageUri: data.storage_uri,
          fingerprintHash: data.fingerprint_hash,
        } as Bundle;
      },

      async getBundles(options) {
        const { where, limit, offset = 0 } = options ?? {};

        let query = db.selectFrom("bundles").orderBy("id", "desc");

        if (where?.channel) {
          query = query.where("channel", "=", where.channel);
        }

        if (where?.platform) {
          query = query.where("platform", "=", where.platform);
        }

        if (limit) {
          query = query.limit(limit);
        }

        if (offset) {
          query = query.offset(offset);
        }

        const data = await query.selectAll().execute();

        return data.map((bundle) => ({
          enabled: bundle.enabled,
          shouldForceUpdate: bundle.should_force_update,
          fileHash: bundle.file_hash,
          gitCommitHash: bundle.git_commit_hash,
          id: bundle.id,
          message: bundle.message,
          platform: bundle.platform,
          targetAppVersion: bundle.target_app_version,
          channel: bundle.channel,
          storageUri: bundle.storage_uri,
          fingerprintHash: bundle.fingerprint_hash,
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
        if (changedSets.length === 0) {
          return;
        }

        const bundles = changedSets.map((op) => op.data);

        await db.transaction().execute(async (tx) => {
          for (const bundle of bundles) {
            await tx
              .insertInto("bundles")
              .values({
                id: bundle.id,
                enabled: bundle.enabled,
                should_force_update: bundle.shouldForceUpdate,
                file_hash: bundle.fileHash,
                git_commit_hash: bundle.gitCommitHash,
                message: bundle.message,
                platform: bundle.platform,
                target_app_version: bundle.targetAppVersion,
                channel: bundle.channel,
                storage_uri: bundle.storageUri,
                fingerprint_hash: bundle.fingerprintHash,
              })
              .onConflict((oc) =>
                oc.column("id").doUpdateSet({
                  enabled: bundle.enabled,
                  should_force_update: bundle.shouldForceUpdate,
                  file_hash: bundle.fileHash,
                  git_commit_hash: bundle.gitCommitHash,
                  message: bundle.message,
                  platform: bundle.platform,
                  target_app_version: bundle.targetAppVersion,
                  channel: bundle.channel,
                  storage_uri: bundle.storageUri,
                  fingerprint_hash: bundle.fingerprintHash,
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
