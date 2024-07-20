import { spinner } from "@clack/prompts";

import { cwd } from "@/cwd";
import { areBuildHashesIncluded } from "@/utils/areBuildHashesIncluded";
import { formatDate } from "@/utils/formatDate";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile, getFileHashFromUrl } from "@/utils/getFileHash";
import { loadConfig } from "@/utils/loadConfig";
import { filterTargetVersion } from "@hot-updater/internal";

export interface DeployOptions {
  targetVersion?: string;
  platform: "ios" | "android";
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

  const { uploadBundle, getUpdateJson, uploadUpdateJson } = deploy({
    cwd: path,
    ...options,
    spinner: s,
  });

  const updateJson = await getUpdateJson();
  const targetVersions = filterTargetVersion(
    options.platform,
    targetVersion,
    updateJson ?? [],
  );

  if (targetVersions.length > 0) {
    const recentVersion = targetVersions[0];
    const fileHashes = await Promise.all(
      recentVersion.files.map(async (file) => {
        const url = new URL(file);
        const pathname = url.pathname.replace(
          `/${recentVersion.bundleVersion}/${options.platform}`,
          "",
        );

        return [pathname, await getFileHashFromUrl(file)];
      }),
    );
    const uploadedHashed = Object.fromEntries(fileHashes);

    const isIncluded = areBuildHashesIncluded(uploadedHashed, buildHashes);
    if (isIncluded) {
      s.stop("The update already exists.", -1);
      return;
    }
  }

  s.message("Uploading bundle...");
  const { files } = await uploadBundle(newBundleVersion);

  await uploadUpdateJson({
    ...options,
    files,
    targetVersion,
    bundleVersion: newBundleVersion,
    enabled: true,
  });
  s.stop("Uploading Success !", 0);
};
