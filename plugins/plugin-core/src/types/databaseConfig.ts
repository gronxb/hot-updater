import type { HotUpdaterCoreApi } from "../coreApi";
import type { DatabaseAdapter } from "../database/adapter";
import type { StorageAdapter } from "./index";

/**
 * How changes to aggregates declared `batched` reach their rows: after the
 * transaction that made them commits, merged with other transactions'
 * changes into one write per aggregate row. Databases that bill each write
 * (DynamoDB, Firestore) batch them.
 */
export interface AggregateBatching {
  /**
   * `"log"` (the default) writes each transaction's changes as one log row
   * in that transaction, and a compaction merges pending log rows into the
   * aggregates. It loses nothing and suits every runtime. `"memory"` keeps
   * changes in the process until a timer flushes them. It writes no log
   * rows, but a crash loses up to one window, and a runtime that freezes
   * or drops the process between requests (Lambda, Cloud Functions,
   * Workers) loses more, so use it only on a long-lived server.
   */
  readonly mode?: "log" | "memory";
  /**
   * How long changes wait before a compaction or a flush: `"log"` compacts
   * after a commit once this has passed since the last compaction, 60
   * seconds by default, and `"memory"` flushes this often, 15 seconds by
   * default. A read that cannot compact (read-only credentials) shows
   * aggregates that can leave out up to one window of the latest changes.
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
  dispose?(): Promise<void>;
}

/**
 * A self-hosted server the CLI and the console reach through its admin API,
 * such as `standaloneRepository(...)`, with the storage they use beside it.
 */
export interface RemoteServer {
  readonly name: string;
  /** Core's reads and typed operations over the server's admin API. */
  readonly core: HotUpdaterCoreApi;
  /** A GET on the server's admin handler, for admin routes core does not cover. */
  readonly fetchAdmin: (path: string) => Promise<Response>;
  /**
   * Where the server's bundles are stored: the CLI uploads to the first, and
   * the console reads and deletes each bundle's files with the adapter of
   * their protocol.
   */
  readonly storage: readonly StorageAdapter[];
  dispose?(): Promise<void>;
}

/** The database a server uses: one the CLI opens itself, or a self-hosted server's admin API. */
export type ConfiguredDatabase = EngineDatabase | RemoteServer;

/** Whether a database is a self-hosted server reached through its admin API. */
export const isRemoteServer = (value: unknown): value is RemoteServer =>
  typeof value === "object" &&
  value !== null &&
  "core" in value &&
  "fetchAdmin" in value;
