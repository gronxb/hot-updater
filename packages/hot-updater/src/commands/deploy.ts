import { cwd } from "@/cwd";
import { areBuildHashesIncluded } from "@/utils/areBuildHashesIncluded";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { getFileHashFromFile, getFileHashFromUrl } from "@/utils/getFileHash";
import { loadConfig } from "@/utils/loadConfig";
import { filterTargetVersion, log } from "@hot-updater/internal";

export interface DeployOptions {
  targetVersion?: string;
  platform: "ios" | "android";
  forceUpdate: boolean;
}

export const deploy = async (options: DeployOptions) => {
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

  const { buildPath, outputs } = await build({
    cwd: path,
    ...options,
    ...config,
  });

  const fileHashes = await Promise.all(
    outputs.map(async (output) => {
      return [output.replace(buildPath, ""), await getFileHashFromFile(output)];
    }),
  );
  const buildHashes = Object.fromEntries(fileHashes);

  const newBundleVersion = Math.trunc(Date.now() / 1000);

  const { uploadBundle, getUpdateJson, uploadUpdateJson } = deploy({
    cwd: path,
    ...options,
    ...config,
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
          `/v${recentVersion.bundleVersion}/${options.platform}`,
          "",
        );

        return [pathname, await getFileHashFromUrl(file)];
      }),
    );
    const uploadedHashed = Object.fromEntries(fileHashes);

    const isIncluded = areBuildHashesIncluded(uploadedHashed, buildHashes);
    if (isIncluded) {
      log.error("The update already exists.");
      return;
    }
  }

  const { files } = await uploadBundle(newBundleVersion);

  await uploadUpdateJson({
    ...options,
    files,
    targetVersion,
    bundleVersion: newBundleVersion,
    enabled: true,
  });
  log.success("upload success");
};
