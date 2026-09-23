import { describe, expect, it } from "vitest";

import { createDatabasePluginHarness } from "../../../packages/hot-updater/src/commands/databasePlugin.testFixtures.ts";
import { commitDeployment } from "../../../packages/hot-updater/src/commands/deployTransaction.ts";
import type { Bundle } from "../../../plugins/plugin-core/dist/index.mjs";
import { resetFixtureReleases } from "./fixture-release-reset.ts";

const artifact = (
  index: number,
  platform: "ios" | "android" = "ios",
): Bundle => ({
  assetBaseStorageUri: "storage://assets",
  gitCommitHash: null,
  id: `01900000-0000-7000-8000-${index.toString().padStart(12, "0")}`,
  manifestFileHash: `hash-${index}`,
  manifestStorageUri: `storage://artifacts/${index}/manifest.json`,
  metadata: {},
  platform,
});

describe("Detox fixture Release reset", () => {
  it("clears only the current platform and namespace while preserving shared artifacts and patches", async () => {
    const harness = createDatabasePluginHarness();
    const { core } = harness;
    const namespace = "e2e-current-job-ios-s1";
    const base = artifact(1);
    const orphan = artifact(6);
    await harness.setBundles([orphan]);
    const deploy = async (bundle: Bundle, channel: string, enabled = true) =>
      (
        await commitDeployment({
          core: harness.core,
          bundle,
          release: {
            channel,
            enabled,
            fingerprintHash: null,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: "1.0.x",
          },
        })
      ).release!;

    // The fixture artifact also serves production and is an external patch base.
    const ownProduction = await deploy(base, `${namespace}-production`);
    await core.promoteRelease({
      releaseId: ownProduction.id,
      targetChannel: "production",
    });
    await deploy(
      {
        ...artifact(2),
        patches: [
          {
            baseBundleId: base.id,
            baseFileHash: base.manifestFileHash,
            byteSize: 10,
            patchFileHash: "patch-hash",
            patchStorageUri: "storage://patches/production.patch",
          },
        ],
      },
      "production",
    );
    const ownBeta = await deploy(artifact(3), `${namespace}-beta`, false);
    await deploy(artifact(4), "e2e-other-job-ios-s1-production");
    await deploy(artifact(5, "android"), `${namespace}-production`);

    const ownIds = [ownProduction.id, ownBeta.id];
    const retainedReleases = (await harness.releases()).filter(
      (release) => !ownIds.includes(release.id),
    );
    const artifactsBefore = await harness.bundles();
    const channelsBefore = await core.listChannels();
    const retainedCatalogs = (
      await core.listReleaseCatalogs({ limit: 100 })
    ).filter(
      (catalog) =>
        ![ownProduction.scope_key, ownBeta.scope_key].includes(
          catalog.scope_key,
        ),
    );
    const patchesOf = async (ids: readonly string[]) =>
      (await Promise.all(ids.map((id) => core.getBundle(id)))).flatMap(
        (detail) => detail?.patches ?? [],
      );
    const patchesBefore = await patchesOf(artifactsBefore.map(({ id }) => id));
    expect(patchesBefore).toHaveLength(1);

    const result = await resetFixtureReleases({
      core,
      namespace,
      platform: "ios",
    });

    expect(result.clearedReleaseIds.sort()).toEqual(ownIds.sort());
    expect(await harness.releases()).toEqual(retainedReleases);
    expect(await harness.bundles()).toEqual(artifactsBefore);
    expect(await core.listChannels()).toEqual(channelsBefore);
    expect(await patchesOf(artifactsBefore.map(({ id }) => id))).toEqual(
      patchesBefore,
    );
    for (const catalog of retainedCatalogs) {
      expect(await core.getReleaseCatalogRow(catalog.scope_key)).toEqual(
        catalog,
      );
    }
    for (const scopeKey of [ownProduction.scope_key, ownBeta.scope_key]) {
      expect(await core.getReleaseCatalogRow(scopeKey)).toMatchObject({
        is_tombstone: true,
      });
    }
  });

  it.each([null, "", " \t"])(
    "rejects missing namespace %j before accessing the provider",
    async (namespace) => {
      const harness = createDatabasePluginHarness();

      await expect(
        resetFixtureReleases({
          core: harness.core,
          namespace,
          platform: "ios",
        }),
      ).rejects.toThrow("HOT_UPDATER_E2E_CHANNEL_NAMESPACE");

      expect(harness.read).not.toHaveBeenCalled();
    },
  );
});
