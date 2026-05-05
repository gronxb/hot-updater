import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  Platform,
} from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { PLATFORMS } from "../commandOptions";

export interface RollbackOptions {
  platform?: Platform;
  yes?: boolean;
  confirmRevertToBinary?: boolean;
  target?: string;
}

interface RollbackTarget {
  platform: Platform;
  bundle: Bundle;
  fallbackId: string | null;
}

const summarizeTarget = (target: RollbackTarget): string => {
  const fallback = target.fallbackId
    ? `next-most-recent enabled bundle: ${target.fallbackId}` +
      ` (actual active bundle per app version may differ — depends on` +
      ` targetAppVersion / fingerprint match)`
    : "next: (would revert to binary-shipped JS)";
  return `  - ${target.platform}: disable ${target.bundle.id} (${fallback})`;
};

const formatRetryHint = (channel: string, target: RollbackTarget): string =>
  `Re-run with: hot-updater rollback ${channel} -p ${target.platform} --target ${target.bundle.id}`;

const safeOnUnmount = async (databasePlugin: DatabasePlugin): Promise<void> => {
  try {
    await databasePlugin.onUnmount?.();
  } catch (err) {
    // Cleanup errors must never mask the originating mutation error.
    p.log.warn(
      `Database plugin onUnmount failed (cleanup-only, original error preserved): ${
        (err as Error)?.message ?? String(err)
      }`,
    );
  }
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

  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const targets: RollbackTarget[] = [];
    const skippedPlatforms: Platform[] = [];
    const wouldRevertToBinary: Platform[] = [];

    if (options.target) {
      // Scoped retry path: roll back exactly the named bundle.
      const targetBundle = await databasePlugin.getBundleById(options.target);
      if (!targetBundle) {
        p.log.error(`No bundle with id ${options.target}.`);
        process.exit(1);
      }
      if (targetBundle.channel !== channel) {
        p.log.error(
          `Bundle ${options.target} is on channel "${targetBundle.channel}", not "${channel}".`,
        );
        process.exit(1);
      }
      if (options.platform && targetBundle.platform !== options.platform) {
        p.log.error(
          `Bundle ${options.target} is on platform "${targetBundle.platform}", not "${options.platform}".`,
        );
        process.exit(1);
      }
      if (!targetBundle.enabled) {
        p.log.info(`Bundle ${options.target} is already disabled. No changes.`);
        return;
      }
      const fallbackResult = await databasePlugin.getBundles({
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
      if (!fallback) {
        wouldRevertToBinary.push(targetBundle.platform);
      }
      targets.push({
        platform: targetBundle.platform,
        bundle: targetBundle,
        fallbackId: fallback?.id ?? null,
      });
    } else {
      for (const platform of platforms) {
        const result = await databasePlugin.getBundles({
          where: { channel, platform, enabled: true },
          limit: 2,
        });
        const [target, fallback] = result.data;
        if (!target) {
          p.log.info(`No enabled bundle on ${channel}/${platform}; skipping.`);
          skippedPlatforms.push(platform);
          continue;
        }
        if (!fallback) {
          wouldRevertToBinary.push(platform);
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
      process.exit(1);
    }

    p.log.message(`Rollback plan for channel "${channel}":`);
    for (const t of targets) {
      p.log.message(summarizeTarget(t));
    }

    if (wouldRevertToBinary.length > 0 && !options.confirmRevertToBinary) {
      const safePlatforms = targets
        .map((t) => t.platform)
        .filter((pl) => !wouldRevertToBinary.includes(pl));
      const safePlatformsHint = safePlatforms.length
        ? ` Re-run with -p ${safePlatforms.join("/")} to skip the platforms above,`
        : "";
      p.log.error(
        `Rollback would leave channel "${channel}" with NO enabled bundles for: ${wouldRevertToBinary.join(", ")}.`,
      );
      p.log.info(
        "Affected platforms would fall back to the binary-shipped JS.",
      );
      p.log.info(
        `${safePlatformsHint} or --confirm-revert-to-binary to also revert ${wouldRevertToBinary.join(", ")} to binary-shipped JS.`,
      );
      process.exit(1);
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
        process.exit(1);
      }
      const ids = targets.map((t) => t.bundle.id).join(", ");
      const confirmed = await p.confirm({
        message: `Disable ${ids} on ${channel}?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    // Mutate phase: queue updates, then flush via a single commitBundle.
    // commitBundle is sequential in the underlying provider; if it throws
    // partway, we still run the verify phase below to surface per-platform
    // state rather than hiding it behind the raw error.
    let commitError: unknown = null;
    try {
      for (const t of targets) {
        await databasePlugin.updateBundle(t.bundle.id, { enabled: false });
      }
      await databasePlugin.commitBundle();
    } catch (err) {
      commitError = err;
      p.log.error(
        `commitBundle threw: ${(err as Error)?.message ?? String(err)}`,
      );
      p.log.info("Running verify phase to surface per-platform state...");
    }

    // Verify phase: re-read each target. Distinguish three states —
    // disabled (success), still-enabled (failure), and gone (success: a
    // deleted bundle satisfies the rollback intent).
    const failures: RollbackTarget[] = [];
    for (const t of targets) {
      const refetched = await databasePlugin.getBundleById(t.bundle.id);
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
      process.exit(1);
    }
  } finally {
    await safeOnUnmount(databasePlugin);
  }
};
