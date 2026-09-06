import { describe, expect, it } from "vitest";

import { createDatabasePluginHarness } from "../../../packages/hot-updater/src/commands/databasePlugin.testFixtures.ts";
import { commitDeployment } from "../../../packages/hot-updater/src/commands/deployTransaction.ts";
import {
  type Bundle,
  promoteRelease,
} from "../../../plugins/plugin-core/dist/index.mjs";
import { resetFixtureReleases } from "./fixture-release-reset.ts";

const artifact = (
  index: number,
  platform: "ios" | "android" = "ios",
): Bundle => ({
  archiveByteSize: 100,
  fileHash: `hash-${index}`,
  gitCommitHash: null,
  id: `01900000-0000-7000-8000-${index.toString().padStart(12, "0")}`,
  platform,
  storageUri: `storage://artifacts/${index}.zip`,
});

describe("Detox fixture Release reset", () => {
  it("clears only the current platform and namespace while preserving shared artifacts and patches", async () => {
    const harness = createDatabasePluginHarness();
    const database = harness.plugin;
    const namespace = "e2e-current-job-ios-s1";
    const base = artifact(1);
    const orphan = artifact(6);
    harness.setBundles([orphan]);
    const deploy = async (bundle: Bundle, channel: string, enabled = true) =>
      (
        await commitDeployment({
          database,
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
    await promoteRelease({
      database,
      releaseId: ownProduction.id,
      targetChannel: "production",
    });
    await deploy(
      {
        ...artifact(2),
        patches: [
          {
            baseBundleId: base.id,
            baseFileHash: base.fileHash,
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
    const channelsBefore = await database.models.channels.list({});
    const retainedCatalogs = (
      await database.models.releaseCatalogs.findMany({ limit: 100 })
    ).filter(
      (catalog) =>
        ![ownProduction.scope_key, ownBeta.scope_key].includes(
          catalog.scope_key,
        ),
    );
    const patchesBefore = await database.models.bundlePatches.findByBundleIds(
      artifactsBefore.map(({ id }) => id),
    );
    expect(patchesBefore).toHaveLength(1);

    const result = await resetFixtureReleases({
      database,
      namespace,
      platform: "ios",
    });

    expect(result.clearedReleaseIds.sort()).toEqual(ownIds.sort());
    expect(await harness.releases()).toEqual(retainedReleases);
    expect(await harness.bundles()).toEqual(artifactsBefore);
    expect(await database.models.channels.list({})).toEqual(channelsBefore);
    expect(
      await database.models.bundlePatches.findByBundleIds(
        artifactsBefore.map(({ id }) => id),
      ),
    ).toEqual(patchesBefore);
    for (const catalog of retainedCatalogs) {
      expect(
        await database.models.releaseCatalogs.findByScopeKey(catalog.scope_key),
      ).toEqual(catalog);
    }
    for (const scopeKey of [ownProduction.scope_key, ownBeta.scope_key]) {
      expect(
        await database.models.releaseCatalogs.findByScopeKey(scopeKey),
      ).toMatchObject({ is_tombstone: true });
    }
  });

  it.each([null, "", " \t"])(
    "rejects missing namespace %j before accessing the provider",
    async (namespace) => {
      const harness = createDatabasePluginHarness();

      await expect(
        resetFixtureReleases({
          database: harness.plugin,
          namespace,
          platform: "ios",
        }),
      ).rejects.toThrow("HOT_UPDATER_E2E_CHANNEL_NAMESPACE");

      expect(harness.read).not.toHaveBeenCalled();
      expect(harness.commit).not.toHaveBeenCalled();
    },
  );
});
