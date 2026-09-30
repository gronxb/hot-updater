import type { RemoteServer } from "@hot-updater/plugin-core";

import { createStandaloneCoreApi } from "./standaloneCore";
import { createStandaloneHttp } from "./standaloneHttp";
import type { StandaloneServerConfig } from "./standaloneRoutes";

export {
  createStandaloneCoreApi,
  STANDALONE_ADMIN_PROTOCOL,
} from "./standaloneCore";
export { StandaloneDatabaseError } from "./standaloneHttp";
export type {
  StandaloneRepositoryConfig,
  StandaloneServerConfig,
} from "./standaloneRoutes";

/** A self-hosted server, reached over its admin handler. */
export type StandaloneRepository = RemoteServer;

/**
 * A self-hosted server for the CLI and console, as `server` in
 * hot-updater.config.ts or `defineConsoleConfig`: core's API over the
 * server's admin API protocol 2, GETs on its admin handler for the routes
 * core does not cover, which its plugins serve, and the storage beside it.
 * The server lists its plugins on the admin `/version`, so nothing here
 * lists them again.
 */
export const standaloneRepository = ({
  storage,
  ...config
}: StandaloneServerConfig): StandaloneRepository => {
  if (!Array.isArray(storage) || storage.length === 0) {
    throw new TypeError(
      "standaloneRepository needs storage: the adapters for the server's bundle storage, where the CLI uploads to the first. In hot-updater.config.ts, that is `server: standaloneRepository({ baseUrl, storage: [s3Storage(...)] })`, in place of `database` and `storage`.",
    );
  }
  const http = createStandaloneHttp(config);
  return Object.freeze({
    name: "standalone-repository",
    url: http.buildUrl(""),
    core: createStandaloneCoreApi(config),
    fetchAdmin: (path: string) =>
      fetch(http.buildUrl(path), {
        headers: http.headers({ "Cache-Control": "no-cache" }),
      }),
    storage: Object.freeze([...storage]),
  });
};
