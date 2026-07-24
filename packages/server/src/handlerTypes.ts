import type {
  AppUpdateAvailableInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  HotUpdaterContext,
} from "@hot-updater/plugin-core";

import type { BundleEventAPI } from "./db/types";
import type { PaginatedResult } from "./types";

export interface HandlerAPI<TContext = unknown> extends Partial<
  BundleEventAPI<TContext>
> {
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
  getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
}

export interface HandlerOptions {
  /** Base path for all routes. @default "/api" */
  readonly basePath?: string;
  /**
   * Route groups to mount. `GET /version` is always mounted independently.
   * All paths are relative to `basePath`.
   */
  readonly routes?: HandlerRoutes;
}

export interface HandlerRoutes {
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
  readonly updateCheck: boolean;
  /**
   * Mounts the bundle management endpoints used by `standaloneRepository`:
   *
   * - `GET /api/bundles/channels`
   * - `GET /api/bundles/:id`
   * - `GET /api/bundles`
   * - `POST /api/bundles`
   * - `PATCH /api/bundles/:id`
   * - `DELETE /api/bundles/:id`
   *
   * @default false
   */
  readonly bundles: boolean;
  /**
   * Mounts client event ingestion and the Analytics/installation query
   * endpoints used by Console:
   *
   * - `POST /events`
   * - `GET /api/bundles/:id/events/summary`
   * - `GET /api/bundles/:id/events/analytics`
   * - `GET /api/installations`
   * - `GET /api/installations/overview`
   * - `GET /api/installations/active`
   * - `GET /api/installations/:installId/events`
   *
   * These endpoints require a database with Analytics support. Enabling this
   * option with an unsupported database logs a warning and mounts no Analytics
   * routes.
   *
   * @default false
   */
  readonly analytics?: boolean;
}

export type RouteHandler<TContext = unknown> = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI<TContext>,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;
