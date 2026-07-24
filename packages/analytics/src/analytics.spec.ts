import type { CapabilityToken } from "@hot-updater/plugin-core";
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
  type AnalyticsFeature,
  type AnalyticsFeatureAvailable,
  type AnalyticsFeatureKind,
  type StrictAnalyticsFeatureKind,
} from "./analytics";
import { analyticsProviderToken, type AnalyticsProvider } from "./provider";
import { createTestProvider } from "./testing/createTestProvider";

class MissingTestCapabilityError extends Error {
  readonly name = "MissingTestCapabilityError";
}

const createSetupContext = (
  provider: AnalyticsProvider | undefined,
  warnings: string[],
): HotUpdaterPluginSetupContext => {
  const get = <TValue>(token: CapabilityToken<TValue>): TValue | undefined =>
    provider === undefined || token !== analyticsProviderToken
      ? undefined
      : token.parse(provider);
  return {
    capabilities: {
      get,
      require<TValue>(token: CapabilityToken<TValue>): TValue {
        const value = get(token);
        if (value === undefined) throw new MissingTestCapabilityError();
        return value;
      },
    },
    diagnostics: {
      warn(diagnostic) {
        warnings.push(diagnostic.code);
      },
    },
  };
};

describe("analytics", () => {
  it("keeps warn and strict manifest versions synchronized with the package", () => {
    // Given / When
    const warnManifest = analytics();
    const strictManifest = analytics({ missingCapability: "error" });

    // Then
    expect(warnManifest.version).toBe(packageJson.version);
    expect(strictManifest.version).toBe(packageJson.version);
  });

  it("preserves its fixed manifest identity and default availability type", () => {
    // Given / When
    const manifest = analytics();

    // Then
    expect(manifest.id).toBe("analytics");
    expect(manifest.namespace).toBe("analytics");
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
      AnalyticsFeature<{ readonly requestId: string }>
    >().toMatchTypeOf<
      | AnalyticsFeatureAvailable<{ readonly requestId: string }>
      | { readonly status: "unavailable" }
    >();
  });

  it("contributes one frozen unavailable state and warning in default mode", async () => {
    // Given
    const warnings: string[] = [];
    const manifest = analytics();

    // When
    const contribution = manifest.setup(
      createSetupContext(undefined, warnings),
    );
    const metadata = await contribution.metadata?.[0]?.resolve(
      new AbortController().signal,
    );

    // Then
    expect(contribution.routes).toEqual([]);
    expect(contribution.api?.value).toEqual({
      reason: "missing-provider-capability",
      status: "unavailable",
    });
    expect(metadata).toEqual({
      analytics: false,
      analyticsQueries: false,
      eventIngestion: false,
    });
    expect(warnings).toEqual(["ANALYTICS_PROVIDER_CAPABILITY_MISSING"]);
    expect(Object.isFrozen(contribution)).toBe(true);
    expect(Object.isFrozen(contribution.api?.value)).toBe(true);
  });

  it("contributes seven public compatibility routes and flat aliases", () => {
    // Given
    const provider = createTestProvider();
    const manifest = analytics({ queryAccess: "public" });

    // When
    const contribution = manifest.setup(createSetupContext(provider, []));

    // Then
    expect(contribution.routes).toHaveLength(7);
    expect(
      contribution.routes?.every((route) => route.access.kind === "public"),
    ).toBe(true);
    expect(contribution.api?.value.status).toBe("available");
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

  it("captures warn and strict query access before caller mutation", () => {
    // Given
    const provider = createTestProvider();
    const warnOptions: {
      queryAccess: "protected" | "public";
    } = { queryAccess: "public" };
    const strictOptions: {
      missingCapability: "error";
      queryAccess: "protected" | "public";
    } = {
      missingCapability: "error",
      queryAccess: "public",
    };
    const warnManifest = analytics(warnOptions);
    const strictManifest = analytics(strictOptions);

    // When
    warnOptions.queryAccess = "protected";
    strictOptions.queryAccess = "protected";
    const warnContribution = warnManifest.setup(
      createSetupContext(provider, []),
    );
    const strictContribution = strictManifest.setup(
      createSetupContext(provider, []),
    );

    // Then
    expect(
      warnContribution.routes?.every((route) => route.access.kind === "public"),
    ).toBe(true);
    expect(
      strictContribution.routes?.every(
        (route) => route.access.kind === "public",
      ),
    ).toBe(true);
    expect(Object.isFrozen(warnOptions)).toBe(false);
    expect(Object.isFrozen(strictOptions)).toBe(false);
  });

  it.each([
    null,
    [],
    "public",
    { missingCapability: "ignore" },
    { missingCapability: null },
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
    const unavailable: AnalyticsProvider = {
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
      .setup(createSetupContext(dedicated, []))
      .metadata?.[0]?.resolve(signal);
    const unavailableMetadata = await analytics()
      .setup(createSetupContext(unavailable, []))
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

  it("makes literal strict mode require the provider and available API type", () => {
    // Given / When
    const manifest = analytics({ missingCapability: "error" });

    // Then
    expect(manifest.requires[0]?.missing).toBe("error");
    expectTypeOf(manifest).toMatchTypeOf<
      HotUpdaterFeatureManifest<
        "analytics",
        StrictAnalyticsFeatureKind,
        typeof analyticsLegacyAliases
      >
    >();
    expectTypeOf<
      AnalyticsFeatureAvailable<{ readonly requestId: string }>
    >().toMatchTypeOf<AnalyticsAPI<{ readonly requestId: string }>>();
    expect(() =>
      manifest.setup(createSetupContext(undefined, [])),
    ).toThrowError(MissingTestCapabilityError);
  });
});
