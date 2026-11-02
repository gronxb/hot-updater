import type { NativeBuildRow } from "@hot-updater/plugin-core";

/**
 * A native build as a person knows it, such as `iOS 1.7.0 (66)`: the store's
 * label when a store took it, else its app version and build number, and its
 * built-in bundle's ID when it reports neither.
 */
export const describeNativeBuild = (build: NativeBuildRow): string => {
  const label =
    build.submitted_version ??
    [
      build.app_version,
      build.build_number === null ? null : `(${build.build_number})`,
    ]
      .filter((part) => part !== null)
      .join(" ");
  return `${build.platform === "ios" ? "iOS" : "Android"} ${label || build.min_bundle_id.slice(0, 8)}`;
};
