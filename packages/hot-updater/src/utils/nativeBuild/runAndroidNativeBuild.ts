import path from "path";
import {
  type NativeBuildArgs,
  type RequiredDeep,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import { runGradle } from "./gradle";
export const runAndroidNativeBuild = async ({
  config,
}: {
  config: RequiredDeep<NativeBuildArgs["android"]>;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  const bundleId = generateMinBundleId();

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
    appModuleName: config.appModuleName,
    tasks: config.aab
      ? [`bundle${config.variant}`]
      : [`assemble${config.variant}`],
    androidProjectPath: androidProjectPath,
  });
};
