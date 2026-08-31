import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  assertStorageOperations,
  type Platform,
} from "@hot-updater/plugin-core";
import { createBundleDiff } from "@hot-updater/server/db";

import { getPlatform } from "@/prompts/getPlatform";
import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";

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
  const storagePlugin = config.storage;
  assertStorageOperations(storagePlugin, ["get", "put", "delete"]);

  try {
    p.note(
      [
        ui.kv("Channel", ui.channel(options.channel)),
        ui.kv("Platform", ui.platform(platform)),
        ui.kv("Base file ID", ui.id(options.baseBundleId)),
        ui.kv("Target file ID", ui.id(options.bundleId)),
      ].join("\n"),
      "Patch",
    );

    await createBundleDiff(
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

    p.outro("Patch ready.");
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    await databasePlugin.dispose?.();
  }
};
