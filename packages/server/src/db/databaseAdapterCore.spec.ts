import type { UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  databaseBundleEventService,
  databaseBundleEventSupport,
  type DatabaseAdapter,
  type DatabaseBundleEventService,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createDatabaseAdapterCore } from "./databaseAdapterCore";
import {
  currentBundle,
  manifests,
  resolveFileUrl,
  seedBundles,
  targetBundle,
  type TestContext,
  updateArgs,
} from "./databaseAdapterCore.testFixtures";
import { supportsBundleEvents } from "./types";

type TestEventRow = {
  id: string;
  type: "UPDATE_APPLIED" | "RECOVERED";
  install_id: string;
  user_id: string | null;
  username: string | null;
  from_bundle_id: string;
  to_bundle_id: string;
  platform: "ios" | "android";
  app_version: string;
  channel: string;
  cohort: string;
  update_strategy: "fingerprint" | "appVersion";
  fingerprint_hash: string | null;
  sdk_version: string | null;
  received_at_ms: number;
};

const createBundleEventAdapter = (
  supportsBundleEvents = true,
): DatabaseAdapter<TestContext> => {
  const rows: TestEventRow[] = [];
  const matches = (
    row: TestEventRow,
    where: readonly Record<string, unknown>[] | undefined,
  ): boolean => {
    if (!where || where.length === 0) return true;
    const [firstCondition, ...remainingConditions] = where;
    if (!firstCondition) return true;
    const evaluate = (condition: Record<string, unknown>): boolean => {
      const actual = Reflect.get(row, condition.field as string);
      const operator = (condition.operator ?? "eq") as string;
      const expected = condition.value;
      if (
        operator === "contains" &&
        typeof actual === "string" &&
        typeof expected === "string"
      ) {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      if (operator === "in" && Array.isArray(expected)) {
        return expected.includes(actual);
      }
      if (
        operator === "gte" &&
        typeof actual === "number" &&
        typeof expected === "number"
      ) {
        return actual >= expected;
      }
      return actual === expected;
    };
    let result = evaluate(firstCondition);
    for (const condition of remainingConditions) {
      const current = evaluate(condition);
      result =
        condition.connector === "OR" ? result || current : result && current;
    }
    return result;
  };
  const ordered = (input: {
    where?: readonly Record<string, unknown>[];
    orderBy?: readonly { field: string; direction: "asc" | "desc" }[];
    distinctOn?: { fields: readonly string[] };
    limit: number;
    offset: number;
  }) => {
    let result = rows.filter((row) => matches(row, input.where));
    if (input.orderBy) {
      const orderBy = input.orderBy;
      result = result.toSorted((left, right) => {
        for (const clause of orderBy) {
          const leftValue = Reflect.get(left, clause.field) as
            | string
            | number
            | null;
          const rightValue = Reflect.get(right, clause.field) as
            | string
            | number
            | null;
          const order =
            typeof leftValue === "number" && typeof rightValue === "number"
              ? leftValue - rightValue
              : String(leftValue).localeCompare(String(rightValue));
          if (order !== 0) {
            return clause.direction === "asc" ? order : -order;
          }
        }
        return 0;
      });
    }
    if (input.distinctOn) {
      const seen = new Set<string>();
      result = result.filter((row) => {
        const key = JSON.stringify(
          input.distinctOn?.fields.map((field) => Reflect.get(row, field)),
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return result.slice(input.offset, input.offset + input.limit);
  };
  return {
    name: "bundle-event-test",
    ...(supportsBundleEvents ? { [databaseBundleEventSupport]: true } : {}),
    create: async (input) => {
      if (input.model === "bundle_events") {
        rows.push(input.data as TestEventRow);
        return input.data as never;
      }
      throw new Error("unused");
    },
    update: async () => {
      throw new Error("unused");
    },
    delete: async () => {
      throw new Error("unused");
    },
    count: async (input) => {
      if (input.model !== "bundle_events") throw new Error("unused");
      const filtered = rows.filter((row) =>
        matches(
          row,
          input.where as readonly Record<string, unknown>[] | undefined,
        ),
      );
      if (!input.distinct) return filtered.length;
      return new Set(
        filtered.map((row) =>
          JSON.stringify(
            input.distinct?.map((field) => Reflect.get(row, field)),
          ),
        ),
      ).size;
    },
    findOne: async () => null,
    findMany: async (input) => {
      if (input.model !== "bundle_events") return [] as never[];
      return ordered({
        where: input.where as readonly Record<string, unknown>[] | undefined,
        orderBy: input.orderBy as
          | readonly { field: string; direction: "asc" | "desc" }[]
          | undefined,
        distinctOn: input.distinctOn as
          | { fields: readonly string[] }
          | undefined,
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
      }) as never[];
    },
  } as DatabaseAdapter<TestContext>;
};

describe("createDatabaseAdapterCore", () => {
  it("omits bundle event methods when the adapter does not opt in", () => {
    // Given
    const adapter = createBundleEventAdapter(false);

    // When
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // Then
    expect(core.api.appendBundleEvent).toBeUndefined();
    expect(core.api.getBundleEventSummary).toBeUndefined();
    expect(core.api.getBundleEventAnalytics).toBeUndefined();
    expect(core.api.getBundleEventOverview).toBeUndefined();
    expect(core.api.searchInstallations).toBeUndefined();
    expect(core.api.getInstallationHistory).toBeUndefined();
  });

  it("uses a database-provided bundle event service", async () => {
    const service = {
      appendBundleEvent: vi.fn(),
      getBundleEventSummary: vi
        .fn<DatabaseBundleEventService["getBundleEventSummary"]>()
        .mockResolvedValue({ installed: 2, recovered: 1 }),
      getBundleEventAnalytics: vi.fn(),
      getBundleEventOverview: vi.fn(),
      searchInstallations: vi.fn(),
      getInstallationHistory: vi.fn(),
    } satisfies DatabaseBundleEventService;
    const adapter: DatabaseAdapter = Object.assign(
      createInMemoryDatabaseAdapter(),
      { [databaseBundleEventService]: service },
    );
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    if (!supportsBundleEvents(core.api)) {
      throw new Error("Expected the database-provided bundle event service.");
    }

    await expect(core.api.getBundleEventSummary("bundle-1")).resolves.toEqual({
      installed: 2,
      recovered: 1,
    });
    expect(service.getBundleEventSummary).toHaveBeenCalledWith(
      "bundle-1",
      undefined,
    );
  });

  it("uses the optional low-adapter update fast-path", async () => {
    // Given
    const baseAdapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(baseAdapter, "findMany");
    const expected: UpdateInfo = {
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    };
    const getUpdateInfo = vi.fn<
      NonNullable<DatabaseAdapter<TestContext>["getUpdateInfo"]>
    >(async () => expected);
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo,
    };
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    // When
    const result = await core.api.getUpdateInfo(updateArgs, context);

    // Then
    expect(result).toEqual(expected);
    expect(getUpdateInfo).toHaveBeenCalledWith(updateArgs, context);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not scan when the optional update fast-path returns null", async () => {
    // Given
    const baseAdapter = createInMemoryDatabaseAdapter();
    const findMany = vi.spyOn(baseAdapter, "findMany");
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo: vi.fn(async () => null),
    };
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = await core.api.getUpdateInfo(updateArgs);

    // Then
    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("derives update info through the fixed low models without a fast-path", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = await core.api.getUpdateInfo(updateArgs);

    // Then
    expect(result).toEqual({
      fileHash: targetBundle.fileHash,
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: targetBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: targetBundle.storageUri,
    });
  });

  it("resolves manifest assets and patch metadata from v2 rows", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText: async (storageUri) => manifests.get(storageUri) ?? null,
    });
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };

    // When
    const result = await core.api.getAppUpdateInfo(updateArgs, context);

    // Then
    expect(result).toMatchObject({
      changedAssets: {
        "index.ios.bundle": {
          file: {
            compression: "br",
            url: "https://assets.example.com/bucket/target/files/index.ios.bundle.br",
          },
          fileHash: "target-bundle-hash",
          patch: {
            algorithm: "bsdiff",
            baseBundleId: currentBundle.id,
            baseFileHash: "current-bundle-hash",
            patchFileHash: "patch-hash",
            patchUrl: "https://assets.example.com/bucket/target/patch.bsdiff",
          },
        },
      },
      manifestFileHash: "sig:target-manifest",
      manifestUrl: "https://assets.example.com/bucket/target/manifest.json",
    });
    expect(result?.changedAssets).not.toHaveProperty("shared.png");
  });

  it("falls back to archive metadata when a manifest cannot be loaded", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await seedBundles(adapter);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText: async () => null,
    });

    // When
    const result = await core.api.getAppUpdateInfo(updateArgs);

    // Then
    expect(result).toEqual({
      fileHash: targetBundle.fileHash,
      fileUrl: "https://assets.example.com/bucket/target/archive.zip",
      id: targetBundle.id,
      message: targetBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("runs the schema readiness guard before a low adapter operation", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    const beforeOperation = vi.fn(async () => {});
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      beforeOperation,
    });

    // When
    await core.api.getChannels();

    // Then
    expect(beforeOperation).toHaveBeenCalledOnce();
  });

  it("rejects invalid bundles before invoking low create", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    const create = vi.spyOn(adapter, "create");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = core.api.insertBundle({
      ...currentBundle,
      targetAppVersion: null,
      fingerprintHash: null,
    });

    // Then
    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects invalid updates before invoking low update", async () => {
    // Given
    const adapter: DatabaseAdapter<TestContext> =
      createInMemoryDatabaseAdapter();
    await createDatabaseClient(adapter).insertBundle(currentBundle);
    const update = vi.spyOn(adapter, "update");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);

    // When
    const result = core.api.updateBundleById(currentBundle.id, {
      id: "00000000-0000-0000-0000-000000000099",
      targetAppVersion: null,
      fingerprintHash: null,
    });

    // Then
    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves initialization rollbacks without reading manifests", async () => {
    // Given
    const baseAdapter = createInMemoryDatabaseAdapter();
    const adapter: DatabaseAdapter<TestContext> = {
      ...baseAdapter,
      getUpdateInfo: async () => ({
        fileHash: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
        storageUri: null,
      }),
    };
    const readStorageText = vi.fn(async () => null);
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      readStorageText,
    });

    // When
    const result = await core.api.getAppUpdateInfo(updateArgs);

    // Then
    expect(result).toEqual({
      fileHash: null,
      fileUrl: null,
      id: NIL_UUID,
      message: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
    expect(readStorageText).not.toHaveBeenCalled();
  });

  it("appends bundle events and derives summary/search/history methods", async () => {
    // Given
    const adapter = createBundleEventAdapter();
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    if (!supportsBundleEvents(core.api)) {
      throw new Error("Expected bundle event support.");
    }
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };
    const nowValues = [
      1_725_000_000_000, 1_725_000_000_000, 1_725_000_003_000,
      1_725_000_003_000, 1_725_000_006_000, 1_725_000_006_000,
    ];
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 0);

    // When
    await core.api.appendBundleEvent(
      {
        type: "UPDATE_APPLIED",
        installId: "install-1",
        fromBundleId: currentBundle.id,
        toBundleId: targetBundle.id,
        userId: "user-1",
        username: "alice",
        platform: "ios",
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        updateStrategy: "appVersion",
        fingerprintHash: null,
      },
      context,
    );
    await core.api.appendBundleEvent(
      {
        type: "RECOVERED",
        installId: "install-2",
        fromBundleId: targetBundle.id,
        toBundleId: currentBundle.id,
        userId: "user-2",
        username: "bob",
        platform: "android",
        appVersion: "1.0.1",
        channel: "production",
        cohort: "beta",
        updateStrategy: "fingerprint",
        fingerprintHash: "fp-2",
      },
      context,
    );
    await core.api.appendBundleEvent(
      {
        type: "UPDATE_APPLIED",
        installId: "install-1",
        fromBundleId: targetBundle.id,
        toBundleId: targetBundle.id,
        userId: "user-1",
        username: "alice",
        platform: "ios",
        appVersion: "1.0.2",
        channel: "production",
        cohort: "default",
        updateStrategy: "appVersion",
        fingerprintHash: null,
      },
      context,
    );
    const summary = await core.api.getBundleEventSummary(
      targetBundle.id,
      context,
    );
    const search = await core.api.searchInstallations("ali", 10, 0, context);
    const history = await core.api.getInstallationHistory(
      "install-1",
      10,
      0,
      context,
    );

    // Then
    expect(summary).toEqual({ installed: 1, recovered: 1 });
    expect(search).toEqual({
      data: [
        {
          installId: "install-1",
          username: "alice",
          userId: "user-1",
          lastKnownBundleId: targetBundle.id,
          latestStatus: "UPDATE_APPLIED",
          platform: "ios",
          appVersion: "1.0.2",
          channel: "production",
          cohort: "default",
          receivedAtMs: 1_725_000_006_000,
        },
      ],
      pagination: { total: 1, limit: 10, offset: 0 },
    });
    expect(history.data).toHaveLength(2);
    expect(history.data[0]).toMatchObject({
      type: "UPDATE_APPLIED",
      toBundleId: targetBundle.id,
      receivedAtMs: 1_725_000_006_000,
    });
    expect(history.data[1]).toMatchObject({
      type: "UPDATE_APPLIED",
      fromBundleId: currentBundle.id,
      receivedAtMs: 1_725_000_000_000,
    });
    expect(history.pagination).toEqual({ total: 2, limit: 10, offset: 0 });
    now.mockRestore();
  });

  it("builds bundle event analytics with cumulative series and recent events", async () => {
    // Given
    const adapter = createBundleEventAdapter();
    const findMany = vi.spyOn(adapter, "findMany");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    if (!supportsBundleEvents(core.api)) {
      throw new Error("Expected bundle event support.");
    }
    const analyticsTime = Date.UTC(2026, 0, 1, 0, 30);
    const nowValues = [
      Date.UTC(2025, 11, 1, 0, 5),
      Date.UTC(2025, 11, 1, 0, 5),
      Date.UTC(2025, 11, 1, 0, 10),
      Date.UTC(2025, 11, 1, 0, 10),
      Date.UTC(2025, 11, 1, 0, 15),
      Date.UTC(2025, 11, 1, 0, 15),
      analyticsTime,
    ];
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 0);

    // When
    await core.api.appendBundleEvent({
      type: "UPDATE_APPLIED",
      installId: "install-a",
      fromBundleId: currentBundle.id,
      toBundleId: targetBundle.id,
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "alpha",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    await core.api.appendBundleEvent({
      type: "UPDATE_APPLIED",
      installId: "install-b",
      fromBundleId: currentBundle.id,
      toBundleId: targetBundle.id,
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "beta",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    await core.api.appendBundleEvent({
      type: "RECOVERED",
      installId: "install-c",
      fromBundleId: targetBundle.id,
      toBundleId: currentBundle.id,
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "beta",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    const analytics = await core.api.getBundleEventAnalytics(
      targetBundle.id,
      "24h",
      10,
      0,
    );

    // Then
    expect(analytics.summary).toEqual({ installed: 2, recovered: 1 });
    expect(analytics.series.installed.at(-1)).toEqual({
      bucketStartMs: Date.UTC(2026, 0, 1, 0, 0, 0),
      value: 0,
    });
    expect(analytics.series.recovered.at(-1)).toEqual({
      bucketStartMs: Date.UTC(2026, 0, 1, 0, 0, 0),
      value: 0,
    });
    expect(analytics.cohorts.installed).toEqual([
      { cohort: "alpha", value: 1 },
      { cohort: "beta", value: 1 },
    ]);
    expect(analytics.cohorts.recovered).toEqual([{ cohort: "beta", value: 1 }]);
    expect(analytics.recentEvents.pagination).toEqual({
      total: 3,
      limit: 10,
      offset: 0,
    });
    expect(analytics.recentEvents.data[0]).toMatchObject({ type: "RECOVERED" });
    const finiteSeriesCalls = findMany.mock.calls.filter(([input]) =>
      input.where?.some((condition) => condition.operator === "gte"),
    );
    expect(finiteSeriesCalls).toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          {
            field: "received_at_ms",
            operator: "gte",
            value: Date.UTC(2025, 11, 31, 1),
          },
        ]),
      }),
      undefined,
    );
    expect(findMany).toHaveBeenCalledTimes(8);
    now.mockRestore();
  });
});
