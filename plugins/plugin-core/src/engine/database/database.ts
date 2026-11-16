import {
  DATABASE_VERSION_COLUMN,
  type SnapshotReader,
  type StoredRow,
} from "../../database/adapter";
import type {
  HotUpdaterDatabase,
  HotUpdaterTransaction,
  KeyLookup,
  Page,
  TableRow,
} from "../../serverPlugin/databaseHandle";
import type { ModuleSchema } from "../../serverPlugin/schema";
import type { AggregateBatching } from "../../types/databaseConfig";
export type {
  AggregateChanges,
  AggregateIdentity,
  AggregateRow,
  CreateRow,
  EngineColumns,
  FindAggregatesModel,
  FindManyModel,
  HotUpdaterDatabase,
  HotUpdaterTransaction,
  KeyLookup,
  Lookup,
  ReadOptions,
  ReadRow,
  TableRow,
  UpdateSet,
} from "../../serverPlugin/databaseHandle";

import { createAggregateBatches } from "./aggregateBatching";
import { createStorageEngine, type DatabaseEngineOptions } from "./engine";
import type { ReadInput } from "./engineReads";
import {
  assertOutsideTransaction,
  type TransactionEngine,
} from "./engineTransaction";
import { DatabaseConstraintError } from "./errors";
import type { ReadMeter } from "./readMeter";
import type { SchemaModule } from "./resolveSchema";

/** A database handle's key and index reads, all of one committed state. */
export type SnapshotDatabase<S extends ModuleSchema> = Pick<
  HotUpdaterDatabase<S>,
  "findOne" | "findByKeys" | "findMany"
>;

/**
 * Reads that must agree, such as a release catalog's head and the rows it
 * names: the adapter's `readSnapshot`, or direct reads on an adapter whose
 * reads each see every write committed before they start.
 */
export interface SnapshotReads<S extends ModuleSchema> {
  /**
   * Whether `snapshot` reads one committed state. False: it reads directly,
   * so a reader checks what it read against the rows' generations instead.
   */
  readonly snapshots: boolean;
  /**
   * Runs `read` on one snapshot. It may run more than once, each time on a
   * fresh snapshot, so it only reads; nothing outlives the call.
   */
  snapshot<T>(read: (db: SnapshotDatabase<S>) => Promise<T>): Promise<T>;
}

/** A transaction handle's batch key read, which `findByKeysIn` reaches. */
const BATCH_KEYS = Symbol("hot-updater.transaction.findByKeys");
type BatchKeys = (
  model: string,
  keys: readonly object[],
) => Promise<readonly unknown[]>;

/**
 * What core's release catalog writer needs beyond a handle's reads and
 * transactions. A write reads the persisted `catalog.partitioning` setting
 * itself, every time, so no process keeps a switch; and a publication too
 * big for one atomic write checks that its final write fits before it
 * stages any row. Exported for `Engine.core`, which `@hot-updater/server`
 * runs.
 */
export interface CatalogWriteSupport<S extends ModuleSchema> {
  /**
   * The adapter's `maxQueriesPerRequest`: the most queries one request may
   * send, which a staged publication is counted against before it stages.
   * Undefined: no cap.
   */
  readonly queryBudget: number | undefined;
  /**
   * One settings row's value, or null when it is absent: one point read.
   * It may run inside a transaction's callback, and is never guarded.
   */
  readSetting(key: string): Promise<string | null>;
  /**
   * `snapshot`, also inside a transaction's callback: its reads are not the
   * transaction's, and nothing guards them. Core's catalog writer reads a
   * partitioned scope's rows with it after reading the scope's own row
   * through the transaction, whose guard on that row then covers them:
   * every write of a scope's live rows writes its row too.
   */
  unguardedSnapshot<T>(
    read: (db: SnapshotDatabase<S>) => Promise<T>,
  ): Promise<T>;
  /**
   * Rows by key through `tx`, in one batch read, each guarded at commit as
   * `tx.findOne` guards it: a release catalog write rewrites or deletes many
   * partition rows, and reads them all in one call instead of one each.
   */
  findByKeysIn<M extends keyof S & string>(
    tx: HotUpdaterTransaction<S>,
    model: M,
    keys: readonly KeyLookup<S[M]>[],
  ): Promise<(TableRow<S[M]> | null)[]>;
  /**
   * Whether `fn`'s writes fit one atomic write of this adapter, as its own
   * `fits` decides on the compiled operations. It runs `fn` with its reads,
   * as a transaction would, and never writes.
   */
  fits(
    fn: (tx: HotUpdaterTransaction<S>) => Promise<unknown>,
  ): Promise<boolean>;
}

