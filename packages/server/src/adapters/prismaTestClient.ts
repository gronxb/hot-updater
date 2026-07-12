import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";

type Row = BundlePatchRow | BundleRow | ChannelRow;
type Table = Row[];
type Tables = {
  bundle_patches: Table;
  bundles: Table;
  channels: Table;
};

type QueryArgs = {
  readonly orderBy?: unknown;
  readonly skip?: number;
  readonly take?: number;
  readonly where?: unknown;
};
type CreateArgs = QueryArgs & { readonly data: Row };
type UpdateArgs = QueryArgs & { readonly data: Partial<BundleRow> };

class PrismaTestConstraintError extends Error {
  readonly name = "PrismaTestConstraintError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  return 0;
};

const normalize = (value: unknown, insensitive: boolean): unknown =>
  insensitive && typeof value === "string" ? value.toLocaleLowerCase() : value;

const readField = (row: Row, field: string): unknown =>
  Object.entries(row).find(([key]) => key === field)?.[1];

const matchesCondition = (current: unknown, condition: unknown): boolean => {
  if (!isRecord(condition)) return Object.is(current, condition);
  const insensitive = condition["mode"] === "insensitive";
  const value = normalize(current, insensitive);
  if ("equals" in condition) {
    return Object.is(value, normalize(condition["equals"], insensitive));
  }
  if ("not" in condition) {
    return !Object.is(value, normalize(condition["not"], insensitive));
  }
  if (Array.isArray(condition["in"])) {
    return condition["in"].some((item) => Object.is(value, item));
  }
  if (Array.isArray(condition["notIn"])) {
    return condition["notIn"].every((item) => !Object.is(value, item));
  }
  if ("gt" in condition) return compare(value, condition["gt"]) > 0;
  if ("gte" in condition) return compare(value, condition["gte"]) >= 0;
  if ("lt" in condition) return compare(value, condition["lt"]) < 0;
  if ("lte" in condition) return compare(value, condition["lte"]) <= 0;
  if (typeof value !== "string") return false;
  if (typeof condition["contains"] === "string") {
    const target = normalize(condition["contains"], insensitive);
    return typeof target === "string" && value.includes(target);
  }
  if (typeof condition["startsWith"] === "string") {
    const target = normalize(condition["startsWith"], insensitive);
    return typeof target === "string" && value.startsWith(target);
  }
  if (typeof condition["endsWith"] === "string") {
    const target = normalize(condition["endsWith"], insensitive);
    return typeof target === "string" && value.endsWith(target);
  }
  return false;
};

const matchesWhere = (row: Row, where: unknown): boolean => {
  if (!isRecord(where)) return true;
  const conjunction = where["AND"];
  if (Array.isArray(conjunction)) {
    return conjunction.every((item) => matchesWhere(row, item));
  }
  const disjunction = where["OR"];
  if (Array.isArray(disjunction)) {
    return disjunction.some((item) => matchesWhere(row, item));
  }
  return Object.entries(where).every(([field, condition]) =>
    matchesCondition(readField(row, field), condition),
  );
};

const sortRows = (rows: Row[], orderBy: unknown): Row[] => {
  if (!isRecord(orderBy)) return rows;
  const entry = Object.entries(orderBy)[0];
  if (entry === undefined) return rows;
  const [field, direction] = entry;
  return rows.toSorted((left, right) => {
    const result = compare(readField(left, field), readField(right, field));
    return direction === "desc" ? -result : result;
  });
};

const assertReferences = (
  tables: Tables,
  model: keyof Tables,
  row: Row,
): void => {
  if (model === "bundles" && "channel" in row) {
    if (!tables.channels.some(({ id }) => id === row.channel)) {
      throw new PrismaTestConstraintError("missing channel");
    }
  }
  if (model === "bundle_patches" && "bundle_id" in row) {
    const bundleIds = new Set(tables.bundles.map(({ id }) => id));
    if (!bundleIds.has(row.bundle_id) || !bundleIds.has(row.base_bundle_id)) {
      throw new PrismaTestConstraintError("missing patch reference");
    }
  }
};

const createDelegate = (tables: Tables, model: keyof Tables) => ({
  count: async (args?: QueryArgs): Promise<number> =>
    tables[model].filter((row) => matchesWhere(row, args?.where)).length,
  create: async ({ data }: CreateArgs): Promise<Row> => {
    if (tables[model].some(({ id }) => id === data.id)) {
      throw new PrismaTestConstraintError("duplicate id");
    }
    assertReferences(tables, model, data);
    tables[model].push(structuredClone(data));
    return structuredClone(data);
  },
  deleteMany: async (args?: QueryArgs): Promise<void> => {
    const selected = tables[model].filter((row) =>
      matchesWhere(row, args?.where),
    );
    if (model === "bundles") {
      const ids = new Set(selected.map(({ id }) => id));
      const referenced = tables.bundle_patches.some(
        (row) =>
          "bundle_id" in row &&
          (ids.has(row.bundle_id) || ids.has(row.base_bundle_id)),
      );
      if (referenced) throw new PrismaTestConstraintError("referenced bundle");
    }
    tables[model] = tables[model].filter(
      (row) => !matchesWhere(row, args?.where),
    );
  },
  findFirst: async (args?: QueryArgs): Promise<Row | null> =>
    structuredClone(
      tables[model].find((row) => matchesWhere(row, args?.where)) ?? null,
    ),
  findMany: async (args?: QueryArgs): Promise<Row[]> => {
    const filtered = tables[model].filter((row) =>
      matchesWhere(row, args?.where),
    );
    const sorted = sortRows(filtered, args?.orderBy);
    const start = args?.skip ?? 0;
    const end = start + (args?.take ?? sorted.length);
    return structuredClone(sorted.slice(start, end));
  },
  update: async ({ data, where }: UpdateArgs): Promise<Row> => {
    const index = tables[model].findIndex((row) => matchesWhere(row, where));
    const current = tables[model][index];
    if (current === undefined) {
      throw new PrismaTestConstraintError("missing update row");
    }
    const updated = { ...current, ...data };
    assertReferences(tables, model, updated);
    tables[model][index] = updated;
    return structuredClone(updated);
  },
});

const createClient = (tables: Tables) => ({
  bundle_patches: createDelegate(tables, "bundle_patches"),
  bundles: createDelegate(tables, "bundles"),
  channels: createDelegate(tables, "channels"),
});

export const createPrismaTestHarness = () => {
  let tables: Tables = { bundle_patches: [], bundles: [], channels: [] };
  const client = {
    ...createClient(tables),
    $transaction: async <TResult>(
      callback: (transaction: object) => Promise<TResult>,
    ): Promise<TResult> => {
      const transactionTables = structuredClone(tables);
      const result = await callback(createClient(transactionTables));
      tables.bundle_patches = transactionTables.bundle_patches;
      tables.bundles = transactionTables.bundles;
      tables.channels = transactionTables.channels;
      return result;
    },
  };
  return {
    client,
    reset: (): void => {
      tables.bundle_patches = [];
      tables.bundles = [];
      tables.channels = [];
    },
  };
};
