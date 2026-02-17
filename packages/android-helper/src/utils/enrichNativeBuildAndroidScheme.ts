import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";

/**
 * Validated scheme filled nullish values with default values.
 */
export type EnrichedNativeBuildAndroidScheme =
  Required<NativeBuildAndroidScheme> & { hotUpdaterSchemeName: string };
export const enrichNativeBuildAndroidScheme = async ({
  schemeConfig,
  hotUpdaterSchemeName,
}: {
  schemeConfig: NativeBuildAndroidScheme;
  hotUpdaterSchemeName: string;
}): Promise<EnrichedNativeBuildAndroidScheme> => {
  return {
    aab: true,
    variant: "Release",
    appModuleName: "app",
    applicationId: schemeConfig.packageName,
    ...schemeConfig,
    hotUpdaterSchemeName,
  };
};
