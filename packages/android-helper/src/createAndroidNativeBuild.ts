import path from "path";
import { generateMinBundleId, getCwd } from "@hot-updater/plugin-core";
import type { EnrichedNativeBuildAndroidScheme } from "./types";
import { runGradle } from "./utils/gradle";
export const createAndroidNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: EnrichedNativeBuildAndroidScheme;
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
