import { type DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createDatabasePluginCore } from "./databasePluginCore";
import {
  currentBundle,
  resolveFileUrl,
} from "./databasePluginCore.testFixtures";

describe("createDatabasePluginCore", () => {
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
    const commit = vi.spyOn(plugin, "commit");
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    const result = core.api.insertBundle({
      ...currentBundle,
      targetAppVersion: null,
      fingerprintHash: null,
    });

    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects invalid updates before invoking low update", async () => {
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    const commit = vi.spyOn(plugin, "commit");
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    await core.api.insertBundle(currentBundle);
    commit.mockClear();
    const result = core.api.updateBundleById(currentBundle.id, {
      id: "00000000-0000-0000-0000-000000000099",
      targetAppVersion: null,
      fingerprintHash: null,
    });

    await expect(result).rejects.toThrow(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
    expect(commit).not.toHaveBeenCalled();
  });
});
