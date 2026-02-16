import { getCwd } from "@hot-updater/cli-tools";
import { generateMinBundleId } from "@hot-updater/plugin-core";
import path from "path";
import { runGradle } from "./builder/runGradle";
import type { EnrichedNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";

export const buildAndroid = async ({
  schemeConfig,
}: {
  schemeConfig: EnrichedNativeBuildAndroidScheme;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");
  const minBundleId = generateMinBundleId();

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${minBundleId}`] },
    appModuleName: schemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    logPrefix: `android-${schemeConfig.hotUpdaterSchemeName}-build`,
    androidProjectPath,
  });
};
