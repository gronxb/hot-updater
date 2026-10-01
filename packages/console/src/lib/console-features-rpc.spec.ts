// @vitest-environment node

import type {
  AnyHotUpdaterPlugin,
  EngineDatabase,
  HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
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
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));

import { getConsoleFeaturesRpc } from "./console-features-rpc";

/** The console over a server definition that runs `plugins` on `database`. */
const definitionRuntime = (
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

afterEach(() => vi.resetAllMocks());

describe("getConsoleFeaturesRpc", () => {
  it("reports the features of the plugins the console runs over the database", async () => {
    mocks.prepare.mockResolvedValue({
      runtime: definitionRuntime(
        { name: "memory", adapter: createMemoryAdapter() },
        [insights()],
      ),
    });

    await expect(getConsoleFeaturesRpc()).resolves.toEqual({
      features: {
        insights: true,
        insightsAnalytics: true,
        apiKeys: false,
      },
      remote: false,
    });
  });

  it("reports what a self-hosted server's admin API serves of its plugins", async () => {
    mocks.prepare.mockResolvedValue({
      runtime: createConsoleRuntime({
        database: {
          name: "standalone-repository",
          url: "https://updates.example.com/hot-updater/admin",
          core: {} as HotUpdaterCoreApi,
          fetchAdmin: async () =>
            Response.json({ plugins: ["apiKeys", "insights"] }),
          storage: [],
        },
      }),
    });

    await expect(getConsoleFeaturesRpc()).resolves.toEqual({
      features: {
        insights: true,
        insightsAnalytics: false,
        apiKeys: false,
      },
      remote: true,
    });
  });

  it("tells a visitor the console does not authorize nothing", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.prepare.mockRejectedValue(denied);

    await expect(getConsoleFeaturesRpc()).rejects.toBe(denied);
  });
});
