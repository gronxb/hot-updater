import { defineUniversalComponentSchema } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeDatabase,
  createRuntimeStorage,
} from "../runtime.testFixtures";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";

describe("createGuardedInfrastructureRuntime", () => {
  it("runs readiness before domain reads and commits", async () => {
    const schema = defineUniversalComponentSchema({
      id: "audit-log",
      versions: [
        {
          version: "1",
          tables: [
            {
              name: "audit_records",
              columns: [{ name: "id", primaryKey: true, type: "string" }],
            },
          ],
        },
      ],
    });
    const database = {
      ...createRuntimeDatabase(),
      componentData: {
        bind: () => ({
          schema,
          append: async () => undefined,
          assertReady: async () => undefined,
          create: async () => "created" as const,
          get: async () => null,
          orderedScan: async () => [],
        }),
      },
    };
    const beforeDatabaseOperation = vi.fn(async () => undefined);
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation,
      database,
      storages: [],
    });

    await runtime.database.bundles.count();
    await runtime.database.commit({
      operation: "update",
      bundleId: "missing-bundle",
      changes: [],
    });
    await runtime.database.componentData?.bind(schema).append({
      table: "audit_records",
      row: { id: "record-1" },
    });

    expect(beforeDatabaseOperation).toHaveBeenCalledTimes(3);
  });

  it("exposes only frozen domain database and storage access", () => {
    const database = Object.assign(createRuntimeDatabase(), {
      createMigrator: () => "secret",
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
    expect(Object.isFrozen(runtime.database.bundles)).toBe(true);
    expect(Object.isFrozen(runtime.database.bundlePatches)).toBe(true);
    expect(Object.isFrozen(runtime.storages)).toBe(true);
    expect(Reflect.has(runtime.database, "createMigrator")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "credentials")).toBe(false);
    expect(Reflect.has(runtime.storages[0] ?? {}, "profiles")).toBe(false);
  });
});
