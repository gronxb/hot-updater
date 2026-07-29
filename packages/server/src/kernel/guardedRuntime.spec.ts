import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDatabase,
  createRuntimeStorage,
  type TestContext,
} from "../runtime.testFixtures";
import { createRuntimeStorageRecords } from "../storageAccess";
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
      storages: createRuntimeStorageRecords([storage]),
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
    const runtime = createGuardedInfrastructureRuntime({
      database: createRuntimeDatabase(),
      storages: createRuntimeStorageRecords([
        createRuntimeStorage(getDownloadUrl, readText),
      ]),
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };
    const [storage] = runtime.storages;
    if (storage === undefined) {
      throw new Error("Expected guarded runtime storage.");
    }

    // When
    const download = await storage.getDownloadUrl(
      "s3://bucket/bundle",
      context,
    );
    const text = await storage.readText("s3://bucket/manifest", context);

    // Then
    expect(download).toEqual({ fileUrl: "https://assets.example.com" });
    expect(text).toBe("https://assets.example.com");
    expect(getDownloadUrl).toHaveBeenCalledWith("s3://bucket/bundle", context);
    expect(readText).toHaveBeenCalledWith("s3://bucket/manifest", context);
  });
});
