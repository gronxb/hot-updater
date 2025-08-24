import path from "path";
import {
  type NativeBuildAndroidScheme,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import { enrichNativeBuildSchemeOptions } from "./utils/enrichNativeBuildSchemeOptions";
import { runGradle } from "./utils/gradle";

export const createAndroidNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildAndroidScheme;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  const bundleId = generateMinBundleId();

  const enrichedSchemeConfig = await enrichNativeBuildSchemeOptions({
    schemeConfig,
    selectDevice: false,
  });

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
    appModuleName: enrichedSchemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    androidProjectPath,
  });
};
