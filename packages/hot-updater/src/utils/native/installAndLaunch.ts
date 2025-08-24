import type { NativeBuildArgs, Platform } from "@hot-updater/plugin-core";

export async function installAndLaunch({
  // config,
  platform,
  // scheme,
  // buildArtifactPath,
}: {
  platform: Platform;
  scheme: string;
  config: Required<NativeBuildArgs>;
  buildArtifactPath: string;
}) {
  if (platform === "android") {
    // await installAndLaunchAndroid({
    //   schemeConfig: config.android[scheme]!,
    //   buildArtifactPath,
    // });
  } else if (platform === "ios") {
    // await installAndLaunchIOS({ schemeConfig: config.ios[scheme]! });
  }
}
