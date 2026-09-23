import type { DatabaseJson } from "@hot-updater/plugin-core/internal";

export type FieldType = "string" | "integer" | "number" | "boolean" | "json";

export type ReferenceAction = "restrict" | "cascade" | "none";

export interface FieldReference {
  readonly model: string;
  readonly onDelete: ReferenceAction;
}

export interface FieldDefinition<TType extends FieldType = FieldType> {
  readonly type: TType;
  /** Defaults to true; an optional field stores null. */
  readonly required?: boolean;
  /** Adds a unique index named after the field. */
  readonly unique?: true;
  /** Strings: the maximum length; unbounded text when absent. */
  readonly maxLength?: number;
  readonly references?: FieldReference;
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

export interface IndexDefinition<TField extends string = string> {
  readonly eq: readonly TField[];
  readonly sort: readonly TField[];
  /** The eq values identify at most one row. */
  readonly unique?: true;
  /** `eq` starts with the key of a `model` row, which every child write bumps. */
  readonly root?: { readonly model: string };
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
> {
  readonly kind: "table";
  readonly fields: TFields;
  readonly key: readonly (keyof TFields & string)[];
  readonly derived: DerivedFields<TFields, TDerived>;
  readonly indexes: TIndexes;
}

export const defineTable = <
  const TFields extends Fields,
  const TDerived extends DerivedTypes = {},
  const TIndexes extends Indexes = {},
>(
  fields: TFields,
  options: {
    readonly key: readonly NoInfer<keyof TFields & string>[];
    readonly derived?: DerivedFields<TFields, TDerived>;
    readonly indexes?: TIndexes &
      CheckIndexes<TIndexes, (keyof TFields | keyof TDerived) & string>;
  },
): TableDefinition<TFields, TDerived, TIndexes> => ({
  kind: "table",
  fields,
  key: options.key,
  derived: options.derived ?? ({} as DerivedFields<TFields, TDerived>),
  indexes: options.indexes ?? ({} as TIndexes),
});

export interface AggregateDefinition<
  TFields extends Fields = Fields,
  TMetric extends string = string,
  TIndexes extends Indexes = Indexes,
> {
  readonly kind: "aggregate";
  /** Identity fields; `key` lists them in declaration order. */
  readonly fields: TFields;
  readonly key: readonly (keyof TFields & string)[];
  /** Blind increments. */
  readonly counters: readonly TMetric[];
  /** Read, merged, and written back per shard; a row at zero is deleted. */
  readonly gauges: readonly TMetric[];
  /** HLL sketches, kept in aggregates of their own. */
  readonly distinct: readonly TMetric[];
  /** Fixed once data exists. */
  readonly shards: number;
  readonly indexes: TIndexes;
}

export const defineAggregate = <
  const TFields extends Fields,
  const TMetric extends string = never,
  const TIndexes extends Indexes = {},
>(
  fields: TFields,
  options: {
    readonly key: readonly NoInfer<keyof TFields & string>[];
    readonly counters?: readonly TMetric[];
    readonly gauges?: readonly TMetric[];
    readonly distinct?: readonly TMetric[];
    readonly shards?: number;
    readonly indexes?: TIndexes &
      CheckIndexes<TIndexes, keyof TFields & string>;
  },
): AggregateDefinition<TFields, TMetric, TIndexes> => ({
  kind: "aggregate",
  fields,
  key: options.key,
  counters: options.counters ?? [],
  gauges: options.gauges ?? [],
  distinct: options.distinct ?? [],
  shards: options.shards ?? 1,
  indexes: options.indexes ?? ({} as TIndexes),
});

export type ModelDefinition = TableDefinition | AggregateDefinition;

/** A module's models by name: core, or one plugin. */
export type ModuleSchema = Readonly<Record<string, ModelDefinition>>;
