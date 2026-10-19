// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import {
  createEngineDatabase,
  createMemoryAdapter,
  migrateCoreSchema,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  // The access middleware runs in the server; these specs call handlers directly.
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => ({
    middleware() {
      return this;
    },
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));

import { schemaMigrationOf } from "./schema-migration";
import { getSchemaMigrationRpc } from "./schema-migration-rpc";

/** Core over a fenced memory database whose core tables an earlier release created. */
const consoleCore = async () => {
  const adapter = createMemoryAdapter();
  await migrateCoreSchema(adapter, "memory");
  return createHotUpdater({
    database: createEngineDatabase({ name: "memory", adapter }),
    storage: mockStorage({}),
    plugins: [insights()],
    clientAccess: "public",
  }).core;
};

afterEach(() => vi.resetAllMocks());

describe("getSchemaMigrationRpc", () => {
  it("reports what the schema fence found, as plain data", async () => {
    mocks.prepare.mockResolvedValue({ core: await consoleCore() });

    await expect(getSchemaMigrationRpc()).resolves.toEqual({
      message: expect.stringContaining("npx hot-updater doctor --fix"),
      settings: [{ key: "schema.insights", expected: "1.0.0", found: null }],
      plugins: ["insights"],
      migratable: true,
    });
  });

  it("is null when the read passes or fails for another reason", async () => {
    mocks.prepare.mockResolvedValue({
      core: { listChannels: async () => [] },
    });
    await expect(getSchemaMigrationRpc()).resolves.toBeNull();

    mocks.prepare.mockResolvedValue({
      core: {
        listChannels: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    });
    await expect(getSchemaMigrationRpc()).resolves.toBeNull();
  });
});

describe("schemaMigrationOf", () => {
  const refusal = (fields: Record<string, unknown>) =>
    Object.assign(new Error("refused"), {
      name: "HotUpdaterSchemaMigrationRequiredError",
      ...fields,
    });

  it("migrates only settings that are missing or older", () => {
    expect(
      schemaMigrationOf(
        refusal({
          settings: [
            { key: "schema.core", expected: "1.2.0", found: "1.0.0" },
            { key: "schema.vault", expected: "1", found: null },
          ],
        }),
      ),
    ).toMatchObject({ migratable: true });
    for (const settings of [
      [{ key: "schema.core", expected: "1.0.0", found: "1.2.0" }],
      [{ key: "schema.engine", expected: "1", found: "2" }],
      [{ key: "schema.core", expected: "1.0.0", found: "next" }],
    ]) {
      expect(schemaMigrationOf(refusal({ settings }))).toMatchObject({
        migratable: false,
      });
    }
    expect(
      schemaMigrationOf(refusal({ currentVersion: "0.21.0", settings: [] })),
    ).toMatchObject({ migratable: false });
  });
});
