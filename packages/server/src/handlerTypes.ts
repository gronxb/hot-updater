import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
import type {
  ChannelDeleteInput,
  ChannelDeleteResult,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  DatabaseBundleQueryOptions,
  HotUpdaterContext,
} from "@hot-updater/plugin-core";

import type { PaginatedResult } from "./types";

export interface HandlerAPI<TContext = unknown> {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<AppUpdateAvailableInfo | null>;
  getBundleById: (
    id: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Bundle | null>;
  getBundles: (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<PaginatedResult>;
  insertBundle: (
    bundle: Bundle,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  insertBundles?: (
    bundles: readonly Bundle[],
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  updateBundleById: (
    bundleId: string,
    bundle: Partial<Bundle>,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  deleteBundleById: (
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  getChannels: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<readonly ChannelRow[]>;
  insertChannel: (
    input: ChannelInsertInput,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<ChannelInsertResult>;
  deleteChannel: (
    input: ChannelDeleteInput,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<ChannelDeleteResult>;
}

export interface HandlerOptions {
  /** Base path for all routes. @default "/api" */
  readonly basePath?: string;
  /** Runtime features to mount. `GET /version` is always available. */
  readonly features?: HandlerFeatures;
}

export interface HandlerFeatures {
  /**
   * Mounts the React Native update-check endpoints:
   *
   * - `GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId`
   * - `GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort`
   * - `GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId`
   * - `GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort`
   *
   * @default true
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
   */
  readonly bundles?: boolean;
}

export type RouteHandler<TContext = unknown> = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI<TContext>,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;
