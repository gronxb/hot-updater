import type { Platform } from "@hot-updater/core";
import type { NativeBuildArgs } from "@hot-updater/plugin-core";
import { runAndroidNativeBuild as createAndroidNativeBuild } from "./android/runAndroidNativeBuild";
import { runIosNativeBuild as createIosNativeBuild } from "./ios/runIosNativeBuild";

export const createNativeBuild = async ({
  platform,
  config,
  scheme,
}: {
  platform: Platform;
  config: Required<NativeBuildArgs>;
  scheme: string;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  switch (platform) {
    case "android":
      return createAndroidNativeBuild({
        schemeConfig: config.android[scheme]!,
      });
    case "ios":
      return createIosNativeBuild({ schemeConfig: config.ios[scheme]! });
  }
};
