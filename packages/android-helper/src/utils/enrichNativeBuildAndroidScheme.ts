import type { ResolvedNativeBuildAndroidScheme } from "@hot-updater/cli-tools";

/**
 * Validated scheme filled nullish values with default values.
 */
export type EnrichedNativeBuildAndroidScheme = Required<
  Omit<
    ResolvedNativeBuildAndroidScheme,
    "signing" | "sandbox" | "sandboxUrlScheme"
  >
> &
  Pick<
    ResolvedNativeBuildAndroidScheme,
    "signing" | "sandbox" | "sandboxUrlScheme"
  > & {
    hotUpdaterSchemeName: string;
  };
export const enrichNativeBuildAndroidScheme = async ({
  schemeConfig,
  hotUpdaterSchemeName,
}: {
  schemeConfig: ResolvedNativeBuildAndroidScheme;
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
