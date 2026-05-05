import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  Platform,
} from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

export interface RollbackOptions {
  platform?: Platform;
  yes?: boolean;
  confirmRevertToBinary?: boolean;
}

interface RollbackTarget {
  platform: Platform;
  bundle: Bundle;
  fallbackId: string | null;
}

const PLATFORMS: readonly Platform[] = ["ios", "android"];

const summarizeTarget = (target: RollbackTarget): string => {
  const fallback = target.fallbackId
    ? `next: ${target.fallbackId}`
    : "next: (would revert to binary-shipped JS)";
  return `  - ${target.platform}: disable ${target.bundle.id} (${fallback})`;
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
  if (!config) {
    p.log.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

  const platforms = options.platform ? [options.platform] : PLATFORMS;

  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const targets: RollbackTarget[] = [];
    const skippedPlatforms: Platform[] = [];
    const wouldRevertToBinary: Platform[] = [];

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

    if (targets.length === 0) {
      p.log.error(
        `Nothing to roll back: no enabled bundles for ${channel} on ${platforms.join(", ")}.`,
      );
      process.exit(1);
    }

    p.log.info(`Rollback plan for channel "${channel}":`);
    for (const t of targets) {
      console.log(summarizeTarget(t));
    }

    if (wouldRevertToBinary.length > 0 && !options.confirmRevertToBinary) {
      p.log.error(
        `Rollback would leave channel "${channel}" with NO enabled bundles for: ${wouldRevertToBinary.join(", ")}.`,
      );
      p.log.info(
        "Affected platforms would fall back to the binary-shipped JS.",
      );
      p.log.info("Re-run with --confirm-revert-to-binary to proceed.");
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
    // Note: DatabasePlugin.commitBundle runs ops sequentially in the
    // underlying provider, so atomicity across platforms is not guaranteed.
    // The verify phase below catches partial-failure state explicitly.
    for (const t of targets) {
      await databasePlugin.updateBundle(t.bundle.id, { enabled: false });
    }
    await databasePlugin.commitBundle();

    // Verify phase: re-read each target. Surface failures per-platform.
    const failures: RollbackTarget[] = [];
    for (const t of targets) {
      const refetched = await databasePlugin.getBundleById(t.bundle.id);
      if (!refetched || refetched.enabled) {
        failures.push(t);
        p.log.error(
          `FAILED: ${t.platform} ${t.bundle.id} is still enabled after rollback.`,
        );
      } else {
        p.log.success(`rolled back ${t.platform} ${t.bundle.id}`);
      }
    }

    if (failures.length > 0) {
      p.log.error(
        `Rollback completed with ${failures.length} failed platform(s) out of ${targets.length}.`,
      );
      process.exit(1);
    }
  } finally {
    await databasePlugin.onUnmount?.();
  }
};
