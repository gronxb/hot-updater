// import { installAndLaunchApp } from "@/utils/native/runOnDevice";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import type { NativeBuildOptions } from "./buildNative";

export interface NativeRunOptions extends NativeBuildOptions {}

export const nativeRun = async (options: NativeRunOptions) => {
  const buildResult = await prepareNativeBuild(options);
  console.log(buildResult);
  // if (buildResult) {
  //   const { outputPath, platform, config } = buildResult;
  //   await installAndLaunchApp(platform, outputPath, config);
  // }
};
