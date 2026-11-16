import {
  createEngineDatabase,
  createMemoryAdapter,
  type DatabaseAdapter,
  migrateCoreSchema,
  type RemoteDatabase,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
import { createHotUpdater, HOT_UPDATER_SERVER_VERSION } from "@hot-updater/server";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { assembleServer } from "./assembleServer";
import {
  enablePartitioningAfterDeploy,
  enableReleaseCatalogPartitioning,
  PartitioningEnableError,
} from "./releaseCatalogPartitioning";

const URL_ = "https://updates.example.com/api";

/** A deployed server over `adapter`, and a fetch that reaches its client mount. */
const deployed = async (adapter: DatabaseAdapter = createMemoryAdapter()) => {
  await migrateCoreSchema(adapter, "memory");
  const server = createHotUpdater({
    clientAccess: "public",
    database: createEngineDatabase({ name: "memory", adapter }),
    storage: createReleaseCatalogTestStorage(),
  });
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return server.handlers.client(
      new Request(`http://localhost${url.pathname.replace(/^\/api/u, "")}${url.search}`, init),
    );
  }) as typeof fetch;
  const switchValue = async () =>
    (await adapter.get(SETTINGS_TABLE, [["catalog.partitioning"]]))[0]
      ?.value ?? null;
  return { adapter, server, fetchImpl, requests, switchValue };
};

/** The CLI's assembly over the same database the server reads. */
const cliOver = (adapter: DatabaseAdapter) =>
  assembleServer({ database: createEngineDatabase({ name: "memory", adapter }) });

describe("enableReleaseCatalogPartitioning", () => {
  it("over the server's database: stores a token, and the server's client route turns it on", async () => {
    const env = await deployed();
    await expect(
      enableReleaseCatalogPartitioning({
        server: cliOver(env.adapter),
        serverUrl: `${URL_}/`,
        fetchImpl: env.fetchImpl,
      }),
    ).resolves.toEqual({ changed: true });
    expect(env.requests).toEqual(["POST /api/release-catalog-partitioning"]);
    expect(await env.switchValue()).toBe("on");
    await expect(
      enableReleaseCatalogPartitioning({
        server: cliOver(env.adapter),
        serverUrl: URL_,
        fetchImpl: env.fetchImpl,
      }),
    ).resolves.toEqual({ changed: false });
  });

  it("over standaloneRepository: the admin route", async () => {
    const env = await deployed();
    const paths: string[] = [];
    const database: RemoteDatabase = {
      name: "standalone-repository",
      core: env.server.core,
      fetchAdmin: (path, init) => {
        paths.push(`${init?.method} ${path}`);
        return env.server.handlers.admin(
          new Request(`http://localhost${path}`, init),
        );
      },
    };
    await expect(
      enableReleaseCatalogPartitioning({ server: { database } }),
    ).resolves.toEqual({ changed: true });
    expect(paths).toEqual(["POST /release-catalog-partitioning"]);
  });

  it("refuses with one line when the server reads another database, and sets nothing", async () => {
    const env = await deployed();
    const other = createMemoryAdapter();
    await migrateCoreSchema(other, "memory");
    const refusal = enableReleaseCatalogPartitioning({
      server: cliOver(other),
      serverUrl: URL_,
      fetchImpl: env.fetchImpl,
    });
    await expect(refusal).rejects.toMatchObject({ code: "REQUEST_REJECTED" });
    expect(await env.switchValue()).toBeNull();
  });

  it("refuses a 1.1 server's 404 with one line", async () => {
    const env = await deployed();
    const refusal = enableReleaseCatalogPartitioning({
      server: cliOver(env.adapter),
      serverUrl: URL_,
      fetchImpl: (async () =>
        Response.json({ error: "Not found" }, { status: 404 })) as never,
    });
    await expect(refusal).rejects.toMatchObject({
      code: "SERVER_TOO_OLD",
      message: `${URL_} runs Hot Updater before 1.2.0. Deploy 1.2.0 to every server first.`,
    });
    expect(await env.switchValue()).toBeNull();
  });

  it("passes the server's refusal through", async () => {
    const env = await deployed();
    const refusal = enableReleaseCatalogPartitioning({
      server: cliOver(env.adapter),
      serverUrl: URL_,
      fetchImpl: (async () =>
        Response.json(
          { code: "PARTITIONS_KEY_ORDER", error: "not in byte order" },
          { status: 409 },
        )) as never,
    });
    await expect(refusal).rejects.toMatchObject({
      code: "REFUSED",
      serverCode: "PARTITIONS_KEY_ORDER",
      message: "not in byte order",
    });
  });

  it("asks for the server's URL over a direct database", async () => {
    const env = await deployed();
    await expect(
      enableReleaseCatalogPartitioning({ server: cliOver(env.adapter) }),
    ).rejects.toBeInstanceOf(PartitioningEnableError);
    expect(await env.switchValue()).toBeNull();
  });
});

