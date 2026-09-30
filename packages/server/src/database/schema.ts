import type { DatabaseJson } from "@hot-updater/plugin-core/internal";

import type {
  AggregateShape,
  FieldDefinition,
  FieldType,
  IndexDefinition,
  TableShape,
} from "./definitions";

export type {
  FieldDefinition,
  FieldReference,
  FieldType,
  IndexDefinition,
  ReferenceAction,
} from "./definitions";

/**
 * How long a model keeps its rows: `days` past the epoch milliseconds in
 * `field`, an integer field (a table's derived one too, where null keeps
 * the row). Expired rows are deleted without cascades, so a model with
 * retention is in no reference and no rooted index.
 */
export interface RetentionDefinition<TField extends string = string> {
  readonly field: TField;
  readonly days: number;
}

export type FieldValue<TType extends FieldType> = TType extends "string"
  ? string
  : TType extends "integer" | "number"
    ? number
    : TType extends "boolean"
      ? boolean
      : DatabaseJson;

type Fields = Readonly<Record<string, FieldDefinition>>;

export type RowOf<TFields extends Fields> = {
  -readonly [K in keyof TFields]: TFields[K] extends FieldDefinition<
    infer TType
  >
    ? TFields[K] extends { readonly required: false }
      ? FieldValue<TType> | null
      : FieldValue<TType>
    : never;
};

/** Computed on every write and stored as a real column. */
export interface DerivedDefinition<
  TRow = never,
  TType extends FieldType = FieldType,
> {
  readonly type: TType;
  /** Up to 16 values; the row is indexed once per value. */
  readonly multi?: true;
  /** Null, or an empty list, leaves the row out of indexes on this field. */
  compute(row: TRow): FieldValue<TType> | null | readonly FieldValue<TType>[];
}

type DerivedTypes = Readonly<Record<string, FieldType>>;

/** Derived fields over a table's row, by name. */
export type DerivedFields<
  TFields extends Fields,
  TDerived extends DerivedTypes,
> = {
  readonly [K in keyof TDerived]: DerivedDefinition<
    RowOf<TFields>,
    TDerived[K]
  >;
};

type Indexes = Readonly<Record<string, IndexDefinition>>;

/** The integer fields, declared or derived, that retention can count from. */
type IntegerFields<TFields extends Fields, TDerived extends DerivedTypes> =
  | {
      [K in keyof TFields]: TFields[K] extends { readonly type: "integer" }
        ? K
        : never;
    }[keyof TFields]
  | {
      [K in keyof TDerived]: TDerived[K] extends "integer" ? K : never;
    }[keyof TDerived];

type MissingFields<TIndex, TNames extends string> = TIndex extends {
  readonly eq: readonly (infer TEq)[];
  readonly sort: readonly (infer TSort)[];
}
  ? Exclude<TEq | TSort, TNames>
  : never;

/** Maps an index to an error message when it names an undeclared field. */
export type CheckIndex<
  TName extends PropertyKey,
  TIndex,
  TNames extends string,
> = [MissingFields<TIndex, TNames>] extends [never]
  ? TIndex
  : `Index "${TName & string}" names undeclared field "${MissingFields<TIndex, TNames> & string}"`;

type CheckIndexes<TIndexes, TNames extends string> = {
  readonly [K in keyof TIndexes]: CheckIndex<K, TIndexes[K], TNames>;
};

export interface TableDefinition<
  TFields extends Fields = Fields,
  TDerived extends DerivedTypes = DerivedTypes,
  TIndexes extends Indexes = Indexes,
  TKey extends readonly (keyof TFields & string)[] = readonly (keyof TFields &
    string)[],
> extends TableShape {
  readonly kind: "table";
  readonly fields: TFields;
  readonly key: TKey;
  readonly derived: DerivedFields<TFields, TDerived>;
  readonly indexes: TIndexes;
}

export const defineTable = <
  const TFields extends Fields,
  const TKey extends readonly (keyof TFields & string)[],
  const TDerived extends DerivedTypes = {},
  const TIndexes extends Indexes = {},
>(
  fields: TFields,
  options: {
    readonly key: TKey;
    readonly derived?: DerivedFields<TFields, TDerived>;
    readonly indexes?: TIndexes &
      CheckIndexes<TIndexes, (keyof TFields | keyof TDerived) & string>;
    /** Rows expire `days` after the epoch milliseconds in `field`. */
    readonly retention?: RetentionDefinition<
      IntegerFields<TFields, TDerived> & string
    >;
  },
): TableDefinition<TFields, TDerived, TIndexes, TKey> => ({
  kind: "table",
  fields,
  key: options.key,
  derived: options.derived ?? ({} as DerivedFields<TFields, TDerived>),
  indexes: options.indexes ?? ({} as TIndexes),
  ...(options.retention === undefined ? {} : { retention: options.retention }),
});

export interface AggregateDefinition<
  TFields extends Fields = Fields,
  TMetric extends string = string,
  TIndexes extends Indexes = Indexes,
  TSketch extends string = string,
  TKey extends readonly (keyof TFields & string)[] = readonly (keyof TFields &
    string)[],
> extends AggregateShape {
  readonly kind: "aggregate";
  readonly fields: TFields;
  readonly key: TKey;
  readonly counters: readonly TMetric[];
  readonly gauges: readonly TMetric[];
  readonly distinct: readonly TSketch[];
  readonly indexes: TIndexes;
  /**
   * On a database that batches aggregates, changes apply after their
   * transaction commits, in one write per row with other transactions'
   * changes, so reads may lag them. Elsewhere they commit with it.
   */
  readonly batched?: true;
}

export const defineAggregate = <
  const TFields extends Fields,
  const TKey extends readonly (keyof TFields & string)[],
  const TMetric extends string = never,
  const TIndexes extends Indexes = {},
  const TSketch extends string = never,
>(
  fields: TFields,
  options: {
    readonly key: TKey;
    readonly counters?: readonly TMetric[];
    readonly gauges?: readonly TMetric[];
    readonly distinct?: readonly TSketch[];
    readonly shards?: number;
    readonly indexes?: TIndexes &
      CheckIndexes<TIndexes, keyof TFields & string>;
    readonly batched?: true;
    /**
     * Rows expire `days` after the epoch milliseconds in `field`, an
     * identity field such as a bucket's start; a change to a row already
     * past it is dropped, so a late gauge decrement never goes below zero.
     */
    readonly retention?: RetentionDefinition<
      IntegerFields<TFields, {}> & string
    >;
  },
): AggregateDefinition<TFields, TMetric, TIndexes, TSketch, TKey> => ({
  kind: "aggregate",
  fields,
  key: options.key,
  counters: options.counters ?? [],
  gauges: options.gauges ?? [],
  distinct: options.distinct ?? [],
  shards: options.shards ?? 1,
  indexes: options.indexes ?? ({} as TIndexes),
  ...(options.batched ? { batched: true } : {}),
  ...(options.retention === undefined ? {} : { retention: options.retention }),
});

export type ModelDefinition = TableDefinition | AggregateDefinition;

/** A module's models by name: core, or one plugin. */
export type ModuleSchema = Readonly<Record<string, ModelDefinition>>;
