// @vitest-environment node

import type { HotUpdaterCoreApi } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  insights,
  remoteConfig,
  type RemoteConfigTemplate,
} from "@hot-updater/server/plugins";
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
    validator(validate: (input: unknown) => unknown) {
      return {
        ...this,
        handler:
          (handler: (input: { data: unknown }) => unknown) =>
          async (input: { data: unknown }) =>
            handler({ data: validate(input.data) }),
      };
    },
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));

import {
  getRemoteConfigRpc,
  getRemoteConfigVersionRpc,
  listRemoteConfigVersionsRpc,
  previewRemoteConfigRpc,
  publishRemoteConfigRpc,
  rollbackRemoteConfigRpc,
} from "./remote-config-rpc";

const template: RemoteConfigTemplate = {
  conditions: [
    { name: "Android", rules: [{ type: "platform", platforms: ["android"] }] },
  ],
  parameters: {
    welcome: {
      valueType: "STRING",
      defaultValue: { value: "Hi" },
      conditionalValues: { Android: { value: "Hi, Android" } },
    },
  },
};

const memoryDatabase = () => ({
  name: "memory",
  adapter: createMemoryAdapter(),
});

/** The console over the server's database, running `remoteConfig()` as the server does. */
const localRuntime = () => {
  const database = memoryDatabase();
  const plugins = [remoteConfig()];
  return createConsoleRuntime({
    database,
    plugins,
    api: createHotUpdater({ database, plugins, clientAccess: "public" }).api,
  });
};

/** The console over a self-hosted server's admin handler, as standaloneRepository reaches it. */
const remoteRuntime = (serverPlugins = [remoteConfig()]) => {
  const server = createHotUpdater({
    database: memoryDatabase(),
    plugins: serverPlugins,
    clientAccess: "public",
  });
  const fetchAdmin = vi.fn((path: string, init?: RequestInit) =>
    server.handlers.admin(
      new Request(`https://admin.example.com${path}`, init),
    ),
  );
  return {
    server,
    fetchAdmin,
    runtime: createConsoleRuntime({
      database: {
        name: "standalone-repository",
        core: {} as HotUpdaterCoreApi,
        fetchAdmin,
      },
      plugins: [remoteConfig()],
    }),
  };
};

afterEach(() => vi.resetAllMocks());

