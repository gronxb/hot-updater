import {
  DATABASE_MAX_MULTI_VALUES,
  type DatabaseKey,
  type DatabaseKeyValue,
  type DatabaseValue,
  findPhysicalColumn,
  indexOrderColumns,
  type PhysicalColumn,
  type PhysicalIndex,
  type PhysicalTable,
  type QueryBound,
  type QueryRequest,
  type StoredRow,
} from "./adapter";

export class DatabaseValueError extends Error {
  readonly name = "DatabaseValueError";
}

/** Compares strings in UTF-8 byte order, which is Unicode code point order. */
export const compareUtf8 = (left: string, right: string): number => {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  const leftDone = leftIndex >= left.length;
  const rightDone = rightIndex >= right.length;
  return leftDone === rightDone ? 0 : leftDone ? -1 : 1;
};

/** Orders strings by UTF-8 bytes, numbers numerically, and false before true. */
export const compareKeyValues = (
  left: DatabaseKeyValue,
  right: DatabaseKeyValue,
): number => {
  if (typeof left === "string" && typeof right === "string") {
    return compareUtf8(left, right);
  }
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  throw new DatabaseValueError(
    `Cannot compare ${typeof left} with ${typeof right}.`,
  );
};

/** Compares tuples element by element; a shorter equal prefix sorts first. */
export const compareTuples = (
  left: readonly DatabaseKeyValue[],
  right: readonly DatabaseKeyValue[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const result = compareKeyValues(left[index]!, right[index]!);
    if (result !== 0) return result;
  }
  return left.length - right.length;
};

/** JSON text with object keys sorted, so a value compares equal after a store reorders map keys. */
export const canonicalJson = (value: DatabaseValue | undefined): string =>
  JSON.stringify(value ?? null, (_, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([left], [right]) =>
            compareUtf8(left, right),
          ),
        )
      : inner,
  );

export const isKeyValue = (value: unknown): value is DatabaseKeyValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** Every `eq` tuple a row is indexed under; none when an index field is null. */
export const indexEntries = (
  table: PhysicalTable,
  index: PhysicalIndex,
  row: StoredRow,
): readonly DatabaseKey[] => {
  if (index.sort.some((column) => !isKeyValue(row[column]))) return [];
  let entries: DatabaseKeyValue[][] = [[]];
  for (const column of index.eq) {
    const value = row[column];
    const values = findPhysicalColumn(table, column).multi
      ? Array.isArray(value)
        ? value.filter(isKeyValue)
        : []
      : isKeyValue(value)
        ? [value]
        : [];
    if (values.length === 0) return [];
    entries = entries.flatMap((entry) =>
      [...new Set(values)].map((item) => [...entry, item]),
    );
  }
  return entries;
};

/** The row's position in an index read, following `indexOrderColumns`. */
export const indexOrderTuple = (
  table: PhysicalTable,
  index: PhysicalIndex,
  row: StoredRow,
): DatabaseKey =>
  indexOrderColumns(table, index).map((column) => {
    const value = row[column];
    if (!isKeyValue(value)) {
      throw new DatabaseValueError(
        `${table.name}.${column} is not orderable for index ${index.name}.`,
      );
    }
    return value;
  });

const satisfiesBound = (
  tuple: DatabaseKey,
  bound: QueryBound | undefined,
  side: "lower" | "upper",
): boolean => {
  if (bound === undefined) return true;
  const result = compareTuples(
    tuple.slice(0, bound.values.length),
    bound.values,
  );
  if (result === 0) return bound.inclusive;
  return side === "lower" ? result > 0 : result < 0;
};

/** Whether a stored row belongs to the result range of a query. */
export const matchesQuery = (
  table: PhysicalTable,
  index: PhysicalIndex,
  request: QueryRequest,
  row: StoredRow,
): boolean =>
  indexEntries(table, index, row).some(
    (entry) => compareTuples(entry, request.eq) === 0,
  ) &&
  satisfiesBound(indexOrderTuple(table, index, row), request.lower, "lower") &&
  satisfiesBound(indexOrderTuple(table, index, row), request.upper, "upper");

const INTEGER_TEXT = /^-?\d+$/u;
const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/iu;

const toNumber = (raw: unknown, integer: boolean): number => {
  const text =
    typeof raw === "bigint"
      ? raw.toString()
      : typeof raw === "string"
        ? raw
        : typeof raw === "object" && raw !== null && "toString" in raw
          ? String(raw)
          : undefined;
  const value =
    typeof raw === "number"
      ? raw
      : text !== undefined && (integer ? INTEGER_TEXT : NUMBER_TEXT).test(text)
        ? Number(text)
        : Number.NaN;
  if (integer ? !Number.isSafeInteger(value) : !Number.isFinite(value)) {
    throw new DatabaseValueError(
      `Expected a ${integer ? "safe integer" : "finite number"}.`,
    );
  }
  return value;
};

const toBoolean = (raw: unknown): boolean => {
  if (raw === true || raw === 1 || raw === 1n || raw === "1" || raw === "t") {
    return true;
  }
  if (raw === false || raw === 0 || raw === 0n || raw === "0" || raw === "f") {
    return false;
  }
  if (raw === "true" || raw === "false") return raw === "true";
  throw new DatabaseValueError("Expected a boolean.");
};

const toScalar = (column: PhysicalColumn, raw: unknown): DatabaseValue => {
  switch (column.type) {
    case "string":
      if (typeof raw !== "string") {
        throw new DatabaseValueError(`Expected a string in ${column.name}.`);
      }
      return raw;
    case "integer":
    case "number":
      return toNumber(raw, column.type === "integer");
    case "boolean":
      return toBoolean(raw);
    case "json":
      return raw as DatabaseValue;
  }
};

export interface NormalizeOptions {
  /** The backend returns JSON and multi-valued columns as text. */
  readonly jsonText: boolean;
}

/** Converts a backend value (int8 text, BigInt, Decimal, 0/1, JSON text) to a stored value. */
export const normalizeStoredValue = (
  column: PhysicalColumn,
  raw: unknown,
  options: NormalizeOptions,
): DatabaseValue => {
  if (raw === null || raw === undefined) return null;
  const parsed =
    options.jsonText &&
    (column.multi || column.type === "json") &&
    typeof raw === "string"
      ? (JSON.parse(raw) as unknown)
      : raw;
  if (!column.multi) return toScalar(column, parsed);
  if (!Array.isArray(parsed) || parsed.length > DATABASE_MAX_MULTI_VALUES) {
    throw new DatabaseValueError(
      `Expected at most ${DATABASE_MAX_MULTI_VALUES} values in ${column.name}.`,
    );
  }
  return parsed.map((item) => toScalar(column, item));
};

/** Converts every column of a backend row; unknown backend columns are dropped. */
export const normalizeStoredRow = (
  table: PhysicalTable,
  raw: Readonly<Record<string, unknown>>,
  options: NormalizeOptions,
): StoredRow =>
  Object.fromEntries(
    table.columns.map((column) => [
      column.name,
      normalizeStoredValue(column, raw[column.name], options),
    ]),
  );
