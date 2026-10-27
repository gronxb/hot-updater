import path from "path";

import {
  type CredentialResolver,
  createMinBundleId,
  getCwd,
} from "@hot-updater/cli-tools";

import { runGradle } from "./builder/runGradle";
import type { EnrichedNativeBuildAndroidScheme } from "./utils/enrichNativeBuildAndroidScheme";
import { resolveGradleSigningEnv } from "./utils/gradleSigning";
import { readBuiltApp } from "./utils/readBuiltApp";

export const buildAndroid = async ({
  schemeConfig,
  minBundleId = createMinBundleId("android"),
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildAndroidScheme;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId?: string;
  /** Resolves the scheme's `signing` keystore, when it signs with one. */
  credentials?: Pick<CredentialResolver, "resolve">;
}): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
  /** What the built artifact reports, or undefined without aapt2. */
  builtApp?: {
    appVersion: string | null;
    /** undefined when the artifact's channel cannot be read exactly. */
    channel?: string | null;
    /** The manifest's `versionCode`. */
    buildNumber: string | null;
  };
}> => {
  const androidProjectPath = path.join(getCwd(), "android");

  const result = await runGradle({
    args: { extraParams: [`-PMIN_BUNDLE_ID=${minBundleId}`] },
    env: await resolveGradleSigningEnv({ schemeConfig, credentials }),
    appModuleName: schemeConfig.appModuleName,
    tasks: schemeConfig.aab
      ? [`bundle${schemeConfig.variant}`]
      : [`assemble${schemeConfig.variant}`],
    logPrefix: `android-${schemeConfig.hotUpdaterSchemeName}-build`,
    androidProjectPath,
  });
  return {
    ...result,
    builtApp: await readBuiltApp({
      artifactPath: result.buildArtifactPath,
      androidProjectPath,
    }),
  };
};
