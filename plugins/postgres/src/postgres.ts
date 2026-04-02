import type { Bundle, Platform } from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./types";

export interface PostgresConfig extends PoolConfig {}

export const postgres = createDatabasePlugin<PostgresConfig>({
  name: "postgres",
  factory: (config) => {
    const pool = new Pool(config);
    const dialect = new PostgresDialect({ pool });
    const db = new Kysely<Database>({ dialect });

    return {
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
        const { where, limit, offset, orderBy } = options ?? {};

        let countQuery = db.selectFrom("bundles");
        if (where?.channel) {
          countQuery = countQuery.where("channel", "=", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.where(
            "platform",
            "=",
            where.platform as Platform,
          );
        }
        if (where?.enabled !== undefined) {
          countQuery = countQuery.where("enabled", "=", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          countQuery =
            where.fingerprintHash === null
              ? countQuery.where("fingerprint_hash", "is", null)
              : countQuery.where(
                  "fingerprint_hash",
                  "=",
                  where.fingerprintHash,
                );
        }
        if (where?.targetAppVersion !== undefined) {
          countQuery =
            where.targetAppVersion === null
              ? countQuery.where("target_app_version", "is", null)
              : countQuery.where(
                  "target_app_version",
                  "=",
                  where.targetAppVersion,
                );
        }
        if (where?.targetAppVersionIn) {
          countQuery = countQuery.where(
            "target_app_version",
            "in",
            where.targetAppVersionIn,
          );
        }
        if (where?.targetAppVersionNotNull) {
          countQuery = countQuery.where("target_app_version", "is not", null);
        }
        if (where?.id?.eq) {
          countQuery = countQuery.where("id", "=", where.id.eq);
        }
        if (where?.id?.gt) {
          countQuery = countQuery.where("id", ">", where.id.gt);
        }
        if (where?.id?.gte) {
          countQuery = countQuery.where("id", ">=", where.id.gte);
        }
        if (where?.id?.lt) {
          countQuery = countQuery.where("id", "<", where.id.lt);
        }
        if (where?.id?.lte) {
          countQuery = countQuery.where("id", "<=", where.id.lte);
        }
        if (where?.id?.in) {
          countQuery = countQuery.where("id", "in", where.id.in);
        }

        const countResult = await countQuery
          .select(db.fn.count<number>("id").as("total"))
          .executeTakeFirst();
        const total = countResult?.total || 0;

        let query = db
          .selectFrom("bundles")
          .orderBy("id", orderBy?.direction === "asc" ? "asc" : "desc");
        if (where?.channel) {
          query = query.where("channel", "=", where.channel);
        }

        if (where?.platform) {
          query = query.where("platform", "=", where.platform as Platform);
        }
        if (where?.enabled !== undefined) {
          query = query.where("enabled", "=", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          query =
            where.fingerprintHash === null
              ? query.where("fingerprint_hash", "is", null)
              : query.where("fingerprint_hash", "=", where.fingerprintHash);
        }
        if (where?.targetAppVersion !== undefined) {
          query =
            where.targetAppVersion === null
              ? query.where("target_app_version", "is", null)
              : query.where("target_app_version", "=", where.targetAppVersion);
        }
        if (where?.targetAppVersionIn) {
          query = query.where(
            "target_app_version",
            "in",
            where.targetAppVersionIn,
          );
        }
        if (where?.targetAppVersionNotNull) {
          query = query.where("target_app_version", "is not", null);
        }
        if (where?.id?.eq) {
          query = query.where("id", "=", where.id.eq);
        }
        if (where?.id?.gt) {
          query = query.where("id", ">", where.id.gt);
        }
        if (where?.id?.gte) {
          query = query.where("id", ">=", where.id.gte);
        }
        if (where?.id?.lt) {
          query = query.where("id", "<", where.id.lt);
        }
        if (where?.id?.lte) {
          query = query.where("id", "<=", where.id.lte);
        }
        if (where?.id?.in) {
          query = query.where("id", "in", where.id.in);
        }

        if (limit) {
          query = query.limit(limit);
        }

        if (offset) {
          query = query.offset(offset);
        }

        const data = await query.selectAll().execute();

        const bundles = data.map((bundle) => ({
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

        const pagination = calculatePagination(total, { limit, offset });

        return {
          data: bundles,
          pagination,
        };
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

        await db.transaction().execute(async (tx) => {
          // Process each operation sequentially
          for (const op of changedSets) {
            if (op.operation === "delete") {
              // Handle delete operation
              const result = await tx
                .deleteFrom("bundles")
                .where("id", "=", op.data.id)
                .executeTakeFirst();

              // Verify deletion was successful
              if (result.numDeletedRows === 0n) {
                throw new Error(`Bundle with id ${op.data.id} not found`);
              }
            } else if (op.operation === "insert" || op.operation === "update") {
              // Handle insert and update operations
              const bundle = op.data;
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
          }
        });
      },
    };
  },
});
