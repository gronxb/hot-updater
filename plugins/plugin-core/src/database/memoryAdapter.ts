import {
  type DatabaseAdapter,
  type DatabaseKey,
  DATABASE_VERSION_COLUMN,
  findPhysicalIndex,
  type PhysicalTable,
  rowKey,
  type StoredRow,
  type WriteOp,
} from "./adapter";
import {
  compareTuples,
  indexEntries,
  indexOrderTuple,
  matchesQuery,
} from "./values";

export interface MemoryAdapterOptions {
  readonly tablePrefix?: string;
  /** Test-only: the most ops `fits()` accepts. */
  readonly maxOps?: number;
  /** Test-only: rows per internal page, so `query` has to loop pages. */
  readonly nativePageSize?: number;
}

type Rows = Map<string, StoredRow>;

const keyId = (key: DatabaseKey): string => JSON.stringify(key);

const numberOf = (value: unknown): number =>
  typeof value === "number" ? value : 0;

const violatesUnique = (
  table: PhysicalTable,
  rows: Rows,
  id: string,
  row: StoredRow,
): boolean =>
  table.indexes.some((index) => {
    if (!index.unique) return false;
    const entries = indexEntries(table, index, row);
    return (
      entries.length > 0 &&
      [...rows].some(
        ([otherId, other]) =>
          otherId !== id &&
          indexEntries(table, index, other).some((entry) =>
            entries.some((candidate) => compareTuples(entry, candidate) === 0),
          ),
      )
    );
  });

const putRow = (
  table: PhysicalTable,
  rows: Rows,
  id: string,
  row: StoredRow,
): boolean => {
  if (violatesUnique(table, rows, id, row)) return false;
  rows.set(id, row);
  return true;
};

/** Applies one op to a draft; false means its guard or a constraint failed. */
const applyOp = (rows: Rows, op: WriteOp): boolean => {
  const id = keyId(op.type === "insert" ? rowKey(op.table, op.row) : op.key);
  const current = rows.get(id);
  const version = numberOf(current?.[DATABASE_VERSION_COLUMN]);
  switch (op.type) {
    case "insert":
      return (
        current === undefined &&
        putRow(op.table, rows, id, structuredClone(op.row))
      );
    case "patch":
      return (
        current !== undefined &&
        version === op.guard.v &&
        putRow(op.table, rows, id, {
          ...current,
          ...structuredClone(op.set),
          [DATABASE_VERSION_COLUMN]: version + 1,
        })
      );
    case "delete":
      return current !== undefined && version === op.guard.v && rows.delete(id);
    case "increment": {
      const base = current ?? op.init;
      if (
        base === undefined ||
        (op.guard !== undefined &&
          (current === undefined || version !== op.guard.v))
      ) {
        return false;
      }
      const next: Record<string, unknown> = structuredClone(base);
      for (const [column, delta] of Object.entries(op.by)) {
        next[column] = numberOf(base[column]) + delta;
      }
      next[DATABASE_VERSION_COLUMN] =
        numberOf(base[DATABASE_VERSION_COLUMN]) + 1;
      return putRow(op.table, rows, id, next as StoredRow);
    }
    case "check":
      return current !== undefined && version === op.guard.v;
  }
};

/**
 * The reference adapter: every read is a consistent snapshot and every write
 * applies to a copy that replaces the state only when all ops succeed.
 */
export const createMemoryAdapter = (
  options: MemoryAdapterOptions = {},
): DatabaseAdapter => {
  const prefix = options.tablePrefix ?? "";
  let state = new Map<string, Rows>();
  const rowsOf = (table: PhysicalTable): Rows =>
    state.get(prefix + table.name) ?? new Map();

  return {
    id: "memory",
    fits: (ops) => ops.length <= (options.maxOps ?? Number.POSITIVE_INFINITY),
    async get(table, keys) {
      const rows = rowsOf(table);
      return keys.map((key) => {
        const row = rows.get(keyId(key));
        return row === undefined ? null : structuredClone(row);
      });
    },
    async query(table, request) {
      const index = findPhysicalIndex(table, request.index);
      const direction = request.order === "asc" ? 1 : -1;
      const ordered = [...rowsOf(table).values()]
        .filter((row) => matchesQuery(table, index, request, row))
        .sort(
          (left, right) =>
            direction *
            compareTuples(
              indexOrderTuple(table, index, left),
              indexOrderTuple(table, index, right),
            ),
        );
      const pageSize = options.nativePageSize ?? request.limit;
      const rows: StoredRow[] = [];
      while (rows.length < request.limit) {
        const page = ordered.slice(
          rows.length,
          rows.length + Math.min(pageSize, request.limit - rows.length),
        );
        if (page.length === 0) break;
        rows.push(...page);
      }
      return rows.map((row) => structuredClone(row));
    },
    async write(ops) {
      const draft = new Map(state);
      const copied = new Set<string>();
      for (const [position, op] of ops.entries()) {
        const name = prefix + op.table.name;
        if (!copied.has(name)) {
          draft.set(name, new Map(draft.get(name)));
          copied.add(name);
        }
        if (!applyOp(draft.get(name)!, op)) {
          return { ok: false, failedOp: position };
        }
      }
      state = draft;
      return { ok: true };
    },
    migrations: {
      async apply(tables) {
        const next = new Map(state);
        for (const table of tables) {
          const name = prefix + table.name;
          next.set(name, next.get(name) ?? new Map());
        }
        state = next;
      },
    },
    async dispose() {
      state = new Map();
    },
  };
};
