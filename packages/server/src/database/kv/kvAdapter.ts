import {
  canonicalJson,
  compareUtf8,
  type DatabaseAdapter,
  DatabaseAdapterContractError,
  type DatabaseKey,
  type DatabaseKeyValue,
  DATABASE_VERSION_COLUMN as V,
  findPhysicalIndex,
  indexEntries,
  indexOrderColumns,
  indexOrderTuple,
  matchesQuery,
  type PhysicalIndex,
  type PhysicalTable,
  type QueryBound,
  type QueryRequest,
  rowKey,
  type StoredRow,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";

/** An item's address: a partition, and a sort key within it. */
export interface KvKey {
  readonly pk: string;
  readonly sk: string;
}

/** What an op requires of its item before the write: that it exists or not, or that its `_v` is `v`. */
export type KvCondition = { readonly exists: boolean } | { readonly v: number };

export type KvOp = {
  readonly key: KvKey;
  readonly condition?: KvCondition;
} & (
  | { readonly type: "put"; readonly value: StoredRow }
  | { readonly type: "delete" }
  | { readonly type: "check" }
  /** Adds to numeric attributes, creating the item from `init` when it is missing. */
  | {
      readonly type: "add";
      readonly by: Readonly<Record<string, number>>;
      readonly init?: StoredRow;
    }
);

/** Sort keys from `gte` up to `lt` in one partition, resuming past `after`. */
export interface KvRange {
  readonly pk: string;
  readonly gte?: string;
  readonly lt?: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly after?: string;
}

export interface KvItem {
  readonly sk: string;
  readonly value: StoredRow;
}

/**
 * A key-value backend (DynamoDB, Firestore): strongly consistent point
 * reads, one partition's sort-key range per page, and atomic writes whose
 * conditions all see the state before the write. Sort keys compare as UTF-8.
 */
export interface KeyValueStore {
  readonly id: string;
  /**
   * The most items, and bytes, one atomic write takes; `itemBytes` caps each
   * item, and `keyBytes` the partition and sort keys the store indexes whole.
   */
  readonly limits: {
    readonly items: number;
    readonly bytes: number;
    readonly itemBytes?: number;
    readonly keyBytes?: { readonly pk: number; readonly sk: number };
  };
  get(keys: readonly KvKey[]): Promise<readonly (StoredRow | null)[]>;
  /** One native page; `more` when the range may go on past it. An empty page ends the range. */
  query(
    range: KvRange,
  ): Promise<{ readonly items: readonly KvItem[]; readonly more: boolean }>;
  /** Applies every op or none; `failedOp` names an op whose condition failed. */
  write(ops: readonly KvOp[]): Promise<WriteResult>;
  /** Prepares the store, such as its one table, for `db migrate`. */
  readonly migrations?: { apply(): Promise<void> };
  dispose?(): Promise<void>;
}

const SEPARATOR = "\u0001";

/** Order-preserving text for key values; each value ends in the lowest code point any encoding uses. */
export const encodeKvKey = (values: readonly DatabaseKeyValue[]): string =>
  values
    .map((value) => {
      if (typeof value === "boolean") return `${Number(value)}${SEPARATOR}`;
      if (typeof value === "number") {
        // IEEE 754 bits sort as hex once positives flip the sign bit and negatives every bit.
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, value === 0 ? 0 : value);
        const mask = view.getUint32(0) >>> 31 ? [~0, ~0] : [1 << 31, 0];
        const words = [0, 4].map((at, word) =>
          ((view.getUint32(at) ^ mask[word]!) >>> 0)
            .toString(16)
            .padStart(8, "0"),
        );
        return `${words.join("")}${SEPARATOR}`;
      }
      let text = "";
      // U+0000–U+0002 become two code units above the separator, in order.
      for (const char of value) {
        text +=
          char < "\u0003"
            ? `\u0002${String.fromCharCode(char.charCodeAt(0) + 1)}`
            : char;
      }
      return `${text}${SEPARATOR}`;
    })
    .join("");

