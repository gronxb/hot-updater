import fs from "node:fs/promises";
import { spinner } from "@clack/prompts";

import { createZip } from "@/utils/createZip";
import { getDefaultTargetAppVersion } from "@/utils/getDefaultTargetAppVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getGitCommitHash, getLatestGitCommitMessage } from "@/utils/git";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";

export interface DeployOptions {
  targetAppVersion?: string;
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

    const [gitCommitHash, gitMessage] = await Promise.all([
      getGitCommitHash(),
      getLatestGitCommitMessage(),
    ]);

    const targetAppVersion =
      options.targetAppVersion ??
      (await getDefaultTargetAppVersion(cwd, options.platform));

    if (!targetAppVersion) {
      throw new Error(
        "Target app version not found. Please provide a target app version.",
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

    const fileHash = await getFileHashFromFile(bundlePath);

    const databasePlugin = config.database({
      cwd,
    });

    s.message("Uploading bundle...");
    const storagePlugin = config.storage({
      cwd,
    });
    const { fileUrl } = await storagePlugin.uploadBundle(bundleId, bundlePath);

    s.message("Appending bundle to database...");
    await databasePlugin.appendBundle({
      forceUpdate: options.forceUpdate,
      platform: options.platform,
      fileUrl,
      fileHash,
      gitCommitHash,
      message: gitMessage,
      targetAppVersion,
      id: bundleId,
      enabled: true,
    });
    await databasePlugin.commitBundle();
    await databasePlugin.onUnmount?.();
    await fs.rm(bundlePath);
    s.stop("Deploy Success !", 0);
  } catch (e) {
    s.stop("Deploy Failed !", -1);
    console.error(e);
    process.exit(-1);
  }
};
