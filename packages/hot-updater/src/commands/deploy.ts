import { cwd } from "@/cwd";
import { getDefaultTargetVersion } from "@/utils/getDefaultTargetVersion";
import { loadConfig } from "@/utils/loadConfig";
import { getNextUpdate } from "@hot-updater/internal";

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

  const { readStrategy, uploadBundle, uploadUpdateJson } = deploy({
    cwd: path,
    ...options,
    ...config,
  });

  await uploadBundle();

  const updateSource = await getNextUpdate(readStrategy, {
    ...options,
    targetVersion,
  });
  console.log(updateSource);
  await uploadUpdateJson(updateSource);
};
