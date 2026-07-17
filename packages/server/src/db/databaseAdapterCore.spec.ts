import {
  createDatabaseClient,
  databaseBundleEventService,
  type DatabaseAdapter,
  type DatabaseBundleEventService,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createDatabaseAdapterCore } from "./databaseAdapterCore";
import {
  currentBundle,
  resolveFileUrl,
} from "./databaseAdapterCore.testFixtures";
import { createBundleEventAdapter } from "./databaseAdapterCoreEvent.testFixtures";
import { supportsAnalytics } from "./types";

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

    await expect(core.api.getBundleEventSummary("bundle-1")).resolves.toEqual({
      installed: 2,
      recovered: 1,
    });
    expect(service.getBundleEventSummary).toHaveBeenCalledWith(
      "bundle-1",
      undefined,
    );
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
