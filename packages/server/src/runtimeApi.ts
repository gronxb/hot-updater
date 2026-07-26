import type {
  HotUpdaterContext,
  RuntimeStorageInput,
} from "@hot-updater/plugin-core";

import type { DatabaseAPI, DatabasePlugin } from "./db/types";
import type { HandlerOptions } from "./handlerTypes";
import type {
  ProjectedFeatureApis,
  ProjectPlugins,
} from "./kernel/apiProjection";
import type { FirstPartyFeatureManifest } from "./kernel/manifest";
import type { StorageContextResolver } from "./storageContext";

export type RuntimeHotUpdaterAPI<TContext = undefined> =
  DatabaseAPI<TContext> & {
    readonly adapterName: string;
    readonly basePath: string;
    readonly handler: (
      request: Request,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<Response>;
    readonly onUnmount: () => Promise<void>;
  };

export type HotUpdaterAPI<TContext = undefined> =
  RuntimeHotUpdaterAPI<TContext>;
export type { RuntimeStorageInput } from "@hot-updater/plugin-core";

export interface CreateHotUpdaterOptions<
  TContext = undefined,
  TPlugins extends readonly FirstPartyFeatureManifest[] = readonly [],
> extends HandlerOptions {
  readonly database: DatabasePlugin;
  readonly plugins?: TPlugins;
  readonly storageContext?: StorageContextResolver<TContext>;
  readonly storages?: readonly RuntimeStorageInput<TContext>[];
}

export type RuntimeFields<TContext> = {
  readonly adapterName: string;
  readonly basePath: string;
  readonly handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
  readonly onUnmount: () => Promise<void>;
};

export const createRuntimeApi = <
  TContext,
  TPlugins extends readonly FirstPartyFeatureManifest[],
>(
  coreApi: DatabaseAPI<TContext>,
  fields: RuntimeFields<TContext>,
  projected: ProjectedFeatureApis,
): RuntimeHotUpdaterAPI<TContext> &
  Readonly<ProjectPlugins<TPlugins, TContext>> =>
  Object.freeze(
    Object.assign(
      {},
      coreApi,
      fields,
      { features: projected.features },
      projected.aliases,
    ),
  );
