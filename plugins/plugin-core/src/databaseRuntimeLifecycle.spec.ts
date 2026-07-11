import { describe, expect, it, vi } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";
import type { DatabasePluginResourceDeclaration } from "./databaseConnectionSpec";
import { databaseRuntimeFactorySymbol } from "./databaseRuntime";
import type { DatabasePluginRuntime } from "./types";

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

const createDeclaration = (
  close: () => Promise<void>,
): DatabasePluginResourceDeclaration => ({
  bundles: {
    getById: async () => null,
    findRecords: async () => [],
    insert: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  },
  patches: {
    storage: "embedded",
    findPatches: async () => [],
    getBundlePatches: async () => [],
    replaceBundlePatches: async () => undefined,
  },
  close,
});

const isDatabaseRuntime = (value: unknown): value is DatabasePluginRuntime =>
  typeof value === "object" &&
  value !== null &&
  "bundles" in value &&
  "bundlePatches" in value &&
  "commit" in value;

const openBorrowedRuntime = async (
  owner: DatabasePluginRuntime,
): Promise<DatabasePluginRuntime> => {
  const factory: unknown = Reflect.get(owner, databaseRuntimeFactorySymbol);
  if (typeof factory !== "function") {
    throw new Error("Database runtime factory is unavailable.");
  }

  const runtime: unknown = await factory();
  if (!isDatabaseRuntime(runtime)) {
    throw new Error("Database runtime factory returned an invalid runtime.");
  }
  return runtime;
};

describe("database runtime handle ownership", () => {
  it("omits owner-only close from borrowed runtimes", async () => {
    // Given
    const owner = createDatabasePlugin({
      name: "owned-runtime",
      connect: () => createDeclaration(async () => undefined),
    })({});

    // When
    const borrowed = await openBorrowedRuntime(owner);

    // Then
    expect(owner.close).toEqual(expect.any(Function));
    expect(borrowed.close).toBeUndefined();
  });

  it("closes the owned connection at most once", async () => {
    // Given
    const closeConnection = vi.fn(async () => undefined);
    const owner = createDatabasePlugin({
      name: "owned-runtime",
      connect: () => createDeclaration(closeConnection),
    })({});
    const closeOwner = owner.close;
    if (!closeOwner) {
      throw new Error("Owned runtime close is unavailable.");
    }

    // When
    await Promise.all([closeOwner(), closeOwner()]);
    await closeOwner();

    // Then
    expect(closeConnection).toHaveBeenCalledOnce();
  });

  it("rejects borrowed runtime opens while the owner is closing and after close", async () => {
    // Given
    const closeStarted = createDeferred();
    const releaseClose = createDeferred();
    const owner = createDatabasePlugin({
      name: "owned-runtime",
      connect: () =>
        createDeclaration(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
        }),
    })({});
    const closeOwner = owner.close;
    if (!closeOwner) {
      throw new Error("Owned runtime close is unavailable.");
    }

    // When
    const closing = closeOwner();
    await closeStarted.promise;
    const openWhileClosing = openBorrowedRuntime(owner);
    releaseClose.resolve();
    await closing;

    // Then
    await expect(openWhileClosing).rejects.toThrow();
    await expect(openBorrowedRuntime(owner)).rejects.toThrow();
  });
});
