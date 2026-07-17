import { describe, expect, it } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { isDatabaseAdapter, supportsAnalytics } from "./types";

describe("isDatabaseAdapter", () => {
  it("accepts a direct v2 low adapter object", () => {
    // Given
    const adapter = createInMemoryDatabaseAdapter();

    // When
    const result = isDatabaseAdapter(adapter);

    // Then
    expect(result).toBe(true);
  });

  it("rejects a v1 factory and non-callable CRUD fields", () => {
    // Given
    const adapter = createInMemoryDatabaseAdapter();
    const factory = () => adapter;
    const malformed = { ...adapter, findMany: null };

    // When
    const factoryResult = isDatabaseAdapter(factory);
    const malformedResult = isDatabaseAdapter(malformed);

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
