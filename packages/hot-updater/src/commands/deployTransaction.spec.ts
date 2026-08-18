import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import type { LegacyBundle } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";
import { commitDeployment, prepareAndCommitBundles } from "./deployTransaction";

const authorityId = "project-a";
const createBundle = (
  id: string,
  platform: LegacyBundle["platform"],
): LegacyBundle => ({
  channel: "production",
  enabled: true,
  fileHash: `${id}-hash`,
  fingerprintHash: null,
  gitCommitHash: null,
  id,
  message: null,
  platform,
  rolloutCohortCount: 1_000,
  shouldForceUpdate: false,
  storageUri: `storage://bundle/${id}`,
  targetAppVersion: "1.0.x",
});

const iosBundle = () =>
  createBundle("01900000-0000-7000-8000-000000000001", "ios");

const scopeKey = (platform: LegacyBundle["platform"]) =>
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
    const bundle = iosBundle();

    const result = await commitDeployment({
      authorityId,
      bundle,
      database: harness.plugin,
    });

    await expect(
      harness.plugin.models.bundles.findById(bundle.id),
    ).resolves.toMatchObject({
      id: bundle.id,
      file_hash: bundle.fileHash,
    });
    await expect(
      harness.plugin.models.releases.findById(result.release!.id),
    ).resolves.toMatchObject({
      bundle_id: bundle.id,
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
    const bundle = iosBundle();
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

    const result = await commitDeployment({ authorityId, bundle, database });

    await expect(
      database.models.releases.findById(result.release!.id),
    ).resolves.toMatchObject({ channel_id: winner.id });
    await expect(
      database.models.releaseCatalogs.findByScopeKey(scopeKey("ios")),
    ).resolves.toMatchObject({ channel_id: winner.id });
  });

  it("prepares both platforms before committing their independent scopes", async () => {
    const bundles = [
      iosBundle(),
      createBundle("01900000-0000-7000-8000-000000000002", "android"),
    ];
    const prepared: string[] = [];

    const { commitResults, results } = await prepareAndCommitBundles({
      database: harness.plugin,
      prepare: async (persistDeployment) => {
        for (const bundle of bundles) {
          prepared.push(bundle.id);
          await persistDeployment({ authorityId, bundle });
        }
        expect(harness.commit).not.toHaveBeenCalled();
        return prepared;
      },
    });

    expect(results).toEqual(bundles.map(({ id }) => id));
    expect(
      commitResults.map(({ release }) => ({
        bundleId: release?.bundle_id,
        platform: release?.platform,
        releaseId: release?.id,
      })),
    ).toEqual([
      {
        bundleId: bundles[0]!.id,
        platform: "ios",
        releaseId: expect.any(String),
      },
      {
        bundleId: bundles[1]!.id,
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
    const bundle = { ...iosBundle(), targetAppVersion: "not-semver" };

    await expect(
      commitDeployment({ authorityId, bundle, database: harness.plugin }),
    ).rejects.toThrow();

    await expect(
      harness.plugin.models.bundles.findById(bundle.id),
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
