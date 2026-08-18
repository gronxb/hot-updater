import type {
  AppUpdateAvailableInfo,
  Bundle,
  LegacyBundle,
  ReleaseCatalog,
} from "@hot-updater/core";
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
  ) => Promise<AppUpdateAvailableInfo | null>;
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
  insertBundle: (bundle: LegacyBundle) => Promise<void>;
  insertBundles?: (bundles: readonly LegacyBundle[]) => Promise<void>;
  updateBundleById: (
    bundleId: string,
    bundle: Partial<LegacyBundle>,
  ) => Promise<void>;
  deleteBundleById: (bundleId: string) => Promise<void>;
  getChannels: () => Promise<readonly ChannelRow[]>;
  insertChannel: (input: ChannelInsertInput) => Promise<ChannelInsertResult>;
  deleteChannel: (input: ChannelDeleteInput) => Promise<ChannelDeleteResult>;
}

export interface HandlerOptions {
  /** Authority accepted by v2 Release catalog paths. */
  readonly authorityId?: string;
  /** Base path for all routes. @default "/api" */
  readonly basePath?: string;
  /** Runtime features to mount. `GET /version` is always available. */
  readonly features?: HandlerFeatures;
}

export interface HandlerFeatures {
  /**
   * Mounts the React Native v1 update-check endpoints:
   *
   * - `GET /v2/release-catalogs/app-version/:authorityId/:platform/:channelKey/:appVersion`
   * - `GET /v2/release-catalogs/fingerprint/:authorityId/:platform/:channelKey/:fingerprintHash`
   * - `GET /v2/artifacts/:targetBundleId/from/:currentBundleId`
   *
   * @default true
   *
   * This only controls the core route group. Optional authentication for
   * these routes is configured through `features.clientAccessKeys`.
   */
  readonly updateCheck?: boolean;
  /**
   * Mounts the bundle management endpoints used by `standaloneRepository`:
   *
   * - `GET /api/channels`
   * - `POST /api/channels`
   * - `DELETE /api/channels/:id`
   * - `GET /api/bundles/:id`
   * - `GET /api/bundles`
   * - `POST /api/bundles`
   * - `PATCH /api/bundles/:id`
   * - `DELETE /api/bundles/:id`
   *
   * @default false
   *
   * Analytics and client access-key behavior are not route groups. Configure
   * them through `features.analytics` and `features.clientAccessKeys`.
   */
  readonly bundles?: boolean;
}

export type RouteHandler = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI,
) => Promise<Response>;
