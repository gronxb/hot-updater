import {
  injectDefaultAndroidNativeBuildSchemeOptions,
  installAndLaunchAndroid,
} from "@hot-updater/android-helper";
import { installAndLaunchIOS } from "@hot-updater/apple-helper";
import type { NativeBuildArgs, Platform } from "@hot-updater/plugin-core";

export async function installAndLaunch({
  config,
  platform,
  scheme,
  buildArtifactPath,
}: {
  platform: Platform;
  scheme: string;
  config: Required<NativeBuildArgs>;
  buildArtifactPath: string;
}) {
  if (platform === "android") {
    const schemeConfig = injectDefaultAndroidNativeBuildSchemeOptions(
      config.android[scheme]!,
    );
    await installAndLaunchAndroid({ schemeConfig, buildArtifactPath });
  } else if (platform === "ios") {
    await installAndLaunchIOS({ schemeConfig: config.ios[scheme]! });
  }
}
