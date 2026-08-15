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
} from "@hot-updater/plugin-core";

import type { PaginatedResult } from "./types";

export interface HandlerAPI {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
  ) => Promise<AppUpdateAvailableInfo | null>;
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
