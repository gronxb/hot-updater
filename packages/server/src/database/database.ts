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
  readonly [K in `_refs_${string}`]?: number;
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
}

/** The engine over one adapter; `database(module)` hands a module its handle. */
export const createDatabaseEngine = (options: DatabaseEngineOptions) => {
  const verified = options.verify ? verifyAdapter(options.adapter) : undefined;
  const reads = createEngineReads({
    adapter: verified ?? options.adapter,
    schema: options.schema,
    ...(options.maxPageSize === undefined
      ? {}
      : { maxPageSize: options.maxPageSize }),
  });
  const tableName = (module: SchemaModule, model: string) =>
    module.namespace ? `${module.namespace}_${model}` : model;

  return {
    reads,
    database<S extends ModuleSchema>(
      module: SchemaModule & { readonly schema: S },
    ): HotUpdaterDatabase<S> {
      return {
        findOne: (model, lookup) =>
          reads.findOne(
            tableName(module, model),
            lookup as Record<string, never>,
          ) as never,
        findMany: (model, input) =>
          reads.findMany(tableName(module, model), input as ReadInput) as never,
        findAggregates: (model, input) =>
          reads.findAggregates(
            tableName(module, model),
            input as ReadInput,
          ) as never,
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
