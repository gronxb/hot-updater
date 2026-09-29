import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";
import {
  commitDeployment,
  type DeploymentWrite,
  prepareAndCommitBundles,
} from "./deployTransaction";

const createDeployment = (
  id: string,
  platform: Bundle["platform"],
): DeploymentWrite => ({
  bundle: {
    assetBaseStorageUri: "storage://assets",
    gitCommitHash: null,
    id,
    manifestFileHash: `${id}-manifest-hash`,
    manifestStorageUri: `storage://bundle/${id}/manifest.json`,
    platform,
  },
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: null,
    rolloutCohortCount: 1_000,
    shouldForceUpdate: false,
    targetAppVersion: "1.0.x",
  },
});

const iosBundle = () =>
  createDeployment("01900000-0000-7000-8000-000000000001", "ios");

const scopeKey = (platform: Bundle["platform"]) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey("production"),
    platform,
    strategy: "APP_VERSION",
  });

describe("Release deployment transaction", () => {
  const harness = createDatabasePluginHarness();

  beforeEach(() => harness.reset());

  it("concurrent first deployments converge on one persisted Catalog identity", async () => {
    const first = iosBundle();
    const second = createDeployment(
      "01900000-0000-7000-8000-000000000002",
      "ios",
    );
    const results = await Promise.all([
      commitDeployment({ core: harness.core, ...first }),
      commitDeployment({ core: harness.core, ...second }),
    ]);

    expect(results[0]!.catalog.catalog_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(results[1]!.catalog.catalog_id).toBe(results[0]!.catalog.catalog_id);
    expect(results.map(({ catalog }) => catalog.generation).sort()).toEqual([
      1, 2,
    ]);
    await expect(
      harness.core.getReleaseCatalogRow(scopeKey("ios")),
    ).resolves.toMatchObject({
      catalog_id: results[0]!.catalog.catalog_id,
      generation: 2,
    });
  });

  it("independent databases get different identities for the same lookup scope", async () => {
    const other = createDatabasePluginHarness();
    const first = await commitDeployment({
      core: harness.core,
      ...iosBundle(),
    });
    const second = await commitDeployment({
      core: other.core,
      ...iosBundle(),
    });

    expect(first.catalog.scope_key).toBe(second.catalog.scope_key);
    expect(first.catalog.catalog_id).not.toBe(second.catalog.catalog_id);
  });

  it("commits Bundle bytes, Release policy, and the compiled catalog in one core call", async () => {
    const deployment = iosBundle();

    const result = await commitDeployment({
      ...deployment,
      core: harness.core,
    });

    await expect(
      harness.core.getBundle(deployment.bundle.id),
    ).resolves.toMatchObject({
      bundle: {
        id: deployment.bundle.id,
        manifest_file_hash: deployment.bundle.manifestFileHash,
      },
    });
    await expect(
      harness.core.getRelease(result.release!.id),
    ).resolves.toMatchObject({
      bundle_id: deployment.bundle.id,
      operation: "DEPLOY",
      revision: 1,
    });
    await expect(
      harness.core.getReleaseCatalogRow(scopeKey("ios")),
    ).resolves.toMatchObject({ generation: 1, is_tombstone: false });

    expect(harness.deploy).toHaveBeenCalledOnce();
    await expect(harness.core.listChannels()).resolves.toEqual([
      expect.objectContaining({
        id: `channel:${encodeChannelKey("production")}`,
        name: "production",
      }),
    ]);
  });

  it("uses the stored channel when another writer created it first", async () => {
    const deployment = iosBundle();
    const winner = { id: "channel-created-concurrently", name: "production" };
    await harness.plugin.models.channels.insert({
      row: winner,
      onConflict: "returnExisting",
    });

    const result = await commitDeployment({
      ...deployment,
      core: harness.core,
    });

    await expect(
      harness.core.getRelease(result.release!.id),
    ).resolves.toMatchObject({ channel_id: winner.id });
    await expect(
      harness.core.getReleaseCatalogRow(scopeKey("ios")),
    ).resolves.toMatchObject({ channel_id: winner.id });
  });

  it("prepares both platforms before committing their independent scopes", async () => {
    const deployments = [
      iosBundle(),
      createDeployment("01900000-0000-7000-8000-000000000002", "android"),
    ];
    const prepared: string[] = [];

    const { commitResults, results } = await prepareAndCommitBundles({
      core: harness.core,
      prepare: async (persistDeployment) => {
        for (const deployment of deployments) {
          prepared.push(deployment.bundle.id);
          await persistDeployment({ ...deployment });
        }
        expect(harness.deploy).not.toHaveBeenCalled();
        return prepared;
      },
    });

    expect(results).toEqual(deployments.map(({ bundle: { id } }) => id));
    expect(
      commitResults.map(({ release }) => ({
        bundleId: release?.bundle_id,
        platform: release?.platform,
        releaseId: release?.id,
      })),
    ).toEqual([
      {
        bundleId: deployments[0]!.bundle.id,
        platform: "ios",
        releaseId: expect.any(String),
      },
      {
        bundleId: deployments[1]!.bundle.id,
        platform: "android",
        releaseId: expect.any(String),
      },
    ]);
    expect(harness.deploy).toHaveBeenCalledOnce();
    await expect(
      harness.core.getReleaseCatalogRow(scopeKey("ios")),
    ).resolves.not.toBeNull();
    await expect(
      harness.core.getReleaseCatalogRow(scopeKey("android")),
    ).resolves.not.toBeNull();
  });

  it("does not deploy anything when preparing a platform fails", async () => {
    const failure = new Error("android build failed");

    await expect(
      prepareAndCommitBundles({
        core: harness.core,
        prepare: async (persistDeployment) => {
          await persistDeployment(iosBundle());
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(harness.deploy).not.toHaveBeenCalled();
    await expect(harness.bundles()).resolves.toEqual([]);
  });

  it("leaves Bundle and Release state unchanged when catalog compilation fails", async () => {
    const deployment = iosBundle();
    const invalidDeployment = {
      ...deployment,
      release: { ...deployment.release, targetAppVersion: "not-semver" },
    };

    await expect(
      commitDeployment({
        ...invalidDeployment,
        core: harness.core,
      }),
    ).rejects.toThrow();

    await expect(
      harness.core.getBundle(deployment.bundle.id),
    ).resolves.toBeNull();
    await expect(
      harness.core.listReleases({
        filter: { kind: "scope", scopeKey: scopeKey("ios") },
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      harness.core.getReleaseCatalogRow(scopeKey("ios")),
    ).resolves.toBeNull();
  });
});
