import fs from "node:fs/promises";
import { intro, spinner, text } from "@clack/prompts";

import { createZip } from "@/utils/createZip";
import { formatDate } from "@/utils/formatDate";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { type Platform, filterTargetVersion } from "@hot-updater/utils";
import { getCwd, loadConfig } from "@hot-updater/plugin-core";

export interface DeployOptions {
  targetVersion?: string;
  platform: Platform;
  forceUpdate: boolean;
}

export const deploy = async (options: DeployOptions) => {
  const s = spinner();

  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

  intro("Please provide a description for the bundle.");
  const description = await text({ message: "Description" });

  const cwd = getCwd();
  const targetVersion =
    options.targetVersion ??
    (await getDefaultTargetVersion(cwd, options.platform));

  if (!targetVersion) {
    throw new Error(
      "Target version not found. Please provide a target version.",
    );
  }

  s.start("Build in progress");

  const { buildPath } = await config.build({
    cwd,
    platform: options.platform,
  });
  s.message("Checking existing updates...");

  await createZip(buildPath, "build.zip");

  const bundlePath = buildPath.concat(".zip");

  const hash = await getFileHashFromFile(bundlePath);

  const newBundleVersion = formatDate(new Date());

  const deployPlugin = config.deploy({
    cwd,
  });

  const updateSources = await deployPlugin.getUpdateSources();
  const targetVersions = filterTargetVersion(
    updateSources ?? [],
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
  const { file } = await deployPlugin.uploadBundle(
    options.platform,
    newBundleVersion,
    bundlePath,
  );

  await deployPlugin.appendUpdateSource({
    forceUpdate: options.forceUpdate,
    platform: options.platform,
    file,
    hash,
    description: String(description),
    targetVersion,
    bundleVersion: newBundleVersion,
    enabled: true,
  });
  await deployPlugin.commitUpdateSource();

  await fs.rm(bundlePath);
  s.stop("Uploading Success !", 0);
};
