import type {
  CapabilityToken,
  DatabaseCapabilityRuntime,
} from "@hot-updater/plugin-core";
import type {
  HotUpdaterFeatureManifest,
  HotUpdaterPluginSetupContext,
} from "@hot-updater/server/internal/first-party-plugin";
import { describe, expect, expectTypeOf, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import {
  analytics,
  analyticsLegacyAliases,
  type AnalyticsAPI,
  type AnalyticsFeatureAvailable,
  type AnalyticsFeatureKind,
  type AnalyticsOptions,
} from "./analytics";
import { type AnalyticsProvider } from "./provider";
import { createTestProvider } from "./testing/createTestProvider";

class UnimplementedDatabaseOperationError extends Error {
  readonly name = "UnimplementedDatabaseOperationError";
}

const unavailable = async (): Promise<never> => {
  throw new UnimplementedDatabaseOperationError();
};

const database: DatabaseCapabilityRuntime = Object.freeze({
  name: "analytics-test",
  count: unavailable,
  create: unavailable,
  delete: unavailable,
  findMany: unavailable,
  findOne: unavailable,
  update: unavailable,
});

const createSetupContext = (
  provider?: AnalyticsProvider,
  warnings: string[] = [],
): HotUpdaterPluginSetupContext => ({
  capabilities: {
    get<TValue>(token: CapabilityToken<TValue>): TValue | undefined {
      return provider === undefined ? undefined : token.parse(provider);
    },
    require<TValue>(_token: CapabilityToken<TValue>): TValue {
      throw new Error("No test capability is registered.");
    },
  },
  database,
  diagnostics: {
    warn(diagnostic) {
      warnings.push(diagnostic.code);
    },
  },
});

describe("analytics", () => {
  it("keeps its manifest version synchronized with the package", () => {
    expect(analytics().version).toBe(packageJson.version);
  });

  it("preserves its fixed identity and always-available feature type", () => {
    // Given / When
    const manifest = analytics();

    // Then
    expect(manifest.id).toBe("analytics");
    expect(manifest.namespace).toBe("analytics");
    expect(manifest.requires).toEqual([
      {
        missing: "continue",
        token: expect.objectContaining({
          id: "hot-updater.analytics.provider@1",
        }),
      },
    ]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expectTypeOf(manifest.namespace).toEqualTypeOf<"analytics">();
    expectTypeOf(manifest).toMatchTypeOf<
      HotUpdaterFeatureManifest<
        "analytics",
        AnalyticsFeatureKind,
        typeof analyticsLegacyAliases
      >
    >();
    expectTypeOf<
      AnalyticsFeatureAvailable<{ readonly requestId: string }>
    >().toMatchTypeOf<AnalyticsAPI<{ readonly requestId: string }>>();
    expectTypeOf<keyof AnalyticsOptions>().toEqualTypeOf<"queryAccess">();
  });

  it("builds the default bounded provider from the generic database", async () => {
    // Given
    const manifest = analytics({ queryAccess: "public" });

    // When
    const contribution = manifest.setup(createSetupContext());
    const metadata = await contribution.metadata?.[0]?.resolve(
      new AbortController().signal,
    );

    // Then
    expect(contribution.routes).toHaveLength(7);
    expect(contribution.api?.value.status).toBe("available");
    expect(metadata).toEqual({
      analytics: true,
      analyticsQueries: true,
      eventIngestion: true,
      maxMatchingRows: 50_000,
      mode: "bounded",
    });
  });

  it("contributes seven public compatibility routes and flat aliases", () => {
    // Given
    const provider = createTestProvider();
    const manifest = analytics({ queryAccess: "public" });

    // When
    const contribution = manifest.setup(createSetupContext(provider));

    // Then
    expect(contribution.routes).toHaveLength(7);
    expect(
      contribution.routes?.every((route) => route.access.kind === "public"),
    ).toBe(true);
    expect(Object.keys(contribution.api?.legacyAliases ?? {})).toEqual([
      "appendBundleEvent",
      "getActiveInstallationOverview",
      "getBundleEventAnalytics",
      "getBundleEventOverview",
      "getBundleEventSummary",
      "getInstallationHistory",
      "searchInstallations",
    ]);
  });

  it("captures query access before caller mutation", async () => {
    // Given
    const provider = createTestProvider();
    const options: {
      queryAccess: "protected" | "public";
    } = {
      queryAccess: "public",
    };
    const manifest = analytics(options);

    // When
    options.queryAccess = "protected";
    const contribution = manifest.setup(createSetupContext(provider));

    // Then
    expect(
      contribution.routes?.every((route) => route.access.kind === "public"),
    ).toBe(true);
    await contribution.api?.value.getBundleEventOverview();
    expect(provider.getBundleEventOverview).toHaveBeenCalledOnce();
    expect(Object.isFrozen(options)).toBe(false);
  });

  it.each([
    null,
    [],
    "public",
    { missingCapability: "error" },
    { provider: () => createTestProvider() },
    { provider: null },
    { provider: {} },
    { queryAccess: "private" },
    { queryAccess: null },
    { pluginId: "analytics", queryAccess: "public" },
  ])("rejects malformed runtime options %#", (candidate) => {
    // Given / When
    const invoke = () => Reflect.apply(analytics, undefined, [candidate]);

    // Then
    expect(invoke).toThrowError(TypeError);
  });

  it("resolves dedicated and remotely unavailable metadata shapes", async () => {
    // Given
    const dedicated = createTestProvider();
    const unavailableProvider: AnalyticsProvider = {
      ...createTestProvider(),
      resolveAvailability: async () => ({
        analytics: false,
        analyticsQueries: false,
        eventIngestion: false,
      }),
    };
    const signal = new AbortController().signal;

    // When
    const dedicatedMetadata = await analytics()
      .setup(createSetupContext(dedicated))
      .metadata?.[0]?.resolve(signal);
    const unavailableMetadata = await analytics()
      .setup(createSetupContext(unavailableProvider))
      .metadata?.[0]?.resolve(signal);

    // Then
    expect(dedicatedMetadata).toEqual({
      analytics: true,
      analyticsQueries: true,
      eventIngestion: true,
      mode: "dedicated",
    });
    expect(unavailableMetadata).toEqual({
      analytics: false,
      analyticsQueries: false,
      eventIngestion: false,
    });
  });
});
