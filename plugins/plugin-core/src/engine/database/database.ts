import {
  DATABASE_VERSION_COLUMN,
  type StoredRow,
} from "../../database/adapter";
import type {
  HotUpdaterDatabase,
  Page,
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
import type { ReadMeter } from "./readMeter";
import type { SchemaModule } from "./resolveSchema";

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
  /** The clock batching times its flushes and compactions by. */
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
    /** Applies batched aggregate changes still pending: this process's buffer and the log. */
    flush: async () => {
      await batches?.flush();
    },
    dispose: async () => {
      await batches?.dispose();
    },
    database<S extends ModuleSchema>(
      module: SchemaModule & { readonly schema: S },
    ): HotUpdaterDatabase<S> {
      const name = (model: string) =>
        module.namespace ? `${module.namespace}_${model}` : model;
      return {
        findOne: outside(
          async (model, lookup) =>
            bare(await reads.findOne(name(model), lookup as never)) as never,
        ),
        findByKeys: outside(
          async (model, keys) =>
            (await reads.findByKeys(name(model), keys as never)).map(
              bare,
            ) as never,
        ),
        findMany: outside(
          (model, input) =>
            barePage(reads.findMany(name(model), input as ReadInput)) as never,
        ),
        findAggregates: outside(async (model, input) => {
          await batches?.beforeRead(name(model));
          return (await barePage(
            reads.findAggregates(name(model), input as ReadInput),
          )) as never;
        }),
        transaction: (fn) =>
          transaction((tx: TransactionEngine) =>
            fn({
              findOne: (model, lookup) =>
                tx.findOne(name(model), lookup as never) as never,
              findMany: (model, input) =>
                tx.findMany(name(model), input as ReadInput) as never,
              create: (model, row) => tx.create(name(model), row),
              update: (model, row, set) => tx.update(name(model), row, set),
              delete: (model, row) => tx.delete(name(model), row),
              aggregate: (model, identity, changes, options) =>
                tx.aggregate(name(model), identity, changes, options),
            }),
          ),
      };
    },
  };
};

export type DatabaseEngine = ReturnType<typeof createDatabaseEngine>;
