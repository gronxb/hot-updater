import { getCwd } from "@hot-updater/cli-tools";
import {
  generateMinBundleId,
  type NativeBuildArgs,
  type RequiredDeep,
} from "@hot-updater/plugin-core";
import path from "path";
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
