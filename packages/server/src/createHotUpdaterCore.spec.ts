import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createHotUpdater } from "./index";
import type {
  CreateHotUpdaterOptions,
  HandlerRoutes,
  HandlerOptions,
  RuntimeHotUpdaterAPI,
} from "./index";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  type NoFeatureApiKind,
} from "./internal/first-party-plugin";
import { createRuntimeDatabase } from "./runtime.testFixtures";

type ExampleAvailableApi<TContext> = {
  readonly examplePing: (context?: TContext) => string;
};

type ExampleFeature<TContext> = ExampleAvailableApi<TContext> & {
  readonly status: "available";
};

interface ExampleFeatureKind extends FeatureApiKind {
  readonly availableApi: ExampleAvailableApi<this["context"]>;
  readonly feature: ExampleFeature<this["context"]>;
}

const examplePlugin = () =>
  defineFirstPartyFeatureManifest<
    "example",
    ExampleFeatureKind,
    { readonly legacyPing: "examplePing" }
  >({
    aliases: { legacyPing: "examplePing" },
    featureApi: "required",
    id: "example",
    namespace: "example",
    setup: () => ({
      api: {
        invocation: {
          examplePing: { contextIndex: 0, publicArity: 1 },
        },
        legacyAliases: { legacyPing: "examplePing" },
        namespace: "example",
        value: {
          examplePing: () => "pong",
          status: "available",
        },
      },
      metadata: [
        {
          keys: ["example"],
          namespace: "example",
          target: "capabilities",
          async resolve() {
            return { example: true };
          },
        },
      ],
    }),
    version: "1.0.0",
  });

const authenticationPlugin = () =>
  defineFirstPartyFeatureManifest<
    "auth",
    NoFeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "auth",
    namespace: "auth",
    setup: () => ({
      authentication: {
        id: "auth",
        async authenticate() {
          return {
            kind: "authenticated",
            principal: { issuer: "test", subject: "user" },
          };
        },
      },
    }),
    version: "1.0.0",
  });

describe("createHotUpdater generic kernel root", () => {
  it("infers an exact empty feature object when plugins are omitted", () => {
    // Given / When
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
    });

    // Then
    expect(hotUpdater.features).toEqual({});
    expect(Object.isFrozen(hotUpdater)).toBe(true);
    expect(Object.isFrozen(hotUpdater.features)).toBe(true);
    expectTypeOf<keyof typeof hotUpdater.features>().toEqualTypeOf<never>();
    expectTypeOf<keyof HandlerOptions>().toEqualTypeOf<"basePath" | "routes">();
    expectTypeOf<HandlerOptions["routes"]>().toEqualTypeOf<
      HandlerRoutes | undefined
    >();
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      | "basePath"
      | "database"
      | "plugins"
      | "routes"
      | "storageContext"
      | "storages"
    >();
  });

  it("projects namespaced features and available-only aliases", () => {
    // Given
    const plugin = examplePlugin();
    const storageContext = vi.fn(() =>
      Object.freeze({
        target: "edge" as const,
        environment: Object.freeze({}),
        bindings: Object.freeze({}),
      }),
    );
    const context = { requestId: "feature-context" };

    // When
    const hotUpdater = createHotUpdater<
      typeof context,
      readonly [typeof plugin]
    >({
      database: createRuntimeDatabase(),
      plugins: [plugin],
      storageContext,
    });

    // Then
    expect(hotUpdater.features.example.status).toBe("available");
    expect(hotUpdater.features.example.examplePing()).toBe("pong");
    expect(hotUpdater.legacyPing(context)).toBe("pong");
    expect(storageContext.mock.calls).toEqual([
      [
        {
          kind: "api",
          operation: {
            member: "examplePing",
            namespace: "example",
            surface: "feature",
          },
          context: undefined,
        },
      ],
      [
        {
          kind: "api",
          operation: {
            invokedAlias: "legacyPing",
            member: "examplePing",
            namespace: "example",
            surface: "feature",
          },
          context,
        },
      ],
    ]);
    expect(Object.isFrozen(hotUpdater.features.example)).toBe(true);
    expectTypeOf(hotUpdater).toMatchTypeOf<RuntimeHotUpdaterAPI>();
  });

  it("publishes plugin metadata through the public version route", async () => {
    // Given
    const hotUpdater = createHotUpdater({
      basePath: "/updates",
      database: createRuntimeDatabase(),
      plugins: [examplePlugin()],
    });

    // When
    const response = await hotUpdater.handler(
      new Request("https://example.com/updates/version", {
        headers: { authorization: "must-not-affect-metadata" },
      }),
    );

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      capabilities: { example: true },
    });
  });

  it("requires authentication for the default enabled bundle policy", () => {
    // Given / When / Then
    expect(() =>
      createHotUpdater({
        routes: { bundles: true },
        database: createRuntimeDatabase(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );

    expect(() =>
      createHotUpdater({
        routes: { bundles: true },
        database: createRuntimeDatabase(),
        plugins: [authenticationPlugin()],
      }),
    ).not.toThrow();
  });

  it("permits an explicit public bundle compatibility policy", async () => {
    // Given
    const hotUpdater = createHotUpdater({
      routes: { bundles: { access: { kind: "public" } } },
      database: createRuntimeDatabase(),
    });

    // When
    const response = await hotUpdater.handler(
      new Request("https://example.com/api/api/bundles/channels"),
    );

    // Then
    expect(response.status).toBe(200);
  });
});
