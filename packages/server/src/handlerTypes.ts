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

export type AuthorizeEventIngestion<TContext = unknown> = (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => boolean | Response | Promise<boolean | Response>;

export interface HandlerEventIngestionOptions<TContext = unknown> {
  readonly authorize: AuthorizeEventIngestion<TContext>;
}

export interface HandlerOptions<TContext = unknown> {
  /** Base path for all routes. @default "/api" */
  readonly basePath?: string;
  /** Required authorization and throttling policy for client event writes. */
  readonly eventIngestion?: HandlerEventIngestionOptions<TContext>;
  /** Route groups to mount. The version endpoint is always mounted. */
  readonly routes?: HandlerRoutes;
}

export interface HandlerRoutes {
  /** React Native update-check routes. @default true */
  readonly updateCheck: boolean;
  /** Bundle management routes used by standaloneRepository. @default false */
  readonly bundles: boolean;
  /** Analytics and installation query routes used by Console. @default false */
  readonly analytics?: boolean;
}

export type RouteHandler<TContext = unknown> = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI<TContext>,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;