/** The engine plus `database(module)`, which hands a module its typed handle. */
export const createDatabaseEngine = ({
  batching,
  now = Date.now,
  meter,
  ...options
}: DatabaseEngineOptions & {
  /**
   * Batches changes to aggregates declared `batched`; the schema must
   * include `aggregateBatchingModule`.
   */
  readonly batching?: AggregateBatching;
  /** The clock batching times its compactions by. */
  readonly now?: () => number;
  /** A metered database's meter, which counts what the engine and its batching read. */
  readonly meter?: ReadMeter;
}) => {
  const adapter = meter ? meter.wrap(options.adapter) : options.adapter;
  const engine = createStorageEngine({ ...options, adapter });
  const { reads } = engine;
  meter?.attach(reads.reads);
  const batches =
    batching &&
    createAggregateBatches({
      engine,
      adapter,
      schema: options.schema,
      batching,
      now,
    });
  const transaction = batches?.transaction ?? engine.transaction;
  const outside =
    <A extends unknown[], T>(read: (...args: A) => T) =>
    (...args: A): T => {
      assertOutsideTransaction();
      return read(...args);
    };
  /** No read outside a transaction returns `_v`, which a key-value index copy lacks. */
  const bare = (row: StoredRow | null) =>
    row &&
    Object.fromEntries(
      Object.entries(row).filter(
        ([column]) => column !== DATABASE_VERSION_COLUMN,
      ),
    );
  const barePage = async (page: Promise<Page<StoredRow>>) => {
    const { rows, next } = await page;
    return { rows: rows.map(bare), ...(next === undefined ? {} : { next }) };
  };
  return {
    ...engine,
    /** Applies the batched aggregate changes still in the log. */
    flush: async () => {
      await batches?.flush();
    },
    database<S extends ModuleSchema>(
      module: SchemaModule & { readonly schema: S },
    ): HotUpdaterDatabase<S> & SnapshotReads<S> & CatalogWriteSupport<S> {
      const name = (model: string) =>
        module.namespace ? `${module.namespace}_${model}` : model;
      const readsOf = (
        source: Pick<typeof reads, "findOne" | "findByKeys" | "findMany">,
        guard: typeof outside = outside,
      ): SnapshotDatabase<S> => ({
        findOne: guard(
          async (model, lookup) =>
            bare(await source.findOne(name(model), lookup as never)) as never,
        ),
        findByKeys: guard(
          async (model, keys) =>
            (await source.findByKeys(name(model), keys as never)).map(
              bare,
            ) as never,
        ),
        findMany: guard(
          (model, input) =>
            barePage(source.findMany(name(model), input as ReadInput)) as never,
        ),
      });
      const typed =
        <R>(fn: (tx: HotUpdaterTransaction<S>) => Promise<R>) =>
        (tx: TransactionEngine): Promise<R> => {
          const handle: HotUpdaterTransaction<S> = {
            findOne: (model, lookup) =>
              tx.findOne(name(model), lookup as never) as never,
            findMany: (model, input) =>
              tx.findMany(name(model), input as ReadInput) as never,
            create: (model, row) => tx.create(name(model), row),
            update: (model, row, set) => tx.update(name(model), row, set),
            delete: (model, row) => tx.delete(name(model), row),
            aggregate: (model, identity, changes, options) =>
              tx.aggregate(name(model), identity, changes, options),
          };
          const batch: BatchKeys = (model, keys) =>
            tx.findByKeys(name(model), keys as never);
          return fn(Object.assign(handle, { [BATCH_KEYS]: batch }));
        };
      const direct = readsOf(reads);
      const { readSnapshot } = engine;
      const anywhere: typeof outside = (read) => read;
      /** `snapshot`'s reads with no transaction check, so a transaction's callback may take them. */
      const unguardedSnapshot = <T>(
        read: (db: SnapshotDatabase<S>) => Promise<T>,
      ): Promise<T> =>
        readSnapshot === undefined
          ? read(readsOf(reads, anywhere))
          : readSnapshot((reader: SnapshotReader) =>
              read(readsOf(reads.over(reader), anywhere)),
            );
      return {
        ...direct,
        snapshots: readSnapshot !== undefined,
        snapshot: outside(unguardedSnapshot),
        findAggregates: outside(async (model, input) => {
          await batches?.beforeRead(name(model));
          return (await barePage(
            reads.findAggregates(name(model), input as ReadInput),
          )) as never;
        }),
        transaction: (fn) => transaction(typed(fn)),
        readSetting: engine.readSetting,
        queryBudget: engine.maxQueriesPerRequest,
        unguardedSnapshot,
        findByKeysIn: (tx, model, keys) => {
          const batch = (tx as { [BATCH_KEYS]?: BatchKeys })[BATCH_KEYS];
          // A wrapper that rebuilt the handle without it: one read per key.
          if (batch === undefined) {
            return Promise.all(
              keys.map((key) => tx.findOne(model as never, key as never)),
            ) as never;
          }
          return batch(model, keys) as never;
        },
        fits: outside(async (fn) => {
          try {
            await transaction(typed(fn), { fitsOnly: true });
            return true;
          } catch (error) {
            if (
              error instanceof DatabaseConstraintError &&
              error.reason === "too_large"
            ) {
              return false;
            }
            throw error;
          }
        }),
      };
    },
  };
};

export type DatabaseEngine = ReturnType<typeof createDatabaseEngine>;
