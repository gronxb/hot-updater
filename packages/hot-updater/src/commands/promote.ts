import { loadConfig, p, promoteBundle } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  NodeStoragePlugin,
} from "@hot-updater/plugin-core";
import {
  assertNodeStoragePlugin,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";

export type PromoteAction = "copy" | "move";

export interface PromoteOptions {
  target: string;
  action?: PromoteAction;
  yes?: boolean;
}

class PromoteExitError extends Error {
  override readonly name = "PromoteExitError";

  constructor(readonly exitCode: number) {
    super(`Promote exited with code ${exitCode}`);
  }
}

const warnCleanupFailure = (owner: string, message: string): void => {
  p.log.warn(
    `${owner} cleanup failed (cleanup-only, earlier outcome preserved): ${message}`,
  );
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

  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  let databasePlugin: DatabasePlugin | null = null;
  let operationError: unknown;
  let operationFailed = false;
  let cleanupError: unknown;
  let cleanupFailed = false;
  let exitCode: number | undefined;
  try {
    config = await loadConfig(null);
    databasePlugin = config.database;
    const databaseClient = createDatabaseClient(databasePlugin);
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        environment[key] = value;
      }
    }
    const context = createNodeStorageContext({ environment });
    let storagePlugin: NodeStoragePlugin | null = null;
    try {
      storagePlugin = await config.storage(context);
      assertNodeStoragePlugin(storagePlugin);
    } catch {
      storagePlugin = null;
    }

    const bundle = await databaseClient.getBundleById(bundleId);
    if (!bundle) {
      p.log.error(`No bundle with id ${bundleId}.`);
      throw new PromoteExitError(1);
    }
    if (bundle.channel === target) {
      p.log.error(`Bundle ${bundleId} is already on channel "${target}".`);
      throw new PromoteExitError(1);
    }

    p.log.message(summarizePlan({ target, action, bundle }));

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        p.log.error(
          "Cannot prompt for confirmation in a non-interactive shell. Re-run with -y, or use a TTY.",
        );
        throw new PromoteExitError(1);
      }
      const confirmed = await p.confirm({
        message: `${action === "copy" ? "Copy" : "Move"} ${bundle.id} from ${bundle.channel} to ${target}?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        throw new PromoteExitError(2);
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
        databaseClient,
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
  } catch (error) {
    if (error instanceof PromoteExitError) {
      exitCode = error.exitCode;
    } else {
      operationError = error;
      operationFailed = true;
    }
  }

  try {
    await config?.disposeStorage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (operationFailed || exitCode !== undefined) {
      warnCleanupFailure("Storage", message);
    } else {
      cleanupError = error;
      cleanupFailed = true;
    }
  }

  try {
    await databasePlugin?.onUnmount?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (operationFailed || exitCode !== undefined || cleanupFailed) {
      warnCleanupFailure("Database", message);
    } else {
      cleanupError = error;
      cleanupFailed = true;
    }
  }

  if (operationFailed) {
    throw operationError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }
};
