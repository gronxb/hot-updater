import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import type { AppleDevice } from "./deviceManager";

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
      | "archive"
      | "verbose"
      | "destination"
    >
  > & {
    device: AppleDevice;
  };
export const enrichNativeBuildSchemeOptions = async (
  scheme: NativeBuildIosScheme,
  { device }: { device: AppleDevice },
): Promise<EnrichedNativeBuildIosScheme> => {
  return {
    platform: "ios",
    installPods: true,
    configuration: "Release",
    archive: false,
    verbose: false,
    destination: [],
    ...scheme,
    device,
  };
};
