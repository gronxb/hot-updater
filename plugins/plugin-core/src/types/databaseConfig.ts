import type { HotUpdaterCoreApi } from "../coreApi";
import type { DatabaseAdapter } from "../database/adapter";

/**
 * A database on Hot Updater's storage engine, as a provider's factory
 * returns it: the adapter that core and plugins run on.
 */
export interface EngineDatabase {
  /** The provider's name, for messages. */
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  dispose?(): Promise<void>;
}

/** A self-hosted server's database, reached through its admin API. */
export interface RemoteDatabase {
  readonly name: string;
  /** Core's reads and typed operations over the server's admin API. */
  readonly core: HotUpdaterCoreApi;
  /** A GET on the server's admin handler, for admin routes core does not cover. */
  readonly fetchAdmin: (path: string) => Promise<Response>;
  dispose?(): Promise<void>;
}

/** The database a config names: one the CLI opens itself, or a self-hosted server's. */
export type ConfiguredDatabase = EngineDatabase | RemoteDatabase;

/** Whether a configured database is a self-hosted server's. */
export const isRemoteDatabase = (
  database: ConfiguredDatabase,
): database is RemoteDatabase => "core" in database && "fetchAdmin" in database;
