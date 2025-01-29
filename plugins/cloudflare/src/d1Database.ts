import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import type { BundlesTable } from "./types";
import { D1Database } from "./utils/wrangler";

export interface D1DatabaseConfig {
  name: string;
  cloudflareApiToken: string;
}

export const d1Database =
  (config: D1DatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const db = new D1Database(config);
    let bundles: Bundle[] = [];

    return {
      name: "d1Database",
      async commitBundle() {
        const command = `INSERT INTO bundles (
            id,
            enabled,
            file_url,
            should_force_update,
            file_hash,
            git_commit_hash,
            message,
            platform,
            target_app_version
          ) VALUES (
            %%id%%,
            %%enabled%%,
            %%file_url%%,
            %%should_force_update%%,
            %%file_hash%%,
            %%git_commit_hash%%,
            %%message%%,
            %%platform%%,
            %%target_app_version%%
        ) ON CONFLICT (id) DO UPDATE SET
              enabled = %%enabled%%,
              file_url = %%file_url%%,
              should_force_update = %%should_force_update%%,
              file_hash = %%file_hash%%,
              git_commit_hash = %%git_commit_hash%%,
              message = %%message%%,
              platform = %%platform%%,
              target_app_version = %%target_app_version%%
`;

        for (const bundle of bundles) {
          await db.execute(command, {
            id: `'${bundle.id}'`,
            enabled: bundle.enabled ? String(1) : String(0),
            file_url: `'${bundle.fileUrl}'`,
            should_force_update: bundle.shouldForceUpdate
              ? String(1)
              : String(0),
            file_hash: `'${bundle.fileHash}'`,
            git_commit_hash: bundle.gitCommitHash
              ? `'${bundle.gitCommitHash}'`
              : String(null),
            message: bundle.message ? `'${bundle.message}'` : String(null),
            platform: `'${bundle.platform}'`,
            target_app_version: `'${bundle.targetAppVersion}'`,
          });
        }

        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
      },
      async appendBundle(inputBundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
      },
      async setBundles(inputBundles) {
        bundles = inputBundles;
      },
      async getBundleById(bundleId) {
        const command = "SELECT * FROM bundles WHERE id = '%%bundleId%%'";
        const { results: rows } = await db.execute<
          typeof command,
          BundlesTable
        >(command, {
          bundleId,
        });

        if (!rows?.length) {
          return null;
        }

        const row = rows[0];
        return {
          enabled: Boolean(row.enabled),
          fileUrl: row.file_url,
          shouldForceUpdate: Boolean(row.should_force_update),
          fileHash: row.file_hash,
          gitCommitHash: row.git_commit_hash,
          id: row.id,
          message: row.message,
          platform: row.platform,
          targetAppVersion: row.target_app_version,
        } as Bundle;
      },
      async getBundles(refresh = false) {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const command = "SELECT * FROM bundles ORDER BY id DESC";
        const { results: rows } = await db.execute<
          typeof command,
          BundlesTable
        >(command);

        if (!rows?.length) {
          return [];
        }

        return rows.map((row) => ({
          enabled: Boolean(row.enabled),
          fileUrl: row.file_url,
          shouldForceUpdate: Boolean(row.should_force_update),
          fileHash: row.file_hash,
          gitCommitHash: row.git_commit_hash,
          id: row.id,
          message: row.message,
          platform: row.platform,
          targetAppVersion: row.target_app_version,
        })) as Bundle[];
      },
    };
  };
