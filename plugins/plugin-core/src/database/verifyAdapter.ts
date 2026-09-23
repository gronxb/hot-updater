import {
  type DatabaseAdapter,
  type DatabaseKey,
  DATABASE_MAX_QUERY_LIMIT,
  DATABASE_VERSION_COLUMN,
  findPhysicalIndex,
  type PhysicalTable,
  type QueryRequest,
  rowKey,
  type StoredRow,
  type WriteOp,
} from "./adapter";
import {
  compareTuples,
  indexOrderTuple,
  isKeyValue,
  matchesQuery,
} from "./values";

export class DatabaseAdapterContractError extends Error {
  readonly name = "DatabaseAdapterContractError";
}

export interface DatabaseReadCount {
  /** `get` calls and the keys they asked for, found or not. */
  readonly gets: number;
  readonly keys: number;
  /** `query` calls, zero-row calls included, and the rows they returned. */
  readonly queries: number;
  readonly rows: number;
}

export interface DatabaseReadMeter {
  total(): DatabaseReadCount;
  byTable(table: string): DatabaseReadCount;
  reset(): void;
}

export interface VerifiedDatabaseAdapter extends DatabaseAdapter {
  readonly reads: DatabaseReadMeter;
}

export interface VerifyAdapterOptions {
  /** After a short page, probe once past its last row to prove the range ended. */
  readonly probeShortPages?: boolean;
}

const EMPTY: DatabaseReadCount = { gets: 0, keys: 0, queries: 0, rows: 0 };

const createReadMeter = () => {
  const tables = new Map<string, DatabaseReadCount>();
  const add = (table: string, count: Partial<DatabaseReadCount>) => {
    const current = tables.get(table) ?? EMPTY;
    tables.set(table, {
      gets: current.gets + (count.gets ?? 0),
      keys: current.keys + (count.keys ?? 0),
      queries: current.queries + (count.queries ?? 0),
      rows: current.rows + (count.rows ?? 0),
    });
  };
  const meter: DatabaseReadMeter = {
    total: () =>
      [...tables.values()].reduce(
        (sum, count) => ({
          gets: sum.gets + count.gets,
          keys: sum.keys + count.keys,
          queries: sum.queries + count.queries,
          rows: sum.rows + count.rows,
        }),
        EMPTY,
      ),
    byTable: (table) => tables.get(table) ?? EMPTY,
    reset: () => tables.clear(),
  };
  return { add, meter };
};

const fail = (message: string): never => {
  throw new DatabaseAdapterContractError(message);
};

const sameKey = (left: DatabaseKey, right: DatabaseKey) =>
  left.length === right.length && compareTuples(left, right) === 0;

const verifyRequest = (table: PhysicalTable, request: QueryRequest) => {
  const index = findPhysicalIndex(table, request.index);
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > DATABASE_MAX_QUERY_LIMIT
  ) {
    fail(`query limit must be 1–${DATABASE_MAX_QUERY_LIMIT}.`);
  }
  if (request.eq.length !== index.eq.length || !request.eq.every(isKeyValue)) {
    fail(`query on ${table.name}.${index.name} must bind every eq column.`);
  }
  return index;
};

const verifyRows = (
  table: PhysicalTable,
  request: QueryRequest,
  rows: readonly StoredRow[],
) => {
  const index = findPhysicalIndex(table, request.index);
  if (rows.length > request.limit) {
    fail(
      `${table.name}.${index.name} returned more than ${request.limit} rows.`,
    );
  }
  let previous: DatabaseKey | undefined;
  for (const row of rows) {
    if (!matchesQuery(table, index, request, row)) {
      fail(`${table.name}.${index.name} returned a row outside the request.`);
    }
    const tuple = indexOrderTuple(table, index, row);
    if (previous !== undefined) {
      const order = compareTuples(previous, tuple);
      if (request.order === "asc" ? order >= 0 : order <= 0) {
        fail(`${table.name}.${index.name} returned rows out of order.`);
      }
    }
    previous = tuple;
  }
  return previous;
};

const verifyWrite = (adapter: DatabaseAdapter, ops: readonly WriteOp[]) => {
  if (ops.length === 0) fail("write needs at least one op.");
  const seen = new Set<string>();
  for (const op of ops) {
    const key = op.type === "insert" ? rowKey(op.table, op.row) : op.key;
    const id = JSON.stringify([op.table.name, key]);
    if (seen.has(id)) fail(`write touches ${op.table.name} ${id} twice.`);
    seen.add(id);
    if (
      op.type === "insert" &&
      typeof op.row[DATABASE_VERSION_COLUMN] !== "number"
    ) {
      fail(`insert into ${op.table.name} must set ${DATABASE_VERSION_COLUMN}.`);
    }
    if (
      op.type === "patch" &&
      Object.keys(op.set).some(
        (column) =>
          column === DATABASE_VERSION_COLUMN || op.table.key.includes(column),
      )
    ) {
      fail(
        `patch of ${op.table.name} may not set key columns or ${DATABASE_VERSION_COLUMN}.`,
      );
    }
  }
  if (!adapter.fits(ops)) fail("write does not fit in one atomic write.");
};

/** Wraps an adapter to check the contract at its boundary and count reads. */
export const verifyAdapter = (
  adapter: DatabaseAdapter,
  options: VerifyAdapterOptions = {},
): VerifiedDatabaseAdapter => {
  const { add, meter } = createReadMeter();
  return {
    ...adapter,
    id: adapter.id,
    reads: meter,
    fits: (ops) => adapter.fits(ops),
    async get(table, keys) {
      const rows = await adapter.get(table, keys);
      add(table.name, { gets: 1, keys: keys.length });
      if (rows.length !== keys.length) {
        fail(
          `${table.name} get returned ${rows.length} rows for ${keys.length} keys.`,
        );
      }
      rows.forEach((row, position) => {
        if (row !== null && !sameKey(rowKey(table, row), keys[position]!)) {
          fail(`${table.name} get returned a row for another key.`);
        }
      });
      return rows;
    },
    async query(table, request) {
      const index = verifyRequest(table, request);
      const rows = await adapter.query(table, request);
      add(table.name, { queries: 1, rows: rows.length });
      const last = verifyRows(table, request, rows);
      if (
        options.probeShortPages &&
        last !== undefined &&
        rows.length < request.limit
      ) {
        const bound = { values: last, inclusive: false };
        const probe = await adapter.query(table, {
          ...request,
          limit: 1,
          ...(request.order === "asc" ? { lower: bound } : { upper: bound }),
        });
        if (probe.length > 0) {
          fail(
            `${table.name}.${index.name} returned a short page before the range ended.`,
          );
        }
      }
      return rows;
    },
    async write(ops) {
      verifyWrite(adapter, ops);
      const result = await adapter.write(ops);
      if (!result.ok && "failedOp" in result) {
        if (
          !Number.isSafeInteger(result.failedOp) ||
          result.failedOp < 0 ||
          result.failedOp >= ops.length
        ) {
          fail(
            `write reported failedOp ${result.failedOp} for ${ops.length} ops.`,
          );
        }
      }
      return result;
    },
  };
};
