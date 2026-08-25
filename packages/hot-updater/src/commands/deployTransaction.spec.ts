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

const authorityId = "project-a";
const createDeployment = (
  id: string,
  platform: Bundle["platform"],
): Omit<DeploymentWrite, "authorityId"> => ({
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
    authorityId,
    channelKey: encodeChannelKey("production"),
    platform,
    strategy: "APP_VERSION",
  });

describe("Release deployment transaction", () => {
  const harness = createDatabasePluginHarness();

  beforeEach(() => harness.reset());

  it("atomically commits Bundle bytes, Release policy, and the compiled catalog", async () => {
    const deployment = iosBundle();

    const result = await commitDeployment({
      authorityId,
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
      authorityId,
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
          await persistDeployment({ authorityId, ...deployment });
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
        authorityId,
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
