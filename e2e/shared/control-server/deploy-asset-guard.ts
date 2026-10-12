import { PAX_LONG_ASSET_REQUIRE_PATH } from "../pax-long-path-fixture.ts";
import { isLynxE2eAppId } from "./lynx-store.ts";

export type BundleProfile =
  | "archive300mb"
  | "default"
  | "multiAssetReplacement"
  | "sizeAwareLargeDiff";

const DEPLOY_ASSET_GUARD_START = "/* E2E_DEPLOY_ASSET_GUARD_START */";
const DEPLOY_ASSET_GUARD_END = "/* E2E_DEPLOY_ASSET_GUARD_END */";
const deployAssetRequirePaths: Partial<
  Record<BundleProfile, readonly string[]>
> = {
  archive300mb: ["../test/_fixture-archive-300mb-random.bmp"],
  multiAssetReplacement: [
    "../test/_fixture-multi-asset-a.bmp",
    "../test/_fixture-multi-asset-b.bmp",
    "../test/_fixture-multi-asset-c.bmp",
    PAX_LONG_ASSET_REQUIRE_PATH,
  ],
  sizeAwareLargeDiff: ["../test/_fixture-size-aware-large-compressible.bmp"],
};

export function createDeployAssetGuardSource(
  bundleProfile: BundleProfile,
  appId: string,
): string {
  const requirePaths = isLynxE2eAppId(appId)
    ? []
    : (deployAssetRequirePaths[bundleProfile] ?? []);
  return [
    DEPLOY_ASSET_GUARD_START,
    ...requirePaths.map(
      (requirePath) =>
        `  void Image.resolveAssetSource(require(${JSON.stringify(requirePath)}));`,
    ),
    `  ${DEPLOY_ASSET_GUARD_END}`,
  ].join("\n");
}
