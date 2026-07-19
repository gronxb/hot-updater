import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
} from "@hot-updater/plugin-core";

type Row = BundleEventRow | BundlePatchRow | BundleRow;
type Table = Row[];
type Tables = {
  bundle_events: Table;
  bundle_patches: Table;
  bundles: Table;
};

type Hooks = {
  beforeNextBundleUpdateMany: (() => void) | undefined;
  failNextBundleDelete: boolean;
  transactionOptions: ({ readonly isolationLevel?: string } | undefined)[];
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
    return (
      value !== null &&
      value !== undefined &&
      !Object.is(value, normalize(condition["not"], insensitive))
    );
  }
  if (Array.isArray(condition["in"])) {
    return condition["in"].some((item) => Object.is(value, item));
  }
  if (Array.isArray(condition["notIn"])) {
    return (
      condition["notIn"].length === 0 ||
      (value !== null &&
        value !== undefined &&
        condition["notIn"].every((item) => !Object.is(value, item)))
    );
  }
  if (value === null || value === undefined) return false;
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
  const clauses = Array.isArray(orderBy)
    ? orderBy.filter(isRecord)
    : isRecord(orderBy)
      ? [orderBy]
      : [];
  if (clauses.length === 0) return rows;
  return rows.toSorted((left, right) => {
    for (const clause of clauses) {
      const entry = Object.entries(clause)[0];
      if (entry === undefined) continue;
      const [field, direction] = entry;
      const result = compare(readField(left, field), readField(right, field));
      if (result !== 0) {
        return direction === "desc" ? -result : result;
      }
    }
    return 0;
  });
};

const assertReferences = (
  tables: Tables,
  model: keyof Tables,
  row: Row,
): void => {
  if (model === "bundle_patches" && "bundle_id" in row) {
    const bundleIds = new Set(tables.bundles.map(({ id }) => id));
    if (!bundleIds.has(row.bundle_id) || !bundleIds.has(row.base_bundle_id)) {
      throw new PrismaTestConstraintError("missing patch reference");
    }
  }
};

const createDelegate = (tables: Tables, model: keyof Tables, hooks: Hooks) => ({
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
    if (model === "bundles" && hooks.failNextBundleDelete) {
      hooks.failNextBundleDelete = false;
      throw new PrismaTestConstraintError("injected bundle delete failure");
    }
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
  updateMany: async ({
    data,
    where,
  }: UpdateArgs): Promise<{ count: number }> => {
    if (model === "bundles") {
      const hook = hooks.beforeNextBundleUpdateMany;
      hooks.beforeNextBundleUpdateMany = undefined;
      hook?.();
    }
    let count = 0;
    tables[model] = tables[model].map((row) => {
      if (!matchesWhere(row, where)) return row;
      const updated = { ...row, ...data };
      assertReferences(tables, model, updated);
      count += 1;
      return updated;
    });
    return { count };
  },
});

const createClient = (tables: Tables, hooks: Hooks) => ({
  bundle_events: createDelegate(tables, "bundle_events", hooks),
  bundle_patches: createDelegate(tables, "bundle_patches", hooks),
  bundles: createDelegate(tables, "bundles", hooks),
});

export const createPrismaTestHarness = () => {
  let tables: Tables = {
    bundle_events: [],
    bundle_patches: [],
    bundles: [],
  };
  const hooks: Hooks = {
    beforeNextBundleUpdateMany: undefined,
    failNextBundleDelete: false,
    transactionOptions: [],
  };
  const client = {
    ...createClient(tables, hooks),
    $transaction: async <TResult>(
      callback: (transaction: object) => Promise<TResult>,
      options?: { readonly isolationLevel?: string },
    ): Promise<TResult> => {
      hooks.transactionOptions.push(options);
      const transactionTables = structuredClone(tables);
      const result = await callback(createClient(transactionTables, hooks));
      tables.bundle_events = transactionTables.bundle_events;
      tables.bundle_patches = transactionTables.bundle_patches;
      tables.bundles = transactionTables.bundles;
      return result;
    },
  };
  return {
    client,
    clearTargetBeforeNextBundleUpdate: (
      id: string,
      field: "fingerprint_hash" | "target_app_version",
    ): void => {
      hooks.beforeNextBundleUpdateMany = () => {
        const index = tables.bundles.findIndex(
          (candidate) => candidate.id === id,
        );
        const row = tables.bundles[index];
        if (row !== undefined && "target_app_version" in row) {
          tables.bundles[index] = { ...row, [field]: null };
        }
      };
    },
    failNextBundleDelete: (): void => {
      hooks.failNextBundleDelete = true;
    },
    getTransactionOptions: () => structuredClone(hooks.transactionOptions),
    reset: (): void => {
      hooks.failNextBundleDelete = false;
      hooks.beforeNextBundleUpdateMany = undefined;
      hooks.transactionOptions.length = 0;
      tables.bundle_events = [];
      tables.bundle_patches = [];
      tables.bundles = [];
    },
  };
};
