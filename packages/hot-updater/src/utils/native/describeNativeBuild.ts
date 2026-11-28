import type { NativeBuildRow } from "@hot-updater/plugin-core";

import { storeVersionLabel } from "./nativeBuildSubmission";

/**
 * A build's label as the stores show it: `1.7.0 (66)`, its version and build
 * number, the store's own label once a store took it, or the build number
 * alone when the version can't be read; null without a build number.
 */
export const nativeBuildLabel = (
  build: Pick<
    NativeBuildRow,
    "submitted_version" | "native_app_version" | "app_version" | "build_number"
  >,
): string | null => {
  if (build.submitted_version) return build.submitted_version;
  if (build.build_number === null) return null;
  return storeVersionLabel(
    build.native_app_version ?? build.app_version,
    build.build_number,
  );
};

/**
 * A native build as a person knows it, such as `iOS 1.7.0 (66)`: the store's
 * label when a store took it, else its app version and build number, and its
 * built-in bundle's ID when it reports neither.
 */
export const describeNativeBuild = (build: NativeBuildRow): string =>
  `${build.platform === "ios" ? "iOS" : "Android"} ${nativeBuildLabel(build) ?? build.native_app_version ?? build.app_version ?? build.min_bundle_id.slice(0, 8)}`;
