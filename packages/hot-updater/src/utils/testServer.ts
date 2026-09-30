import type {
  ConfiguredDatabase,
  StorageAdapter,
} from "@hot-updater/plugin-core";

import type { LoadedServer } from "./loadServer";

/**
 * A server as `loadServer` returns it, over `database` and `storage`, for
 * specs that mock `loadServer`. Disposing it disposes the database.
 */
export const testServer = ({
  database,
  storage = [],
  plugins = [],
}: {
  readonly database: ConfiguredDatabase;
  readonly storage?: readonly StorageAdapter[];
  readonly plugins?: readonly unknown[];
}): LoadedServer =>
  ({
    kind: "definition",
    path: "/project/hotUpdater.ts",
    hotUpdater: {},
    definition: { database, storage, plugins },
    plugins,
    database,
    storage,
    dispose: async () => {
      await database.dispose?.();
    },
  }) as unknown as LoadedServer;
