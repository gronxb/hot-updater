import { runAndroidNativeBuild } from "@/utils/nativeBuild/runAndroidNativeBuild";
import * as p from "@clack/prompts";
import type { Platform } from "@hot-updater/core";
import type { NativeBuildArgs } from "@hot-updater/plugin-core";

export const runNativeBuild = async ({
  platform,
  config,
}: {
  platform: Platform;
  config: NativeBuildArgs;
}) => {
  switch (platform) {
    case "android":
      await runAndroidNativeBuild({ config });
      break;
    case "ios":
      throw new Error("Not Implemented");
  }
  p.log.success("Your native build will be done (WIP)");
};
