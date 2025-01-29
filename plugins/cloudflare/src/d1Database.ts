import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";
import { CloudflareD1 } from "./context/CloudflareD1";
import type { BundlesTable } from "./types";

export interface D1DatabaseConfig {
  name: string;
  cloudflareApiToken: string;
}

export const d1Database =
  (config: D1DatabaseConfig, hooks?: DatabasePluginHooks) =>
  (plugin: BasePluginArgs): DatabasePlugin => {
    const db = new CloudflareD1({ ...config, cwd: plugin.cwd });
    let bundles: Bundle[] = [];

    const changedIds = new Set<string>();
    function markChanged(id: string) {
      changedIds.add(id);
    }

    return {
      name: "d1Database",
      async commitBundle() {
        if (changedIds.size === 0) {
          return;
        }

        const changedBundles = bundles.filter((b) => changedIds.has(b.id));
        if (changedBundles.length === 0) {
          return;
        }

        const valuesSql = changedBundles
          .map(
            (b) => `(
            '${b.id}',
            ${b.enabled ? 1 : 0},
            '${b.fileUrl}',
            ${b.shouldForceUpdate ? 1 : 0},
            '${b.fileHash}',
            ${b.gitCommitHash ? `'${b.gitCommitHash}'` : "NULL"},
            ${b.message ? `'${b.message}'` : "NULL"},
            '${b.platform}',
            '${b.targetAppVersion}'
          )`,
          )
          .join(",\n");

        const command = `
          INSERT OR REPLACE INTO bundles (
            id,
            enabled,
            file_url,
            should_force_update,
            file_hash,
            git_commit_hash,
            message,
            platform,
            target_app_version
          )
          VALUES
          ${valuesSql};`;

        await db.execute(command);

        changedIds.clear();

        hooks?.onDatabaseUpdated?.();
      },

      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const index = bundles.findIndex((b) => b.id === targetBundleId);
        if (index === -1) {
          throw new Error(`Cannot find bundle with id ${targetBundleId}`);
        }
        Object.assign(bundles[index], newBundle);
        markChanged(targetBundleId);
      },

      async appendBundle(inputBundle: Bundle) {
        bundles.unshift(inputBundle);

        markChanged(inputBundle.id);
      },

      async setBundles(inputBundles: Bundle[]) {
        bundles = inputBundles;
        for (const b of inputBundles) {
          markChanged(b.id);
        }
      },

      async getBundleById(bundleId: string) {
        const found = bundles.find((b) => b.id === bundleId);
        if (found) {
          return found;
        }

        const command =
          "SELECT * FROM bundles WHERE id = '%%bundleId%%' LIMIT 1";
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

        const command = `
          SELECT
            id,
            enabled,
            file_url,
            should_force_update,
            file_hash,
            git_commit_hash,
            message,
            platform,
            target_app_version
          FROM bundles
          ORDER BY id DESC
        `;
        const { results: rows } = await db.execute<
          typeof command,
          BundlesTable
        >(command);

        if (!rows?.length) {
          bundles = [];
        } else {
          bundles = rows.map((row) => ({
            id: row.id,
            enabled: Boolean(row.enabled),
            fileUrl: row.file_url,
            shouldForceUpdate: Boolean(row.should_force_update),
            fileHash: row.file_hash,
            gitCommitHash: row.git_commit_hash,
            message: row.message,
            platform: row.platform,
            targetAppVersion: row.target_app_version,
          }));
        }
        return bundles;
      },
    };
  };