describe("enablePartitioningAfterDeploy", () => {
  const run = async (
    env: Awaited<ReturnType<typeof deployed>>,
    options: Partial<Parameters<typeof enablePartitioningAfterDeploy>[0]>,
  ) =>
    enablePartitioningAfterDeploy({
      server: cliOver(env.adapter),
      serverUrl: URL_,
      expectedVersion: HOT_UPDATER_SERVER_VERSION,
      deployed: async () => true,
      fetchImpl: env.fetchImpl,
      ...options,
    });

  it("turns it on after the completion signal and five cache-busted /version answers", async () => {
    const env = await deployed();
    await expect(run(env, {})).resolves.toEqual({
      enabled: true,
      changed: true,
    });
    const versions = env.requests.filter((r) => r.startsWith("GET /api/version?"));
    expect(versions).toHaveLength(5);
    expect(new Set(versions).size).toBe(5);
    expect(env.requests.at(-1)).toBe("POST /api/release-catalog-partitioning");
    // An upgrade replayed on an enabled database: on, unchanged.
    await expect(run(env, {})).resolves.toEqual({
      enabled: true,
      changed: false,
    });
  });

  it.each([
    ["no completion signal", { deployed: undefined }],
    [
      "a completion signal that refuses",
      { deployed: async () => "the distribution is InProgress." },
    ],
    [
      "a completion signal that throws",
      {
        deployed: async () => {
          throw new Error("GetDistribution failed");
        },
      },
    ],
    ["another expected version", { expectedVersion: "9.9.9" }],
  ] as const)("leaves it off with %s, and prints the command", async (_, options) => {
    const env = await deployed();
    const result = await run(env, options as never);
    expect(result).toMatchObject({
      enabled: false,
      command: `npx hot-updater db partition-catalogs --server-url ${URL_}`,
    });
    expect(env.requests).not.toContain("POST /api/release-catalog-partitioning");
    expect(await env.switchValue()).toBeNull();
  });

  it("leaves it off when old and new servers answer side by side, or a cache answers a stale /version", async () => {
    const env = await deployed();
    for (const answers of [
      // Mixed: one route still reaches the old server.
      [HOT_UPDATER_SERVER_VERSION, "1.1.16", HOT_UPDATER_SERVER_VERSION],
      // Stale: a cache answers the old /version every time.
      ["1.1.16"],
    ]) {
      let call = 0;
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/version")) {
          const version = answers[call++ % answers.length];
          return Response.json({ version });
        }
        return env.fetchImpl(input, init);
      }) as typeof fetch;
      const result = await run(env, { fetchImpl });
      expect(result).toMatchObject({
        enabled: false,
        reason: `${URL_}/version answered 1.1.16, not ${HOT_UPDATER_SERVER_VERSION}.`,
      });
    }
    expect(await env.switchValue()).toBeNull();
  });

  it("leaves it off when the server refuses, and the switch stays unset", async () => {
    const env = await deployed();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json(
            { code: "PARTITIONS_UNAVAILABLE", error: "no such table" },
            { status: 409 },
          )
        : env.fetchImpl(input, init)) as typeof fetch;
    await expect(run(env, { fetchImpl })).resolves.toMatchObject({
      enabled: false,
      reason: "no such table",
    });
    expect(await env.switchValue()).toBeNull();
  });
});
