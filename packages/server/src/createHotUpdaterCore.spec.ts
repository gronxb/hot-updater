import { describe, expect, expectTypeOf, it } from "vitest";

import { createHotUpdater } from "./index";
import type {
  CreateHotUpdaterOptions,
  HandlerOptions,
  RuntimeHotUpdaterAPI,
} from "./index";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
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
    id: "example",
    namespace: "example",
    setup: () => ({
      api: {
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
  defineFirstPartyFeatureManifest<"auth", FeatureApiKind, Record<never, never>>(
    {
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
    },
  );

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
    expectTypeOf<keyof HandlerOptions>().toEqualTypeOf<
      "basePath" | "coreRoutes"
    >();
    expectTypeOf<keyof CreateHotUpdaterOptions>().toEqualTypeOf<
      "basePath" | "coreRoutes" | "database" | "plugins" | "storages"
    >();
  });

  it("projects namespaced features and available-only aliases", () => {
    // Given
    const plugin = examplePlugin();

    // When
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [plugin],
    });

    // Then
    expect(hotUpdater.features.example.status).toBe("available");
    expect(hotUpdater.features.example.examplePing()).toBe("pong");
    expect(hotUpdater.legacyPing()).toBe("pong");
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
        coreRoutes: { bundles: true },
        database: createRuntimeDatabase(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );

    expect(() =>
      createHotUpdater({
        coreRoutes: { bundles: true },
        database: createRuntimeDatabase(),
        plugins: [authenticationPlugin()],
      }),
    ).not.toThrow();
  });

  it("permits an explicit public bundle compatibility policy", async () => {
    // Given
    const hotUpdater = createHotUpdater({
      coreRoutes: { bundles: { access: { kind: "public" } } },
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
