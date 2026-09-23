import {
  DatabaseBundleNotFoundError,
  ReleaseManagementError,
  type Bundle,
  type Deployment,
} from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  DatabaseRowReferencedError,
} from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { createBundleFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createInProcessCoreApi } from "./api";

const setup = () => {
  let clock = 1_000;
  const core = createInProcessCoreApi(createMemoryAdapter(), {
    now: () => (clock += 1),
  });
  return { core };
};

const deployment = (
  bundle: Bundle,
  policy: Partial<Deployment["release"]> = {},
): Deployment => ({
  bundle,
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: null,
    shouldForceUpdate: false,
    targetAppVersion: "1.0.0",
    ...policy,
  },
});

const patchFrom = (bundle: Bundle, base: Bundle) => ({
  baseBundleId: base.id,
  baseFileHash: `base-${base.id}`,
  byteSize: 42,
  patchFileHash: `patch-${bundle.id}`,
  patchStorageUri: `storage://patches/${bundle.id}.patch`,
});

describe("core operations", () => {
  it("deploys bundles with their releases and catalogs, creating the channel", async () => {
    const { core } = setup();
    const ios = createBundleFixture("601");
    const android = {
      ...createBundleFixture("602"),
      platform: "android",
    } as const;

    const [first, second] = await core.deploy([
      deployment(ios),
      deployment(android, { channel: "beta" }),
    ]);

    expect(first!.release).toMatchObject({
      bundle_id: ios.id,
      operation: "DEPLOY",
      revision: 1,
      enabled: true,
    });
    expect(first!.release!.id > ios.id).toBe(true);
    expect(first!.catalog.generation).toBe(1);
    expect(second!.catalog).toMatchObject({
      platform: "android",
      generation: 1,
    });
    await expect(core.findChannelByName("beta")).resolves.toMatchObject({
      name: "beta",
    });
    const [next] = await core.deploy([deployment(createBundleFixture("603"))]);
    expect(next!.release!.id > first!.release!.id).toBe(true);
    expect(next!.catalog.generation).toBe(2);
    expect(await core.countBundles("ios")).toBe(2);
  });

  it("updates a release policy under its revision, and previews it without writing", async () => {
    const { core } = setup();
    const [deployed] = await core.deploy([
      deployment(createBundleFixture("611")),
    ]);
    const releaseId = deployed!.release!.id;

    const preview = await core.preflightReleasePolicy({
      releaseId,
      patch: { rolloutCohortCount: 250 },
    });
    expect(preview).toMatchObject({
      expectedReleaseRevision: 1,
      release: { revision: 2, rollout_cohort_count: 250 },
      catalog: { generation: 2 },
      currentCatalog: { generation: 1 },
    });
    await expect(core.getRelease(releaseId)).resolves.toMatchObject({
      revision: 1,
      rollout_cohort_count: 1_000,
    });

    const updated = await core.updateReleasePolicy({
      releaseId,
      expectedRevision: 1,
      patch: { rolloutCohortCount: 250, message: "slow" },
    });
    expect(updated.release).toMatchObject({
      revision: 2,
      rollout_cohort_count: 250,
      message: "slow",
    });
    const conflict = core.updateReleasePolicy({
      releaseId,
      expectedRevision: 1,
      patch: { enabled: false },
    });
    await expect(conflict).rejects.toBeInstanceOf(ReleaseManagementError);
    await expect(conflict).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      core.updateReleasePolicy({
        releaseId,
        patch: { fingerprintHash: "other" },
      }),
    ).rejects.toMatchObject({ code: "SCOPE_MOVE_UNSUPPORTED" });
    await expect(
      core.updateReleasePolicy({ releaseId: "missing", patch: {} }),
    ).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });
  });

  it("deletes only a disabled release", async () => {
    const { core } = setup();
    const [deployed] = await core.deploy([
      deployment(createBundleFixture("621")),
    ]);
    const releaseId = deployed!.release!.id;

    await expect(core.deleteRelease({ releaseId })).rejects.toMatchObject({
      code: "ENABLED_RELEASE",
    });
    await core.updateReleasePolicy({ releaseId, patch: { enabled: false } });
    const deleted = await core.deleteRelease({ releaseId });
    expect(deleted.release).toBeNull();
    expect(deleted.catalog.is_tombstone).toBe(true);
    await expect(core.getRelease(releaseId)).resolves.toBeNull();
  });

  it("promotes a bundle release by copy or by move", async () => {
    const { core } = setup();
    const [deployed] = await core.deploy([
      deployment(createBundleFixture("631")),
    ]);
    const source = deployed!.release!;

    const copied = await core.promoteRelease({
      releaseId: source.id,
      targetChannel: " beta ",
    });
    expect(copied.source).toBeNull();
    expect(copied.target.release).toMatchObject({
      operation: "PROMOTE",
      source_release_id: source.id,
      bundle_id: source.bundle_id,
      enabled: true,
      revision: 1,
    });
    await expect(core.getRelease(source.id)).resolves.toMatchObject({
      enabled: true,
    });

    const moved = await core.promoteRelease({
      releaseId: source.id,
      targetChannel: "staging",
      action: "move",
    });
    expect(moved.source!.release).toMatchObject({ enabled: false });
    expect(moved.target.release).toMatchObject({
      source_release_id: source.id,
      scope_key: moved.target.catalog.scope_key,
    });
    await expect(
      core.promoteRelease({
        releaseId: source.id,
        targetChannel: "production",
      }),
    ).rejects.toMatchObject({ code: "TARGET_RELEASE_INVALID" });
    await expect(
      core.promoteRelease({ releaseId: source.id, targetChannel: "  " }),
    ).rejects.toMatchObject({ code: "TARGET_RELEASE_INVALID" });
  });

  it("rebuilds a catalog only when it changed, and previews a rebuild", async () => {
    const { core } = setup();
    const [deployed] = await core.deploy([
      deployment(createBundleFixture("641")),
    ]);
    const scopeKey = deployed!.catalog.scope_key;

    await expect(
      core.preflightReleaseCatalogRebuild(scopeKey),
    ).resolves.toMatchObject({
      changed: false,
      currentCatalog: { generation: 1 },
    });
    await expect(core.rebuildReleaseCatalog(scopeKey)).resolves.toMatchObject({
      attempts: 1,
      changed: false,
      catalog: { generation: 1 },
    });
    await expect(core.rebuildReleaseCatalog("missing")).rejects.toThrow(
      'Release catalog "missing" was not found.',
    );
  });

  it("creates a channel once and deletes one no release uses", async () => {
    const { core } = setup();
    const first = await core.ensureChannel("qa");
    await expect(core.ensureChannel("qa")).resolves.toEqual(first);
    await expect(core.deleteChannel(first.id)).resolves.toEqual({
      deleted: true,
    });
    await core.deploy([deployment(createBundleFixture("651"))]);
    const production = await core.findChannelByName("production");
    await expect(core.deleteChannel(production!.id)).resolves.toEqual({
      deleted: false,
      reason: "not_empty",
    });
  });

  it("updates a bundle and replaces its patches, and deletes bundles no release uses", async () => {
    const { core } = setup();
    const base = createBundleFixture("661");
    const target = createBundleFixture("662");
    const [baseRelease] = await core.deploy([deployment(base)]);
    await core.deploy([deployment(target)]);

    await core.updateBundle(target.id, {
      gitCommitHash: "abc",
      patches: [patchFrom(target, base)],
    });
    const detail = await core.getBundle(target.id);
    expect(detail).toMatchObject({
      bundle: { git_commit_hash: "abc" },
      patches: [{ base_bundle_id: base.id }],
    });
    await expect(core.getBundle(base.id)).resolves.toMatchObject({
      childCount: 1,
    });
    await expect(
      core.updateBundle("missing", { gitCommitHash: "x" }),
    ).rejects.toBeInstanceOf(DatabaseBundleNotFoundError);
    await expect(core.deleteBundles([base.id])).rejects.toBeInstanceOf(
      DatabaseRowReferencedError,
    );
    const releaseId = baseRelease!.release!.id;
    await core.updateReleasePolicy({ releaseId, patch: { enabled: false } });
    await core.deleteRelease({ releaseId });
    await core.deleteBundles([base.id, "missing"]);
    await expect(core.getBundle(base.id)).resolves.toBeNull();
    await expect(core.getBundle(target.id)).resolves.toMatchObject({
      patches: [],
    });
  });
});
