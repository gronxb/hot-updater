import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";
import { MongoClient } from "mongodb";

import {
  matchesMongoTestFilter,
  type MongoTestRow,
  sortMongoTestRows,
} from "./mongodbTestFilter";

type Tables = {
  bundle_patches: MongoTestRow[];
  bundles: MongoTestRow[];
  channels: MongoTestRow[];
};

type FindOptions = { readonly projection?: unknown };
type UpdateInput = { readonly $set: Partial<BundleRow> };
type MongoTestHooks = {
  beforeBundlePatchInsert?: () => Promise<void>;
  failNextBundleTombstone: boolean;
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
  countDocuments: async (filter?: unknown): Promise<number> =>
    tables[model].filter((row) => matchesMongoTestFilter(row, filter)).length,
  deleteMany: async (filter?: unknown): Promise<void> => {
    tables[model] = tables[model].filter(
      (row) => !matchesMongoTestFilter(row, filter),
    );
  },
  find: (filter?: unknown, options?: FindOptions): MongoTestCursor =>
    new MongoTestCursor(
      tables[model].filter((row) => matchesMongoTestFilter(row, filter)),
      options?.projection,
    ),
  findOne: async (
    filter?: unknown,
    options?: FindOptions,
  ): Promise<MongoTestRow | null> => {
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
    if (model === "bundle_patches") await hooks.beforeBundlePatchInsert?.();
    if (tables[model].some(({ id }) => id === row.id)) {
      throw new MongoTestConstraintError("duplicate id");
    }
    if (
      model === "channels" &&
      "name" in row &&
      tables.channels.some(
        (current) => "name" in current && current.name === row.name,
      )
    ) {
      throw new MongoTestConstraintError("duplicate channel name");
    }
    tables[model].push(structuredClone(row));
  },
  updateMany: async (filter: unknown, update: UpdateInput): Promise<void> => {
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
      case "channels":
        return createCollection(tables, "channels", hooks);
      default:
        return createCollection(tables, "channels", hooks);
    }
  },
});

export const createMongoTestHarness = () => {
  const tables: Tables = { bundle_patches: [], bundles: [], channels: [] };
  const hooks: MongoTestHooks = { failNextBundleTombstone: false };
  const client = new MongoClient("mongodb://127.0.0.1:27017/hot_updater_test");
  Object.defineProperty(client, "db", {
    value: () => createDatabase(tables, hooks),
  });
  return {
    client,
    close: () => client.close(),
    reset: (): void => {
      hooks.failNextBundleTombstone = false;
      tables.bundle_patches = [];
      tables.bundles = [];
      tables.channels = [];
    },
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
export type MongoTestChannelRow = ChannelRow;
