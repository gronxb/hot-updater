import type { NativeBuildArgs, Platform } from "@hot-updater/plugin-core";
import { installAndLaunchAndroid, injectDefaultAndroidNativeBuildSchemeOptions } from "@hot-updater/android-helper";
import { installAndLaunchIOS, injectDefaultIosNativeBuildSchemeOptions } from "@hot-updater/apple-helper";

export async function installAndLaunch({
  config,
  platform,
  scheme,
}: {
  platform: Platform;
  scheme: string;
  config: Required<NativeBuildArgs>;
}) {
  if (platform === "android") {
    const schemeConfig = injectDefaultAndroidNativeBuildSchemeOptions(
      config.android[scheme]!,
    );
    await installAndLaunchAndroid({ schemeConfig });
  } else if (platform === "ios") {
    const schemeConfig = injectDefaultIosNativeBuildSchemeOptions(
      config.ios[scheme]!,
    );
    await installAndLaunchIOS({ schemeConfig });
  }
}
