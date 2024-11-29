import fs from "node:fs/promises";
import { spinner } from "@clack/prompts";

import { createZip } from "@/utils/createZip";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { getCwd, loadConfig } from "@hot-updater/plugin-core";
import { type Platform, filterTargetVersion } from "@hot-updater/utils";
import { getBranchName, getRecentCommitMessages } from "workspace-tools";

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

    const branch = getBranchName(cwd);
    const message = branch ? getRecentCommitMessages(branch, cwd)[0] : void 0;

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

    const deployPlugin = config.deploy({
      cwd,
    });

    const bundles = await deployPlugin.getBundles();
    const targetVersions = filterTargetVersion(
      bundles ?? [],
      targetVersion,
      options.platform,
    );

    // hash check
    if (targetVersions.length > 0) {
      const recentVersion = targetVersions[0];
      const recentHash = recentVersion?.hash;

      if (recentHash === hash) {
        s.stop("The update already exists.", -1);
        return;
      }
    }

    s.message("Uploading bundle...");
    const { file } = await deployPlugin.uploadBundle(bundleId, bundlePath);

    await deployPlugin.appendBundle({
      forceUpdate: options.forceUpdate,
      platform: options.platform,
      file,
      hash,
      message,
      targetVersion,
      id: bundleId,
      enabled: true,
    });
    await deployPlugin.commitBundle();

    await fs.rm(bundlePath);
    s.stop("Uploading Success !", 0);
  } catch (e) {
    s.stop("Uploading Failed !", -1);
    console.error(e);
    process.exit(-1);
  }
};
