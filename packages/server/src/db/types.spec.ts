import { describe, expect, it } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { isDatabasePlugin, supportsAnalytics } from "./types";

describe("isDatabasePlugin", () => {
  it("accepts a direct fixed-model plugin object", () => {
    // Given
    const plugin = createInMemoryDatabasePlugin();

    // When
    const result = isDatabasePlugin(plugin);

    // Then
    expect(result).toBe(true);
  });

  it("rejects a v1 factory and non-callable CRUD fields", () => {
    // Given
    const plugin = createInMemoryDatabasePlugin();
    const factory = () => plugin;
    const malformed = { ...plugin, findMany: null };

    // When
    const factoryResult = isDatabasePlugin(factory);
    const malformedResult = isDatabasePlugin(malformed);

    // Then
    expect(factoryResult).toBe(false);
    expect(malformedResult).toBe(false);
  });
});

describe("supportsAnalytics", () => {
  const analyticsMethods = () => ({
    appendBundleEvent: () => undefined,
    getBundleEventSummary: () => undefined,
    getBundleEventAnalytics: () => undefined,
    getBundleEventOverview: () => undefined,
    searchInstallations: () => undefined,
    getInstallationHistory: () => undefined,
  });

  it("requires the active-installation overview method", () => {
    const withoutActiveOverview = analyticsMethods();
    const withActiveOverview = {
      ...withoutActiveOverview,
      getActiveInstallationOverview: () => undefined,
    };

    expect(supportsAnalytics(withoutActiveOverview)).toBe(false);
    expect(supportsAnalytics(withActiveOverview)).toBe(true);
  });
});
