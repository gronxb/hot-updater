import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";
import type { ClientSession } from "mongodb";
import { MongoClient } from "mongodb";

import {
  matchesMongoTestFilter,
  type MongoTestRow,
  sortMongoTestRows,
} from "./mongodbTestFilter";

type Tables = {
  bundle_patches: MongoTestRow[];
  bundles: MongoTestRow[];
  bundle_events: MongoTestRow[];
  client_access_keys: MongoTestRow[];
};

type FindOptions = { readonly projection?: unknown };
type UpdateInput = { readonly $set: Partial<BundleRow> };
type MongoTestHooks = {
  beforeBundlePatchInsert?: () => Promise<void>;
  failNextBundleTombstone: boolean;
  operationCount: number;
};

class MongoTestConstraintError extends Error {
  readonly name = "MongoTestConstraintError";
}

class MongoTestCursor {
  private offset = 0;
  private maximum = Number.POSITIVE_INFINITY;
  private sortSpecification: unknown;

  constructor(
    private readonly rows: MongoTestRow[],
    private readonly projection?: unknown,
  ) {}

  limit(value: number): this {
    this.maximum = value;
    return this;
  }

  project(): this {
    return this;
  }

  skip(value: number): this {
    this.offset = value;
    return this;
  }

  sort(value: unknown): this {
    this.sortSpecification = value;
    return this;
  }

  async toArray(): Promise<MongoTestRow[]> {
    const rows = sortMongoTestRows(this.rows, this.sortSpecification);
    return structuredClone(
      rows
        .slice(this.offset, this.offset + this.maximum)
        .map((row) => projectMongoTestRow(row, this.projection)),
    );
  }
}

const projectMongoTestRow = (
  row: MongoTestRow,
  projection: unknown,
): MongoTestRow => {
  if (typeof projection !== "object" || projection === null) return row;
  const projected = structuredClone(row);
  for (const field of Object.keys(projected)) {
    if (Reflect.get(projection, field) === 0) {
      Reflect.deleteProperty(projected, field);
    }
  }
  return projected;
};

const createCollection = (
  tables: Tables,
  model: keyof Tables,
  hooks: MongoTestHooks,
) => ({
  countDocuments: async (filter?: unknown): Promise<number> => {
    hooks.operationCount += 1;
    return tables[model].filter((row) => matchesMongoTestFilter(row, filter))
      .length;
  },
  deleteMany: async (filter?: unknown): Promise<void> => {
    hooks.operationCount += 1;
    tables[model] = tables[model].filter(
      (row) => !matchesMongoTestFilter(row, filter),
    );
  },
  distinct: async (field: string, filter?: unknown): Promise<unknown[]> => {
    hooks.operationCount += 1;
    return Array.from(
      new Set(
        tables[model]
          .filter((row) => matchesMongoTestFilter(row, filter))
          .map((row) => Reflect.get(row, field)),
      ),
    );
  },
  find: (filter?: unknown, options?: FindOptions): MongoTestCursor => {
    hooks.operationCount += 1;
    return new MongoTestCursor(
      tables[model].filter((row) => matchesMongoTestFilter(row, filter)),
      options?.projection,
    );
  },
  findOne: async (
    filter?: unknown,
    options?: FindOptions,
  ): Promise<MongoTestRow | null> => {
    hooks.operationCount += 1;
    const row = tables[model].find((candidate) =>
      matchesMongoTestFilter(candidate, filter),
    );
    return row === undefined
      ? null
      : structuredClone(projectMongoTestRow(row, options?.projection));
  },
  findOneAndUpdate: async (
    filter: unknown,
    update: UpdateInput,
  ): Promise<MongoTestRow | null> => {
    hooks.operationCount += 1;
    const index = tables[model].findIndex((row) =>
      matchesMongoTestFilter(row, filter),
    );
    const current = tables[model][index];
    if (current === undefined) return null;
    const updated = { ...current, ...update.$set };
    tables[model][index] = updated;
    return structuredClone(updated);
  },
  insertOne: async (row: MongoTestRow): Promise<void> => {
    hooks.operationCount += 1;
    if (model === "bundle_patches") await hooks.beforeBundlePatchInsert?.();
    if (tables[model].some(({ id }) => id === row.id)) {
      throw new MongoTestConstraintError("duplicate id");
    }
    if (
      model === "client_access_keys" &&
      "hash" in row &&
      tables.client_access_keys.some(
        (candidate) => "hash" in candidate && candidate.hash === row.hash,
      )
    ) {
      throw new MongoTestConstraintError("duplicate hash");
    }
    tables[model].push(structuredClone(row));
  },
  updateMany: async (filter: unknown, update: UpdateInput): Promise<void> => {
    hooks.operationCount += 1;
    tables[model] = tables[model].map((row) =>
      matchesMongoTestFilter(row, filter) ? { ...row, ...update.$set } : row,
    );
    if (model === "bundles" && hooks.failNextBundleTombstone) {
      hooks.failNextBundleTombstone = false;
      throw new MongoTestConstraintError("injected tombstone failure");
    }
  },
});

