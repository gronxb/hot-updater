import { runAndroidNativeBuild } from "@/utils/nativeBuild/runAndroidNativeBuild";
import type { Platform } from "@hot-updater/core";
import type { NativeBuildArgs, RequiredDeep } from "@hot-updater/plugin-core";
import { runIosNativeBuild } from "./runIosNativeBuild";

export const runNativeBuild = async ({
  platform,
  config,
}: {
  platform: Platform;
  config: RequiredDeep<NativeBuildArgs>;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  switch (platform) {
    case "android":
      return runAndroidNativeBuild({ config: config.android });
    case "ios":
      return runIosNativeBuild({ config: config.ios });
  }
};
