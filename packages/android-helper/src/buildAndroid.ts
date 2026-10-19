import path from "path";

import { type CredentialResolver, getCwd } from "@hot-updater/cli-tools";

import { runGradle } from "./builder/runGradle";
import type { EnrichedNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { resolveGradleSigningEnv } from "./utils/gradleSigning";

export const buildAndroid = async ({
  schemeConfig,
  minBundleId,
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildAndroidScheme;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId: string;
  credentials: Pick<CredentialResolver, "resolve">;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  return runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${minBundleId}`] },
    env: await resolveGradleSigningEnv({ schemeConfig, credentials }),
    appModuleName: schemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    logPrefix: `android-${schemeConfig.hotUpdaterSchemeName}-build`,
    androidProjectPath,
  });
};
