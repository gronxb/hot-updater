import {
  attachUniversalComponentDataAdapter,
  defineUniversalComponentSchema,
  type UniversalComponentDataAdapter,
  type UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "../createHotUpdaterCore";
import { defineFirstPartyServerPlugin } from "../kernel/manifest";
import {
  generateUniversalComponentArtifacts,
  migrateUniversalComponents,
  UniversalComponentMigrationUnsupportedError,
} from "./index";

const schema = (id: string): UniversalComponentSchema =>
  defineUniversalComponentSchema({
    id,
    versions: [
      {
        version: "1",
        tables: [
          {
            columns: [
              { name: "id", primaryKey: true, type: "string" },
              { name: "recorded_at_ms", type: "integer" },
            ],
            name: `${id.replaceAll("-", "_")}_records`,
          },
        ],
      },
    ],
  });

const createTarget = (
  schemas: readonly UniversalComponentSchema[],
  adapter: UniversalComponentDataAdapter,
) => {
  const database = attachUniversalComponentDataAdapter(
    createInMemoryDatabasePlugin(),
    () => adapter,
  );
  return createHotUpdater({
    database,
    plugins: schemas.map((componentSchema) =>
      defineFirstPartyServerPlugin({
        id: `plugin-${componentSchema.id}`,
        schema: componentSchema,
        setup: () => ({}),
      }),
    ),
  });
};

const adapterWith = (
  overrides: Partial<UniversalComponentDataAdapter> = {},
): UniversalComponentDataAdapter => ({
  bind: (componentSchema) => ({
    schema: componentSchema,
    append: async () => undefined,
    assertReady: async () => undefined,
    orderedScan: async () => [],
  }),
  ...overrides,
});

describe("universal component DB tooling", () => {
  it("is a no-op when no feature plugin declares component data", async () => {
    const target = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
    });

    await expect(migrateUniversalComponents(target)).resolves.toEqual([]);
    expect(generateUniversalComponentArtifacts(target)).toEqual([]);
  });

  it("migrates every declared schema deterministically outside runtime setup", async () => {
    const migrate = vi.fn(
      async (componentSchema: UniversalComponentSchema) => ({
        changed: true,
        version: componentSchema.versions.at(-1)!.version,
      }),
    );
    const target = createTarget(
      [schema("zeta-log"), schema("audit-log")],
      adapterWith({ migrate }),
    );

    expect(migrate).not.toHaveBeenCalled();
    await expect(migrateUniversalComponents(target)).resolves.toEqual([
      { changed: true, componentId: "audit-log", version: "1" },
      { changed: true, componentId: "zeta-log", version: "1" },
    ]);
    expect(migrate.mock.calls.map(([component]) => component.id)).toEqual([
      "audit-log",
      "zeta-log",
    ]);
  });

  it("fails explicitly when the provider has no runtime migration hook", async () => {
    const target = createTarget([schema("audit-log")], adapterWith());

    await expect(migrateUniversalComponents(target)).rejects.toMatchObject({
      adapterName: "in-memory-v2",
      componentIds: ["audit-log"],
      name: UniversalComponentMigrationUnsupportedError.name,
    });
  });

  it("rejects a provider result that does not confirm the declared version", async () => {
    const target = createTarget(
      [schema("audit-log")],
      adapterWith({
        migrate: async () => ({ changed: true, version: "unexpected" }),
      }),
    );

    await expect(migrateUniversalComponents(target)).rejects.toThrow(
      "Invalid universal component migration result for audit-log",
    );
  });

  it("collects provider artifacts with their component owner", () => {
    const target = createTarget(
      [schema("audit-log")],
      adapterWith({
        artifacts: (componentSchema) => [
          {
            contents: `schema=${componentSchema.id}\n`,
            path: `generated/${componentSchema.id}.txt`,
            targetVersion: "1",
          },
        ],
      }),
    );

    expect(generateUniversalComponentArtifacts(target)).toEqual([
      {
        componentId: "audit-log",
        contents: "schema=audit-log\n",
        path: "generated/audit-log.txt",
        targetVersion: "1",
      },
    ]);
  });

  it("rejects colliding artifact paths before returning a partial plan", () => {
    const target = createTarget(
      [schema("audit-log"), schema("security-log")],
      adapterWith({
        artifacts: () => [
          {
            contents: "generated",
            path: "shared.json",
            targetVersion: "1",
          },
        ],
      }),
    );

    expect(() => generateUniversalComponentArtifacts(target)).toThrow(
      "Invalid universal component artifact for security-log",
    );
  });

  it("rejects artifacts generated for a different component version", () => {
    const target = createTarget(
      [schema("audit-log")],
      adapterWith({
        artifacts: () => [
          {
            contents: "stale",
            path: "generated/audit-log.txt",
            targetVersion: "0",
          },
        ],
      }),
    );

    expect(() => generateUniversalComponentArtifacts(target)).toThrow(
      "Invalid universal component artifact for audit-log",
    );
  });
});
