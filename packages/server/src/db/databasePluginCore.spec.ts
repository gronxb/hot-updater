import {
  createDatabaseClient,
  databaseBundleEventService,
  type DatabasePlugin,
  type DatabaseBundleEventService,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import {
  getAnalyticsCapability,
  supportsAnalytics,
} from "./analyticsCapability";
import { createDatabasePluginCore } from "./databasePluginCore";
import {
  currentBundle,
  resolveFileUrl,
} from "./databasePluginCore.testFixtures";
import { createBundleEventPlugin } from "./databasePluginCoreEvent.testFixtures";

describe("createDatabasePluginCore capabilities", () => {
  it("omits bundle event methods when the plugin does not opt in", () => {
    const core = createDatabasePluginCore(
      createBundleEventPlugin(false),
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
    const core = createDatabasePluginCore(
      createBundleEventPlugin(),
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
    const plugin: DatabasePlugin = Object.assign(
      createInMemoryDatabasePlugin(),
      { [databaseBundleEventService]: service },
    );
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
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
    const plugin = Object.assign(createInMemoryDatabasePlugin(), {
      [Symbol.for("@hot-updater/internal/analytics-capability-probe")]: probe,
    });

    // When
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    const forwarded = Reflect.get(
      core.api,
      Symbol.for("@hot-updater/internal/analytics-capability-probe"),
    ) as () => Promise<typeof capability>;

    // Then
    await expect(forwarded()).resolves.toEqual(capability);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("runs the schema readiness guard before a low plugin operation", async () => {
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    const beforeOperation = vi.fn(async () => {});
    const core = createDatabasePluginCore(plugin, resolveFileUrl, {
      beforeOperation,
    });

    await core.api.getChannels();

    expect(beforeOperation).toHaveBeenCalledOnce();
  });

  it("rejects invalid bundles before invoking low create", async () => {
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    const create = vi.spyOn(plugin, "create");
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
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
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    await createDatabaseClient(plugin).insertBundle(currentBundle);
    const update = vi.spyOn(plugin, "update");
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
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
