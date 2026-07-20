import {
  createDatabaseClient,
  databaseBundleEventService,
  type DatabaseAdapter,
  type DatabaseBundleEventService,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import {
  getAnalyticsCapability,
  supportsAnalytics,
} from "./analyticsCapability";
import { createDatabaseAdapterCore } from "./databaseAdapterCore";
import {
  currentBundle,
  resolveFileUrl,
} from "./databaseAdapterCore.testFixtures";
import { createBundleEventAdapter } from "./databaseAdapterCoreEvent.testFixtures";

describe("createDatabaseAdapterCore capabilities", () => {
  it("omits bundle event methods when the adapter does not opt in", () => {
    const core = createDatabaseAdapterCore(
      createBundleEventAdapter(false),
      resolveFileUrl,
    );

    expect(core.api.appendBundleEvent).toBeUndefined();
    expect(core.api.getBundleEventSummary).toBeUndefined();
    expect(core.api.getBundleEventAnalytics).toBeUndefined();
    expect(core.api.getBundleEventOverview).toBeUndefined();
    expect(core.api.searchInstallations).toBeUndefined();
    expect(core.api.getInstallationHistory).toBeUndefined();
    expect(getAnalyticsCapability(core.api)).toBeNull();
  });

  it("describes CRUD-derived Analytics as bounded", () => {
    const core = createDatabaseAdapterCore(
      createBundleEventAdapter(),
      resolveFileUrl,
    );

    expect(getAnalyticsCapability(core.api)).toEqual({
      mode: "bounded",
      maxMatchingRows: 50_000,
    });
  });

  it("uses a database-provided bundle event service", async () => {
    const service = {
      appendBundleEvent: vi.fn(),
      getBundleEventSummary: vi
        .fn<DatabaseBundleEventService["getBundleEventSummary"]>()
        .mockResolvedValue({ installed: 2, recovered: 1 }),
      getBundleEventAnalytics: vi.fn(),
      getBundleEventOverview: vi.fn(),
      getActiveInstallationOverview: vi.fn(),
      searchInstallations: vi.fn(),
      getInstallationHistory: vi.fn(),
    } satisfies DatabaseBundleEventService;
    const adapter: DatabaseAdapter = Object.assign(
      createInMemoryDatabaseAdapter(),
      { [databaseBundleEventService]: service },
    );
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    if (!supportsAnalytics(core.api)) {
      throw new Error("Expected the database-provided bundle event service.");
    }
    expect(getAnalyticsCapability(core.api)).toEqual({ mode: "dedicated" });

    await expect(core.api.getBundleEventSummary("bundle-1")).resolves.toEqual({
      installed: 2,
      recovered: 1,
    });
    expect(service.getBundleEventSummary).toHaveBeenCalledWith("bundle-1");
  });

  it("forwards an internal remote Analytics capability probe", async () => {
    // Given
    const capability = { analytics: false as const };
    const probe = vi.fn().mockResolvedValue(capability);
    const adapter = Object.assign(createInMemoryDatabaseAdapter(), {
      [Symbol.for("@hot-updater/internal/analytics-capability-probe")]: probe,
    });

    // When
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    const forwarded = Reflect.get(
      core.api,
      Symbol.for("@hot-updater/internal/analytics-capability-probe"),
    ) as () => Promise<typeof capability>;

    // Then
    await expect(forwarded()).resolves.toEqual(capability);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("runs the schema readiness guard before a low adapter operation", async () => {
    const adapter: DatabaseAdapter = createInMemoryDatabaseAdapter();
    const beforeOperation = vi.fn(async () => {});
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl, {
      beforeOperation,
    });

    await core.api.getChannels();

    expect(beforeOperation).toHaveBeenCalledOnce();
  });

  it("rejects invalid bundles before invoking low create", async () => {
    const adapter: DatabaseAdapter = createInMemoryDatabaseAdapter();
    const create = vi.spyOn(adapter, "create");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    const result = core.api.insertBundle({
      ...currentBundle,
      targetAppVersion: null,
      fingerprintHash: null,
    });

    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects invalid updates before invoking low update", async () => {
    const adapter: DatabaseAdapter = createInMemoryDatabaseAdapter();
    await createDatabaseClient(adapter).insertBundle(currentBundle);
    const update = vi.spyOn(adapter, "update");
    const core = createDatabaseAdapterCore(adapter, resolveFileUrl);
    const result = core.api.updateBundleById(currentBundle.id, {
      id: "00000000-0000-0000-0000-000000000099",
      targetAppVersion: null,
      fingerprintHash: null,
    });

    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(update).not.toHaveBeenCalled();
  });
});
