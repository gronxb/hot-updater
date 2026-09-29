/**
 * The model declarations the engine reads. `defineTable` and
 * `defineAggregate` (./schema) build them with typed rows.
 */
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
  /** Strings: ASCII only, so a long key fits MySQL's 3,072-byte index limit. */
  readonly ascii?: true;
  readonly references?: FieldReference;
}

export interface IndexDefinition<TField extends string = string> {
  readonly eq: readonly TField[];
  readonly sort: readonly TField[];
  /** The eq values identify at most one row. */
  readonly unique?: true;
  /** `eq` starts with the key of a `model` row, which every child write bumps. */
  readonly root?: { readonly model: string };
}

/** A field computed on every write and stored as a real column. */
export interface DerivedShape {
  readonly type: FieldType;
  /** Up to 16 values; the row is indexed once per value. */
  readonly multi?: true;
  /** Null, or an empty list, leaves the row out of indexes on this field. */
  compute(row: never): unknown;
}

export interface TableShape {
  readonly kind: "table";
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly key: readonly string[];
  readonly derived: Readonly<Record<string, DerivedShape>>;
  readonly indexes: Readonly<Record<string, IndexDefinition>>;
}

export interface AggregateShape {
  readonly kind: "aggregate";
  /** Identity fields; `key` lists them in declaration order. */
  readonly fields: Readonly<Record<string, FieldDefinition>>;
  readonly key: readonly string[];
  /** Blind increments. */
  readonly counters: readonly string[];
  /** Read, merged, and written back per shard; a row at zero is deleted. */
  readonly gauges: readonly string[];
  /** HLL sketches, kept in aggregates of their own. */
  readonly distinct: readonly string[];
  /** Fixed once data exists. */
  readonly shards: number;
  readonly indexes: Readonly<Record<string, IndexDefinition>>;
}

export type ModelShape = TableShape | AggregateShape;

/** A module's models by name: core, or one plugin. */
export type SchemaShape = Readonly<Record<string, ModelShape>>;
