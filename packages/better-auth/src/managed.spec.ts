import { attachUniversalComponentDataAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { defineFirstPartyServerPlugin } from "@hot-updater/server/internal/first-party-plugin";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../../server/src/runtime.testFixtures";
import {
  managedAccessKeyComponentSchema,
  managedBetterAuthPlugin,
  managedRoutePolicy,
  type ManagedAccessKeyRecord,
  type ManagedAccessKeyStore,
} from "./managed";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const RAW_API_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_API_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const API_KEY_SHA256 = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";

const activeRecord: ManagedAccessKeyRecord = Object.freeze({
  createdAt: 1,
  enabled: true,
  hash: API_KEY_SHA256,
  id: `managed-client-${API_KEY_SHA256}`,
  name: "Default",
  prefix: RAW_API_KEY.slice(0, 6),
  revokedAt: null,
  role: "client",
});

const createStore = (
  initial: readonly ManagedAccessKeyRecord[] = [activeRecord],
): ManagedAccessKeyStore => {
  const records = new Map(initial.map((record) => [record.hash, record]));
  return Object.freeze({
    async create(record) {
      if (records.has(record.hash)) return "existing";
      records.set(record.hash, record);
      return "created";
    },
    async findByHash(hash) {
      return records.get(hash) ?? null;
    },
    async list() {
      return [...records.values()];
    },
    async revoke({ id, revokedAt }) {
      const record = [...records.values()].find((value) => value.id === id);
      if (record === undefined) return null;
      const revoked = Object.freeze({
        ...record,
        enabled: false,
        revokedAt,
      });
      records.set(record.hash, revoked);
      return revoked;
    },
  });
};

const analyticsIngestion = defineFirstPartyServerPlugin({
  id: "test-analytics-ingestion",
  setup: () => ({
    routes: [
      {
        access: { kind: "public" },
        id: "analytics.appendBundleEvent",
        method: "POST",
        path: "/events",
        handle: async () => new Response(null, { status: 204 }),
      },
      {
        access: { kind: "public" },
        id: "analytics.getBundleEventSummary",
        method: "GET",
        path: "/analytics-summary",
        handle: async () => Response.json({ installations: 1 }),
      },
    ],
  }),
});

const request = (path: string, apiKey?: string, method = "GET") =>
  new Request(`https://example.com${path}`, {
    headers: apiKey === undefined ? undefined : { "x-api-key": apiKey },
    method,
  });

const managementRequest = (path: string, token: string) =>
  new Request(`https://example.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

const createManagedServer = (
  scope: "all" | "client" | "management",
  store = createStore(),
  managementBearerToken?: string,
) =>
  createHotUpdater({
    database: createRuntimeDatabase(),
    plugins: [
      managedBetterAuthPlugin({ managementBearerToken, store }),
      managedRoutePolicy({ scope }),
      analyticsIngestion,
    ],
    routes: { bundles: true, updateCheck: true },
  });

describe("managedBetterAuthPlugin", () => {
  it("contributes authentication without changing public route defaults", async () => {
    const plugin = managedBetterAuthPlugin({ store: createStore() });
    const contribution = plugin.setup(createPluginSetupContext());
    const server = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [plugin],
    });

    const responses = await Promise.all([
      server.handler(request("/api/version")),
      server.handler(request("/api/version", WRONG_API_KEY)),
    ]);

    expect(Reflect.ownKeys(contribution as object)).toEqual(["authentication"]);
    expect(plugin.schema).toBeUndefined();
    expect(managedBetterAuthPlugin().schema).toBe(
      managedAccessKeyComponentSchema,
    );
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  });

  it("resolves the access-key store from its canonical component source", async () => {
    const database = attachUniversalComponentDataAdapter(
      createRuntimeDatabase(),
      () => ({
        bind(schema) {
          return {
            schema,
            append: async () => undefined,
            assertReady: async () => undefined,
            create: async () => "created",
            get: async ({ primaryKey, table }) =>
              table === "better_auth_managed_access_keys" &&
              primaryKey === activeRecord.id
                ? {
                    created_at_ms: activeRecord.createdAt,
                    hash: activeRecord.hash,
                    id: activeRecord.id,
                    name: activeRecord.name,
                    prefix: activeRecord.prefix,
                    role: activeRecord.role,
                  }
                : null,
            orderedScan: async () => [],
          };
        },
      }),
    );
    const server = createHotUpdater({
      database,
      plugins: [
        managedBetterAuthPlugin(),
        managedRoutePolicy({ scope: "client" }),
      ],
    });

    const response = await server.handler(
      request(
        "/api/app-version/ios/1.0.0/production/0/builtin/stable",
        RAW_API_KEY,
      ),
    );

    expect(response.status).toBe(200);
  });

  it("requires a component adapter when no explicit store is configured", () => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        plugins: [managedBetterAuthPlugin()],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_COMPONENT_DATA_ADAPTER",
      }),
    );
  });

  it("emits exact management, client, and all-route policies", () => {
    const management = managedRoutePolicy({ scope: "management" }).setup(
      createPluginSetupContext(),
    );
    const client = managedRoutePolicy({ scope: "client" }).setup(
      createPluginSetupContext(),
    );
    const all = managedRoutePolicy({ scope: "all" }).setup(
      createPluginSetupContext(),
    );

    expect(Reflect.get(management as object, "routePolicy")).toEqual({
      kind: "protect-except-core",
      routeIds: [
        "core.version",
        "core.update.fingerprint",
        "core.update.fingerprint-cohort",
        "core.update.app-version",
        "core.update.app-version-cohort",
      ],
    });
    expect(Reflect.get(client as object, "routePolicy")).toEqual({
      kind: "protect-except-core",
      routeIds: ["core.version"],
    });
    expect(Reflect.get(all as object, "routePolicy")).toEqual({
      kind: "protect-all",
    });
  });

  it("keeps version public while requiring the client key for OTA", async () => {
    const server = createManagedServer("client");
    const otaPath = "/api/app-version/ios/1.0.0/production/0/builtin/stable";

    const responses = await Promise.all([
      server.handler(request("/api/version")),
      server.handler(request(otaPath)),
      server.handler(request(otaPath, WRONG_API_KEY)),
      server.handler(request(otaPath, RAW_API_KEY)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 401, 401, 200]);
  });

  it("requires the analytics write permission for event ingestion", async () => {
    const server = createManagedServer("client");

    const responses = await Promise.all([
      server.handler(request("/api/events", undefined, "POST")),
      server.handler(request("/api/events", WRONG_API_KEY, "POST")),
      server.handler(request("/api/events", RAW_API_KEY, "POST")),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 204]);
  });

  it("never grants client keys access to bundle management routes", async () => {
    const server = createManagedServer("client");

    const responses = await Promise.all([
      server.handler(request("/api/bundles")),
      server.handler(request("/api/bundles", RAW_API_KEY)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401]);
  });

  it("never grants client keys access to analytics reads", async () => {
    const server = createManagedServer("client");

    const responses = await Promise.all([
      server.handler(request("/api/analytics-summary")),
      server.handler(request("/api/analytics-summary", RAW_API_KEY)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401]);
  });

  it("authenticates a configured management bearer without granting client keys", async () => {
    const store = createStore();
    const findByHash = vi.fn(store.findByHash);
    const server = createManagedServer(
      "client",
      { ...store, findByHash },
      "management-secret",
    );

    const responses = await Promise.all([
      server.handler(managementRequest("/api/bundles", "management-secret")),
      server.handler(
        managementRequest("/api/analytics-summary", "management-secret"),
      ),
      server.handler(managementRequest("/api/bundles", "wrong-secret")),
      server.handler(request("/api/bundles", RAW_API_KEY)),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200, 401, 401]);
    expect(findByHash).not.toHaveBeenCalled();
  });

  it("rejects a revoked key without mutating the request body", async () => {
    const store = createStore();
    await store.revoke({ id: activeRecord.id, revokedAt: 2 });
    const server = createManagedServer("client", store);
    let bodyPulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const eventRequestInit = {
      body,
      duplex: "half",
      headers: { "x-api-key": RAW_API_KEY },
      method: "POST" as const,
    };
    const eventRequest = new Request(
      "https://example.com/api/events",
      eventRequestInit,
    );

    const response = await server.handler(eventRequest);

    expect(response.status).toBe(401);
    expect(eventRequest.bodyUsed).toBe(false);
    expect(bodyPulls).toBe(0);
  });

  it("uses read-only lookups for repeated and concurrent requests", async () => {
    const baseStore = createStore();
    const findByHash = vi.fn(baseStore.findByHash);
    const create = vi.fn(baseStore.create);
    const revoke = vi.fn(baseStore.revoke);
    const store: ManagedAccessKeyStore = {
      create,
      findByHash,
      list: baseStore.list,
      revoke,
    };
    const server = createManagedServer("client", store);
    const path = "/api/fingerprint/ios/hash/production/0/builtin/stable";

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        server.handler(request(path, RAW_API_KEY)),
      ),
    );

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(findByHash).toHaveBeenCalledTimes(20);
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each([null, "invalid", []])(
    "rejects invalid managed options from JavaScript %#",
    (options) => {
      expect(() =>
        Reflect.apply(managedBetterAuthPlugin, undefined, [options]),
      ).toThrow("Managed Better Auth options must be an object.");
    },
  );

  it.each(["", null, 1])(
    "rejects invalid management bearer tokens from JavaScript %#",
    (managementBearerToken) => {
      expect(() =>
        Reflect.apply(managedBetterAuthPlugin, undefined, [
          { managementBearerToken, store: createStore() },
        ]),
      ).toThrow(
        "Managed Better Auth managementBearerToken must be a non-empty string.",
      );
    },
  );

  it.each([undefined, null, {}, { scope: "unknown" }])(
    "rejects an invalid route policy scope from JavaScript %#",
    (options) => {
      expect(() =>
        Reflect.apply(managedRoutePolicy, undefined, [options]),
      ).toThrow(
        'Managed route policy scope must be "management", "client", or "all".',
      );
    },
  );
});
