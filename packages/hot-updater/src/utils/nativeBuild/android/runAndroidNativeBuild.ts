import {
  type NativeBuildAndroidScheme,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import path from "path";
import { runGradle } from "./utils/gradle";
import { injectDefaultAndroidNativeBuildSchemeOptions } from './utils/injectDefaultAndroidNativeBuildSchemeOptions';
export const runAndroidNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildAndroidScheme;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  const bundleId = generateMinBundleId();

  const mergedConfig =
    injectDefaultAndroidNativeBuildSchemeOptions(schemeConfig);

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
    appModuleName: mergedConfig.appModuleName,
    tasks: mergedConfig.aab
      ? [`bundle${mergedConfig.variant}`]
      : [`assemble${mergedConfig.variant}`],
    androidProjectPath,
  });
};
