import { runAndroidNativeBuild } from "@/utils/nativeBuild/android/runAndroidNativeBuild";
import type { Platform } from "@hot-updater/core";
import type { NativeBuildArgs } from "@hot-updater/plugin-core";
import { runIosNativeBuild } from "./ios/runIosNativeBuild";

export const runNativeBuild = async ({
  platform,
  config,
  scheme,
}: {
  platform: Platform;
  config: Required<NativeBuildArgs>;
  scheme: string;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  switch (platform) {
    case "android":
      return runAndroidNativeBuild({ schemeConfig: config.android[scheme]! });
    case "ios":
      return runIosNativeBuild({ schemeConfig: config.ios[scheme]! });
  }
};
