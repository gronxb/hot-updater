import { cwd } from "@/cwd";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { loadConfig } from "@/utils/loadConfig";
import { log } from "@hot-updater/internal";

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

  await build({ cwd: path, ...options, ...config });

  const newBundleVersion = Math.trunc(Date.now() / 1000);

  const { uploadBundle, uploadUpdateJson } = deploy({
    cwd: path,
    ...options,
    ...config,
  });

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
