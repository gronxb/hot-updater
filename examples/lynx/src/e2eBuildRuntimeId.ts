export type LynxPlatform = "ios" | "android";

export interface E2eBuildRuntimeEnvironment {
  readonly HOT_UPDATER_E2E_BUILD_MODE?: string;
  readonly HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE?: string;
}

const CROSS_PROVENANCE_BUILD_MODE = "cross-provenance";
const CROSS_PROVENANCE_RUNTIME_SUFFIX = "-cross-provenance-rejected";

export const lynxHostRuntimeId = (platform: LynxPlatform): string =>
  platform === "ios"
    ? "sparkling-c4ce8d2-navigation-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-managed-pages-v1"
    : "android-sparkling-2.1.0-rc.12-navsrc-937f70d7c3012a5a-lynx-3.9.0-primjs-3.8.0-alpha.6-managed-pages-v1";

export const resolveE2eBuildRuntimeId = (
  platform: LynxPlatform,
  environment: E2eBuildRuntimeEnvironment = process.env,
): string => {
  const hostRuntimeId = lynxHostRuntimeId(platform);
  const buildMode = environment.HOT_UPDATER_E2E_BUILD_MODE;
  const override = environment.HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE;

  if (buildMode === undefined && override === undefined) {
    return hostRuntimeId;
  }

  const expectedOverride = `${hostRuntimeId}${CROSS_PROVENANCE_RUNTIME_SUFFIX}`;
  if (
    buildMode !== CROSS_PROVENANCE_BUILD_MODE ||
    override !== expectedOverride
  ) {
    throw new Error(
      `Cross-provenance E2E builds require HOT_UPDATER_E2E_BUILD_MODE=${CROSS_PROVENANCE_BUILD_MODE} and HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE=${expectedOverride}.`,
    );
  }

  return override;
};
