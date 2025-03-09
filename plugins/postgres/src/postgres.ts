import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { Database } from "./types";

export interface PostgresConfig extends PoolConfig {}

export const postgres =
  (config: PostgresConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const pool = new Pool(config);

    const dialect = new PostgresDialect({
      pool,
    });

    const db = new Kysely<Database>({
      dialect,
    });
    let bundles: Bundle[] = [];

    const changedIds = new Set<string>();
    function markChanged(id: string) {
      changedIds.add(id);
    }

    let isUnmount = false;

    return {
      name: "postgres",
      async onUnmount() {
        if (isUnmount) {
          return;
        }
        isUnmount = true;
        await pool.end();
        changedIds.clear();
      },
      async commitBundle() {
        if (changedIds.size === 0) {
          return;
        }
        const changedBundles = bundles.filter((b) => changedIds.has(b.id));
        if (changedBundles.length === 0) {
          return;
        }
        await db.transaction().execute(async (tx) => {
          for (const bundle of changedBundles) {
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

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
        markChanged(targetBundleId);
      },
      async appendBundle(inputBundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
        markChanged(inputBundle.id);
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
      async getBundles(refresh = false) {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const data = await db
          .selectFrom("bundles")
          .orderBy("id", "desc")
          .selectAll()
          .execute();
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
    };
  };