/** The first sort key after every key that starts with `prefix`. */
const pastPrefix = (prefix: string) => `${prefix.slice(0, -1)}\u0002`;

/** A unique item's sort key, and an index item's when its order is empty. */
const ONLY = "#";

interface Layout {
  readonly table: PhysicalTable;
  readonly rows: string;
  /** The columns index copies hold: all but `_v` and counters (columns with a default). */
  readonly copied: readonly string[];
  readonly counters: readonly string[];
  /** Indexes with items of their own: unique ones, and those not in key order. */
  readonly indexed: readonly PhysicalIndex[];
}

/** An index whose eq and order columns are the key, in order, reads the row items. */
const inKeyOrder = (table: PhysicalTable, index: PhysicalIndex) => {
  const columns = [...index.eq, ...indexOrderColumns(table, index)];
  return (
    !index.unique &&
    columns.length === table.key.length &&
    columns.every((column, position) => column === table.key[position])
  );
};

const same = (left: StoredRow, right: StoredRow, columns: readonly string[]) =>
  columns.every(
    (name) => canonicalJson(left[name]) === canonicalJson(right[name]),
  );

type Planned = { readonly op: KvOp; readonly origin: number };

export interface KvAdapterOptions {
  readonly store: KeyValueStore;
  readonly tablePrefix?: string;
}

/**
 * The storage adapter over a key-value store. A row is one item at
 * `pk = <table>`, `sk = enc(key)`; each index not in key order adds an item
 * per entry at `pk = <table>#<index>#enc(eq)`, `sk = enc(order)`, and each
 * unique entry one item at `sk = "#"`, written only where no other row holds
 * it. Index items hold a copy of the row without `_v` or counters, so an
 * increment, which changes only those, never makes them stale.
 */
