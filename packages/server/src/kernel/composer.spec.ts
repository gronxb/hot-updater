import {
  attachCapabilityContribution,
  defineCapability,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import type { FeatureApiKind } from "./manifest";
import { defineFirstPartyFeatureManifest } from "./manifest";

interface ExampleKind extends FeatureApiKind {
  readonly availableApi: {
    readonly ping: () => string;
  };
  readonly context: unknown;
  readonly feature:
    | {
        readonly ping: () => string;
        readonly status: "available";
      }
    | {
        readonly reason: "missing";
        readonly status: "unavailable";
      };
}

const infrastructure = () => {
  const database = createRuntimeDatabase();
  return {
    database,
    runtime: createGuardedInfrastructureRuntime({
      database,
      storages: [],
    }),
  };
};

describe("composeServerKernel", () => {
  it("runs setup by plugin ID and compiles every contribution surface", () => {
    // Given
    const order: string[] = [];
    const token = defineCapability({
      id: "example@1",
      parse(value) {
        if (typeof value !== "string") throw new Error("invalid");
        return value;
      },
    });
    const feature = defineFirstPartyFeatureManifest<
      "feature",
      ExampleKind,
      { readonly ping: "ping" }
    >({
      aliases: { ping: "ping" },
      id: "a-feature",
      namespace: "feature",
      requires: [{ missing: "error", token }],
      setup({ capabilities }) {
        order.push("a-feature");
        const value = capabilities.require(token);
        return {
          api: {
            legacyAliases: { ping: "ping" },
            namespace: "feature",
            value: {
              ping: () => value,
              status: "available",
            },
          },
          metadata: [
            {
              keys: ["featureEnabled"],
              namespace: "feature",
              target: "capabilities",
              async resolve() {
                return { featureEnabled: true };
              },
            },
          ],
          middleware: [
            {
              id: "feature.middleware",
              phase: "post-auth",
              async handle(_context, next) {
                return next();
              },
            },
          ],
          routes: [
            {
              access: { kind: "public" },
              id: "feature.route",
              method: "GET",
              path: "/feature",
              async handle() {
                return new Response("feature");
              },
            },
          ],
        };
      },
      version: "1.0.0",
    });
    const observer = defineFirstPartyFeatureManifest<
      "observer",
      ExampleKind,
      {}
    >({
      aliases: {},
      id: "z-observer",
      namespace: "observer",
      setup() {
        order.push("z-observer");
        return {};
      },
      version: "1.0.0",
    });
    const { database, runtime } = infrastructure();
    const carrier = attachCapabilityContribution(database, {
      create: () => "pong",
      token,
    });

    // When
    const composed = composeServerKernel({
      carriers: [carrier],
      coreApiKeys: ["handler"],
      manifests: [observer, feature],
      runtime,
    });

    // Then
    expect(order).toEqual(["a-feature", "z-observer"]);
    expect(composed.router.routes.map(({ id }) => id)).toEqual([
      "feature.route",
    ]);
    expect(composed.middleware.map(({ id }) => id)).toEqual([
      "feature.middleware",
    ]);
    expect(composed.metadata.contributions).toHaveLength(1);
    expect(composed.api.features.feature).toEqual(
      expect.objectContaining({ status: "available" }),
    );
    expect(composed.api.aliases.ping).toBe(
      Reflect.get(composed.api.features.feature ?? {}, "ping"),
    );
  });

  it("rejects a strict missing capability before setup", () => {
    // Given
    let setupWasCalled = false;
    const token = defineCapability({
      id: "missing@1",
      parse: String,
    });
    const manifest = defineFirstPartyFeatureManifest<
      "feature",
      ExampleKind,
      {}
    >({
      aliases: {},
      id: "feature",
      namespace: "feature",
      requires: [{ missing: "error", token }],
      setup() {
        setupWasCalled = true;
        return {};
      },
      version: "1.0.0",
    });

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [manifest],
        runtime: infrastructure().runtime,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MISSING_CAPABILITY",
        details: { pluginId: "feature", tokenId: "missing@1" },
      }),
    );
    expect(setupWasCalled).toBe(false);
  });

  it("maps asynchronous setup to a typed invalid-contribution error", () => {
    // Given
    const manifest = defineFirstPartyFeatureManifest<
      "feature",
      ExampleKind,
      {}
    >({
      aliases: {},
      id: "feature",
      namespace: "feature",
      setup: () => ({}),
      version: "1.0.0",
    });
    const malformed = { ...manifest };
    Reflect.set(malformed, "setup", async () => ({}));

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [malformed],
        runtime: infrastructure().runtime,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PLUGIN_CONTRIBUTION" }),
    );
  });

  it("rejects an empty manifest namespace", () => {
    // Given
    const manifest = defineFirstPartyFeatureManifest<"", ExampleKind, {}>({
      aliases: {},
      id: "feature",
      namespace: "",
      setup: () => ({}),
      version: "1.0.0",
    });

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [manifest],
        runtime: infrastructure().runtime,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_PLUGIN_CONTRIBUTION" }),
    );
  });

  it("emits at most one construction warning per plugin", () => {
    // Given
    const manifest = defineFirstPartyFeatureManifest<
      "feature",
      ExampleKind,
      {}
    >({
      aliases: {},
      id: "feature",
      namespace: "feature",
      setup({ diagnostics }) {
        diagnostics.warn({ code: "FIRST", message: "first warning" });
        diagnostics.warn({ code: "SECOND", message: "second warning" });
        return {};
      },
      version: "1.0.0",
    });

    // When
    const composed = composeServerKernel({
      carriers: [],
      manifests: [manifest],
      runtime: infrastructure().runtime,
    });

    // Then
    expect(composed.diagnostics).toEqual([
      { code: "FIRST", message: "first warning" },
    ]);
    expect(Object.isFrozen(composed.diagnostics[0])).toBe(true);
  });
});
