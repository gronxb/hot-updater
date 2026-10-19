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
