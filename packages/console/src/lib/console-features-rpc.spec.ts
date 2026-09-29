// @vitest-environment node

import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { insights } from "@hot-updater/server/plugins/insights";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRuntime } from "./server/runtime.server";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));

import { getConsoleFeaturesRpc } from "./console-features-rpc";

afterEach(() => vi.resetAllMocks());

describe("getConsoleFeaturesRpc", () => {
  it("reports the features of the plugins the console runs over the database", async () => {
    mocks.prepare.mockResolvedValue({
      runtime: createConsoleRuntime({
        database: { name: "memory", adapter: createMemoryAdapter() },
        plugins: [insights()],
      }),
    });

    await expect(getConsoleFeaturesRpc()).resolves.toEqual({
      features: { insights: true, insightsAnalytics: true, apiKeys: false },
      remote: false,
    });
  });

  it("reports what a self-hosted server's admin API serves of its plugins", async () => {
    mocks.prepare.mockResolvedValue({
      runtime: createConsoleRuntime({
        database: {
          name: "standalone-repository",
          core: {} as HotUpdaterCoreApi,
          fetchAdmin: async () =>
            Response.json({ plugins: ["apiKeys", "insights"] }),
        },
      }),
    });

    await expect(getConsoleFeaturesRpc()).resolves.toEqual({
      features: { insights: true, insightsAnalytics: false, apiKeys: false },
      remote: true,
    });
  });

  it("tells a visitor the console does not authorize nothing", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.prepare.mockRejectedValue(denied);

    await expect(getConsoleFeaturesRpc()).rejects.toBe(denied);
  });
});
