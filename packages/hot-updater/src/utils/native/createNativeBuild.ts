import type { Platform } from "@hot-updater/core";
import type { NativeBuildArgs } from "@hot-updater/plugin-core";
import { createAndroidNativeBuild } from "./android/createAndroidNativeBuild";
import { createIosNativeBuild } from "./ios/createIosNativeBuild";

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
