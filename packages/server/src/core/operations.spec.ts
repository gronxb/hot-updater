import {
  DatabaseBundleNotFoundError,
  ReleaseManagementError,
  type Bundle,
  type Deployment,
  createMemoryAdapter,
  DatabaseRowReferencedError,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";
import {
  createBundleFixture,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { createInProcessCoreApi } from "./inProcess.testFixtures";

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
  it("ensures a channel again when it is deleted between ensuring it and the deploy", async () => {
    const memory = createMemoryAdapter();
    const direct = createInProcessCoreApi(memory);
    let raced = false;
    // The first release write lets a concurrent delete of its channel land first.
    const adapter: DatabaseAdapter = {
      ...memory,
      write: async (ops) => {
        if (
          !raced &&
          ops.some((op) => op.type === "insert" && op.table.name === "releases")
        ) {
          raced = true;
          const channel = await direct.findChannelByName("production");
          await direct.deleteChannel(channel!.id);
        }
        return memory.write(ops);
      },
    };
    const core = createInProcessCoreApi(adapter);

    const [result] = await core.deploy([deployment(createBundleFixture("1"))]);

    expect(raced).toBe(true);
    const channel = await core.findChannelByName("production");
    expect(result!.release!.channel_id).toBe(channel!.id);
  });

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

  it("republishes a stored bundle as a new release, writing no bundle", async () => {
    const { core } = setup();
    const bundle = createBundleFixture("611");
    const [original] = await core.deploy([deployment(bundle)]);

    const [republished] = await core.deploy([
      {
        bundleId: bundle.id,
        release: deployment(bundle).release,
      },
    ]);

    expect(republished!.release).toMatchObject({
      bundle_id: bundle.id,
      operation: "DEPLOY",
      platform: "ios",
      scope_key: original!.release!.scope_key,
    });
    expect(republished!.release!.id > original!.release!.id).toBe(true);
    expect(republished!.catalog.generation).toBe(2);
    expect(await core.countBundles()).toBe(1);
    await expect(
      core.deploy([
        { bundleId: "missing", release: deployment(bundle).release },
      ]),
    ).rejects.toBeInstanceOf(DatabaseBundleNotFoundError);
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

  it("updates a bundle and replaces its patches, and refuses to delete a bundle a release uses", async () => {
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
    await expect(
      core.getRelease(baseRelease!.release!.id),
    ).resolves.toMatchObject({ bundle_id: base.id });
  });

  it("retains independently published patch bases during concurrent atomic upserts", async () => {
    const { core } = setup();
    const first = createBundleFixture("663");
    const second = createBundleFixture("664");
    const target = createBundleFixture("665");
    for (const bundle of [first, second, target]) {
      await core.deploy([deployment(bundle)]);
    }
    await Promise.all(
      [first, second].map((base) =>
        core.updateBundle(target.id, {
          upsertPatch: { artifact: patchFrom(target, base), position: "last" },
        }),
      ),
    );
    const detail = await core.getBundle(target.id);
    expect(detail?.patches.map((patch) => patch.base_bundle_id).sort()).toEqual(
      [first.id, second.id],
    );
    await expect(
      core.countBundleChildren([first.id, second.id]),
    ).resolves.toEqual({ [first.id]: 1, [second.id]: 1 });
    await core.updateBundle(target.id, {
      upsertPatch: {
        artifact: { ...patchFrom(target, first), byteSize: 43 },
        position: "first",
      },
    });
    expect((await core.getBundle(target.id))?.patches).toMatchObject([
      { base_bundle_id: first.id, byte_size: 43, order_index: 0 },
      { base_bundle_id: second.id, byte_size: 42, order_index: 1 },
    ]);
  });

  it("deletes an artifact with the last release on it, and the patches built on it", async () => {
    const { core } = setup();
    const base = createBundleFixture("671");
    const target = createBundleFixture("672");
    const [baseRelease] = await core.deploy([deployment(base)]);
    await core.deploy([deployment(target)]);
    await core.updateBundle(target.id, { patches: [patchFrom(target, base)] });
    const releaseId = baseRelease!.release!.id;
    await core.updateReleasePolicy({ releaseId, patch: { enabled: false } });

    await core.deleteRelease({ releaseId });

    await expect(core.getBundle(base.id)).resolves.toBeNull();
    await expect(core.getBundle(target.id)).resolves.toMatchObject({
      patches: [],
    });
    await expect(
      core.deleteBundles([base.id, "missing"]),
    ).resolves.toBeUndefined();
  });

  it("keeps an artifact while another release still uses it", async () => {
    const { core } = setup();
    const bundle = createBundleFixture("681");
    const [deployed] = await core.deploy([deployment(bundle)]);
    const source = deployed!.release!;
    const promoted = await core.promoteRelease({
      releaseId: source.id,
      targetChannel: "beta",
    });
    const copy = promoted.target.release!;
    for (const releaseId of [source.id, copy.id]) {
      await core.updateReleasePolicy({ releaseId, patch: { enabled: false } });
    }

    await core.deleteRelease({ releaseId: source.id });
    await expect(core.getBundle(bundle.id)).resolves.toMatchObject({
      bundle: { id: bundle.id },
    });

    await core.deleteRelease({ releaseId: copy.id });
    await expect(core.getBundle(bundle.id)).resolves.toBeNull();
  });
});

describe("cached client routes", () => {
  /** Core over `adapter` with a purge that counts its calls. */
  const withPurges = (adapter: DatabaseAdapter = createMemoryAdapter()) => {
    let purges = 0;
    const core = createInProcessCoreApi(adapter, {
      onCachedRoutesChange: async () => {
        purges += 1;
      },
    });
    return { core, purges: () => purges };
  };

  it("purges once after a deploy commits, however many catalogs it wrote", async () => {
    const { core, purges } = withPurges();
    const android = {
      ...createBundleFixture("702"),
      platform: "android",
    } as const;

    await core.deploy([
      deployment(createBundleFixture("701")),
      deployment(android),
    ]);

    expect(purges()).toBe(1);
  });

  it("purges nothing for a write that changes no catalog, or for a preview", async () => {
    const { core, purges } = withPurges();

    await core.ensureChannel("beta");
    expect(purges()).toBe(0);
    const [deployed] = await core.deploy([
      deployment(createBundleFixture("711")),
    ]);
    expect(purges()).toBe(1);
    await core.preflightReleasePolicy({
      releaseId: deployed!.release!.id,
      patch: { rolloutCohortCount: 250 },
    });

    expect(purges()).toBe(1);
  });

  it("purges once, for the attempt that commits", async () => {
    const memory = createMemoryAdapter();
    const direct = createInProcessCoreApi(memory);
    await direct.deploy([deployment(createBundleFixture("721"))]);
    let raced = false;
    // The first catalog write lets a concurrent deploy to the same scope land first, so the transaction reruns.
    const adapter: DatabaseAdapter = {
      ...memory,
      write: async (ops) => {
        if (
          !raced &&
          ops.some(
            (op) => op.type !== "check" && op.table.name === "release_catalogs",
          )
        ) {
          raced = true;
          await direct.deploy([deployment(createBundleFixture("722"))]);
        }
        return memory.write(ops);
      },
    };
    const { core, purges } = withPurges(adapter);

    const [result] = await core.deploy([
      deployment(createBundleFixture("723")),
    ]);

    expect(raced).toBe(true);
    expect(result!.catalog.generation).toBe(3);
    expect(purges()).toBe(1);
  });

  it("takes the purge from a configured database", async () => {
    let purges = 0;
    const { core } = createHotUpdater({
      database: {
        name: "memory",
        adapter: createMemoryAdapter(),
        onCachedRoutesChange: async () => {
          purges += 1;
        },
      },
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });

    await core.deploy([deployment(createBundleFixture("731"))]);

    expect(purges).toBe(1);
  });
});
