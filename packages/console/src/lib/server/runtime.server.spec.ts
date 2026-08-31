// @vitest-environment node

import { mockDatabase } from "@hot-updater/mock";
import { describe, expect, it, vi } from "vitest";

import {
  parseActiveInstallationInput,
  parseBundleEventInsightsInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "../insights-input";
import {
  createApiKeyStore,
  createRuntimeHotUpdater,
  getActiveInstallationOverview,
  getInsightsCapability,
  getBundleEventInsights,
  getBundleEventSummary,
  getInstallationHistory,
  searchInstallations,
} from "./runtime.server";

const createDatabase = () => mockDatabase({ latency: { min: 0, max: 0 } });

describe("API-key runtime", () => {
  it("uses only the official database domain", async () => {
    const database = createDatabase();

    const store = createApiKeyStore({ database });

    expect(store).toBe(database.models.apiKeys);
    expect(
      createApiKeyStore({
        database: {
          models: {
            bundles: database.models.bundles,
            bundlePatches: database.models.bundlePatches,
            channels: database.models.channels,
            releaseCatalogs: database.models.releaseCatalogs,
            releases: database.models.releases,
          },
          commit: database.commit,
          name: database.name,
        },
      }),
    ).toBeNull();
  });
});

const createRuntime = () => ({
  mode: "bounded" as const,
  maxMatchingRows: 50_000,
  appendBundleEvent: vi.fn(),
  getActiveInstallationOverview: vi.fn(),
  getBundleEventSummary: vi.fn(),
  getBundleEventSummaries: vi.fn(),
  getBundleEventInsights: vi.fn(),
  getBundleEventOverview: vi.fn(),
  searchInstallations: vi.fn(),
  getInstallationHistory: vi.fn(),
});

describe("insights runtime input validation", () => {
  it("composes Insights from the official database domain", async () => {
    // Given
    const database = createDatabase();
    const scan = vi.spyOn(database.models.insights, "scan");

    // When
    const runtime = createRuntimeHotUpdater({
      database,
    });

    // Then
    expect(runtime).toMatchObject({ mode: "bounded" });
    expect(runtime).not.toBeNull();
    if (runtime === null) throw new Error("Expected Insights runtime");
    await expect(getInsightsCapability(runtime)).resolves.toMatchObject({
      insights: true,
      insightsQueries: true,
      mode: "bounded",
    });
    await expect(runtime.getBundleEventOverview()).resolves.toEqual({
      bundles: [],
      trackedInstallations: 0,
    });
    expect(scan).toHaveBeenCalled();
  });

  it("rejects an invalid Insights runtime", async () => {
    // Given
    const runtime = { mode: "bounded", maxMatchingRows: 50_000 };

    // When
    const result = getBundleEventSummary(runtime, { bundleId: "bundle-1" });

    // Then
    await expect(result).rejects.toThrow(/not supported/i);
  });

  it.each([
    { bundleId: "bundle-1", window: "1h" },
    { bundleId: "bundle-1", window: "24h", limit: 0 },
    { bundleId: "bundle-1", window: "24h", limit: 101 },
    { bundleId: "bundle-1", window: "24h", limit: 1.5 },
    { bundleId: "bundle-1", window: "24h", offset: -1 },
    {
      bundleId: "bundle-1",
      window: "24h",
      offset: Number.MAX_SAFE_INTEGER + 1,
    },
    { bundleId: " ", window: "24h" },
    { bundleId: "x".repeat(1025), window: "24h" },
    { bundleId: 1, window: "24h" },
    { bundleId: "bundle-1", window: "24h", limit: "50" },
    { bundleId: "bundle-1", window: "24h", offset: "0" },
  ])("rejects invalid bundle insights input %#", async (input: unknown) => {
    // Given
    const runtime = createRuntime();

    // When
    const result = getBundleEventInsights(runtime, input);

    // Then
    await expect(result).rejects.toThrow();
    expect(runtime.getBundleEventInsights).not.toHaveBeenCalled();
  });

  it.each([
    [searchInstallations, { query: " " }],
    [searchInstallations, { query: "x".repeat(1025) }],
    [searchInstallations, { query: null }],
    [searchInstallations, { query: "query", limit: 0 }],
    [getInstallationHistory, { installId: " " }],
    [getInstallationHistory, { installId: 1 }],
    [getInstallationHistory, { installId: "install-1", offset: 1.5 }],
  ])("rejects invalid paginated insights input %#", async (fn, input) => {
    // Given
    const runtime = createRuntime();

    // When
    const result = fn(runtime, input);

    // Then
    await expect(result).rejects.toThrow();
    expect(runtime.searchInstallations).not.toHaveBeenCalled();
    expect(runtime.getInstallationHistory).not.toHaveBeenCalled();
  });

  it("trims valid insights strings and applies pagination defaults", async () => {
    // Given
    const runtime = createRuntime();

    // When
    await getBundleEventInsights(runtime, {
      bundleId: " bundle-1 ",
      window: "all",
    });
    await searchInstallations(runtime, { query: " query " });
    await getInstallationHistory(runtime, { installId: " install-1 " });
    await getActiveInstallationOverview(runtime, {
      window: "7d",
      userId: " Alias/B ",
    });

    // Then
    expect(runtime.getBundleEventInsights).toHaveBeenCalledWith(
      "bundle-1",
      "all",
      50,
      0,
    );
    expect(runtime.searchInstallations).toHaveBeenCalledWith("query", 50, 0);
    expect(runtime.getInstallationHistory).toHaveBeenCalledWith(
      "install-1",
      50,
      0,
    );
    expect(runtime.getActiveInstallationOverview).toHaveBeenCalledWith({
      window: "7d",
      userId: "Alias/B",
    });
  });

  it("rejects an invalid bundle summary id before plugin access", async () => {
    // Given
    const runtime = createRuntime();

    // When
    const result = getBundleEventSummary(runtime, { bundleId: " " });

    // Then
    await expect(result).rejects.toThrow();
    expect(runtime.getBundleEventSummary).not.toHaveBeenCalled();
  });
});

describe("insights server function input parsers", () => {
  it("accepts inclusive pagination boundaries", () => {
    // Given
    const insightsInput = {
      bundleId: " bundle-1 ",
      window: "30d",
      limit: 100,
      offset: Number.MAX_SAFE_INTEGER,
    };

    // When
    const insights = parseBundleEventInsightsInput(insightsInput);
    const search = parseSearchInstallationsInput({
      query: " query ",
      limit: 1,
      offset: 0,
    });
    const history = parseInstallationHistoryInput({
      installId: " install-1 ",
    });

    // Then
    expect(insights).toEqual({
      bundleId: "bundle-1",
      window: "30d",
      limit: 100,
      offset: Number.MAX_SAFE_INTEGER,
    });
    expect(search).toEqual({ query: "query", limit: 1, offset: 0 });
    expect(history).toEqual({ installId: "install-1" });
  });

  it.each([null, [], "input"])(
    "rejects a non-record insights input %#",
    (input) => {
      // Given / When
      const parse = () => parseSearchInstallationsInput(input);

      // Then
      expect(parse).toThrow();
    },
  );

  it("normalizes an empty optional active alias out of the request", () => {
    expect(
      parseActiveInstallationInput({ window: "30d", userId: "   " }),
    ).toEqual({ window: "30d" });
  });
});
