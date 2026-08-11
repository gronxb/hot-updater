import { runInNewContext } from "node:vm";

import {
  attachCapabilityContribution,
  attachUniversalComponentDataAdapter,
  defineCapability,
  defineUniversalComponentSchema,
  type UniversalComponentDataAdapter,
  type UniversalComponentDataSource,
  type UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import type { HotUpdaterRoutePolicy, HotUpdaterServerRoute } from "./contracts";
import { validatePluginContribution } from "./contributionValidation";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import { defineFirstPartyServerPlugin } from "./manifest";

const createRuntime = (
  database: ReturnType<typeof createRuntimeDatabase> = createRuntimeDatabase(),
) =>
  createGuardedInfrastructureRuntime({
    database,
    storages: [],
  });

const createComponentSchema = (
  id: string,
  table = `${id.replaceAll("-", "_")}_records`,
  index?: string,
): UniversalComponentSchema =>
  defineUniversalComponentSchema({
    id,
    versions: [
      {
        version: "1",
        tables: [
          {
            name: table,
            columns: [
              { name: "id", primaryKey: true, type: "string" },
              { name: "occurred_at_ms", type: "float" },
            ],
            ...(index === undefined
              ? {}
              : {
                  indexes: [{ columns: ["occurred_at_ms"], name: index }],
                }),
          },
        ],
        orderedScans: [
          {
            columns: ["occurred_at_ms", "id"],
            name: "chronological",
            table,
          },
        ],
      },
    ],
  });

const createComponentDataSource = (
  schema: UniversalComponentSchema,
): UniversalComponentDataSource => ({
  schema,
  append: async () => undefined,
  assertReady: async () => undefined,
  create: async () => "created",
  get: async () => null,
  orderedScan: async () => [],
});

const route = (
  id: string,
  path: `/${string}`,
  access: HotUpdaterServerRoute["access"] = { kind: "public" },
): HotUpdaterServerRoute => ({
  access,
  id,
  method: "GET",
  path,
  async handle() {
    return new Response();
  },
});

const authenticationPlugin = () =>
  defineFirstPartyServerPlugin({
    id: "authentication",
    setup: () => ({
      authentication: {
        id: "test-authentication",
        async authenticate() {
          return { kind: "anonymous" } as const;
        },
      },
    }),
  });

describe("composeServerKernel", () => {
  it("binds declared component schemas before setup without administrative side effects", () => {
    const calls: string[] = [];
    const schema = createComponentSchema("audit-log");
    const otherIdentity = createComponentSchema("audit-log");
    const source = createComponentDataSource(schema);
    const assertReady = vi.spyOn(source, "assertReady");
    const migrate = vi.fn(async () => ({ changed: true, version: "1" }));
    const artifacts = vi.fn(() => []);
    const adapter: UniversalComponentDataAdapter = {
      artifacts,
      bind(boundSchema) {
        calls.push(`bind:${boundSchema.id}`);
        return source;
      },
      migrate,
    };
    const database = attachUniversalComponentDataAdapter(
      createRuntimeDatabase(),
      () => {
        calls.push("adapter");
        return adapter;
      },
    );
    const plugin = defineFirstPartyServerPlugin({
      id: "audit-plugin",
      schema,
      setup: ({ components }) => {
        calls.push("setup");
        expect(components.get(schema)).toBe(source);
        expect(components.require(schema)).toBe(source);
        expect(components.get(otherIdentity)).toBeUndefined();
        return {};
      },
    });

    const composed = composeServerKernel({
      carriers: [database],
      coreRoutes: [],
      databaseCarrier: database,
      plugins: [plugin],
      runtime: createRuntime(database),
    });

    expect(calls).toEqual(["adapter", "bind:audit-log", "setup"]);
    expect(composed.components.schemas).toEqual([schema]);
    expect(composed.components.sources).toEqual([source]);
    expect(composed.components.require(schema)).toBe(source);
    expect(assertReady).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(artifacts).not.toHaveBeenCalled();
  });

  it("binds component schemas deterministically before ordered plugin setup", () => {
    const calls: string[] = [];
    const zetaSchema = createComponentSchema("zeta-component");
    const alphaSchema = createComponentSchema("alpha-component");
    const database = attachUniversalComponentDataAdapter(
      createRuntimeDatabase(),
      () => ({
        bind(schema) {
          calls.push(`bind:${schema.id}`);
          return createComponentDataSource(schema);
        },
      }),
    );
    const plugins = [
      defineFirstPartyServerPlugin({
        id: "a-zeta-plugin",
        schema: zetaSchema,
        setup: () => {
          calls.push("setup:a-zeta-plugin");
          return {};
        },
      }),
      defineFirstPartyServerPlugin({
        id: "z-alpha-plugin",
        schema: alphaSchema,
        setup: () => {
          calls.push("setup:z-alpha-plugin");
          return {};
        },
      }),
    ];

    const composed = composeServerKernel({
      carriers: [database],
      coreRoutes: [],
      databaseCarrier: database,
      plugins,
      runtime: createRuntime(database),
    });

    expect(composed.components.schemas).toEqual([alphaSchema, zetaSchema]);
    expect(calls).toEqual([
      "bind:alpha-component",
      "bind:zeta-component",
      "setup:a-zeta-plugin",
      "setup:z-alpha-plugin",
    ]);
  });

  it("requires the component adapter to be attached to the database carrier", () => {
    const schema = createComponentSchema("audit-log");
    const setup = vi.fn(() => ({}));
    const plugin = defineFirstPartyServerPlugin({
      id: "audit-plugin",
      schema,
      setup,
    });
    const nonDatabaseCarrier = attachUniversalComponentDataAdapter({}, () => ({
      bind: createComponentDataSource,
    }));

    expect(() =>
      composeServerKernel({
        carriers: [nonDatabaseCarrier],
        coreRoutes: [],
        databaseCarrier: createRuntimeDatabase(),
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MISSING_COMPONENT_DATA_ADAPTER",
        details: { componentIds: ["audit-log"] },
      }),
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it("rejects an asynchronous component bind before plugin setup", async () => {
    const schema = createComponentSchema("audit-log");
    const setup = vi.fn(() => ({}));
    const adapter = {
      bind: () => Promise.resolve(createComponentDataSource(schema)),
    } as unknown as UniversalComponentDataAdapter;
    const database = attachUniversalComponentDataAdapter(
      createRuntimeDatabase(),
      () => adapter,
    );
    const plugin = defineFirstPartyServerPlugin({
      id: "audit-plugin",
      schema,
      setup,
    });

    expect(() =>
      composeServerKernel({
        carriers: [database],
        coreRoutes: [],
        databaseCarrier: database,
        plugins: [plugin],
        runtime: createRuntime(database),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_COMPONENT_DATA_ADAPTER",
        details: { componentId: "audit-log" },
      }),
    );
    expect(setup).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each(["bundles", "bundle_patches", "private_hot_updater_settings"])(
    "rejects a component table named like core table %s",
    (table) => {
      const createAdapter = vi.fn(() => ({
        bind: createComponentDataSource,
      }));
      const database = attachUniversalComponentDataAdapter(
        createRuntimeDatabase(),
        createAdapter,
      );
      const plugin = defineFirstPartyServerPlugin({
        id: "component-plugin",
        schema: createComponentSchema("component", table),
        setup: () => ({}),
      });

      expect(() =>
        composeServerKernel({
          carriers: [database],
          coreRoutes: [],
          databaseCarrier: database,
          plugins: [plugin],
          runtime: createRuntime(database),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "DUPLICATE_COMPONENT_TABLE",
          details: { tableName: table },
        }),
      );
      expect(createAdapter).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      firstIndex: "shared_records_idx",
      secondIndex: "shared_records_idx",
    },
    {
      firstIndex: "bundles_channel_idx",
      secondIndex: "other_records_idx",
    },
  ])(
    "rejects globally conflicting SQL index name $firstIndex",
    ({ firstIndex, secondIndex }) => {
      const createAdapter = vi.fn(() => ({
        bind: createComponentDataSource,
      }));
      const database = attachUniversalComponentDataAdapter(
        createRuntimeDatabase(),
        createAdapter,
      );
      const schemas = [
        createComponentSchema("first-component", "first_records", firstIndex),
        createComponentSchema(
          "second-component",
          "second_records",
          secondIndex,
        ),
      ];
      const plugins = schemas.map((schema, index) =>
        defineFirstPartyServerPlugin({
          id: `plugin-${index}`,
          schema,
          setup: () => ({}),
        }),
      );

      expect(() =>
        composeServerKernel({
          carriers: [database],
          coreRoutes: [],
          databaseCarrier: database,
          plugins,
          runtime: createRuntime(database),
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "DUPLICATE_COMPONENT_INDEX",
          details: { indexName: firstIndex },
        }),
      );
      expect(createAdapter).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      code: "DUPLICATE_COMPONENT_ID",
      first: createComponentSchema("first-component", "first_records"),
      second: createComponentSchema("first-component", "second_records"),
    },
    {
      code: "DUPLICATE_COMPONENT_TABLE",
      first: createComponentSchema("first-component", "shared_records"),
      second: createComponentSchema("second-component", "shared_records"),
    },
  ])(
    "rejects $code before materializing the adapter",
    ({ code, first, second }) => {
      const createAdapter = vi.fn(() => ({
        bind: createComponentDataSource,
      }));
      const database = attachUniversalComponentDataAdapter(
        createRuntimeDatabase(),
        createAdapter,
      );
      const plugins = [first, second].map((schema, index) =>
        defineFirstPartyServerPlugin({
          id: `plugin-${index}`,
          schema,
          setup: () => ({}),
        }),
      );

      expect(() =>
        composeServerKernel({
          carriers: [database],
          coreRoutes: [],
          databaseCarrier: database,
          plugins,
          runtime: createRuntime(database),
        }),
      ).toThrowError(expect.objectContaining({ code }));
      expect(createAdapter).not.toHaveBeenCalled();
    },
  );

  it("materializes capabilities before synchronous setup in plugin id order", () => {
    const calls: string[] = [];
    const token = defineCapability({ id: "example@1", parse: String });
    const carrier = attachCapabilityContribution(
      {},
      {
        create: () => {
          calls.push("capability");
          return "ready";
        },
        token,
      },
    );
    const beta = defineFirstPartyServerPlugin({
      id: "beta",
      setup: ({ capabilities }) => {
        calls.push(`beta:${capabilities.require(token)}`);
        return {};
      },
    });
    const alpha = defineFirstPartyServerPlugin({
      id: "alpha",
      requires: [{ missing: "error", token }],
      setup: ({ capabilities, database }) => {
        calls.push(`alpha:${capabilities.get(token)}:${database.name}`);
        return {};
      },
    });

    const composed = composeServerKernel({
      carriers: [carrier],
      coreRoutes: [],
      plugins: [beta, alpha],
      runtime: createRuntime(),
    });

    expect(calls).toEqual([
      "capability",
      "alpha:ready:testDatabase",
      "beta:ready",
    ]);
    expect(Object.isFrozen(composed)).toBe(true);
  });

  it("rejects duplicate plugin ids before setup", () => {
    const setup = vi.fn(() => ({}));
    const first = defineFirstPartyServerPlugin({
      id: "duplicate",
      setup,
    });
    const second = defineFirstPartyServerPlugin({
      id: "duplicate",
      setup,
    });

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [first, second],
        runtime: createRuntime(),
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_PLUGIN_ID" }));
    expect(setup).not.toHaveBeenCalled();
  });

  it("combines core and plugin routes with one authentication provider", () => {
    const coreRoute = {
      access: { kind: "public" },
      id: "core.version",
      method: "GET",
      path: "/version",
      async handle() {
        return new Response();
      },
    } as const;
    const authentication = {
      id: "auth",
      async authenticate() {
        return { kind: "anonymous" } as const;
      },
    };
    const plugin = defineFirstPartyServerPlugin({
      id: "feature",
      setup: () => ({
        authentication,
        routes: [
          {
            access: { kind: "protected" },
            id: "feature.route",
            method: "POST",
            path: "/feature",
            async handle() {
              return new Response();
            },
          },
        ],
      }),
    });

    const composed = composeServerKernel({
      carriers: [],
      coreRoutes: [coreRoute],
      plugins: [plugin],
      runtime: createRuntime(),
    });

    expect(composed.router.routes.map(({ id }) => id)).toEqual([
      "core.version",
      "feature.route",
    ]);
    expect(composed.authentication).toBe(authentication);
  });

  it("rejects a strict missing capability before setup", () => {
    const token = defineCapability({ id: "required@1", parse: String });
    const setup = vi.fn(() => ({}));
    const plugin = defineFirstPartyServerPlugin({
      id: "feature",
      requires: [{ missing: "error", token }],
      setup,
    });

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        details: { pluginId: "feature", tokenId: "required@1" },
      }),
    );
    expect(setup).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown field", () => ({ middleware: [] })],
    ["thenable", async () => ({})],
  ])("rejects an invalid %s contribution", (_name, setup) => {
    const plugin = Reflect.apply(defineFirstPartyServerPlugin, undefined, [
      { id: "invalid", setup },
    ]);

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "invalid" },
      }),
    );
  });

  it("rejects a custom setup thenable without executing it", () => {
    const then = vi.fn();
    const plugin = defineFirstPartyServerPlugin({
      id: "thenable",
      setup: () => Reflect.construct(Object, [{ then }]),
    });

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PLUGIN_CONTRIBUTION" }),
    );
    expect(then).not.toHaveBeenCalled();
  });

  it("handles a rejected setup promise from another realm", async () => {
    const plugin = defineFirstPartyServerPlugin({
      id: "cross-realm",
      setup: () =>
        runInNewContext('Promise.reject(new Error("setup rejected"))'),
    });

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PLUGIN_CONTRIBUTION" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("preserves declared access when no route policy is contributed", () => {
    const plugin = defineFirstPartyServerPlugin({
      id: "feature",
      setup: () => ({
        routes: [route("feature.public", "/feature")],
      }),
    });

    const composed = composeServerKernel({
      carriers: [],
      coreRoutes: [route("core.protected", "/core", { kind: "protected" })],
      plugins: [authenticationPlugin(), plugin],
      runtime: createRuntime(),
    });

    expect(
      composed.router.routes.map(({ access, id }) => [id, access.kind]),
    ).toEqual([
      ["core.protected", "protected"],
      ["feature.public", "public"],
    ]);
  });

  it("protects plugin routes while excepting only actual core routes", () => {
    const policy = defineFirstPartyServerPlugin({
      id: "policy",
      setup: () => ({
        routePolicy: { kind: "protect-except-core", routeIds: ["core.public"] },
      }),
    });
    const feature = defineFirstPartyServerPlugin({
      id: "feature",
      setup: () => ({
        routes: [route("feature.public", "/feature")],
      }),
    });

    const composed = composeServerKernel({
      carriers: [],
      coreRoutes: [
        route("core.public", "/public"),
        route("core.protected", "/protected", { kind: "protected" }),
      ],
      plugins: [authenticationPlugin(), feature, policy],
      runtime: createRuntime(),
    });

    expect(
      Object.fromEntries(
        composed.router.routes.map(({ access, id }) => [id, access.kind]),
      ),
    ).toEqual({
      "core.protected": "protected",
      "core.public": "public",
      "feature.public": "protected",
    });
  });

  it("does not let a plugin route spoof a core exception id", () => {
    const policy = defineFirstPartyServerPlugin({
      id: "policy",
      setup: () => ({
        routePolicy: {
          kind: "protect-except-core",
          routeIds: ["core.version"],
        },
      }),
    });
    const feature = defineFirstPartyServerPlugin({
      id: "core",
      setup: () => ({ routes: [route("core.version", "/feature")] }),
    });

    const composed = composeServerKernel({
      carriers: [],
      coreRoutes: [],
      plugins: [authenticationPlugin(), feature, policy],
      runtime: createRuntime(),
    });

    expect(composed.router.routes[0]?.access.kind).toBe("protected");
  });

  it("makes protect-all dominant regardless of plugin input order", () => {
    const exceptCore = defineFirstPartyServerPlugin({
      id: "except-core",
      setup: () => ({
        routePolicy: { kind: "protect-except-core", routeIds: ["core.public"] },
      }),
    });
    const protectAll = defineFirstPartyServerPlugin({
      id: "protect-all",
      setup: () => ({ routePolicy: { kind: "protect-all" } }),
    });
    const feature = defineFirstPartyServerPlugin({
      id: "feature",
      setup: () => ({ routes: [route("feature.public", "/feature")] }),
    });
    const options = {
      carriers: [],
      coreRoutes: [route("core.public", "/core")],
      runtime: createRuntime(),
    };
    const accessFor = (
      plugins: readonly ReturnType<typeof authenticationPlugin>[],
    ) =>
      composeServerKernel({ ...options, plugins }).router.routes.map(
        ({ access, id }) => [id, access.kind],
      );
    const plugins = [
      authenticationPlugin(),
      exceptCore,
      feature,
      protectAll,
    ] as const;

    expect(Object.fromEntries(accessFor(plugins))).toEqual({
      "core.public": "protected",
      "feature.public": "protected",
    });
    expect(Object.fromEntries(accessFor([...plugins].reverse()))).toEqual({
      "core.public": "protected",
      "feature.public": "protected",
    });
  });

  it("intersects core exceptions regardless of policy input order", () => {
    const first = defineFirstPartyServerPlugin({
      id: "first-policy",
      setup: () => ({
        routePolicy: {
          kind: "protect-except-core",
          routeIds: ["core.first", "core.shared"],
        },
      }),
    });
    const second = defineFirstPartyServerPlugin({
      id: "second-policy",
      setup: () => ({
        routePolicy: {
          kind: "protect-except-core",
          routeIds: ["core.second", "core.shared"],
        },
      }),
    });
    const options = {
      carriers: [],
      coreRoutes: [
        route("core.first", "/first"),
        route("core.second", "/second"),
        route("core.shared", "/shared"),
      ],
      runtime: createRuntime(),
    };
    const accessFor = (plugins: readonly (typeof first)[]) =>
      Object.fromEntries(
        composeServerKernel({ ...options, plugins }).router.routes.map(
          ({ access, id }) => [id, access.kind],
        ),
      );

    expect(accessFor([authenticationPlugin(), first, second])).toEqual({
      "core.first": "protected",
      "core.second": "protected",
      "core.shared": "public",
    });
    expect(accessFor([authenticationPlugin(), second, first])).toEqual({
      "core.first": "protected",
      "core.second": "protected",
      "core.shared": "public",
    });
  });

  it("requires authentication after a policy protects a route", () => {
    const policy = defineFirstPartyServerPlugin({
      id: "policy",
      setup: () => ({ routePolicy: { kind: "protect-all" } }),
    });

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [route("core.public", "/core")],
        plugins: [policy],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
        details: { routeId: "core.public" },
      }),
    );
  });

  it.each([
    { kind: "unknown" },
    { kind: "protect-all", routeIds: [] },
    { kind: "protect-except-core", routeIds: [""] },
    { kind: "protect-except-core", routeIds: [1] },
    { kind: "protect-except-core", routeIds: Object.assign([], { length: 1 }) },
    {
      kind: "protect-except-core",
      routeIds: Object.assign([1], { every: () => true }),
    },
    { then: () => undefined },
  ])("rejects an invalid route policy contribution", (routePolicy) => {
    const plugin = Reflect.apply(defineFirstPartyServerPlugin, undefined, [
      { id: "invalid-policy", setup: () => ({ routePolicy }) },
    ]);

    expect(() =>
      composeServerKernel({
        carriers: [],
        coreRoutes: [],
        plugins: [plugin],
        runtime: createRuntime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "invalid-policy" },
      }),
    );
  });

  it("copies and freezes protect-except-core route ids", () => {
    const routeIds = ["core.public"];
    const contribution = validatePluginContribution({
      routePolicy: { kind: "protect-except-core", routeIds },
    });
    routeIds.push("core.extra");

    expect(contribution.routePolicy).toEqual({
      kind: "protect-except-core",
      routeIds: ["core.public"],
    } satisfies HotUpdaterRoutePolicy);
    expect(Object.isFrozen(contribution.routePolicy)).toBe(true);
    expect(
      contribution.routePolicy?.kind === "protect-except-core" &&
        Object.isFrozen(contribution.routePolicy.routeIds),
    ).toBe(true);
  });
});
