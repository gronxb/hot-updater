import type {
  AppUpdateAvailableInfo,
  AppUpdateInfo,
  Bundle,
  GetBundlesArgs,
} from "@hot-updater/core";
import { describe, expect, it } from "vitest";

type BsdiffManifestFixture = {
  assetPath: "index.ios.bundle";
  currentBundleId: string;
  currentManifest: {
    assets: Record<string, { fileHash: string }>;
    bundleId: string;
  };
  nextBundleId: string;
  nextManifest: {
    assets: Record<string, { fileHash: string }>;
    bundleId: string;
  };
  patchPath: string;
};

type PreparedBsdiffManifestArtifacts = {
  cleanup?: () => Promise<void> | void;
  currentArtifacts: Partial<Bundle>;
  nextArtifacts: Partial<Bundle>;
};

type SetupBsdiffManifestUpdateInfoTestSuiteOptions = {
  getUpdateInfo: (
    args: GetBundlesArgs,
  ) => Promise<AppUpdateInfo | Record<string, any> | null>;
  prepareArtifacts: (
    fixture: BsdiffManifestFixture,
  ) => Promise<PreparedBsdiffManifestArtifacts>;
  seedBundles: (bundles: Bundle[]) => Promise<void>;
  expectPatchUrl: (
    patchUrl: string,
    fixture: BsdiffManifestFixture,
  ) => Promise<void> | void;
};

const createManifest = (bundleId: string, hbcHash: string) => ({
  assets: {
    "assets/logo.png": {
      fileHash: "hash-logo",
    },
    "index.ios.bundle": {
      fileHash: hbcHash,
    },
  },
  bundleId,
});

const createBundle = (
  id: string,
  artifacts: Partial<Bundle>,
  overrides: Partial<Bundle> = {},
): Bundle => ({
  id,
  platform: "ios",
  targetAppVersion: "1.0.0",
  shouldForceUpdate: false,
  enabled: true,
  fileHash:
    id === DEFAULT_FIXTURE.currentBundleId
      ? "hash-current-zip"
      : "hash-next-zip",
  gitCommitHash: null,
  message: id === DEFAULT_FIXTURE.currentBundleId ? "current" : "next",
  channel: "production",
  storageUri: "storage://unused",
  fingerprintHash: null,
  metadata: {},
  ...artifacts,
  ...overrides,
});

const DEFAULT_FIXTURE: BsdiffManifestFixture = {
  assetPath: "index.ios.bundle",
  currentBundleId: "00000000-0000-0000-0000-000000000201",
  currentManifest: createManifest(
    "00000000-0000-0000-0000-000000000201",
    "hash-old-bundle",
  ),
  nextBundleId: "00000000-0000-0000-0000-000000000202",
  nextManifest: createManifest(
    "00000000-0000-0000-0000-000000000202",
    "hash-new-bundle",
  ),
  patchPath:
    "00000000-0000-0000-0000-000000000202/patches/00000000-0000-0000-0000-000000000201/index.ios.bundle.bsdiff",
};

export const setupBsdiffManifestUpdateInfoTestSuite = ({
  getUpdateInfo,
  prepareArtifacts,
  seedBundles,
  expectPatchUrl,
}: SetupBsdiffManifestUpdateInfoTestSuiteOptions) => {
  describe("manifest bsdiff patch descriptors", () => {
    it("returns changed asset bsdiff patch metadata when the current bundle matches the diff base", async () => {
      const fixture = DEFAULT_FIXTURE;
      const prepared = await prepareArtifacts(fixture);

      try {
        await seedBundles([
          createBundle(fixture.currentBundleId, prepared.currentArtifacts),
          createBundle(fixture.nextBundleId, prepared.nextArtifacts),
        ]);

        const updateInfo = await getUpdateInfo({
          appVersion: "1.0.0",
          bundleId: fixture.currentBundleId,
          platform: "ios",
          _updateStrategy: "appVersion",
        });

        expect(updateInfo).toMatchObject({
          id: fixture.nextBundleId,
          manifestFileHash: "sig:manifest-next",
          status: "UPDATE",
        });

        const changedAssets = (updateInfo as AppUpdateAvailableInfo | null)
          ?.changedAssets as Record<string, any> | undefined;
        const changedAsset = changedAssets?.[fixture.assetPath];

        expect(changedAsset).toMatchObject({
          fileHash: "hash-new-bundle",
          patch: {
            algorithm: "bsdiff",
            baseBundleId: fixture.currentBundleId,
            baseFileHash: "hash-old-bundle",
            patchFileHash: "hash-bsdiff",
          },
        });

        await expectPatchUrl(changedAsset?.patch?.patchUrl, fixture);
      } finally {
        await prepared.cleanup?.();
      }
    });
  });
};
