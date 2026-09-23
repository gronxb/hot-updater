import {
  type DatabaseAdapter,
  type DatabaseReadCount,
  verifyAdapter,
} from "@hot-updater/plugin-core/internal";

import {
  createEngineReads,
  type EngineReadCount,
  type Page,
  type ReadInput,
} from "./engineReads";
import {
  assertOutsideTransaction,
  createTransactions,
  type RetryOptions,
  type TransactionEngine,
} from "./engineTransaction";
import type { ResolvedSchema, SchemaModule } from "./resolveSchema";
import type {
  AggregateDefinition,
  FieldType,
  FieldValue,
  ModuleSchema,
  RowOf,
  TableDefinition,
} from "./schema";

type TableNames<S extends ModuleSchema> = {
  [K in keyof S]: S[K] extends TableDefinition ? K : never;
}[keyof S] &
  string;

type AggregateNames<S extends ModuleSchema> = {
  [K in keyof S]: S[K] extends AggregateDefinition ? K : never;
}[keyof S] &
  string;

/** Engine columns every stored row carries. */
export type EngineColumns = { readonly _v: number } & {
  readonly [K: `_refs_${string}`]: number;
};

type DerivedValues<TDerived> = {
  -readonly [K in keyof TDerived]: TDerived[K] extends FieldType
    ? FieldValue<TDerived[K]> | readonly FieldValue<TDerived[K]>[] | null
    : never;
};

type Values<TModel> =
  TModel extends TableDefinition<infer TFields, infer TDerived>
    ? RowOf<TFields> & DerivedValues<TDerived>
    : TModel extends AggregateDefinition<
          infer TFields,
          infer TMetric,
          infer _TIndexes,
          infer TSketch
        >
      ? RowOf<TFields> & { -readonly [K in TMetric]: number } & {
          -readonly [K in TSketch]: string;
        }
      : never;

export type TableRow<TModel> = Values<TModel> & EngineColumns;
export type AggregateRow<TModel> = Values<TModel>;

type IndexesOf<TModel> = TModel extends { readonly indexes: infer I }
  ? I
  : never;
type IndexName<TModel> = keyof IndexesOf<TModel> & string;
type IndexFields<
  TModel,
  TIndex,
  TPart extends "eq" | "sort",
> = IndexesOf<TModel>[TIndex & keyof IndexesOf<TModel>] extends {
  readonly [P in TPart]: readonly (infer F)[];
}
  ? F & keyof Values<TModel>
  : never;

type KeyValueOf<TModel, TField extends keyof Values<TModel>> = Exclude<
  Values<TModel>[TField],
  null | readonly unknown[]
>;

type FirstOrderField<TModel, TIndex> = IndexesOf<TModel>[TIndex &
  keyof IndexesOf<TModel>] extends {
  readonly sort: readonly [infer F, ...unknown[]];
}
  ? F & keyof Values<TModel>
  : TModel extends { readonly key: readonly (infer K)[] }
    ? K & keyof Values<TModel>
    : never;

export interface ReadOptions<TModel, TIndex> {
  readonly index: TIndex;
  /** Every eq field of the index; null never matches. */
  readonly where: {
    readonly [F in IndexFields<TModel, TIndex, "eq">]: KeyValueOf<TModel, F>;
  };
  readonly range?: {
    readonly [B in "gt" | "gte" | "lt" | "lte"]?: KeyValueOf<
      TModel,
      FirstOrderField<TModel, TIndex>
    >;
  };
  readonly order?: "asc" | "desc";
  readonly limit: number;
  readonly cursor?: string;
}

type UniqueLookups<TModel> =
  TModel extends TableDefinition<infer TFields, infer _D, infer TIndexes>
    ?
        | {
            [F in keyof TFields]: TFields[F] extends { readonly unique: true }
              ? {
                  readonly [P in F]: KeyValueOf<
                    TModel,
                    P & keyof Values<TModel>
                  >;
                }
              : never;
          }[keyof TFields]
        | {
            [I in keyof TIndexes]: TIndexes[I] extends {
              readonly unique: true;
              readonly eq: readonly (infer E)[];
            }
              ? {
                  readonly [P in E & string]: KeyValueOf<
                    TModel,
                    P & keyof Values<TModel>
                  >;
                }
              : never;
          }[keyof TIndexes]
    : never;

/** The key, or the eq fields of a unique index. */
export type Lookup<TModel> =
  | (TModel extends TableDefinition<infer _F>
      ? {
          readonly [K in TModel["key"][number]]: KeyValueOf<
            TModel,
            K & keyof Values<TModel>
          >;
        }
      : never)
  | UniqueLookups<TModel>;

type RootedIndexName<TModel> = {
  [I in keyof IndexesOf<TModel>]: IndexesOf<TModel>[I] extends {
    readonly root: object;
  }
    ? I
    : never;
}[keyof IndexesOf<TModel>] &
  string;

type OptionalFields<TFields> = {
  [K in keyof TFields]: TFields[K] extends { readonly required: false }
    ? K
    : never;
}[keyof TFields];

/** Declared fields, optional ones omittable; derived fields and engine columns are computed. */
export type CreateRow<TModel> =
  TModel extends TableDefinition<infer TFields>
    ? Omit<RowOf<TFields>, OptionalFields<TFields>> &
        Partial<Pick<RowOf<TFields>, OptionalFields<TFields>>>
    : never;

