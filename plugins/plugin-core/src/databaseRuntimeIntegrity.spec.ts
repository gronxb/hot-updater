import { describe, expect, it, vi } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";
import type {
  DatabasePluginResourceDeclaration,
  DatabasePluginTransaction,
} from "./databaseConnectionSpec";
import type { DatabaseBundleRecord } from "./types";

const baseBundle: DatabaseBundleRecord = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: ["device-1"],
};

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

const createDeferred = (): Deferred => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => {
      if (!resolvePromise) {
        throw new Error("Deferred promise was not initialized.");
      }
      resolvePromise();
    },
  };
};

type DeclarationOptions = {
  readonly beginTransaction?: () => Promise<DatabasePluginTransaction>;
  readonly close?: () => Promise<void>;
  readonly insert?: DatabasePluginResourceDeclaration["bundles"]["insert"];
  readonly records?: Map<string, DatabaseBundleRecord>;
};

const createDeclaration = (
  options: DeclarationOptions = {},
): DatabasePluginResourceDeclaration => {
  const records = options.records ?? new Map<string, DatabaseBundleRecord>();

  return {
    bundles: {
      getById: async ({ bundleId }) => records.get(bundleId) ?? null,
      findRecords: async () => Array.from(records.values()),
      insert:
        options.insert ??
        (async ({ bundle }) => {
          records.set(bundle.id, bundle);
        }),
      update: async ({ bundleId, patch }) => {
        const current = records.get(bundleId);
        if (current) {
          records.set(bundleId, { ...current, ...patch });
        }
      },
      delete: async ({ bundleId }) => {
        records.delete(bundleId);
      },
    },
    patches: {
      storage: "embedded",
      findPatches: async () => [],
      getBundlePatches: async () => [],
      replaceBundlePatches: async () => undefined,
    },
    ...(options.beginTransaction
      ? { beginTransaction: options.beginTransaction }
      : {}),
    ...(options.close ? { close: options.close } : {}),
  };
};

describe("database runtime commit integrity", () => {
  it("retains mutations staged while a commit is in flight", async () => {
    // Given
    const firstInsertStarted = createDeferred();
    const releaseFirstInsert = createDeferred();
    const records = new Map<string, DatabaseBundleRecord>();
    const plugin = createDatabasePlugin({
      name: "commit-integrity",
      connect: () =>
        createDeclaration({
          records,
          insert: async ({ bundle }) => {
            if (bundle.id === baseBundle.id) {
              firstInsertStarted.resolve();
              await releaseFirstInsert.promise;
            }
            records.set(bundle.id, bundle);
          },
        }),
    })({});
    const stagedDuringCommit = {
      ...baseBundle,
      id: "0195a408-8f13-7d9b-8df4-123456789abd",
    };
    await plugin.bundles.insert({ bundle: baseBundle });

    // When
    const firstCommit = plugin.commit();
    await firstInsertStarted.promise;
    await plugin.bundles.insert({ bundle: stagedDuringCommit });
    releaseFirstInsert.resolve();
    await firstCommit;

    // Then
    await expect(
      plugin.bundles.getById({ bundleId: stagedDuringCommit.id }),
    ).resolves.toStrictEqual(stagedDuringCommit);
    expect(records.has(stagedDuringCommit.id)).toBe(false);
    await plugin.commit();
    expect(records.get(stagedDuringCommit.id)).toStrictEqual(
      stagedDuringCommit,
    );
  });

  it("does not apply the same staged mutation twice for overlapping commits", async () => {
    // Given
    const insertStarted = createDeferred();
    const releaseInsert = createDeferred();
    const insert = vi.fn(async () => {
      insertStarted.resolve();
      await releaseInsert.promise;
    });
    const plugin = createDatabasePlugin({
      name: "commit-integrity",
      connect: () => createDeclaration({ insert }),
    })({});
    await plugin.bundles.insert({ bundle: baseBundle });

    // When
    const firstCommit = plugin.commit();
    await insertStarted.promise;
    const overlappingCommit = plugin.commit();
    await Promise.resolve();
    releaseInsert.resolve();
    await Promise.all([firstCommit, overlappingCommit]);

    // Then
    expect(insert).toHaveBeenCalledOnce();
  });

  it("continues queued commits after an earlier commit rejects", async () => {
    // Given
    const mutationError = new Error("first mutation failed");
    let attempt = 0;
    const insert = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw mutationError;
      }
    });
    const plugin = createDatabasePlugin({
      name: "commit-integrity",
      connect: () => createDeclaration({ insert }),
    })({});
    await plugin.bundles.insert({ bundle: baseBundle });

    // When
    const rejectedCommit = plugin.commit();
    const queuedCommit = plugin.commit();

    // Then
    await expect(rejectedCommit).rejects.toBe(mutationError);
    await expect(queuedCommit).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("preserves the mutation and rollback failures in an AggregateError", async () => {
    // Given
    const mutationError = new Error("mutation failed");
    const rollbackError = new Error("rollback failed");
    const transactionConnection = createDeclaration({
      insert: async () => {
        throw mutationError;
      },
    });
    const plugin = createDatabasePlugin({
      name: "commit-integrity",
      connect: () =>
        createDeclaration({
          beginTransaction: async () => ({
            connection: transactionConnection,
            commit: async () => undefined,
            rollback: async () => {
              throw rollbackError;
            },
          }),
        }),
    })({});
    await plugin.bundles.insert({ bundle: baseBundle });

    // When
    const receivedError: unknown = await plugin.commit().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Then
    expect(receivedError).toBeInstanceOf(AggregateError);
    if (!(receivedError instanceof AggregateError)) {
      throw new Error("Expected commit to reject with AggregateError.");
    }
    expect(receivedError.errors).toStrictEqual([mutationError, rollbackError]);
  });
});
