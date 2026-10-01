import {
  type AnyHotUpdaterPlugin,
  type ConfiguredDatabase,
  type HotUpdaterCoreApi,
  isRemoteServer,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";

import type { LoadedServer } from "./loadServer";

/**
 * A server as `loadServer` returns it, over `database` and `storage`, for
 * specs that mock `loadServer`. Its core is the server definition's over the
 * database, or `database.core` when the database has one, such as a
 * self-hosted server's or a harness's that spies on calls. Disposing it
 * disposes the database.
 */
export const testServer = ({
  database,
  storage = [],
  plugins = [],
}: {
  readonly database:
    | ConfiguredDatabase
    | (ConfiguredDatabase & { readonly core: HotUpdaterCoreApi });
  readonly storage?: readonly StorageAdapter[];
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}): LoadedServer => {
  const definition =
    isRemoteServer(database) || "core" in database
      ? undefined
      : createHotUpdater({
          database,
          storage,
          plugins,
          ...(plugins.some(({ provides }) => provides?.clientAuth)
            ? {}
            : { clientAccess: "public" }),
        } as Parameters<typeof createHotUpdater>[0]);
  const core =
    definition?.core ?? (database as { readonly core: HotUpdaterCoreApi }).core;
  return {
    kind: "definition",
    path: "/project/hotUpdater.ts",
    definition: {
      database,
      storage,
      plugins,
      clientPlugins: definition?.clientPlugins ?? [],
      clientEndpoints: definition?.clientEndpoints ?? [],
      core,
      api: definition?.api ?? {},
    },
    plugins,
    database,
    core,
    storage,
    dispose: async () => {
      await database.dispose?.();
    },
  } as unknown as LoadedServer;
};
