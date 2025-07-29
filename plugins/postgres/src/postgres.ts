import type {
  Bundle,
  DatabasePluginHooks,
  NativeBuild,
  Platform,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./types";

export interface PostgresConfig extends PoolConfig {}

export const postgres = (
  config: PostgresConfig,
  hooks?: DatabasePluginHooks,
) => {
  return createDatabasePlugin(
    "postgres",
    {
      getContext: () => {
        const pool = new Pool(config);

        const dialect = new PostgresDialect({
          pool,
        });

        const db = new Kysely<Database>({
          dialect,
        });
        return {
          db,
          pool,
        };
      },
      async onUnmount(context) {
        await context.db.destroy();
        await context.pool.end();
      },
      async getBundleById(context, bundleId) {
        const data = await context.db
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

      async getBundles(context, options) {
        const { where, limit, offset } = options ?? {};

        let countQuery = context.db.selectFrom("bundles");
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

        const countResult = await countQuery
          .select(context.db.fn.count<number>("id").as("total"))
          .executeTakeFirst();
        const total = countResult?.total || 0;

        let query = context.db.selectFrom("bundles").orderBy("id", "desc");
        if (where?.channel) {
          query = query.where("channel", "=", where.channel);
        }

        if (where?.platform) {
          query = query.where("platform", "=", where.platform as Platform);
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

      async getChannels(context) {
        const data = await context.db
          .selectFrom("bundles")
          .select("channel")
          .groupBy("channel")
          .execute();
        return data.map((bundle) => bundle.channel);
      },

      async commitBundle(context, { changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        await context.db.transaction().execute(async (tx) => {
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

        // Trigger hooks after all operations
        hooks?.onDatabaseUpdated?.();
      },

      // Native build operations
      async getNativeBuildById(
        context: { db: Kysely<Database>; pool: Pool },
        nativeBuildId: string,
      ) {
        const data = await context.db
          .selectFrom("native_builds")
          .selectAll()
          .where("id", "=", nativeBuildId)
          .executeTakeFirst();

        if (!data) {
          return null;
        }

        return {
          id: data.id,
          nativeVersion: data.native_version,
          platform: data.platform,
          fingerprintHash: data.fingerprint_hash,
          storageUri: data.storage_uri,
          fileHash: data.file_hash,
          fileSize: data.file_size,
          channel: data.channel,
          metadata: data.metadata || {},
        } as NativeBuild;
      },

      async getNativeBuilds(
        context: { db: Kysely<Database>; pool: Pool },
        options: {
          where?: {
            channel?: string;
            platform?: string;
            nativeVersion?: string;
          };
          limit: number;
          offset: number;
        },
      ) {
        const { where, limit, offset } = options ?? {};

        let countQuery = context.db.selectFrom("native_builds");
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
        if (where?.nativeVersion) {
          countQuery = countQuery.where(
            "native_version",
            "=",
            where.nativeVersion,
          );
        }

        const countResult = await countQuery
          .select(context.db.fn.count("id").as("total"))
          .executeTakeFirst();
        const total = Number(countResult?.total) || 0;

        let query = context.db
          .selectFrom("native_builds")
          .orderBy("id", "desc");
        if (where?.channel) {
          query = query.where("channel", "=", where.channel);
        }
        if (where?.platform) {
          query = query.where("platform", "=", where.platform as Platform);
        }
        if (where?.nativeVersion) {
          query = query.where("native_version", "=", where.nativeVersion);
        }

        if (limit) {
          query = query.limit(limit);
        }
        if (offset) {
          query = query.offset(offset);
        }

        const data = await query.selectAll().execute();

        const nativeBuilds = data.map((build: any) => ({
          id: build.id,
          nativeVersion: build.native_version,
          platform: build.platform,
          fingerprintHash: build.fingerprint_hash,
          storageUri: build.storage_uri,
          fileHash: build.file_hash,
          fileSize: build.file_size,
          channel: build.channel,
          metadata: build.metadata || {},
        })) as NativeBuild[];

        const pagination = calculatePagination(total, { limit, offset });

        return {
          data: nativeBuilds,
          pagination,
        };
      },

      async updateNativeBuild(
        context: { db: Kysely<Database>; pool: Pool },
        targetNativeBuildId: string,
        newNativeBuild: Partial<NativeBuild>,
      ) {
        const updateData: any = {};
        if (newNativeBuild.nativeVersion !== undefined)
          updateData.native_version = newNativeBuild.nativeVersion;
        if (newNativeBuild.platform !== undefined)
          updateData.platform = newNativeBuild.platform;
        if (newNativeBuild.fingerprintHash !== undefined)
          updateData.fingerprint_hash = newNativeBuild.fingerprintHash;
        if (newNativeBuild.storageUri !== undefined)
          updateData.storage_uri = newNativeBuild.storageUri;
        if (newNativeBuild.fileHash !== undefined)
          updateData.file_hash = newNativeBuild.fileHash;
        if (newNativeBuild.fileSize !== undefined)
          updateData.file_size = newNativeBuild.fileSize;
        if (newNativeBuild.channel !== undefined)
          updateData.channel = newNativeBuild.channel;
        if (newNativeBuild.metadata !== undefined)
          updateData.metadata = newNativeBuild.metadata;

        await context.db
          .updateTable("native_builds")
          .set(updateData)
          .where("id", "=", targetNativeBuildId)
          .execute();
      },

      async appendNativeBuild(
        context: { db: Kysely<Database>; pool: Pool },
        insertNativeBuild: NativeBuild,
      ) {
        await context.db
          .insertInto("native_builds")
          .values({
            id: insertNativeBuild.id,
            native_version: insertNativeBuild.nativeVersion,
            platform: insertNativeBuild.platform,
            fingerprint_hash: insertNativeBuild.fingerprintHash,
            storage_uri: insertNativeBuild.storageUri,
            file_hash: insertNativeBuild.fileHash,
            file_size: insertNativeBuild.fileSize,
            channel: insertNativeBuild.channel,
            metadata: insertNativeBuild.metadata,
          })
          .execute();
      },

      async deleteNativeBuild(
        context: { db: Kysely<Database>; pool: Pool },
        deleteNativeBuild: NativeBuild,
      ) {
        await context.db
          .deleteFrom("native_builds")
          .where("id", "=", deleteNativeBuild.id)
          .execute();
      },
    },
    hooks,
  );
};
