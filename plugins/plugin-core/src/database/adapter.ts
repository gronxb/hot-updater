/**
 * The storage adapter contract. An adapter implements `get`, `query`, and
 * `write` with its backend's native features and knows nothing about Hot
 * Updater's domain or plugins. Unstable until the redesign ships (E4).
 */

export type DatabaseJson =
  | null
  | boolean
  | number
  | string
  | readonly DatabaseJson[]
  | { readonly [key: string]: DatabaseJson };

/** A stored value: a string, number, boolean, null, or JSON document. */
export type DatabaseValue = DatabaseJson;

/** A value allowed in keys and indexes. */
export type DatabaseKeyValue = string | number | boolean;

/** Primary-key values in the table's key-column order. */
export type DatabaseKey = readonly DatabaseKeyValue[];

export type StoredRow = { readonly [column: string]: DatabaseValue };

/** `integer` holds safe integers; `number` holds any finite number. */
export type PhysicalColumnType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "json";

export interface PhysicalColumn {
  readonly name: string;
  readonly type: PhysicalColumnType;
  readonly nullable: boolean;
  /** Strings only: the maximum length in UTF-16 code units; unbounded text when absent. */
  readonly maxLength?: number;
  /** Strings only: ASCII text, stored in single bytes where a backend limits index size (MySQL). */
  readonly ascii?: true;
  /** A whole number the backend stores when a writer omits the column; the engine's own columns default to 0. */
  readonly default?: number;
  /** A multi-valued field: an array of 1–16 values of `type`, indexable in `eq` only. */
  readonly multi?: true;
}

export interface PhysicalIndex {
  readonly name: string;
  readonly eq: readonly string[];
  readonly sort: readonly string[];
  /** The `eq` values identify at most one row. */
  readonly unique?: true;
}

export interface PhysicalTable {
  /** The logical name; each adapter applies its own table prefix. */
  readonly name: string;
  readonly columns: readonly PhysicalColumn[];
  /** Primary-key columns, in order. */
  readonly key: readonly string[];
  readonly indexes: readonly PhysicalIndex[];
}

export interface QueryBound {
  /** A prefix of the index's order columns (see `indexOrderColumns`). */
  readonly values: readonly DatabaseKeyValue[];
  readonly inclusive: boolean;
}

export interface QueryRequest {
  readonly index: string;
  /** Values for the index's `eq` columns, in order. */
  readonly eq: readonly DatabaseKeyValue[];
  readonly lower?: QueryBound;
  readonly upper?: QueryBound;
  readonly order: "asc" | "desc";
  /** 1–500 rows. */
  readonly limit: number;
}

/** The row's `_v` at read time. */
export interface WriteGuard {
  readonly v: number;
}

/** At most one op per (table, key); guards see the pre-write state. */
export type WriteOp =
  | {
      readonly type: "insert";
      readonly table: PhysicalTable;
      /** The complete row, `_v` included; the key must not exist. */
      readonly row: StoredRow;
    }
  | {
      readonly type: "patch";
      readonly table: PhysicalTable;
      readonly key: DatabaseKey;
      /** Named non-key columns only; the adapter sets `_v` to `guard.v + 1`. */
      readonly set: StoredRow;
      readonly guard: WriteGuard;
      readonly previous: StoredRow;
    }
  | {
      readonly type: "delete";
      readonly table: PhysicalTable;
      readonly key: DatabaseKey;
      readonly guard: WriteGuard;
      readonly previous: StoredRow;
    }
  | {
      readonly type: "increment";
      readonly table: PhysicalTable;
      readonly key: DatabaseKey;
      readonly by: Readonly<Record<string, number>>;
      /** The row to create, before `by` applies, when the key does not exist. */
      readonly init?: StoredRow;
      readonly guard?: WriteGuard;
    }
  | {
      readonly type: "check";
      readonly table: PhysicalTable;
      readonly key: DatabaseKey;
      readonly guard: WriteGuard;
    };

export type WriteResult =
  | { readonly ok: true }
  /** A guard failed, unique violations and missing rows included. */
  | { readonly ok: false; readonly failedOp: number }
  /** Transient: deadlock, serialization, SQLITE_BUSY, TransactionConflict, ABORTED. */
  | { readonly ok: false; readonly retry: true };

export interface DatabaseAdapter {
  readonly id: string;
  /** True when the ops commit atomically in one write. */
  fits(ops: readonly WriteOp[]): boolean;
  /** Strongly consistent batch point read; results follow the order of keys. */
  get(
    table: PhysicalTable,
    keys: readonly DatabaseKey[],
  ): Promise<readonly (StoredRow | null)[]>;
  /** Index range read; loops native pages until `limit` rows or the range ends, never a short page. */
  query(
    table: PhysicalTable,
    request: QueryRequest,
  ): Promise<readonly StoredRow[]>;
  write(ops: readonly WriteOp[]): Promise<WriteResult>;
  /** Called only by `@hot-updater/server/db` tooling. */
  readonly migrations?: {
    apply(tables: readonly PhysicalTable[]): Promise<void>;
  };
  dispose?(): Promise<void>;
}

export const DATABASE_VERSION_COLUMN = "_v";
export const DATABASE_MAX_QUERY_LIMIT = 500;
export const DATABASE_MAX_MULTI_VALUES = 16;

export class DatabaseSchemaError extends Error {
  readonly name = "DatabaseSchemaError";
}

export const findPhysicalColumn = (
  table: PhysicalTable,
  name: string,
): PhysicalColumn => {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (column === undefined) {
    throw new DatabaseSchemaError(`${table.name} has no column ${name}.`);
  }
  return column;
};

export const findPhysicalIndex = (
  table: PhysicalTable,
  name: string,
): PhysicalIndex => {
  const index = table.indexes.find((candidate) => candidate.name === name);
  if (index === undefined) {
    throw new DatabaseSchemaError(`${table.name} has no index ${name}.`);
  }
  return index;
};

/**
 * The columns that order an index read and close its cursors: the sort
 * columns, then the key columns that neither `eq` nor `sort` fixes.
 */
export const indexOrderColumns = (
  table: PhysicalTable,
  index: PhysicalIndex,
): readonly string[] => [
  ...index.sort,
  ...table.key.filter(
    (column) => !index.sort.includes(column) && !index.eq.includes(column),
  ),
];

/** The primary key of a row, in key-column order. */
export const rowKey = (table: PhysicalTable, row: StoredRow): DatabaseKey =>
  table.key.map((column) => {
    const value = row[column];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new DatabaseSchemaError(
        `${table.name}.${column} is a key column and must be a string, number, or boolean.`,
      );
    }
    return value;
  });
