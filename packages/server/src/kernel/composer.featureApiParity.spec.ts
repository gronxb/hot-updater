import { describe, expect, it } from "vitest";

import { createRuntimeDatabase } from "../runtime.testFixtures";
import { composeServerKernel } from "./composer";
import { createGuardedInfrastructureRuntime } from "./guardedRuntime";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  type NoFeatureApiKind,
} from "./manifest";

interface FeatureBearingKind extends FeatureApiKind {
  readonly availableApi: {
    readonly ping: () => string;
  };
  readonly feature: {
    readonly ping: () => string;
    readonly status: "available";
  };
}

const runtime = () => {
  const database = createRuntimeDatabase();
  return createGuardedInfrastructureRuntime({ database, storages: [] });
};

describe("feature API contribution parity", () => {
  it("rejects a feature-bearing manifest whose runtime setup omits api", () => {
    // Given
    const feature = defineFirstPartyFeatureManifest<
      "feature",
      FeatureBearingKind,
      {}
    >({
      aliases: {},
      featureApi: "required",
      id: "feature",
      namespace: "feature",
      setup: () => ({
        api: {
          invocation: { ping: { contextIndex: 0, publicArity: 1 } },
          legacyAliases: {},
          namespace: "feature",
          value: {
            ping: () => "pong",
            status: "available",
          },
        },
      }),
      version: "1.0.0",
    });
    const malformed = { ...feature };
    Reflect.set(malformed, "setup", () => ({}));

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [malformed],
        runtime: runtime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "feature" },
      }),
    );
  });

  it("rejects a no-feature manifest whose runtime setup contributes api", () => {
    // Given
    const feature = defineFirstPartyFeatureManifest<
      "feature",
      NoFeatureApiKind,
      {}
    >({
      aliases: {},
      id: "feature",
      namespace: "feature",
      setup: () => ({}),
      version: "1.0.0",
    });
    const malformed = { ...feature };
    Reflect.set(malformed, "setup", () => ({
      api: {
        invocation: {},
        legacyAliases: {},
        namespace: "feature",
        value: {},
      },
    }));

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [malformed],
        runtime: runtime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "feature" },
      }),
    );
  });

  it.each([
    ["missing", {}],
    [
      "extra",
      {
        ping: { contextIndex: 0, publicArity: 1 },
        pong: { contextIndex: 0, publicArity: 1 },
      },
    ],
    ["unsafe integer", { ping: { contextIndex: 0, publicArity: 2 ** 53 } }],
    ["wrong context index", { ping: { contextIndex: 0, publicArity: 2 } }],
  ])("rejects %s invocation metadata", (_label, invocation) => {
    // Given
    const feature = defineFirstPartyFeatureManifest<
      "feature",
      FeatureBearingKind,
      {}
    >({
      aliases: {},
      featureApi: "required",
      id: "feature",
      namespace: "feature",
      setup: () => ({
        api: {
          invocation: { ping: { contextIndex: 0, publicArity: 1 } },
          legacyAliases: {},
          namespace: "feature",
          value: {
            ping: () => "pong",
            status: "available",
          },
        },
      }),
      version: "1.0.0",
    });
    const malformed = { ...feature };
    Reflect.set(malformed, "setup", () => ({
      api: {
        invocation,
        legacyAliases: {},
        namespace: "feature",
        value: {
          ping: () => "pong",
          status: "available",
        },
      },
    }));

    // When / Then
    expect(() =>
      composeServerKernel({
        carriers: [],
        manifests: [malformed],
        runtime: runtime(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_PLUGIN_CONTRIBUTION",
        details: { pluginId: "feature" },
      }),
    );
  });
});
