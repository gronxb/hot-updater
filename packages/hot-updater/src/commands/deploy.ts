import fs from "node:fs/promises";
import { spinner } from "@clack/prompts";

import { getCwd } from "@/cwd";
import { createZip } from "@/utils/createZip";
import { formatDate } from "@/utils/formatDate";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile } from "@/utils/getFileHash";
import { loadConfig } from "@/utils/loadConfig";
import { type Platform, filterTargetVersion } from "@hot-updater/internal";
export interface DeployOptions {
  targetVersion?: string;
  platform: Platform;
  forceUpdate: boolean;
}

export const deploy = async (options: DeployOptions) => {
  const s = spinner();

  const { build, deploy, ...config } = await loadConfig();

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

  const { buildPath } = await build({
    cwd,
    spinner: s,
    platform: options.platform,
  });
  s.message("Checking existing updates...");

  await createZip(buildPath, "build.zip");

  const bundlePath = buildPath.concat(".zip");

  const hash = await getFileHashFromFile(bundlePath);

  const newBundleVersion = formatDate(new Date());

  const deployPlugin = deploy({
    cwd,
    spinner: s,
  });

  const updateSources = await deployPlugin.getUpdateJson();
  const targetVersions = filterTargetVersion(
    updateSources ?? [],
    targetVersion,
    options.platform,
  );

  // hash check
  if (targetVersions.length > 0) {
    const recentVersion = targetVersions[0];
    const recentHash = recentVersion.hash;

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

  await deployPlugin.appendUpdateJson({
    forceUpdate: options.forceUpdate,
    platform: options.platform,
    file,
    hash,
    description: "",
    targetVersion,
    bundleVersion: newBundleVersion,
    enabled: true,
  });
  await deployPlugin.commitUpdateJson();

  await fs.rm(bundlePath);
  s.stop("Uploading Success !", 0);
};
