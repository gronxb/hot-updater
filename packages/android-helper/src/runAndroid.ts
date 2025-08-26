import path from "path";
import {
  type NativeBuildAndroidScheme,
  generateMinBundleId,
  getCwd,
} from "@hot-updater/plugin-core";
import { enrichNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { runGradle } from "./utils/gradle";
import { selectAndroidTargetDevice } from "./utils/selectAndroidTargetDevice";

export const runAndroid = async ({
  schemeConfig: _schemeConfig,
  deviceOption,
  interactive,
}: {
  schemeConfig: NativeBuildAndroidScheme;
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  const bundleId = generateMinBundleId();

  const androidDevice = (
    await selectAndroidTargetDevice({ deviceOption, interactive })
  ).device;

  const schemeConfig = await enrichNativeBuildAndroidScheme({
    schemeConfig: _schemeConfig,
  });

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${bundleId}`] },
    appModuleName: schemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    androidProjectPath,
  });
};
