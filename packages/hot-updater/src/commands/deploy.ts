import { spinner } from "@clack/prompts";

import { cwd } from "@/cwd";
import { areBuildHashesIncluded } from "@/utils/areBuildHashesIncluded";
import { formatDate } from "@/utils/formatDate";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile, getFileHashFromUrl } from "@/utils/getFileHash";
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

  const path = cwd();
  const targetVersion =
    options.targetVersion ??
    (await getDefaultTargetVersion(path, options.platform));

  if (!targetVersion) {
    throw new Error(
      "Target version not found. Please provide a target version.",
    );
  }

  s.start("Build in progress");

  const { buildPath, outputs } = await build({
    cwd: path,
    ...options,
    ...config,
  });
  s.message("Checking existing updates...");

  const fileHashes = await Promise.all(
    outputs.map(async (output) => {
      return [output.replace(buildPath, ""), await getFileHashFromFile(output)];
    }),
  );
  const buildHashes = Object.fromEntries(fileHashes);
  const newBundleVersion = formatDate(new Date());

  const deployPlugin = deploy({
    cwd: path,
    spinner: s,
  });

  const updateSources = await deployPlugin.getUpdateJson();
  const targetVersions = filterTargetVersion(
    options.platform,
    targetVersion,
    updateSources ?? [],
  );

  // hash check
  // if (targetVersions.length > 0) {
  //   const recentVersion = targetVersions[0];
  //   const fileHashes = await Promise.all(
  //     recentVersion.file.map(async (file) => {
  //       const url = new URL(recentVersion.file);
  //       const pathname = url.pathname.replace(
  //         `/${recentVersion.bundleVersion}/${options.platform}`,
  //         "",
  //       );

  //       return [pathname, await getFileHashFromUrl(file)];
  //     }),
  //   );

  //   const url = new URL(recentVersion.file);
  //   const pathname = url.pathname.replace(
  //     `/${recentVersion.bundleVersion}/${options.platform}`,
  //     "",
  //   );

  //   const filehash = [pathname, await getFileHashFromUrl(recentVersion.file)];

  //   const uploadedHashed = Object.fromEntries(fileHashes);

  //   const isIncluded = areBuildHashesIncluded(uploadedHashed, buildHashes);
  //   if (isIncluded) {
  //     s.stop("The update already exists.", -1);
  //     return;
  //   }
  // }

  s.message("Uploading bundle...");
  const { files } = await deployPlugin.uploadBundle(
    options.platform,
    newBundleVersion,
  );

  await deployPlugin.appendUpdateJson({
    forceUpdate: options.forceUpdate,
    platform: options.platform,
    file: "", // tar.gz file
    hash: "", // hash of tar.gz file
    message: "", // commit message
    targetVersion,
    bundleVersion: newBundleVersion,
    enabled: true,
  });
  await deployPlugin.commitUpdateJson();
  s.stop("Uploading Success !", 0);
};