describe.each([
  ["over the database", () => ({ runtime: localRuntime() })],
  ["over a self-hosted server's admin API", () => remoteRuntime()],
])("Remote Config RPCs %s", (_case, start) => {
  it("publishes, refuses stale and invalid templates, lists, and rolls back", async () => {
    mocks.prepare.mockResolvedValue({ runtime: start().runtime });

    await expect(getRemoteConfigRpc()).resolves.toMatchObject({ version: 0 });
    await expect(
      publishRemoteConfigRpc({
        data: { template, baseVersion: 0, description: "First" },
      }),
    ).resolves.toMatchObject({
      status: "published",
      version: { version: 1, description: "First" },
    });
    await expect(
      publishRemoteConfigRpc({ data: { template, baseVersion: 0 } }),
    ).resolves.toEqual({ status: "conflict", currentVersion: 1 });
    await expect(
      publishRemoteConfigRpc({
        data: {
          template: { parameters: { bad: { valueType: "COLOR" } } },
          baseVersion: 1,
        },
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      issues: [{ path: "parameters.bad.valueType" }],
    });
    await publishRemoteConfigRpc({ data: { template: {}, baseVersion: 1 } });

    await expect(
      rollbackRemoteConfigRpc({ data: { version: 1, baseVersion: 2 } }),
    ).resolves.toMatchObject({
      status: "published",
      version: { version: 3, updateType: "ROLLBACK", rollbackSource: 1 },
    });
    await expect(
      rollbackRemoteConfigRpc({ data: { version: 9, baseVersion: 3 } }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(getRemoteConfigRpc()).resolves.toMatchObject({
      version: 3,
      template,
    });
    const page = await listRemoteConfigVersionsRpc({ data: {} });
    expect(page.versions.map(({ version }) => version)).toEqual([3, 2, 1]);
    await expect(
      getRemoteConfigVersionRpc({ data: { version: 2 } }),
    ).resolves.toMatchObject({ version: 2, template: EMPTY });
    await expect(
      getRemoteConfigVersionRpc({ data: { version: 8 } }),
    ).resolves.toBeNull();
  });
});

const EMPTY = { conditions: [], parameters: {} };

describe("previewRemoteConfigRpc", () => {
  it("evaluates a draft for a device, or lists what to fix", async () => {
    mocks.prepare.mockResolvedValue({ runtime: localRuntime() });

    await expect(
      previewRemoteConfigRpc({
        data: { template, context: { platform: "android", channel: " " } },
      }),
    ).resolves.toEqual({
      status: "ok",
      parameters: { welcome: { value: "Hi, Android", condition: "Android" } },
    });
    await expect(
      previewRemoteConfigRpc({
        data: { template: { parameters: 1 }, context: {} },
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    await expect(
      previewRemoteConfigRpc({
        data: { template, context: { platform: "web" } },
      }),
    ).rejects.toThrow("platform");
  });

  it("evaluates a date-time rule at the time asked, or at the server's clock", async () => {
    mocks.prepare.mockResolvedValue({ runtime: localRuntime() });
    const scheduled = {
      conditions: [
        {
          name: "Launch",
          rules: [{ type: "dateTime", from: "2026-10-08T10:00:00Z" }],
        },
      ],
      parameters: {
        banner: {
          valueType: "STRING",
          defaultValue: { value: "soon" },
          conditionalValues: { Launch: { value: "live" } },
        },
      },
    };
    const at = async (now?: number) =>
      (
        (await previewRemoteConfigRpc({
          data: {
            template: scheduled,
            context: now === undefined ? {} : { now },
          },
        })) as { parameters: Record<string, { value: string | null }> }
      ).parameters.banner!.value;

    expect(await at(Date.parse("2026-10-08T09:00:00Z"))).toBe("soon");
    expect(await at(Date.parse("2026-10-08T10:00:00Z"))).toBe("live");
    expect(await at()).toBe(
      Date.now() >= Date.parse("2026-10-08T10:00:00Z") ? "live" : "soon",
    );
    await expect(
      previewRemoteConfigRpc({
        data: { template: scheduled, context: { now: "today" } },
      }),
    ).rejects.toThrow("now");
  });
});

describe("Remote Config RPC access", () => {
  it("refuses Remote Config without remoteConfig() in the config", async () => {
    const database = memoryDatabase();
    mocks.prepare.mockResolvedValue({
      runtime: createConsoleRuntime({
        database,
        plugins: [insights()],
        api: createHotUpdater({
          database,
          plugins: [insights()],
          clientAccess: "public",
        }).api,
      }),
    });

    await expect(getRemoteConfigRpc()).rejects.toMatchObject({
      name: "ConsoleFeatureUnavailableError",
      feature: "remoteConfig",
      status: 404,
    });
  });

  it("tells a self-hosted server that stopped running remoteConfig() from one without the version", async () => {
    const { runtime } = remoteRuntime([]);
    mocks.prepare.mockResolvedValue({ runtime });

    await expect(getRemoteConfigRpc()).rejects.toMatchObject({
      name: "ConsoleFeatureUnavailableError",
      feature: "remoteConfig",
    });
  });

  it("sends a publish as a PUT with a JSON body to the admin route", async () => {
    const { runtime, fetchAdmin } = remoteRuntime();
    mocks.prepare.mockResolvedValue({ runtime });

    await publishRemoteConfigRpc({ data: { template, baseVersion: 0 } });

    const [path, init] = fetchAdmin.mock.calls[0]!;
    expect(path).toBe("/remote-config/template");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      template,
      baseVersion: 0,
    });
  });
});
