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
 * the server's admin API protocol 2, and GETs on its admin handler for the
 * routes core does not cover, such as the Insights reads. Insights and API
 * keys belong to the server's own database and plugins.
 */
export const standaloneRepository = (
  config: StandaloneRepositoryConfig,
): StandaloneRepository => {
  const http = createStandaloneHttp(config);
  return Object.freeze({
    name: "standalone-repository",
    core: createStandaloneCoreApi(config),
    fetchAdmin: (path: string) =>
      fetch(http.buildUrl(path), {
        headers: http.headers({ "Cache-Control": "no-cache" }),
      }),
  });
};
