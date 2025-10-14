import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";

/**
 * Validated scheme filled nullish values with default values.
 */
export type EnrichedNativeBuildIosScheme = NativeBuildIosScheme &
  Required<
    Pick<
      NativeBuildIosScheme,
      | "platform"
      | "installPods"
      | "configuration"
      | "verbose"
      | "destination"
    >
  >;
export const enrichNativeBuildIosScheme = async (
  scheme: NativeBuildIosScheme,
): Promise<EnrichedNativeBuildIosScheme> => {
  return {
    platform: "ios",
    installPods: true,
    configuration: "Release",
    verbose: false,
    destination: [],
    ...scheme,
  };
};
