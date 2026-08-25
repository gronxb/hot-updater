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

  it("inserts an artifact without synthesizing a Release", async () => {
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    const core = createDatabasePluginCore(plugin, resolveFileUrl);

    await core.api.insertBundle(currentBundle);

    await expect(
      core.api.getBundleById(currentBundle.id),
    ).resolves.toMatchObject(currentBundle);
    await expect(
      plugin.models.releases.findMany({
        bundleId: currentBundle.id,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("updates an artifact without requiring or mutating a Release", async () => {
    const plugin: DatabasePlugin = createInMemoryDatabasePlugin();
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    await core.api.insertBundle(currentBundle);
    await core.api.updateBundleById(currentBundle.id, {
      storageUri: `r2://bucket/bundles/${currentBundle.id}/updated.zip`,
    });

    await expect(
      core.api.getBundleById(currentBundle.id),
    ).resolves.toMatchObject({
      id: currentBundle.id,
      storageUri: `r2://bucket/bundles/${currentBundle.id}/updated.zip`,
    });
    await expect(
      plugin.models.releases.findMany({
        bundleId: currentBundle.id,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
