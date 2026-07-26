import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDatabase,
  createRuntimeStorage,
  type TestContext,
} from "../runtime.testFixtures";
import { StorageInvocationAuthority } from "../storageInvocation";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";

describe("createGuardedInfrastructureRuntime", () => {
  it("runs the readiness gate before each database operation", async () => {
    // Given
    const database = createRuntimeDatabase();
    const calls: string[] = [];
    const count = vi.spyOn(database, "count").mockImplementation(async () => {
      calls.push("database");
      return 0;
    });
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation: async () => {
        calls.push("guard");
      },
      database,
      storages: [],
    });

    // When
    await runtime.database.count({ model: "bundles" });

    // Then
    expect(calls).toEqual(["guard", "database"]);
    expect(count).toHaveBeenCalledOnce();
  });

  it("keeps transaction callbacks behind the same readiness gate", async () => {
    // Given
    const database = createRuntimeDatabase();
    const beforeDatabaseOperation = vi.fn(async () => undefined);
    database.transaction = async (callback) => callback(database);
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation,
      database,
      storages: [],
    });

    // When
    await runtime.database.transaction?.(async (transaction) => {
      await transaction.count({ model: "bundles" });
    });

    // Then
    expect(beforeDatabaseOperation).toHaveBeenCalledTimes(2);
  });

  it("exposes only frozen generic database and runtime storage access", () => {
    // Given
    const database = Object.assign(createRuntimeDatabase(), {
      adapterName: "secret-adapter",
      createMigrator: () => "secret-migrator",
    });
    const storage = Object.assign(
      createRuntimeStorage(async () => ({ fileUrl: "https://example.com" })),
      { credentials: "secret" },
    );

    // When
    const runtime = createGuardedInfrastructureRuntime({
      database,
      storages: [storage],
    });

    // Then
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.database)).toBe(true);
    expect(Object.isFrozen(runtime.storages)).toBe(true);
    expect(Object.isFrozen(runtime.storages[0])).toBe(true);
    expect(Reflect.has(runtime.database, "adapterName")).toBe(false);
    expect(Reflect.has(runtime.database, "createMigrator")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "credentials")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "profiles")).toBe(false);
  });

  it("forwards runtime storage context without widening it", async () => {
    // Given
    const getDownloadUrl = vi.fn(
      async (_storageUri: string, context?: TestContext) => ({
        fileUrl: context?.env?.assetHost ?? "https://fallback.example.com",
      }),
    );
    const readText = vi.fn(
      async (_storageUri: string, context?: TestContext) =>
        context?.env?.assetHost ?? null,
    );
    const authority = new StorageInvocationAuthority<TestContext>();
    const runtime = createGuardedInfrastructureRuntime({
      database: createRuntimeDatabase(),
      resolveStorageInvocation: (token) => authority.resolve(token),
      storages: [createRuntimeStorage(getDownloadUrl, readText)],
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };
    const [storage] = runtime.storages;
    if (storage === undefined) {
      throw new Error("Expected guarded runtime storage.");
    }
    const token = authority.begin({
      operation: { member: "getBundleById", surface: "database" },
      platformContext: context,
    });
    authority.bind(token, undefined);

    // When
    const download = await storage.getDownloadUrl("s3://bucket/bundle", token);
    const text = await storage.readText("s3://bucket/manifest", token);
    authority.close(token);

    // Then
    expect(download).toEqual({ fileUrl: "https://assets.example.com" });
    expect(text).toBe("https://assets.example.com");
    expect(getDownloadUrl).toHaveBeenCalledWith("s3://bucket/bundle", context);
    expect(readText).toHaveBeenCalledWith("s3://bucket/manifest", context);
  });

  it("rejects foreign, unbound, and revoked tokens before storage I/O", async () => {
    // Given
    const getDownloadUrl = vi.fn(async () => ({
      fileUrl: "https://example.com",
    }));
    const owner = new StorageInvocationAuthority<TestContext>();
    const foreign = new StorageInvocationAuthority<TestContext>();
    const runtime = createGuardedInfrastructureRuntime({
      database: createRuntimeDatabase(),
      resolveStorageInvocation: (token) => owner.resolve(token),
      storages: [createRuntimeStorage(getDownloadUrl)],
    });
    const storage = runtime.storages[0];
    if (storage === undefined) {
      throw new Error("Expected guarded runtime storage.");
    }
    const operation = {
      member: "getBundleById" as const,
      surface: "database" as const,
    };
    const unbound = owner.begin({
      operation,
      platformContext: undefined,
    });
    const revoked = owner.begin({
      operation,
      platformContext: undefined,
    });
    owner.bind(revoked, undefined);
    owner.close(revoked);
    const foreignToken = foreign.begin({
      operation,
      platformContext: undefined,
    });
    foreign.bind(foreignToken, undefined);

    // When
    const attempts = [unbound, revoked, foreignToken].map((token) =>
      storage.getDownloadUrl("s3://bucket/bundle", token),
    );
    attempts.push(
      Reflect.apply(storage.getDownloadUrl, storage, ["s3://bucket/bundle"]),
    );

    // Then
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: "invalid-storage-invocation",
      });
    }
    expect(getDownloadUrl).not.toHaveBeenCalled();
    owner.close(unbound);
    foreign.close(foreignToken);
  });
});
