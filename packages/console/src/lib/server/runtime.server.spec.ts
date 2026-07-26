// @vitest-environment node

import { analytics } from "@hot-updater/analytics";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  parseActiveInstallationInput,
  parseBundleEventAnalyticsInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "../analytics-input";
import {
  createRuntimeHotUpdater,
  getActiveInstallationOverview,
  getBundleEventAnalytics,
  getBundleEventSummary,
  getInstallationHistory,
  searchInstallations,
} from "./runtime.server";

const createTestDatabaseOperations = () => ({
  create: vi.fn(async ({ data }) => data),
  update: vi.fn(async () => null),
  delete: vi.fn(async () => undefined),
  count: vi.fn(async () => 0),
  findOne: vi.fn(async () => null),
  findMany: vi.fn(async () => []),
});

const createTestDatabasePlugin = (
  operations = createTestDatabaseOperations(),
) =>
  createDatabasePlugin({
    name: "analytics-runtime-test",
    plugin: () => operations,
  });

const createRuntime = () => {
  const methods = {
    appendBundleEvent: vi.fn(),
    getActiveInstallationOverview: vi.fn(),
    getBundleEventSummary: vi.fn(),
    getBundleEventAnalytics: vi.fn(),
    getBundleEventOverview: vi.fn(),
    searchInstallations: vi.fn(),
    getInstallationHistory: vi.fn(),
  };
  return {
    ...methods,
    features: {
      analytics: {
        ...methods,
        status: "available",
      },
    },
  };
};

const createDedicatedProvider = () => ({
  appendBundleEvent: vi.fn(async () => undefined),
  getActiveInstallationOverview: vi.fn(async () => ({
    activeInstallations: 0,
    asOfMs: 0,
    bundleSeries: [],
    bundles: [],
    series: [],
    window: "24h" as const,
  })),
  getBundleEventAnalytics: vi.fn(async (_bundleId, _window, limit, offset) => ({
    cohorts: { installed: [], recovered: [] },
    recentEvents: {
      data: [],
      pagination: { limit, offset, total: 0 },
    },
    series: { installed: [], recovered: [] },
    summary: { installed: 0, recovered: 0 },
  })),
  getBundleEventOverview: vi.fn(async () => ({
    bundles: [],
    trackedInstallations: 0,
  })),
  getBundleEventSummary: vi.fn(async () => ({
    installed: 0,
    recovered: 0,
  })),
  getInstallationHistory: vi.fn(async (_installId, limit, offset) => ({
    data: [],
    pagination: { limit, offset, total: 0 },
  })),
  mode: "dedicated" as const,
  searchInstallations: vi.fn(async (_query, limit, offset) => ({
    data: [],
    pagination: { limit, offset, total: 0 },
  })),
});

