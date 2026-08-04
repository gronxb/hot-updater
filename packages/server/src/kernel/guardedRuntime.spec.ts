import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDatabase,
  createRuntimeStorage,
} from "../runtime.testFixtures";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";

describe("createGuardedInfrastructureRuntime", () => {
  it("runs readiness before database operations and transaction operations", async () => {
    // Given
    const database = createRuntimeDatabase();
    database.transaction = async (callback) => callback(database);
    const beforeDatabaseOperation = vi.fn(async () => undefined);
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation,
      database,
      storages: [],
    });

    // When
    await runtime.database.count({ model: "bundles" });
    await runtime.database.transaction?.((transaction) =>
      transaction.count({ model: "bundles" }),
    );

    // Then
    expect(beforeDatabaseOperation).toHaveBeenCalledTimes(3);
  });

  it("exposes only frozen generic database and storage access", () => {
    // Given
    const database = Object.assign(createRuntimeDatabase(), {
      createMigrator: () => "secret",
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
    expect(Reflect.has(runtime.database, "createMigrator")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "credentials")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "profiles")).toBe(false);
  });
});
