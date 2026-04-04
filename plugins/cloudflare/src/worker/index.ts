export { verifyJwtSignedUrl } from "@hot-updater/js";

import type { RequestEnvContext as BaseRequestEnvContext } from "@hot-updater/plugin-core";

import {
  type CloudflareWorkerDatabaseEnv,
  d1WorkerDatabase,
} from "../cloudflareWorkerDatabase";
import {
  type CloudflareWorkerStorageConfig,
  type CloudflareWorkerStorageEnv,
  r2WorkerStorage,
} from "../r2WorkerStorage";

export type { CloudflareWorkerDatabaseEnv, CloudflareWorkerStorageEnv };

export interface CloudflareWorkerRuntimeEnv
  extends CloudflareWorkerDatabaseEnv, CloudflareWorkerStorageEnv {}

export type RequestEnvContext<TEnv = CloudflareWorkerRuntimeEnv> =
  BaseRequestEnvContext<TEnv>;

export const d1Database = <
  TContext extends RequestEnvContext<CloudflareWorkerRuntimeEnv> =
    RequestEnvContext<CloudflareWorkerRuntimeEnv>,
>() => d1WorkerDatabase<TContext>();

export const r2Storage = <
  TContext extends RequestEnvContext<CloudflareWorkerRuntimeEnv> =
    RequestEnvContext<CloudflareWorkerRuntimeEnv>,
>(
  config: CloudflareWorkerStorageConfig<TContext>,
) => r2WorkerStorage<TContext>(config);
