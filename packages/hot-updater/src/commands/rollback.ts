import { disposeLoadedDatabase, loadConfig, p } from "@hot-updater/cli-tools";
import type { Bundle, Platform } from "@hot-updater/plugin-core";
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";
import {
  listDatabaseRuntimeBundles,
  readDatabaseRuntimeBundle,
  stageDatabaseRuntimeBundleUpdate,
} from "@hot-updater/server/db";

import { printBanner } from "@/utils/printBanner";

import { PLATFORMS } from "../commandOptions";
import { ui } from "../utils/cli-ui";

export interface RollbackOptions {
  platform?: Platform;
  yes?: boolean;
  target?: string;
}

interface RollbackTarget {
  platform: Platform;
  bundle: Bundle;
  fallbackId: string | null;
}

const summarizeTarget = (target: RollbackTarget): string =>
  ui.block(`${target.platform}`, [
    ui.kv("Disable", ui.id(target.bundle.id)),
    target.fallbackId
      ? ui.kv("Fallback", ui.id(target.fallbackId))
      : ui.kv("Fallback", ui.warning("binary-shipped JS")),
  ]);

const formatRetryHint = (channel: string, target: RollbackTarget): string =>
  `Re-run with: hot-updater rollback ${channel} -p ${target.platform} --target ${target.bundle.id}`;

const safeCloseDatabase = async (
  databasePlugin: DatabasePluginRuntime,
): Promise<void> => {
  try {
    await disposeLoadedDatabase(databasePlugin);
  } catch (err) {
    p.log.warn(
      `Database plugin close failed (cleanup-only, original error preserved): ${
        (err as Error)?.message ?? String(err)
      }`,
    );
  }
};

const exitAfterDatabaseClose = async (
  databasePlugin: DatabasePluginRuntime,
  code: number,
): Promise<never> => {
  await safeCloseDatabase(databasePlugin);
  process.exit(code);
};

export const handleRollback = async (
  channel: string,
  options: RollbackOptions = {},
) => {
  printBanner();

  if (!channel) {
    p.log.error("rollback requires a channel argument: `rollback <channel>`");
    process.exit(1);
  }

  const config = await loadConfig(null);

  const platforms = options.platform ? [options.platform] : PLATFORMS;

  const databasePlugin = await config.database();
  try {
    const targets: RollbackTarget[] = [];
    const skippedPlatforms: Platform[] = [];

    if (options.target) {
      // Scoped retry path: roll back exactly the named bundle.
      const targetBundle = await readDatabaseRuntimeBundle(
        databasePlugin,
        options.target,
      );
      if (!targetBundle) {
        p.log.error(`No bundle with id ${options.target}.`);
        return await exitAfterDatabaseClose(databasePlugin, 1);
      }
      if (targetBundle.channel !== channel) {
        p.log.error(
          `Bundle ${options.target} is on channel "${targetBundle.channel}", not "${channel}".`,
        );
        return await exitAfterDatabaseClose(databasePlugin, 1);
      }
      if (options.platform && targetBundle.platform !== options.platform) {
        p.log.error(
          `Bundle ${options.target} is on platform "${targetBundle.platform}", not "${options.platform}".`,
        );
        return await exitAfterDatabaseClose(databasePlugin, 1);
      }
      if (!targetBundle.enabled) {
        p.log.info(`Bundle ${options.target} is already disabled. No changes.`);
        return;
      }
      const fallbackResult = await listDatabaseRuntimeBundles(databasePlugin, {
        where: {
          channel,
          platform: targetBundle.platform,
          enabled: true,
        },
        limit: 2,
      });
      const fallback = fallbackResult.data.find(
        (b) => b.id !== targetBundle.id,
      );
      targets.push({
        platform: targetBundle.platform,
        bundle: targetBundle,
        fallbackId: fallback?.id ?? null,
      });
    } else {
      for (const platform of platforms) {
        const result = await listDatabaseRuntimeBundles(databasePlugin, {
          where: { channel, platform, enabled: true },
          limit: 2,
        });
        const [target, fallback] = result.data;
        if (!target) {
          p.log.info(`No enabled bundle on ${channel}/${platform}; skipping.`);
          skippedPlatforms.push(platform);
          continue;
        }
        targets.push({
          platform,
          bundle: target,
          fallbackId: fallback?.id ?? null,
        });
      }
    }

    if (targets.length === 0) {
      p.log.error(
        `Nothing to roll back: no enabled bundles for ${channel} on ${platforms.join(", ")}.`,
      );
      return await exitAfterDatabaseClose(databasePlugin, 1);
    }

    p.log.message(ui.title(`Rollback ${channel}`));
    for (const t of targets) {
      p.log.message(summarizeTarget(t));
    }

    if (skippedPlatforms.length > 0 && !options.yes) {
      p.log.warn(
        `Some requested platforms had no enabled bundle on ${channel}; only the platforms above will be touched.`,
      );
    }

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        p.log.error(
          "Cannot prompt for confirmation in a non-interactive shell. Re-run with -y, or use a TTY.",
        );
        return await exitAfterDatabaseClose(databasePlugin, 1);
      }
      const confirmed = await p.confirm({
        message: `Apply this rollback plan to ${channel}?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        return await exitAfterDatabaseClose(databasePlugin, 2);
      }
    }

    let commitError: unknown = null;
    try {
      for (const t of targets) {
        await stageDatabaseRuntimeBundleUpdate(databasePlugin, {
          bundleId: t.bundle.id,
          patch: { enabled: false },
        });
      }
      await databasePlugin.commit();
    } catch (err) {
      commitError = err;
      p.log.error(`commit threw: ${(err as Error)?.message ?? String(err)}`);
      p.log.info("Running verify phase to surface per-platform state...");
    }

    // Verify phase: re-read each target. Distinguish three states —
    // disabled (success), still-enabled (failure), and gone (success: a
    // deleted bundle satisfies the rollback intent).
    const failures: RollbackTarget[] = [];
    for (const t of targets) {
      const refetched = await readDatabaseRuntimeBundle(
        databasePlugin,
        t.bundle.id,
      );
      if (!refetched) {
        p.log.warn(
          `${t.platform} ${t.bundle.id} was deleted between commit and verify; treating as rolled back.`,
        );
      } else if (refetched.enabled) {
        failures.push(t);
        p.log.error(
          `FAILED: ${t.platform} ${t.bundle.id} is still enabled after rollback. ${formatRetryHint(channel, t)}`,
        );
      } else {
        p.log.success(`rolled back ${t.platform} ${t.bundle.id}`);
      }
    }

    if (commitError || failures.length > 0) {
      p.log.error(
        `Rollback completed with ${failures.length} failed platform(s) out of ${targets.length}.`,
      );
      return await exitAfterDatabaseClose(databasePlugin, 1);
    }
  } finally {
    await safeCloseDatabase(databasePlugin);
  }
};
