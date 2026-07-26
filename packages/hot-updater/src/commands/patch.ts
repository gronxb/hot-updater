import { loadConfig, p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { createBundleDiff } from "@hot-updater/server/db";

import { getPlatform } from "@/prompts/getPlatform";
import { printBanner } from "@/utils/printBanner";

export interface PatchOptions {
  baseBundleId: string;
  bundleId: string;
  channel: string;
  interactive: boolean;
  platform?: Platform;
}

export const createPatch = async (options: PatchOptions) => {
  printBanner();

  const platform =
    options.platform ??
    (options.interactive
      ? await getPlatform("Which platform does this patch target?")
      : null);

  if (p.isCancel(platform)) {
    return;
  }

  if (!platform) {
    p.log.error(
      "Platform not found. -p <ios | android> or --platform <ios | android>",
    );
    return;
  }

  const config = await loadConfig({ channel: options.channel, platform });
  const databasePlugin = config.database;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  const storageContext = createNodeStorageContext({ environment });
  let outcome:
    | { readonly kind: "success" }
    | { readonly kind: "exit"; readonly code: number }
    | { readonly kind: "error"; readonly error: unknown } = {
    kind: "success",
  };
  let storageInitialized = false;

  try {
    const storagePlugin = await config.storage(storageContext);
    storageInitialized = true;

    p.note(
      [
        `Channel: ${options.channel}`,
        `Platform: ${platform === "ios" ? "iOS" : "Android"}`,
        `Base bundle: ${options.baseBundleId}`,
        `Target bundle: ${options.bundleId}`,
      ].join("\n"),
      "Patch",
    );

    const updatedBundle = await createBundleDiff(
      {
        baseBundleId: options.baseBundleId,
        bundleId: options.bundleId,
      },
      {
        databasePlugin,
        storagePlugin,
      },
      {
        makePrimary: true,
      },
    );

    p.outro(`⚡ Patch Ready (${updatedBundle.id})`);
  } catch (error) {
    if (storageInitialized) {
      console.error(error);
      outcome = { code: 1, kind: "exit" };
    } else {
      outcome = { error, kind: "error" };
      throw error;
    }
  } finally {
    let hasCleanupError = false;
    let firstCleanupError: unknown;
    const recordCleanupError = (
      error: unknown,
      owner: string,
      message: string,
    ): void => {
      if (outcome.kind === "success" && !hasCleanupError) {
        hasCleanupError = true;
        firstCleanupError = error;
        return;
      }
      p.log.warn(`${owner} cleanup failed: ${message}`);
    };

    try {
      await config.disposeStorage();
    } catch (error) {
      recordCleanupError(
        error,
        "Storage",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      try {
        await databasePlugin.onUnmount?.();
      } catch (error) {
        recordCleanupError(
          error,
          "Database",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (outcome.kind === "success" && hasCleanupError) {
      outcome = { error: firstCleanupError, kind: "error" };
    }
  }

  switch (outcome.kind) {
    case "success":
      return;
    case "exit":
      process.exitCode = outcome.code;
      return;
    case "error":
      throw outcome.error;
  }
};
