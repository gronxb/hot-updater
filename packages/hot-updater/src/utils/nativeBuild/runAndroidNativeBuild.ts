import type { NativeBuildArgs, RequiredDeep } from "@hot-updater/plugin-core";

export const runAndroidNativeBuild = async ({
  config,
}: {
  config: RequiredDeep<NativeBuildArgs["android"]>;
}) => {};
