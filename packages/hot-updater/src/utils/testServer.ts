import { assembleServer } from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  type ConfiguredDatabase,
  createStorageAdapter,
  type HotUpdaterCoreApi,
  type StorageAdapter,
} from "@hot-updater/plugin-core";

import type { LoadedServer } from "./loadServer";

/**
 * A server as `loadServer` returns it, assembled over `database`,
 * `storage`, and `plugins`, for specs that mock `loadServer`. Without
 * `storage`, its storage owns no URI. Its core is the assembled one, or
 * `database.core` when the database has one, such as a harness's that spies
 * on calls. Disposing it disposes the database.
 */
export const testServer = ({
  database,
  storage = createStorageAdapter({ name: "none", protocol: "none" }),
  plugins = [],
}: {
  readonly database:
    | ConfiguredDatabase
    | (ConfiguredDatabase & { readonly core: HotUpdaterCoreApi });
  readonly storage?: StorageAdapter;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}): LoadedServer => {
  const server = assembleServer({ database, storage, plugins });
  return {
    ...server,
    storage,
    core: "core" in database ? database.core : server.core,
    dispose: async () => {
      await database.dispose?.();
    },
  };
};