export const createKvAdapter = ({
  store,
  tablePrefix = "",
}: KvAdapterOptions): DatabaseAdapter => {
  const layouts = new WeakMap<PhysicalTable, Layout>();
  const layoutOf = (table: PhysicalTable): Layout => {
    const known = layouts.get(table);
    if (known) return known;
    const counters = table.columns
      .filter((column) => column.default !== undefined && column.name !== V)
      .map((column) => column.name);
    const layout = {
      table,
      rows: tablePrefix + table.name,
      copied: table.columns
        .map((column) => column.name)
        .filter((name) => name !== V && !counters.includes(name)),
      counters,
      indexed: table.indexes.filter((index) => !inKeyOrder(table, index)),
    };
    layouts.set(table, layout);
    return layout;
  };
  const rowItem = (layout: Layout, key: DatabaseKey): KvKey => ({
    pk: layout.rows,
    sk: encodeKvKey(key),
  });
  const partition = (layout: Layout, index: PhysicalIndex, eq: DatabaseKey) =>
    `${layout.rows}#${index.name}#${encodeKvKey(eq)}`;
  const copyOf = (layout: Layout, row: StoredRow): StoredRow =>
    Object.fromEntries(layout.copied.map((name) => [name, row[name] ?? null]));

  /** Every index and unique item a row has, by address. */
  const itemsOf = (layout: Layout, row: StoredRow | null) => {
    const items = new Map<string, { key: KvKey; unique: boolean }>();
    for (const index of row === null ? [] : layout.indexed) {
      for (const eq of indexEntries(layout.table, index, row!)) {
        const pk = partition(layout, index, eq);
        const sk = index.unique
          ? ONLY
          : encodeKvKey(indexOrderTuple(layout.table, index, row!)) || ONLY;
        items.set(JSON.stringify([pk, sk]), {
          key: { pk, sk },
          unique: index.unique === true,
        });
      }
    }
    return items;
  };

  /** Moves a row's index items from `before` to `after`; a unique entry is taken only where no row holds it. */
  const indexOps = (
    layout: Layout,
    before: StoredRow | null,
    after: StoredRow | null,
  ): KvOp[] => {
    const old = itemsOf(layout, before);
    const next = itemsOf(layout, after);
    const ops: KvOp[] = [...old]
      .filter(([id]) => !next.has(id))
      .map(([, item]) => ({ type: "delete", key: item.key }));
    const copy = after && copyOf(layout, after);
    const unchanged =
      before !== null && copy !== null && same(before, copy, layout.copied);
    for (const [id, item] of next) {
      if (old.has(id) && unchanged) continue;
      const taken = item.unique && !old.has(id);
      ops.push({
        type: "put",
        key: item.key,
        value: copy!,
        condition: taken ? { exists: false } : undefined,
      });
    }
    return ops;
  };

  /** The item ops of one adapter op: its row item first, then its index items. */
  const plan = (op: WriteOp): KvOp[] => {
    const layout = layoutOf(op.table);
    const key = rowItem(
      layout,
      op.type === "insert" ? rowKey(op.table, op.row) : op.key,
    );
    const guard = op.type === "insert" ? { exists: false } : op.guard;
    const condition = guard && ("v" in guard ? { v: guard.v } : guard);
    switch (op.type) {
      case "check":
        return [{ type: "check", key, condition }];
      case "increment":
        if (
          layout.indexed.length > 0 &&
          (op.init !== undefined ||
            Object.keys(op.by).some((name) => layout.copied.includes(name)))
        ) {
          throw new DatabaseAdapterContractError(
            `${op.table.name} has index copies: an increment may change only counters of an existing row.`,
          );
        }
        return [
          {
            type: "add",
            key,
            by: { ...op.by, [V]: 1 },
            init: op.init,
            condition: condition ?? (op.init ? undefined : { exists: true }),
          },
        ];
      case "delete":
        return [
          { type: "delete", key, condition },
          ...indexOps(layout, op.previous, null),
        ];
      default: {
        const before = op.type === "insert" ? null : op.previous;
        const row =
          op.type === "insert"
            ? op.row
            : { ...op.previous, ...op.set, [V]: op.guard.v + 1 };
        return [
          { type: "put", key, value: row, condition },
          ...indexOps(layout, before, row),
        ];
      }
    }
  };

  /**
   * One op per item. Only unique items of two rows can meet: one op frees
   * the value and another takes it. That becomes one unconditional put, as
   * the freeing op's guard already holds the value's owner. Two rows taking
   * one value fail at the later op.
   */
  const compile = (ops: readonly WriteOp[]) => {
    const items = new Map<string, Planned>();
    for (const [origin, op] of ops.entries()) {
      for (const kv of plan(op)) {
        const id = JSON.stringify([kv.key.pk, kv.key.sk]);
        const earlier = items.get(id);
        const put = [earlier, { op: kv, origin }].find(
          (planned) => planned?.op.type === "put",
        );
        if (earlier === undefined) {
          items.set(id, { op: kv, origin });
        } else if (
          put?.op.type === "put" &&
          [earlier.op, kv].some(({ type }) => type === "delete")
        ) {
          items.set(id, { op: { ...put.op, condition: undefined }, origin });
        } else {
          return { failedOp: origin };
        }
      }
    }
    return { items: [...items.values()] };
  };

  const encoder = new TextEncoder();
  const sizeOf = ({ op }: Planned) =>
    encoder.encode(
      op.key.pk +
        op.key.sk +
        JSON.stringify(
          op.type === "put" ? op.value : op.type === "add" ? op.init : null,
        ),
    ).length;

  /** Fills counters from the rows; a row that still equals its copy is returned whole, `_v` included. */
  const complete = async (layout: Layout, copies: readonly StoredRow[]) => {
    if (layout.counters.length === 0 || copies.length === 0) return copies;
    const rows = await store.get(
      copies.map((copy) => rowItem(layout, rowKey(layout.table, copy))),
    );
    return copies.map((copy, at) => {
      const row = rows[at];
      if (row && same(row, copy, layout.copied)) return row;
      const counters = layout.counters.map((name) => [name, row?.[name] ?? 0]);
      return { ...copy, ...Object.fromEntries(counters) };
    });
  };

  /**
   * A request's sort keys within its partition, from `gte` up to `lt`; null
   * when none can match. Every encoding ends in the separator, so the keys
   * that start with a prefix end right before `pastPrefix` of it.
   */
  const rangeOf = (prefix: string, request: QueryRequest) => {
    const edge = (bound: QueryBound | undefined, lower: boolean) => {
      if (bound === undefined) {
        return prefix === "" ? undefined : lower ? prefix : pastPrefix(prefix);
      }
      const text = prefix + encodeKvKey(bound.values);
      if (text === "") return bound.inclusive ? undefined : null;
      return lower === bound.inclusive ? text : pastPrefix(text);
    };
    const gte = edge(request.lower, true);
    const lt = edge(request.upper, false);
    if (gte === null || lt === null) return null;
    // Bounds that cross leave nothing, and DynamoDB refuses them.
    if (gte !== undefined && lt !== undefined && compareUtf8(gte, lt) >= 0) {
      return null;
    }
    return { gte, lt };
  };

  return {
    id: store.id,
    fits(ops) {
      const { items } = compile(ops);
      // A write in which two rows take one unique value fails at its op, not here.
      if (items === undefined) return true;
      const { items: most, bytes, itemBytes = bytes, keyBytes } = store.limits;
      const sizes = items.map(sizeOf);
      const length = (text: string) => encoder.encode(text).length;
      return (
        items.length <= most &&
        sizes.reduce((sum, size) => sum + size, 0) <= bytes &&
        sizes.every((size) => size <= itemBytes) &&
        (keyBytes === undefined ||
          items.every(
            ({ op }) =>
              length(op.key.pk) <= keyBytes.pk &&
              length(op.key.sk) <= keyBytes.sk,
          ))
      );
    },
    get: (table, keys) =>
      store.get(keys.map((key) => rowItem(layoutOf(table), key))),
    async query(table, request) {
      const layout = layoutOf(table);
      const index = findPhysicalIndex(table, request.index);
      if (index.unique) {
        const key = { pk: partition(layout, index, request.eq), sk: ONLY };
        const [copy] = await store.get([key]);
        const found = copy && matchesQuery(table, index, request, copy);
        return complete(layout, found ? [copy] : []);
      }
      const own = inKeyOrder(table, index);
      const range = rangeOf(own ? encodeKvKey(request.eq) : "", request);
      if (range === null) return [];
      const pk = own ? layout.rows : partition(layout, index, request.eq);
      const rows: StoredRow[] = [];
      let after: string | undefined;
      // Native pages are capped (DynamoDB: 1 MB), so read on until the limit or the range's end.
      while (rows.length < request.limit) {
        const { items, more } = await store.query({
          pk,
          ...range,
          order: request.order,
          limit: request.limit - rows.length,
          after,
        });
        rows.push(...items.map((item) => item.value));
        if (!more || items.length === 0) break;
        after = items.at(-1)!.sk;
      }
      return own ? rows : complete(layout, rows);
    },
    async write(ops) {
      const { items, failedOp } = compile(ops);
      if (items === undefined) return { ok: false, failedOp };
      const result = await store.write(items.map(({ op }) => op));
      return !result.ok && "failedOp" in result
        ? { ok: false, failedOp: items[result.failedOp]!.origin }
        : result;
    },
    // Tables need no items of their own; the store prepares itself, if at all.
    migrations: { apply: async () => store.migrations?.apply() },
    ...(store.dispose === undefined ? {} : { dispose: () => store.dispose!() }),
  };
};
