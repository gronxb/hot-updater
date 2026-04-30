import { loadConfig, p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";
import { createBundleDiff } from "@hot-updater/server";

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
  const [databasePlugin, storagePlugin] = await Promise.all([
    config.database(),
    config.storage(),
  ]);

  try {
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
    console.error(error);
    process.exit(1);
  } finally {
    await databasePlugin.onUnmount?.();
  }
};
