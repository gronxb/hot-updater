import { getCwd } from "@hot-updater/cli-tools";
import {
  generateMinBundleId,
  type NativeBuildAndroidScheme,
} from "@hot-updater/plugin-core";
import path from "path";
import { enrichNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { runGradle } from "./utils/gradle";

export const buildAndroid = async ({
  schemeConfig: _schemeConfig,
}: {
  schemeConfig: NativeBuildAndroidScheme;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");
  const minBundleId = generateMinBundleId();

  const schemeConfig = await enrichNativeBuildAndroidScheme({
    schemeConfig: _schemeConfig,
  });

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${minBundleId}`] },
    appModuleName: schemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    androidProjectPath,
  });
};
