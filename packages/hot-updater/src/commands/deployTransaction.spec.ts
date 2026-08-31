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
    archiveByteSize: 1024,
    fileHash: `${id}-hash`,
    gitCommitHash: null,
    id,
    platform,
    storageUri: `storage://bundle/${id}`,
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
      commitDeployment({ database: harness.plugin, ...first }),
      commitDeployment({ database: harness.plugin, ...second }),
    ]);

    expect(results[0]!.catalog.catalog_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(results[1]!.catalog.catalog_id).toBe(results[0]!.catalog.catalog_id);
    expect(results.map(({ catalog }) => catalog.generation).sort()).toEqual([
      1, 2,
    ]);
    await expect(
      harness.plugin.models.releaseCatalogs.findByScopeKey(scopeKey("ios")),
    ).resolves.toMatchObject({
      catalog_id: results[0]!.catalog.catalog_id,
      generation: 2,
    });
  });

  it("independent databases get different identities for the same lookup scope", async () => {
    const other = createDatabasePluginHarness();
    const first = await commitDeployment({
      database: harness.plugin,
      ...iosBundle(),
    });
    const second = await commitDeployment({
      database: other.plugin,
      ...iosBundle(),
    });

    expect(first.catalog.scope_key).toBe(second.catalog.scope_key);
    expect(first.catalog.catalog_id).not.toBe(second.catalog.catalog_id);
  });

  it("atomically commits Bundle bytes, Release policy, and the compiled catalog", async () => {
    const deployment = iosBundle();

    const result = await commitDeployment({
      ...deployment,
      database: harness.plugin,
    });

    await expect(
      harness.plugin.models.bundles.findById(deployment.bundle.id),
    ).resolves.toMatchObject({
      id: deployment.bundle.id,
      file_hash: deployment.bundle.fileHash,
    });
    await expect(
      harness.plugin.models.releases.findById(result.release!.id),
    ).resolves.toMatchObject({
      bundle_id: deployment.bundle.id,
      operation: "DEPLOY",
      revision: 1,
    });
    await expect(
      harness.plugin.models.releaseCatalogs.findByScopeKey(scopeKey("ios")),
    ).resolves.toMatchObject({ generation: 1, is_tombstone: false });

    expect(harness.commit).toHaveBeenCalledOnce();
    expect(
      harness.commit.mock.calls[0]?.[0].changes.map(
        ({ model }: { readonly model: string }) => model,
      ),
    ).toEqual(["bundles", "releases", "releaseCatalogs"]);
    await expect(harness.plugin.models.channels.list({})).resolves.toEqual({
      channels: [
        {
          id: `channel:${encodeChannelKey("production")}`,
          name: "production",
        },
      ],
    });
  });

  it("uses the canonical channel returned by a concurrent creator", async () => {
    const deployment = iosBundle();
    const winner = { id: "channel-created-concurrently", name: "production" };
    let listed = false;
    const database = {
      ...harness.plugin,
      models: {
        ...harness.plugin.models,
        channels: {
          ...harness.plugin.models.channels,
          async insert(
            input: Parameters<typeof harness.plugin.models.channels.insert>[0],
          ) {
            await harness.plugin.models.channels.insert({
              row: winner,
              onConflict: "returnExisting",
            });
            return harness.plugin.models.channels.insert(input);
          },
          async list(input: {}) {
            if (!listed) {
              listed = true;
              return { channels: [] };
            }
            return harness.plugin.models.channels.list(input);
          },
        },
      },
    };

    const result = await commitDeployment({
      ...deployment,
      database,
    });

    await expect(
      database.models.releases.findById(result.release!.id),
    ).resolves.toMatchObject({ channel_id: winner.id });
    await expect(
      database.models.releaseCatalogs.findByScopeKey(scopeKey("ios")),
    ).resolves.toMatchObject({ channel_id: winner.id });
  });

  it("prepares both platforms before committing their independent scopes", async () => {
    const deployments = [
      iosBundle(),
      createDeployment("01900000-0000-7000-8000-000000000002", "android"),
    ];
    const prepared: string[] = [];

    const { commitResults, results } = await prepareAndCommitBundles({
      database: harness.plugin,
      prepare: async (persistDeployment) => {
        for (const deployment of deployments) {
          prepared.push(deployment.bundle.id);
          await persistDeployment({ ...deployment });
        }
        expect(harness.commit).not.toHaveBeenCalled();
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
    expect(harness.commit).toHaveBeenCalledOnce();
    await expect(
      harness.plugin.models.releaseCatalogs.findByScopeKey(scopeKey("ios")),
    ).resolves.not.toBeNull();
    await expect(
      harness.plugin.models.releaseCatalogs.findByScopeKey(scopeKey("android")),
    ).resolves.not.toBeNull();
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
        database: harness.plugin,
      }),
    ).rejects.toThrow();

    await expect(
      harness.plugin.models.bundles.findById(deployment.bundle.id),
    ).resolves.toBeNull();
    await expect(
      harness.plugin.models.releases.findManyByScope({
        consistency: "strong",
        limit: 10,
        scopeKey: scopeKey("ios"),
      }),
    ).resolves.toEqual([]);
    await expect(
      harness.plugin.models.releaseCatalogs.findByScopeKey(scopeKey("ios")),
    ).resolves.toBeNull();
    expect(harness.commit).not.toHaveBeenCalled();
  });
});
