import path from "path";
import {
  type NativeBuildAndroidScheme,
  type RequiredDeep,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import { runGradle } from "./gradle";
export const createAndroidNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: RequiredDeep<NativeBuildAndroidScheme>;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  const bundleId = generateMinBundleId();

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
    appModuleName: schemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    androidProjectPath,
  });
};