const createDatabase = (tables: Tables, hooks: MongoTestHooks) => ({
  collection: (name: string) => {
    switch (name) {
      case "bundles":
        return createCollection(tables, "bundles", hooks);
      case "bundle_patches":
        return createCollection(tables, "bundle_patches", hooks);
      case "bundle_events":
        return createCollection(tables, "bundle_events", hooks);
      case "client_access_keys":
        return createCollection(tables, "client_access_keys", hooks);
      default:
        throw new MongoTestConstraintError(`unknown collection: ${name}`);
    }
  },
});

export const createMongoTestHarness = () => {
  const tables: Tables = {
    bundle_patches: [],
    bundles: [],
    bundle_events: [],
    client_access_keys: [],
  };
  const hooks: MongoTestHooks = {
    failNextBundleTombstone: false,
    operationCount: 0,
  };
  let activeTables = tables;
  const client = new MongoClient("mongodb://127.0.0.1:27017/hot_updater_test");
  Object.defineProperty(client, "db", {
    value: () => createDatabase(activeTables, hooks),
  });
  Object.defineProperty(client, "withSession", {
    value: async (
      callback: (session: ClientSession) => Promise<unknown>,
    ): Promise<unknown> => {
      const session = {
        withTransaction: async (transaction: () => Promise<unknown>) => {
          const staged = structuredClone(tables);
          activeTables = staged;
          try {
            const result = await transaction();
            tables.bundle_patches = staged.bundle_patches;
            tables.bundles = staged.bundles;
            tables.bundle_events = staged.bundle_events;
            tables.client_access_keys = staged.client_access_keys;
            return result;
          } finally {
            activeTables = tables;
          }
        },
      } as unknown as ClientSession;
      return callback(session);
    },
  });
  return {
    client,
    close: () => client.close(),
    reset: (): void => {
      hooks.failNextBundleTombstone = false;
      hooks.operationCount = 0;
      tables.bundle_patches = [];
      tables.bundles = [];
      tables.bundle_events = [];
      tables.client_access_keys = [];
    },
    getOperationCount: (): number => hooks.operationCount,
    setBeforeBundlePatchInsert: (
      hook: MongoTestHooks["beforeBundlePatchInsert"],
    ): void => {
      hooks.beforeBundlePatchInsert = hook;
    },
    failNextBundleTombstone: (): void => {
      hooks.failNextBundleTombstone = true;
    },
    setBundleField: (id: string, field: string, value: unknown): void => {
      const row = tables.bundles.find((candidate) => candidate.id === id);
      if (row === undefined) throw new MongoTestConstraintError("missing row");
      Reflect.set(row, field, value);
    },
  };
};

export type MongoTestBundleRow = BundleRow;
export type MongoTestBundlePatchRow = BundlePatchRow;
