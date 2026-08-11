import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDatabase,
  createRuntimeStorage,
} from "../runtime.testFixtures";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";

describe("createGuardedInfrastructureRuntime", () => {
  it("runs readiness before database operations and transaction operations", async () => {
    const database = createRuntimeDatabase();
    database.transaction = async (callback) => callback(database);
    const beforeDatabaseOperation = vi.fn(async () => undefined);
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation,
      database,
      storages: [],
    });

    await runtime.database.count({ model: "bundles" });
    await runtime.database.transaction?.((transaction) =>
      transaction.count({ model: "bundles" }),
    );

    expect(beforeDatabaseOperation).toHaveBeenCalledTimes(3);
  });

  it("exposes only frozen generic database and storage access", async () => {
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const database = Object.assign(createRuntimeDatabase(), {
      createMigrator: () => "secret",
      onDatabaseUpdated,
    });
    const storage = Object.assign(
      createRuntimeStorage(async () => ({ fileUrl: "https://example.com" })),
      { credentials: "secret" },
    );

    const runtime = createGuardedInfrastructureRuntime({
      database,
      storages: [storage],
    });

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.database)).toBe(true);
    expect(Object.isFrozen(runtime.storages)).toBe(true);
    expect(Reflect.has(runtime.database, "createMigrator")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "credentials")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "profiles")).toBe(false);

    await runtime.database.onDatabaseUpdated?.();
    expect(onDatabaseUpdated).toHaveBeenCalledOnce();
  });
});