/** Changed non-key fields. */
export type UpdateSet<TModel> =
  TModel extends TableDefinition<infer TFields, infer _D, infer _I, infer TKey>
    ? Partial<Omit<RowOf<TFields>, TKey[number]>>
    : never;

/** Reads are recorded and guarded at commit; writes apply only if every guard holds. */
export interface HotUpdaterTransaction<S extends ModuleSchema> {
  findOne<M extends TableNames<S>>(
    model: M,
    lookup: Lookup<S[M]>,
  ): Promise<TableRow<S[M]> | null>;
  /** Rooted indexes only: the parent row guards the whole range. */
  findMany<M extends TableNames<S>, I extends RootedIndexName<S[M]>>(
    model: M,
    options: ReadOptions<S[M], I>,
  ): Promise<Page<TableRow<S[M]>>>;
  create<M extends TableNames<S>>(model: M, row: CreateRow<S[M]>): void;
  /** Patches a row this transaction read. */
  update<M extends TableNames<S>>(
    model: M,
    row: TableRow<S[M]>,
    set: UpdateSet<S[M]>,
  ): void;
  /** Deletes a row this transaction read, cascading to its children first. */
  delete<M extends TableNames<S>>(model: M, row: TableRow<S[M]>): Promise<void>;
}

/** A table name, or the reason an aggregate cannot be read this way. */
export type FindManyModel<S extends ModuleSchema, M> =
  M extends TableNames<S>
    ? M
    : "findMany reads tables; read aggregates with findAggregates";

/** An aggregate name, or the reason a table cannot be read this way. */
export type FindAggregatesModel<S extends ModuleSchema, M> =
  M extends AggregateNames<S>
    ? M
    : "findAggregates reads aggregates; read tables with findMany";

/** A module's database handle. There is no count, offset, or free-form filter. */
export interface HotUpdaterDatabase<S extends ModuleSchema> {
  findOne<M extends TableNames<S>>(
    model: M,
    lookup: Lookup<S[M]>,
  ): Promise<TableRow<S[M]> | null>;
  findMany<M extends keyof S & string, I extends IndexName<S[M]>>(
    model: FindManyModel<S, M>,
    options: ReadOptions<S[M], I>,
  ): Promise<Page<TableRow<S[M]>>>;
  findAggregates<M extends keyof S & string, I extends IndexName<S[M]>>(
    model: FindAggregatesModel<S, M>,
    options: ReadOptions<S[M], I>,
  ): Promise<Page<AggregateRow<S[M]>>>;
  /** Reruns `fn` when a guarded read changed, within a jittered retry budget. */
  transaction<R>(fn: (tx: HotUpdaterTransaction<S>) => Promise<R>): Promise<R>;
}

export interface ReadMeasurement<T> {
  readonly result: T;
  /** Point reads and rows the adapter returned. */
  readonly adapter: DatabaseReadCount;
  /** Calls and rows (logical rows for aggregates) returned to callers. */
  readonly engine: EngineReadCount;
}

export interface DatabaseEngineOptions {
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly maxPageSize?: number;
  /** Checks every adapter call against the contract and meters adapter reads. */
  readonly verify?: boolean;
  readonly retry?: RetryOptions;
}

/** The engine over one adapter; `database(module)` hands a module its handle. */
export const createDatabaseEngine = (options: DatabaseEngineOptions) => {
  const verified = options.verify ? verifyAdapter(options.adapter) : undefined;
  const adapter = verified ?? options.adapter;
  const reads = createEngineReads({
    adapter,
    schema: options.schema,
    ...(options.maxPageSize === undefined
      ? {}
      : { maxPageSize: options.maxPageSize }),
  });
  const transactions = createTransactions({
    adapter,
    schema: options.schema,
    reads,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  const outside =
    <A extends unknown[], T>(read: (...args: A) => T) =>
    (...args: A): T => {
      assertOutsideTransaction();
      return read(...args);
    };

  return {
    reads,
    database<S extends ModuleSchema>(
      module: SchemaModule & { readonly schema: S },
    ): HotUpdaterDatabase<S> {
      const name = (model: string) =>
        module.namespace ? `${module.namespace}_${model}` : model;
      return {
        findOne: outside(
          (model, lookup) =>
            reads.findOne(name(model), lookup as never) as never,
        ),
        findMany: outside(
          (model, input) =>
            reads.findMany(name(model), input as ReadInput) as never,
        ),
        findAggregates: outside(
          (model, input) =>
            reads.findAggregates(name(model), input as ReadInput) as never,
        ),
        transaction: (fn) =>
          transactions.transaction((tx: TransactionEngine) =>
            fn({
              findOne: (model, lookup) =>
                tx.findOne(name(model), lookup as never) as never,
              findMany: (model, input) =>
                tx.findMany(name(model), input as ReadInput) as never,
              create: (model, row) => tx.create(name(model), row),
              update: (model, row, set) => tx.update(name(model), row, set),
              delete: (model, row) => tx.delete(name(model), row),
            }),
          ),
      };
    },
    /** Runs `read` and reports what it read at both boundaries (verify mode only). */
    async measureReads<T>(read: () => Promise<T>): Promise<ReadMeasurement<T>> {
      if (verified === undefined) {
        throw new Error(
          "measureReads needs an engine created with verify: true.",
        );
      }
      verified.reads.reset();
      reads.reads.reset();
      const result = await read();
      return {
        result,
        adapter: verified.reads.total(),
        engine: reads.reads.total(),
      };
    },
  };
};

export type DatabaseEngine = ReturnType<typeof createDatabaseEngine>;
