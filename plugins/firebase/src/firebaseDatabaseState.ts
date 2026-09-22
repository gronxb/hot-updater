import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  ApiKeyRow,
  ChannelRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
export interface FirebaseDatabaseSnapshot {
  readonly bundles: Map<string, BundleRow>;
  readonly bundlePatches: Map<string, BundlePatchRow>;
  readonly bundleEvents: Map<string, BundleEventRow>;
  readonly channels: Map<string, ChannelRow>;
  readonly apiKeys: Map<string, ApiKeyRow>;
  readonly releaseCatalogs: Map<string, ReleaseCatalogRow>;
  readonly releases: Map<string, ReleaseRow>;
}

export class FirebaseDatabaseConstraintError extends Error {
  readonly name = "FirebaseDatabaseConstraintError";

  constructor(readonly constraint: string) {
    super(`Firebase database constraint failed: ${constraint}`);
  }
}

export const cloneFirebaseDatabaseSnapshot = (
  snapshot: FirebaseDatabaseSnapshot,
): FirebaseDatabaseSnapshot => ({
  bundles: new Map(snapshot.bundles),
  bundlePatches: new Map(snapshot.bundlePatches),
  bundleEvents: new Map(snapshot.bundleEvents),
  channels: new Map(snapshot.channels),
  apiKeys: new Map(snapshot.apiKeys),
  releaseCatalogs: new Map(snapshot.releaseCatalogs),
  releases: new Map(snapshot.releases),
});
