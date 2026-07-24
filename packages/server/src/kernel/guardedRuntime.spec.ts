import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDatabase,
  createRuntimeStorage,
} from "../runtime.testFixtures";
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
});
