import type { HotUpdaterCoreApi } from "../coreApi";
import type { DatabaseAdapter } from "../database/adapter";
import type { RetryOptions } from "../engine/database/engineTransaction";

/**
 * How changes to aggregates declared `batched` reach their rows: each
 * transaction writes its changes as one log row, and a compaction merges
 * pending log rows into one write per aggregate row. Databases that bill each
 * write (DynamoDB, Firestore, Cosmos DB) batch them.
 */
export interface AggregateBatching {
  /**
   * A commit compacts once this has passed since the last compaction, 60
   * seconds by default. A read compacts first; one that cannot (read-only
   * credentials) shows aggregates that can leave out up to one window of the
   * latest changes.
   */
  readonly windowMs?: number;
}

/**
 * A database on Hot Updater's storage engine, as a provider's factory
 * returns it: the adapter that core and plugins run on.
 */
export interface EngineDatabase {
  /** The provider's name, for messages. */
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  /**
   * Purges a CDN's copies of the cacheable client routes. Core calls it after
   * a committed write that changes what those routes answer.
   */
  readonly onCachedRoutesChange?: () => Promise<void>;
  /** Batches aggregates declared `batched`; absent, they commit with each transaction. */
  readonly aggregateBatching?: AggregateBatching;
  /**
   * How a transaction that conflicts with another write runs again. A store
   * many writers contend on, such as DynamoDB under a burst of events, can
   * take more attempts; `onRetry` observes each rerun.
   */
  readonly retry?: RetryOptions;
  dispose?(): Promise<void>;
}

/** A self-hosted server's database, reached through its admin API. */
export interface RemoteDatabase {
  readonly name: string;
  /** Core's reads and typed operations over the server's admin API. */
  readonly core: HotUpdaterCoreApi;
  /**
   * A request to the server's admin handler, for admin routes core does not
   * cover, such as its plugins' routes: a GET unless `init` names another
   * method. The database's headers come first; `init.headers` add to them.
   */
  readonly fetchAdmin: (path: string, init?: RequestInit) => Promise<Response>;
  dispose?(): Promise<void>;
}

/** The database a config names: one the CLI opens itself, or a self-hosted server's. */
export type ConfiguredDatabase = EngineDatabase | RemoteDatabase;

/** Whether a configured database is a self-hosted server's. */
export const isRemoteDatabase = (value: unknown): value is RemoteDatabase =>
  typeof value === "object" &&
  value !== null &&
  "core" in value &&
  "fetchAdmin" in value;
