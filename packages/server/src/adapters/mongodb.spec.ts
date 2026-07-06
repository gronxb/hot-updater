import type { DatabaseBundleRecord } from "@hot-updater/plugin-core";
import type { ClientSession, MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";

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
  const bundles = {
    updateOne: vi.fn(async () => undefined),
  };
  const patches = {
    deleteMany: vi.fn(async () => undefined),
    insertMany: vi.fn(async () => undefined),
  };
  const db = {
    collection: (name: string) =>
      name === "bundle_patches" ? patches : bundles,
  };
  const session = {
    endSession: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (operation: () => Promise<void>) =>
      operation(),
    ),
  } as unknown as ClientSession;
  const startSession = vi.fn(() => session);
  const client = {
    db: () => db,
    startSession,
  } as unknown as MongoClient;

  return { bundles, client, session, startSession };
};

describe("mongoAdapter transactions", () => {
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
