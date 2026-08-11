// @vitest-environment node

import { analyticsComponentSchema } from "@hot-updater/analytics";
import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  parseActiveInstallationInput,
  parseBundleEventAnalyticsInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "../analytics-input";
import {
  getActiveInstallationOverview,
  getBundleEventAnalytics,
  getBundleEventSummary,
  getInstallationHistory,
  getAnalyticsCapability,
  searchInstallations,
  createRuntimeHotUpdater,
} from "./runtime.server";

const createDatabase = () =>
  createDatabasePlugin({
    name: "console-component-test",
    plugin: () => ({
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => data),
      delete: vi.fn(async () => undefined),
      findMany: vi.fn(async () => []),
      findOne: vi.fn(async () => null),
      update: vi.fn(async () => null),
    }),
  });

const createRuntime = () => ({
  mode: "dedicated" as const,
  appendBundleEvent: vi.fn(),
  getActiveInstallationOverview: vi.fn(),
  getBundleEventSummary: vi.fn(),
  getBundleEventAnalytics: vi.fn(),
  getBundleEventOverview: vi.fn(),
  searchInstallations: vi.fn(),
  getInstallationHistory: vi.fn(),
});

describe("analytics runtime input validation", () => {
  it("composes Analytics from the database's neutral component adapter", async () => {
    // Given
    const bind = vi.fn((schema) => ({
      schema,
      append: vi.fn(async () => undefined),
      create: vi.fn(async () => "created" as const),
      get: vi.fn(async () => null),
      assertReady: vi.fn(async () => undefined),
      orderedScan: vi.fn(async () => []),
    }));
    const database = attachUniversalComponentDataAdapter(
      createDatabase(),
      () => ({ bind }),
    );

    // When
    const runtime = createRuntimeHotUpdater({
      database,
    } as Parameters<typeof createRuntimeHotUpdater>[0]);

    // Then
    expect(bind).toHaveBeenCalledWith(analyticsComponentSchema);
    expect(runtime).toMatchObject({ mode: "bounded" });
    await expect(getAnalyticsCapability(runtime)).resolves.toMatchObject({
      analytics: true,
      analyticsQueries: true,
      mode: "bounded",
    });
    await expect(runtime?.getBundleEventOverview()).resolves.toEqual({
      bundles: [],
      trackedInstallations: 0,
    });
  });

  it("reports Analytics unsupported without a neutral component adapter", () => {
    expect(
      createRuntimeHotUpdater({
        database: createDatabase(),
      } as Parameters<typeof createRuntimeHotUpdater>[0]),
    ).toBeNull();
  });

  it("rejects a remote that internally reports Analytics unsupported", async () => {
    // Given
    const runtime = Object.assign(createRuntime(), {
      resolveAvailability: () =>
        Promise.resolve({
          analytics: false as const,
          analyticsQueries: false,
          eventIngestion: false,
        }),
    });

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
