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

class MongoTestConstraintError extends Error {
  readonly name = "MongoTestConstraintError";
}

class MongoTestCursor {
  private offset = 0;
  private maximum = Number.POSITIVE_INFINITY;
  private sortSpecification: unknown;

  constructor(private readonly rows: MongoTestRow[]) {}

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
    return structuredClone(rows.slice(this.offset, this.offset + this.maximum));
  }
}

const createCollection = (tables: Tables, model: keyof Tables) => ({
  countDocuments: async (filter?: unknown): Promise<number> =>
    tables[model].filter((row) => matchesMongoTestFilter(row, filter)).length,
  deleteMany: async (filter?: unknown): Promise<void> => {
    tables[model] = tables[model].filter(
      (row) => !matchesMongoTestFilter(row, filter),
    );
  },
  find: (filter?: unknown, _options?: FindOptions): MongoTestCursor =>
    new MongoTestCursor(
      tables[model].filter((row) => matchesMongoTestFilter(row, filter)),
    ),
  findOne: async (
    filter?: unknown,
    _options?: FindOptions,
  ): Promise<MongoTestRow | null> =>
    structuredClone(
      tables[model].find((row) => matchesMongoTestFilter(row, filter)) ?? null,
    ),
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
    if (tables[model].some(({ id }) => id === row.id)) {
      throw new MongoTestConstraintError("duplicate id");
    }
    tables[model].push(structuredClone(row));
  },
});

const createDatabase = (tables: Tables) => ({
  collection: (name: string) => {
    switch (name) {
      case "bundles":
        return createCollection(tables, "bundles");
      case "bundle_patches":
        return createCollection(tables, "bundle_patches");
      case "channels":
        return createCollection(tables, "channels");
      default:
        return createCollection(tables, "channels");
    }
  },
});

export const createMongoTestHarness = () => {
  const tables: Tables = { bundle_patches: [], bundles: [], channels: [] };
  const client = new MongoClient("mongodb://127.0.0.1:27017/hot_updater_test");
  Object.defineProperty(client, "db", {
    value: () => createDatabase(tables),
  });
  return {
    client,
    close: () => client.close(),
    reset: (): void => {
      tables.bundle_patches = [];
      tables.bundles = [];
      tables.channels = [];
    },
  };
};

export type MongoTestBundleRow = BundleRow;
export type MongoTestBundlePatchRow = BundlePatchRow;
export type MongoTestChannelRow = ChannelRow;
