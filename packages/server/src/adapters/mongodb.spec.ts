import type { DatabaseBundleRecord } from "@hot-updater/plugin-core";
import type { Document, OptionalUnlessRequiredId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import type {
  MongoClientRuntime,
  MongoCollectionRuntime,
  MongoCursorRuntime,
  MongoOperationOptions,
  MongoSessionRuntime,
} from "../db/types";
import { mongoAdapter } from "./mongodb";

const bundle: DatabaseBundleRecord = {
  id: "01971f10-1aa1-7445-8b8c-010101010101",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "file-hash",
  storageUri: "storage://bundle.zip",
  gitCommitHash: null,
  message: null,
  channel: "production",
  targetAppVersion: null,
  fingerprintHash: null,
  metadata: undefined,
  manifestStorageUri: null,
  manifestFileHash: null,
  assetBaseStorageUri: null,
  rolloutCohortCount: 1000,
  targetCohorts: null,
};

const createClient = () => {
  const createCursor = <TRow extends Document>(): MongoCursorRuntime<TRow> => ({
    project: <TProjection extends Document>() => createCursor<TProjection>(),
    sort: () => createCursor<TRow>(),
    toArray: async () => [],
  });
  const bundles = {
    updateOne: vi.fn(
      async (
        _filter: object,
        _update: object,
        _options?: MongoOperationOptions,
      ) => undefined,
    ),
  };
  const patches = {
    deleteMany: vi.fn(
      async (_filter: object, _options?: MongoOperationOptions) => undefined,
    ),
    insertMany: vi.fn(
      async (
        _rows: readonly OptionalUnlessRequiredId<Document>[],
        _options?: MongoOperationOptions,
      ) => undefined,
    ),
  };
  const db = {
    collection: <TRow extends Document>(
      name: string,
    ): MongoCollectionRuntime<TRow> => ({
      createIndex: async () => undefined,
      deleteMany: async (filter, options) => {
        if (name === "bundle_patches") {
          await patches.deleteMany(filter, options);
        }
      },
      find: () => createCursor<TRow>(),
      findOne: async () => null,
      insertMany: async (rows, options) => {
        if (name === "bundle_patches") {
          await patches.insertMany(rows, options);
        }
      },
      updateOne: async (filter, update, options) => {
        if (name !== "bundle_patches") {
          await bundles.updateOne(filter, update, options);
        }
      },
    }),
    createCollection: async () => undefined,
  };
  const session: MongoSessionRuntime = {
    endSession: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (operation) => operation()),
  };
  const startSession = vi.fn(() => session);
  const client: MongoClientRuntime = {
    db: () => db,
    startSession,
  };

  return { bundles, client, session, startSession };
};

describe("mongoAdapter transactions", () => {
  it("exposes MongoDB as a legacy/native adapter with migrator metadata", () => {
    const { client } = createClient();
    const database = mongoAdapter({ client });

    expect(database.adapterName).toBe("mongodb");
    expect(database.provider).toBe("mongodb");
    expect(database.createMigrator).toBeTypeOf("function");
    expect(database.generateSchema).toBeUndefined();
  });

  it("does not use MongoDB sessions by default", async () => {
    const { bundles, client, startSession } = createClient();
    const database = mongoAdapter({ client });

    await database.bundles.insert({ bundle });
    await database.commit();

    expect(startSession).not.toHaveBeenCalled();
    expect(bundles.updateOne).toHaveBeenCalledWith(
      { id: bundle.id },
      expect.any(Object),
      { upsert: true },
    );
  });

  it("uses MongoDB sessions when transactions are enabled", async () => {
    const { bundles, client, session, startSession } = createClient();
    const database = mongoAdapter({ client, transactions: "enabled" });

    await database.bundles.insert({ bundle });
    await database.commit();

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(bundles.updateOne).toHaveBeenCalledWith(
      { id: bundle.id },
      expect.any(Object),
      { upsert: true, session },
    );
  });
});
