import { loadConfig, p, promoteBundle } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  NodeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertNodeStoragePlugin } from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";

export type PromoteAction = "copy" | "move";

export interface PromoteOptions {
  target: string;
  action?: PromoteAction;
  yes?: boolean;
}

const safeOnUnmount = async (databasePlugin: DatabasePlugin): Promise<void> => {
  try {
    await databasePlugin.onUnmount?.();
  } catch (err) {
    p.log.warn(
      `Database plugin onUnmount failed (cleanup-only, original error preserved): ${
        (err as Error)?.message ?? String(err)
      }`,
    );
  }
};

const summarizePlan = (params: {
  target: string;
  action: PromoteAction;
  bundle: Bundle;
}): string =>
  ui.block(
    `Promote (${params.action})`,
    [
      ui.kv("Bundle", ui.id(params.bundle.id)),
      ui.kv("Platform", ui.platform(params.bundle.platform)),
      ui.kv("From", ui.channel(params.bundle.channel)),
      ui.kv("To", ui.channel(params.target)),
      params.bundle.targetAppVersion
        ? ui.kv("Version", ui.version(params.bundle.targetAppVersion))
        : ui.kv("Version", ui.muted("-")),
      params.bundle.message ? ui.kv("Message", params.bundle.message) : null,
    ].filter((line): line is string => line !== null),
  );

export const handlePromote = async (
  bundleId: string,
  options: PromoteOptions,
) => {
  printBanner();

  const action: PromoteAction = options.action ?? "copy";
  const target = options.target.trim();

  if (!target) {
    p.log.error("--target is required.");
    process.exit(1);
  }

  const config = await loadConfig(null);
  const databasePlugin: DatabasePlugin = await config.database();
  let storagePlugin: NodeStoragePlugin | null = null;
  try {
    storagePlugin = await config.storage();
    assertNodeStoragePlugin(storagePlugin);
  } catch {
    storagePlugin = null;
  }

  try {
    const bundle = await databasePlugin.getBundleById(bundleId);
    if (!bundle) {
      p.log.error(`No bundle with id ${bundleId}.`);
      process.exit(1);
    }
    if (bundle.channel === target) {
      p.log.error(`Bundle ${bundleId} is already on channel "${target}".`);
      process.exit(1);
    }

    p.log.message(summarizePlan({ target, action, bundle }));

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        p.log.error(
          "Cannot prompt for confirmation in a non-interactive shell. Re-run with -y, or use a TTY.",
        );
        process.exit(1);
      }
      const confirmed = await p.confirm({
        message: `${action === "copy" ? "Copy" : "Move"} ${bundle.id} from ${bundle.channel} to ${target}?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    const promoted = await promoteBundle(
      {
        action,
        bundleId: bundle.id,
        targetChannel: target,
      },
      {
        config,
        databasePlugin,
        storagePlugin,
      },
    );

    if (action === "copy") {
      p.log.success(`Copied bundle to ${target}.`);
      p.log.info(`  ${ui.id(promoted.id)} (new bundle id)`);
    } else {
      p.log.success(`Moved bundle to ${target}.`);
      p.log.info(`  ${ui.id(promoted.id)}`);
    }
  } finally {
    await safeOnUnmount(databasePlugin);
  }
};
