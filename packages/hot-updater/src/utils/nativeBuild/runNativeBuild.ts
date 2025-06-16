import { runAndroidNativeBuild } from "@/utils/nativeBuild/runAndroidNativeBuild";
import type { Platform } from "@hot-updater/core";
import type { NativeBuildArgs, RequiredDeep } from "@hot-updater/plugin-core";

export const runNativeBuild = async ({
  platform,
  config,
}: {
  platform: Platform;
  config: RequiredDeep<NativeBuildArgs>;
}) => {
  switch (platform) {
    case "android":
      await runAndroidNativeBuild({ config: config.android });
      break;
    case "ios":
      throw new Error("Not Implemented");
  }
};
