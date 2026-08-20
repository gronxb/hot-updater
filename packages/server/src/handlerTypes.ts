import type { ArtifactInfo, Bundle, ReleaseCatalog } from "@hot-updater/core";
import type {
  ChannelDeleteInput,
  ChannelDeleteResult,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  DatabaseBundleQueryOptions,
  DatabaseCommit,
  DatabaseCommitResult,
  ReleaseCatalogRow,
  ReleaseCatalogMutationPreflight,
  ReleaseCatalogMutationResult,
  ReleaseCatalogRebuildResult,
  ReleasePolicyPatch,
  ReleaseRow,
} from "@hot-updater/plugin-core";

import type { ReleaseCatalogRequest } from "./db/releaseCatalog";
import type { PaginatedResult } from "./types";

export interface HandlerAPI {
  getReleaseCatalog?: (
    input: ReleaseCatalogRequest,
  ) => Promise<ReleaseCatalog | null>;
  getArtifactInfo?: (
    targetBundleId: string,
    currentBundleId: string,
  ) => Promise<ArtifactInfo | null>;
  getReleaseById?: (id: string) => Promise<ReleaseRow | null>;
  getReleasesByScope?: (input: {
    readonly scopeKey: string;
    readonly afterReleaseId?: string;
    readonly limit: number;
  }) => Promise<readonly ReleaseRow[]>;
  getReleases?: (input: {
    readonly afterReleaseId?: string;
    readonly beforeReleaseId?: string;
    readonly bundleId?: string;
    readonly channelId?: string;
    readonly enabled?: boolean;
    readonly platform?: "ios" | "android";
    readonly targetAppVersion?: string;
    readonly limit: number;
  }) => Promise<readonly ReleaseRow[]>;
  getReleaseCatalogByScopeKey?: (
    scopeKey: string,
  ) => Promise<ReleaseCatalogRow | null>;
  getReleaseCatalogs?: (input: {
    readonly afterScopeKey?: string;
    readonly limit: number;
  }) => Promise<readonly ReleaseCatalogRow[]>;
  updateReleasePolicy?: (input: {
    readonly expectedRevision?: number;
    readonly patch: ReleasePolicyPatch;
    readonly releaseId: string;
  }) => Promise<ReleaseCatalogMutationResult>;
  preflightReleasePolicy?: (input: {
    readonly expectedRevision?: number;
    readonly patch: ReleasePolicyPatch;
    readonly releaseId: string;
  }) => Promise<ReleaseCatalogMutationPreflight>;
  deleteRelease?: (input: {
    readonly expectedRevision?: number;
    readonly releaseId: string;
  }) => Promise<ReleaseCatalogMutationResult>;
  rebuildReleaseCatalog?: (
    scopeKey: string,
  ) => Promise<ReleaseCatalogRebuildResult>;
  commitDatabase?: (input: DatabaseCommit) => Promise<DatabaseCommitResult>;
  getBundleById: (id: string) => Promise<Bundle | null>;
  getBundles: (options: DatabaseBundleQueryOptions) => Promise<PaginatedResult>;
  insertBundle: (bundle: Bundle) => Promise<void>;
  insertBundles?: (bundles: readonly Bundle[]) => Promise<void>;
  updateBundleById: (
    bundleId: string,
    bundle: Partial<Bundle>,
  ) => Promise<void>;
  deleteBundleById: (bundleId: string) => Promise<void>;
  getChannels: () => Promise<readonly ChannelRow[]>;
  insertChannel: (input: ChannelInsertInput) => Promise<ChannelInsertResult>;
  deleteChannel: (input: ChannelDeleteInput) => Promise<ChannelDeleteResult>;
}

export interface HandlerOptions {
  /** Authority accepted by Release Catalog client paths. */
  readonly authorityId?: string;
}

export type HotUpdaterHandler = (request: Request) => Promise<Response>;

export interface HotUpdaterHandlers {
  readonly client: HotUpdaterHandler;
  readonly admin: HotUpdaterHandler;
}

export type RouteHandler = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI,
) => Promise<Response>;