describe("analytics runtime input validation", () => {
  it("keeps Analytics disabled when Console does not opt in", async () => {
    const operations = createTestDatabaseOperations();
    const runtime = Reflect.apply(createRuntimeHotUpdater, undefined, [
      { database: createTestDatabasePlugin(operations) },
    ]);
    const versionResponse = await runtime.handler(
      new Request(
        new URL(`${runtime.basePath}/version`, "https://updates.example.com"),
      ),
    );
    const version = await versionResponse.json();

    expect(runtime.features.analytics).toBeUndefined();
    expect(Reflect.has(version.capabilities, "analytics")).toBe(false);
    await expect(
      getBundleEventSummary(runtime, { bundleId: "bundle-1" }),
    ).rejects.toThrow(/not supported/i);
    expect(
      Object.values(operations).every(
        (operation) => operation.mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  it("installs database-backed Analytics as a Console runtime plugin", async () => {
    const operations = createTestDatabaseOperations();
    const runtime = Reflect.apply(createRuntimeHotUpdater, undefined, [
      {
        console: {
          plugins: [analytics({ queryAccess: "public" })],
        },
        database: createTestDatabasePlugin(operations),
      },
    ]);

    expect(runtime.features.analytics.status).toBe("available");
    await runtime.features.analytics.appendBundleEvent({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprintHash: null,
      fromBundleId: "bundle-0",
      installId: "install-1",
      platform: "ios",
      toBundleId: "bundle-1",
      type: "UPDATE_APPLIED",
      updateStrategy: "appVersion",
    });
    expect(operations.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "bundle_events" }),
    );
  });

  it("passes dedicated feature manifests to the Console runtime", async () => {
    // Given
    const provider = createDedicatedProvider();
    const manifest = analytics({
      provider: () => provider,
      queryAccess: "public",
    });
    const database = createTestDatabasePlugin();

    // When
    const runtime = Reflect.apply(createRuntimeHotUpdater, undefined, [
      {
        console: { plugins: [manifest] },
        database,
      },
    ]);
    await runtime.features.analytics.getBundleEventSummary("bundle-1");

    // Then
    expect(provider.getBundleEventSummary).toHaveBeenCalledWith("bundle-1");
  });

  it("rejects an unbranded Console runtime plugin", () => {
    // Given / When
    const construct = () =>
      Reflect.apply(createRuntimeHotUpdater, undefined, [
        {
          console: {
            plugins: [
              {
                id: "forged",
                namespace: "analytics",
                version: "1.0.0",
              },
            ],
          },
          database: createTestDatabasePlugin(),
        },
      ]);

    // Then
    expect(construct).toThrow(
      "Console plugins must be first-party feature manifests.",
    );
  });

  it("rejects an unavailable Analytics feature", async () => {
    // Given
    const runtime = {
      ...createRuntime(),
      features: {
        analytics: {
          reason: "missing-provider-capability",
          status: "unavailable",
        },
      },
    };

    // When
    const result = getBundleEventSummary(runtime, { bundleId: "bundle-1" });

    // Then
    await expect(result).rejects.toThrow(/not supported/i);
    expect(runtime.getBundleEventSummary).not.toHaveBeenCalled();
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
  ])("rejects invalid bundle analytics input %#", async (input: unknown) => {
    // Given
    const runtime = createRuntime();

    // When
    const result = getBundleEventAnalytics(runtime, input);

    // Then
    await expect(result).rejects.toThrow();
    expect(runtime.getBundleEventAnalytics).not.toHaveBeenCalled();
  });

  it.each([
    [searchInstallations, { query: " " }],
    [searchInstallations, { query: "x".repeat(1025) }],
    [searchInstallations, { query: null }],
    [searchInstallations, { query: "query", limit: 0 }],
    [getInstallationHistory, { installId: " " }],
    [getInstallationHistory, { installId: 1 }],
    [getInstallationHistory, { installId: "install-1", offset: 1.5 }],
  ])("rejects invalid paginated analytics input %#", async (fn, input) => {
    // Given
    const runtime = createRuntime();

    // When
    const result = fn(runtime, input);

    // Then
    await expect(result).rejects.toThrow();
    expect(runtime.searchInstallations).not.toHaveBeenCalled();
    expect(runtime.getInstallationHistory).not.toHaveBeenCalled();
  });

  it("trims valid analytics strings and applies pagination defaults", async () => {
    // Given
    const runtime = createRuntime();

    // When
    await getBundleEventAnalytics(runtime, {
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
    expect(runtime.getBundleEventAnalytics).toHaveBeenCalledWith(
      "bundle-1",
      "all",
      50,
      0,
      undefined,
    );
    expect(runtime.searchInstallations).toHaveBeenCalledWith(
      "query",
      50,
      0,
      undefined,
    );
    expect(runtime.getInstallationHistory).toHaveBeenCalledWith(
      "install-1",
      50,
      0,
      undefined,
    );
    expect(runtime.getActiveInstallationOverview).toHaveBeenCalledWith(
      { window: "7d", userId: "Alias/B" },
      undefined,
    );
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

describe("analytics server function input parsers", () => {
  it("accepts inclusive pagination boundaries", () => {
    // Given
    const analyticsInput = {
      bundleId: " bundle-1 ",
      window: "30d",
      limit: 100,
      offset: Number.MAX_SAFE_INTEGER,
    };

    // When
    const analytics = parseBundleEventAnalyticsInput(analyticsInput);
    const search = parseSearchInstallationsInput({
      query: " query ",
      limit: 1,
      offset: 0,
    });
    const history = parseInstallationHistoryInput({
      installId: " install-1 ",
    });

    // Then
    expect(analytics).toEqual({
      bundleId: "bundle-1",
      window: "30d",
      limit: 100,
      offset: Number.MAX_SAFE_INTEGER,
    });
    expect(search).toEqual({ query: "query", limit: 1, offset: 0 });
    expect(history).toEqual({ installId: "install-1" });
  });

  it.each([null, [], "input"])(
    "rejects a non-record analytics input %#",
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
