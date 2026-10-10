// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import type {
  AnyHotUpdaterPlugin,
  EngineDatabase,
  HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRuntime, requireFeature } from "./server/runtime.server";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  events: vi.fn(),
  activity: vi.fn(),
}));
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
vi.mock("./server/releaseAdoption", () => ({
  getBundleEvents: mocks.events,
}));

vi.mock("./server/bundleActivity", () => ({
  getBundleActivity: mocks.activity,
}));

import {
  getBundleActivityRpc,
  readBundleActivityInput,
} from "./insights-recovery-rpc";
import { getBundleEventsRpc } from "./release-adoption-rpc";

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
      storage: mockStorage({}),
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

/** A console that runs insights() over its database, and the model it reads. */
const withInsights = async () => {
  const runtime = databaseRuntime(memoryDatabase(), [insights()]);
  mocks.prepare.mockResolvedValue({ runtime });
  return requireFeature(runtime, "insightsAnalytics");
};

afterEach(() => vi.resetAllMocks());

describe("bundle events access", () => {
  const data = {
    platform: "ios",
    channel: "production",
    window: "7d",
    endMs: 7_200_000,
    bundleId: "bundle-a",
    type: "LAUNCHED",
  } as const;

  it("reads through the authenticated console's Insights model", async () => {
    const model = await withInsights();
    mocks.events.mockResolvedValue({ points: [] });
    await expect(getBundleEventsRpc({ data })).resolves.toEqual({
      points: [],
    });
    expect(mocks.events).toHaveBeenCalledWith(model, data);
  });

  it("reads nothing when console access is denied", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.prepare.mockRejectedValue(denied);
    await expect(getBundleEventsRpc({ data })).rejects.toBe(denied);
    expect(mocks.events).not.toHaveBeenCalled();
  });
});

describe("bundle activity access", () => {
  const data = [
    { platform: "ios", channel: "production", releaseId: "release-a" },
  ] as const;
  it("authenticates batch requests and uses the console database", async () => {
    const model = await withInsights();
    mocks.activity.mockResolvedValue({});
    await expect(getBundleActivityRpc({ data: [...data] })).resolves.toEqual(
      {},
    );
    expect(mocks.activity).toHaveBeenCalledWith(model, data);
    mocks.prepare.mockRejectedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    mocks.activity.mockClear();
    await expect(
      getBundleActivityRpc({ data: [...data] }),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.activity).not.toHaveBeenCalled();
  });
  it("bounds the batch and rejects an absent ID before querying", () => {
    expect(() =>
      readBundleActivityInput(Array.from({ length: 21 }, () => data[0])),
    ).toThrow("up to 20");
    expect(() =>
      readBundleActivityInput([{ ...data[0], releaseId: "" }]),
    ).toThrow();
    expect(() =>
      readBundleActivityInput([{ ...data[0], channel: "" }]),
    ).toThrow();
    expect(readBundleActivityInput(data)).toEqual(data);
  });
});

describe("activity the console does not serve", () => {
  it.each([
    [
      "without insights()",
      databaseRuntime(memoryDatabase()),
      "without the insights() plugin",
    ],
    [
      "for a self-hosted server that runs insights()",
      createConsoleRuntime({
        database: {
          name: "standalone-repository",
          core: {} as HotUpdaterCoreApi,
          fetchAdmin: vi.fn(),
        },
        plugins: [insights()],
      }),
      "reaches a self-hosted server",
    ],
  ])(
    "is refused %s, before anything is read",
    async (_case, runtime, message) => {
      mocks.prepare.mockResolvedValue({ runtime });

      await expect(
        getBundleEventsRpc({
          data: {
            platform: "ios",
            channel: "production",
            window: "7d",
            endMs: 7_200_000,
            bundleId: "bundle-a",
            type: "LAUNCHED",
          },
        }),
      ).rejects.toMatchObject({
        name: "ConsoleFeatureUnavailableError",
        feature: "insightsAnalytics",
        status: 404,
        message: expect.stringContaining(message),
      });
      await expect(
        getBundleActivityRpc({
          data: [{ platform: "ios", channel: "production", releaseId: "r" }],
        }),
      ).rejects.toMatchObject({ feature: "insightsAnalytics" });
      expect(mocks.events).not.toHaveBeenCalled();
      expect(mocks.activity).not.toHaveBeenCalled();
    },
  );
});
