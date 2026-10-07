import type { RemoteDatabase } from "@hot-updater/plugin-core";

import { createStandaloneCoreApi } from "./standaloneCore";
import { createStandaloneHttp } from "./standaloneHttp";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export {
  createStandaloneCoreApi,
  STANDALONE_ADMIN_PROTOCOL,
} from "./standaloneCore";
export { StandaloneDatabaseError } from "./standaloneHttp";
export type { StandaloneRepositoryConfig } from "./standaloneRoutes";

/** A self-hosted server's database, reached over its admin handler. */
export type StandaloneRepository = RemoteDatabase;

/**
 * A self-hosted server's database for the CLI and console: core's API over
 * the server's admin API protocol 2, and requests to its admin handler for
 * the routes core does not cover, which its plugins serve. Plugins' tables belong
 * to the server's own database.
 */
export const standaloneRepository = (
  config: StandaloneRepositoryConfig,
): StandaloneRepository => {
  const http = createStandaloneHttp(config);
  return Object.freeze({
    name: "standalone-repository",
    core: createStandaloneCoreApi(config),
    fetchAdmin: (path: string, init: RequestInit = {}) => {
      const headers = new Headers(http.headers({ "Cache-Control": "no-cache" }));
      new Headers(init.headers).forEach((value, name) => {
        headers.set(name, value);
      });
      return fetch(http.buildUrl(path), { ...init, headers });
    },
  });
};
