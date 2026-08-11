import { NIL_UUID } from "@hot-updater/core";
import {
  attachCapabilityContribution,
  attachUniversalComponentDataAdapter,
  createDatabaseClient,
  defineCapability,
  defineUniversalComponentSchema,
  type UniversalComponentDataAdapter,
  type DatabasePlugin,
  type RuntimeStoragePlugin,
  type RuntimeStorageProfile,
} from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import packageJson from "../package.json" with { type: "json" };
import { getHotUpdaterCoreMetadata } from "./createHotUpdaterCore";
import { createHotUpdater } from "./index";
import type {
  CreateHotUpdaterOptions,
  HandlerAPI,
  HandlerOptions,
  HandlerRoutes,
} from "./index";
import { defineFirstPartyServerPlugin } from "./internal/first-party-plugin";
import {
  createRuntimeDatabase,
  createRuntimeStorage,
  createSchemaManagedDatabase,
  runtimeBundle,
  type TestContext,
} from "./runtime.testFixtures";
import { HOT_UPDATER_SCHEMA_VERSION } from "./schema/types";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const updateUrl =
  "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
  `${NIL_UUID}/${NIL_UUID}`;

describe("runtime createHotUpdater", () => {
  it("publishes only the supported runtime and database subpaths", () => {
    const packageExports = packageJson.exports;

    const databaseEntry = packageExports["./db"];
    const hasRuntimeEntry = Object.hasOwn(packageExports, "./runtime");

    expect(databaseEntry).toBeDefined();
    expect(hasRuntimeEntry).toBe(false);
  });

  it("exports runtime-safe handler types from the root entry", () => {
    expectTypeOf<HandlerAPI>().toHaveProperty("getBundles");
    expectTypeOf<HandlerOptions>().toHaveProperty("routes");
    expectTypeOf<keyof HandlerOptions>().toEqualTypeOf<"basePath" | "routes">();
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      | "database"
      | "storages"
      | "storagePlugins"
      | "basePath"
      | "cwd"
      | "routes"
      | "plugins"
    >();
    expectTypeOf<HandlerRoutes>().toEqualTypeOf<{
      readonly updateCheck: boolean;
      readonly bundles: boolean;
    }>();
  });

  it("accepts a direct v2 plugin object without exposing maintenance methods", () => {
    const database: DatabasePlugin = {
      ...createInMemoryDatabasePlugin(),
      name: "contextlessTestDatabase",
    };
    const storage = (): RuntimeStoragePlugin<undefined> => ({
      name: "contextlessTestStorage",
      supportedProtocol: "s3",
      profiles: {
        runtime: {
          getDownloadUrl: async () => ({ fileUrl: "https://example.com" }),
          readText: async () => null,
        },
      },
    });

    const hotUpdater = createHotUpdater({ database, storages: [storage] });

    expect(hotUpdater.basePath).toBe("/api");
    expect(hotUpdater.adapterName).toBe("contextlessTestDatabase");
    expect(hotUpdater.handler).toEqual(expect.any(Function));
    expect("createMigrator" in hotUpdater).toBe(false);
    expect("generateSchema" in hotUpdater).toBe(false);
    expectTypeOf(hotUpdater).not.toHaveProperty("createMigrator");
    expectTypeOf(hotUpdater).not.toHaveProperty("generateSchema");
    expectTypeOf(hotUpdater.handler).parameter(1).toEqualTypeOf<undefined>();
  });

  it("rejects access when a managed schema is not initialized", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("kysely", undefined),
    });

    const result = hotUpdater.getBundles({ limit: 10 });

    await expect(result).rejects.toThrow(
      "Hot Updater database schema is not initialized for kysely.",
    );
  });

  it("rejects access when a managed schema is stale", async () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaManagedDatabase("mongodb", "0.21.0"),
    });

    const result = hotUpdater.getChannels();

    await expect(result).rejects.toThrow(
      "Hot Updater database schema version 0.21.0 is not supported by mongodb.",
    );
  });

  it("checks a ready managed schema only once", async () => {
    const database = createSchemaManagedDatabase(
      "kysely",
      HOT_UPDATER_SCHEMA_VERSION,
    );
    const createMigrator = vi.spyOn(database, "createMigrator");
    const hotUpdater = createHotUpdater({ database });

    await hotUpdater.getChannels();
    await hotUpdater.getChannels();

    expect(createMigrator).toHaveBeenCalledOnce();
  });

  it("passes handler context to storage but not the database plugin", async () => {
    const request = new Request(updateUrl);
    const getUpdateInfo = vi.fn<NonNullable<DatabasePlugin["getUpdateInfo"]>>(
      async () => ({
        fileHash: runtimeBundle.fileHash,
        id: runtimeBundle.id,
        message: runtimeBundle.message,
        shouldForceUpdate: false,
        status: "UPDATE",
        storageUri: runtimeBundle.storageUri,
      }),
    );
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo,
    };
    const getDownloadUrl = vi.fn<
      RuntimeStorageProfile<TestContext>["getDownloadUrl"]
    >(async (_storageUri, context) => ({
      fileUrl: new URL("/bundle.zip", context?.env?.assetHost).toString(),
    }));
    const hotUpdater = createHotUpdater({
      database,
      storages: [createRuntimeStorage(getDownloadUrl)],
      basePath: "/api/check-update",
      routes: { updateCheck: true, bundles: false },
    });
    expectTypeOf(hotUpdater.handler)
      .parameter(1)
      .toEqualTypeOf<TestContext | undefined>();
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
      request,
    };

    const response = await hotUpdater.handler(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fileUrl: "https://assets.example.com/bundle.zip",
      id: runtimeBundle.id,
      status: "UPDATE",
    });
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object));
    expect(getDownloadUrl).toHaveBeenCalledWith(
      runtimeBundle.storageUri,
      context,
    );
  });

  it("does not pass handler context to generic database queries", async () => {
    const request = new Request(updateUrl);
    const database = createRuntimeDatabase();
    await createDatabaseClient(database).insertBundle(runtimeBundle);
    const findMany = vi.spyOn(database, "findMany");
    const hotUpdater = createHotUpdater({
      database,
      storages: [
        createRuntimeStorage(async () => ({
          fileUrl: "https://assets.example.com/bundle.zip",
        })),
      ],
      basePath: "/api/check-update",
      routes: { updateCheck: true, bundles: false },
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    const response = await hotUpdater.handler(request, context);

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.any(Object));
  });

  it("ignores framework bindings when an extra execution argument is passed", async () => {
    const getUpdateInfo = vi.fn(async () => ({
      fileHash: runtimeBundle.fileHash,
      id: runtimeBundle.id,
      message: runtimeBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE" as const,
      storageUri: runtimeBundle.storageUri,
    }));
    const database: DatabasePlugin = {
      ...createRuntimeDatabase(),
      getUpdateInfo,
    };
    const hotUpdater = createHotUpdater({
      database,
      storages: [
        createRuntimeStorage(async () => ({
          fileUrl: "https://assets.example.com/bundle.zip",
        })),
      ],
      basePath: "/api/check-update",
      routes: { updateCheck: true, bundles: false },
    });
    const request = new Request(updateUrl.replace("/api/check-update", ""));

    const response = await Reflect.apply(hotUpdater.handler, undefined, [
      request,
      { binding: "ignored" },
      { waitUntil: () => undefined },
    ]);

    expect(response.status).toBe(200);
    expect(getUpdateInfo).toHaveBeenCalledWith(expect.any(Object));
  });

  it.each([
    { updateCheck: true, bundles: false },
    { updateCheck: false, bundles: false },
  ])(
    "keeps the version route mounted for $updateCheck/$bundles",
    async (routes) => {
      const hotUpdater = createHotUpdater({
        database: createRuntimeDatabase(),
        basePath: "/api/check-update",
        routes,
      });

      const response = await hotUpdater.handler(
        new Request("https://updates.example.com/api/check-update/version"),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        version: HOT_UPDATER_SERVER_VERSION,
      });
    },
  );

  it("keeps core routes public when an authentication provider is installed", async () => {
    const authenticate = vi.fn(async () => {
      throw new Error("public routes must not authenticate");
    });
    const authentication = defineFirstPartyServerPlugin({
      id: "authentication",
      setup: () => ({
        authentication: { id: "authentication", authenticate },
      }),
    });
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [authentication],
    });

    const response = await hotUpdater.handler(
      new Request("https://updates.example.com/api/version"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: HOT_UPDATER_SERVER_VERSION,
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("enforces a core-exception policy across denied and authorized bundle requests", async () => {
    let bodyPulls = 0;
    let authenticated = false;
    const authenticate = vi.fn(async () =>
      authenticated
        ? ({
            kind: "authenticated",
            principal: { issuer: "test", subject: "operator" },
          } as const)
        : ({ kind: "anonymous" } as const),
    );
    const authentication = defineFirstPartyServerPlugin({
      id: "authentication",
      setup: () => ({
        authentication: { id: "authentication", authenticate },
      }),
    });
    const policy = defineFirstPartyServerPlugin({
      id: "route-policy",
      setup: () => ({
        routePolicy: {
          kind: "protect-except-core",
          routeIds: [
            "core.version",
            "core.update.fingerprint",
            "core.update.fingerprint-cohort",
            "core.update.app-version",
            "core.update.app-version-cohort",
          ],
        },
      }),
    });
    const database = createRuntimeDatabase();
    const hotUpdater = createHotUpdater({
      database,
      plugins: [authentication, policy],
      routes: { bundles: true, updateCheck: true },
    });

    const version = await hotUpdater.handler(
      new Request("https://updates.example.com/api/version"),
    );
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulls += 1;
          controller.enqueue(new TextEncoder().encode('{"bundles":[]}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const bundle = await hotUpdater.handler(
      new Request("https://updates.example.com/api/bundles", {
        body,
        duplex: "half",
        method: "POST",
      }),
    );
    authenticated = true;
    const authorizedRequest = new Request(
      "https://updates.example.com/api/bundles",
      {
        body: JSON.stringify(runtimeBundle),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    const authorizedBundle = await hotUpdater.handler(authorizedRequest);

    expect(version.status).toBe(200);
    expect(bundle.status).toBe(401);
    expect(bundle.headers.get("cache-control")).toBe("private, no-store");
    expect(bodyPulls).toBe(0);
    expect(authorizedBundle.status).toBe(201);
    expect(authorizedRequest.bodyUsed).toBe(true);
    await expect(
      createDatabaseClient(database).getBundleById(runtimeBundle.id),
    ).resolves.toMatchObject(runtimeBundle);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("authenticates a protected plugin route before parsing its body", async () => {
    let bodyPulls = 0;
    const parse = vi.fn(async (request: Request) => request.json());
    const handle = vi.fn(async () => Response.json({ accepted: true }));
    const plugin = defineFirstPartyServerPlugin({
      id: "protected-route",
      setup: () => ({
        authentication: {
          id: "authentication",
          authenticate: async () => ({ kind: "anonymous" }),
        },
        routes: [
          {
            access: { kind: "protected" },
            id: "feature.create",
            input: { parse },
            method: "POST",
            path: "/feature",
            handle,
          },
        ],
      }),
    });
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [plugin],
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulls += 1;
          controller.enqueue(new TextEncoder().encode('{"secret":true}'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://updates.example.com/api/feature", {
      body,
      duplex: "half",
      method: "POST",
    });

    const response = await hotUpdater.handler(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(bodyPulls).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("materializes provider capabilities before plugin setup", async () => {
    const capability = defineCapability<{ readonly label: string }>({
      id: "example@1",
      parse(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          typeof Reflect.get(value, "label") !== "string"
        ) {
          throw new TypeError("Invalid example capability.");
        }
        return Object.freeze({ label: Reflect.get(value, "label") });
      },
    });
    const database = attachCapabilityContribution(createRuntimeDatabase(), {
      token: capability,
      create: () => ({ label: "database-provider" }),
    });
    const plugin = defineFirstPartyServerPlugin({
      id: "capability-route",
      requires: [{ missing: "error", token: capability }],
      setup: ({ capabilities }) => {
        const service = capabilities.require(capability);
        return {
          routes: [
            {
              access: { kind: "public" },
              id: "feature.capability",
              method: "GET",
              path: "/feature-capability",
              async handle() {
                return Response.json({ label: service.label });
              },
            },
          ],
        };
      },
    });
    const hotUpdater = createHotUpdater({ database, plugins: [plugin] });

    const response = await hotUpdater.handler(
      new Request("https://updates.example.com/api/feature-capability"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      label: "database-provider",
    });
  });

  it("exposes bound component data through maintenance metadata", () => {
    const schema = defineUniversalComponentSchema({
      id: "audit-log",
      versions: [
        {
          version: "1",
          tables: [
            {
              columns: [
                { name: "id", primaryKey: true, type: "string" },
                { name: "occurred_at_ms", type: "float" },
              ],
              name: "audit_records",
            },
          ],
          orderedScans: [
            {
              columns: ["occurred_at_ms", "id"],
              name: "chronological",
              table: "audit_records",
            },
          ],
        },
      ],
    });
    const source = {
      schema,
      append: async () => undefined,
      assertReady: async () => undefined,
      create: async () => "created" as const,
      get: async () => null,
      orderedScan: async () => [],
    };
    const migrate = vi.fn(async () => ({ changed: true, version: "1" }));
    const artifacts = vi.fn(() => []);
    const adapter: UniversalComponentDataAdapter = {
      artifacts,
      bind: () => source,
      migrate,
    };
    const database = attachUniversalComponentDataAdapter(
      createRuntimeDatabase(),
      () => adapter,
    );
    const plugin = defineFirstPartyServerPlugin({
      id: "audit-log",
      schema,
      setup: () => ({}),
    });

    const hotUpdater = createHotUpdater({ database, plugins: [plugin] });
    const metadata = getHotUpdaterCoreMetadata(hotUpdater);

    expect(metadata?.components?.schemas).toEqual([schema]);
    expect(metadata?.components?.sources).toEqual([source]);
    expect(metadata?.universalComponentDataAdapter).toBe(adapter);
    expect(migrate).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
  });

  it("does not materialize component data without a schema declaration", () => {
    const createAdapter = vi.fn<() => UniversalComponentDataAdapter>(() => ({
      bind() {
        throw new Error("unused");
      },
    }));
    const database = attachUniversalComponentDataAdapter(
      createRuntimeDatabase(),
      createAdapter,
    );
    const plugin = defineFirstPartyServerPlugin({
      id: "schema-free",
      setup: () => ({}),
    });

    const hotUpdater = createHotUpdater({ database, plugins: [plugin] });
    const metadata = getHotUpdaterCoreMetadata(hotUpdater);

    expect(metadata?.components).toBeUndefined();
    expect(metadata?.universalComponentDataAdapter).toBeUndefined();
    expect(createAdapter).not.toHaveBeenCalled();
  });
});
