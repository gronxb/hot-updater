import type { NativeBuildArgs, Platform } from "@hot-updater/plugin-core";
import { installAndLaunchAndroid } from "./android/installAndLaunchAndroid";
import { injectDefaultAndroidNativeBuildSchemeOptions } from "./android/utils/injectDefaultAndroidNativeBuildSchemeOptions";
import { installAndLaunchIOS } from "./ios/installAndLaunchIOS";
import { injectDefaultIosNativeBuildSchemeOptions } from "./ios/utils/injectDefaultIosNativeBuildSchemeOptions";

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
