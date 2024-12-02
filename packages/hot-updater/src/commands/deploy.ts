import fs from "node:fs/promises";
import { spinner } from "@clack/prompts";

import { createZip } from "@/utils/createZip";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getLatestGitCommitMessage } from "@/utils/getLatestGitCommitMessage";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";

export interface DeployOptions {
  targetVersion?: string;
  platform: Platform;
  forceUpdate: boolean;
}

export const deploy = async (options: DeployOptions) => {
  const s = spinner();

  try {
    const config = await loadConfig();
    if (!config) {
      console.error("No config found. Please run `hot-updater init` first.");
      process.exit(1);
    }
    const cwd = getCwd();

    const message = await getLatestGitCommitMessage();

    const targetVersion =
      options.targetVersion ??
      (await getDefaultTargetVersion(cwd, options.platform));

    if (!targetVersion) {
      throw new Error(
        "Target version not found. Please provide a target version.",
      );
    }

    s.start("Build in progress");

    const { buildPath, bundleId } = await config.build({
      cwd,
      platform: options.platform,
    });
    s.message("Checking existing updates...");

    await createZip(buildPath, "build.zip");

    const bundlePath = buildPath.concat(".zip");

    const hash = await getFileHashFromFile(bundlePath);

    const databasePlugin = config.database({
      cwd,
    });

    s.message("Uploading bundle...");
    const storagePlugin = config.storage({
      cwd,
    });
    const { file } = await storagePlugin.uploadBundle(bundleId, bundlePath);

    await databasePlugin.appendBundle({
      forceUpdate: options.forceUpdate,
      platform: options.platform,
      file,
      hash,
      message: message ?? undefined,
      targetVersion,
      id: bundleId,
      enabled: true,
    });
    await databasePlugin.commitBundle();
    await databasePlugin.onUnmount?.();
    await fs.rm(bundlePath);
    s.stop("Uploading Success !", 0);
  } catch (e) {
    s.stop("Uploading Failed !", -1);
    console.error(e);
    process.exit(-1);
  }
};
