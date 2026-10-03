// @vitest-environment node

import type {
  AnyHotUpdaterPlugin,
  EngineDatabase,
  HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRuntime } from "./server/runtime.server";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  // The access middleware runs in the server; these specs call handlers directly.
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => ({
    middleware() {
      return this;
    },
    validator() {
      return this;
    },
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));

import {
  createApiKeyRpc,
  listApiKeysRpc,
  revokeApiKeyRpc,
  toApiKeyView,
} from "./api-keys-rpc";

/** The console over `database`, running `plugins` as the server does. */
const databaseRuntime = (
  database: EngineDatabase,
  plugins: readonly AnyHotUpdaterPlugin[] = [],
) =>
  createConsoleRuntime({
    database,
    plugins,
    api: createHotUpdater({
      database,
      plugins,
      ...(plugins.some(({ provides }) => provides?.clientAuth)
        ? {}
        : { clientAccess: "public" }),
    } as Parameters<typeof createHotUpdater>[0]).api,
  });

const memoryDatabase = () => ({
  name: "memory",
  adapter: createMemoryAdapter(),
});

afterEach(() => vi.resetAllMocks());

describe("API-key RPC output", () => {
  it("never serializes the provider lookup hash", () => {
    const view = toApiKeyView({
      created_at_ms: 1,
      hash: "provider-lookup-hash",
      id: `api-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revoked_at_ms: null,
      role: "client",
    });

    expect(view).toEqual({
      created_at_ms: 1,
      id: `api-${"a".repeat(43)}`,
      name: "Production app",
      prefix: "abcdef",
      revoked_at_ms: null,
      role: "client",
    });
    expect("hash" in view).toBe(false);
  });
});

describe("API-key RPC access", () => {
  it("manages keys through the apiKeys() plugin the console runs", async () => {
    mocks.prepare.mockResolvedValue({
      runtime: databaseRuntime(memoryDatabase(), [apiKeys()]),
    });

    const created = await createApiKeyRpc({ data: { name: "CI" } });

    await expect(listApiKeysRpc()).resolves.toEqual([
      expect.objectContaining({ id: created.record.id, name: "CI" }),
    ]);
  });

  it.each([
    [
      "without apiKeys()",
      databaseRuntime(memoryDatabase(), [insights()]),
      "without the apiKeys() plugin",
    ],
    [
      "for a self-hosted server, which manages its own keys",
      createConsoleRuntime({
        database: {
          name: "standalone-repository",
          core: {} as HotUpdaterCoreApi,
          fetchAdmin: vi.fn(),
        },
        plugins: [apiKeys()],
      }),
      "reaches a self-hosted server",
    ],
  ])("refuses key management %s", async (_case, runtime, message) => {
    mocks.prepare.mockResolvedValue({ runtime });
    const refused = {
      name: "ConsoleFeatureUnavailableError",
      feature: "apiKeys",
      status: 404,
      message: expect.stringContaining(message),
    };

    await expect(listApiKeysRpc()).rejects.toMatchObject(refused);
    await expect(
      createApiKeyRpc({ data: { name: "CI" } }),
    ).rejects.toMatchObject(refused);
    await expect(
      revokeApiKeyRpc({ data: { id: `api-${"a".repeat(43)}` } }),
    ).rejects.toMatchObject(refused);
  });
});
