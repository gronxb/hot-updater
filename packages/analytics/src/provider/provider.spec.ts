import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { analytics } from "../analytics";
import { attachAnalyticsProviderCapability } from "../internal/provider-capability";
import { createTestProvider } from "../testing/createTestProvider";
import { InvalidAnalyticsProviderError, parseAnalyticsProvider } from "./index";

class UnimplementedDatabaseOperationError extends Error {
  readonly name = "UnimplementedDatabaseOperationError";
}

const unavailable = async (): Promise<never> => {
  throw new UnimplementedDatabaseOperationError();
};

const createDatabase = (): DatabasePlugin =>
  Object.freeze({
    name: "analytics-test",
    count: unavailable,
    create: unavailable,
    delete: unavailable,
    findMany: unavailable,
    findOne: unavailable,
    update: unavailable,
  });

describe("parseAnalyticsProvider", () => {
  it("parses and freezes a complete provider", () => {
    // Given
    const source = createTestProvider();

    // When
    const provider = parseAnalyticsProvider(source);

    // Then
    expect(provider).toBe(source);
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it.each([
    {},
    { ...createTestProvider(), mode: "bounded" },
    { ...createTestProvider(), appendBundleEvent: undefined },
    { ...createTestProvider(), mode: "unsupported" },
  ])("rejects malformed provider %#", (candidate) => {
    // Given / When / Then
    expect(() => parseAnalyticsProvider(candidate)).toThrowError(
      InvalidAnalyticsProviderError,
    );
  });
});

describe("analytics database ownership", () => {
  it("installs against a bare generic database without decorating it", () => {
    // Given
    const database = createDatabase();
    const manifest = analytics({ queryAccess: "public" });

    // When
    const runtime = createHotUpdater({
      routes: { bundles: false, updateCheck: false },
      database,
      plugins: [manifest],
    });

    // Then
    expect(runtime.features.analytics.status).toBe("available");
    expect(getCapabilityContributions(database)).toEqual([]);
  });

  it("prefers an attached dedicated provider capability", async () => {
    // Given
    const database = createDatabase();
    const provider = createTestProvider();
    let factoryCalls = 0;
    const capableDatabase = attachAnalyticsProviderCapability(database, () => {
      factoryCalls += 1;
      return provider;
    });
    const manifest = analytics({ queryAccess: "public" });

    // When
    const runtime = createHotUpdater({
      routes: { bundles: false, updateCheck: false },
      database: capableDatabase,
      plugins: [manifest],
    });

    // Then
    expect(factoryCalls).toBe(1);
    expect(runtime.features.analytics.status).toBe("available");
    await runtime.features.analytics.getBundleEventSummary("bundle-id");
    expect(provider.getBundleEventSummary).toHaveBeenCalledWith("bundle-id");
    expect(getCapabilityContributions(database)).toEqual([]);
    expect(getCapabilityContributions(capableDatabase)).toHaveLength(1);
  });
});
