import type {
  ReleaseCatalogMutationResult,
  ReleasePolicyPatch,
  ReleaseRow,
} from "@hot-updater/plugin-core";

export interface LegacyBundleCleanupAPI {
  readonly deleteBundleById: (bundleId: string) => Promise<void>;
  readonly deleteRelease: (input: {
    readonly expectedRevision?: number;
    readonly releaseId: string;
  }) => Promise<ReleaseCatalogMutationResult>;
  readonly getReleases: (input: {
    readonly bundleId?: string;
    readonly limit: number;
  }) => Promise<readonly ReleaseRow[]>;
  readonly updateReleasePolicy: (input: {
    readonly expectedRevision?: number;
    readonly patch: ReleasePolicyPatch;
    readonly releaseId: string;
  }) => Promise<ReleaseCatalogMutationResult>;
}

export const deleteLegacyBundle = async (
  api: LegacyBundleCleanupAPI,
  bundleId: string,
): Promise<void> => {
  for (;;) {
    const releases = await api.getReleases({ bundleId, limit: 1_000 });
    if (releases.length === 0) break;

    for (const release of releases) {
      let revision = release.revision;
      if (release.enabled) {
        const result = await api.updateReleasePolicy({
          expectedRevision: revision,
          patch: { enabled: false },
          releaseId: release.id,
        });
        if (result.release === null) {
          throw new Error(`Release "${release.id}" was not updated.`);
        }
        revision = result.release.revision;
      }
      await api.deleteRelease({
        expectedRevision: revision,
        releaseId: release.id,
      });
    }
  }

  await api.deleteBundleById(bundleId);
};
