import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";

/**
 * Validated scheme filled nullish values with default values.
 */
export type EnrichedNativeBuildAndroidScheme =
  Required<NativeBuildAndroidScheme>;
export const enrichNativeBuildAndroidScheme = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildAndroidScheme;
}): Promise<EnrichedNativeBuildAndroidScheme> => {
  return {
    aab: true,
    variant: "Release",
    appModuleName: "app",
    ...schemeConfig,
  };
};
