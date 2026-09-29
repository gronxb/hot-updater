import {
  DatabasePluginInputError,
  type DatabaseChange,
  type ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { createDatabaseEngine } from "../database/database";
import { DatabaseConstraintError } from "../database/errors";
import { resolveSchema } from "../database/resolveSchema";
import {
  commitLegacyChanges,
  coreModule,
  createCoreReads,
  targetBaseCandidateKey,
} from "./index";

const channel = createChannelRowFixture("production");
const bundle = createBundleRowFixture("401");
const other = createBundleRowFixture("402");
const release = createReleaseRowFixture("401", bundle, channel);

const catalog = (generation: number): ReleaseCatalogRow => ({
  scope_key: release.scope_key,
  catalog_id: "catalog-1",
  strategy: "APP_VERSION",
  channel_id: channel.id,
  channel_key: "cHJvZHVjdGlvbg",
  platform: "ios",
  fingerprint_hash: null,
  generation,
  payload: "{}",
  catalog_hash: `sha256:${generation}`,
  byte_size: 2,
  is_tombstone: false,
  updated_at_ms: generation,
});

const setup = async () => {
  const engine = createDatabaseEngine({
    adapter: createMemoryAdapter(),
    schema: resolveSchema([coreModule]),
  });
  const db = engine.database(coreModule);
  const commit = (...changes: DatabaseChange[]) =>
    commitLegacyChanges(db, { changes });
  await commit({
    model: "channels",
    operation: "insert",
    row: channel,
    onConflict: "ignore",
  });
  return {
    db,
    commit,
    reads: createCoreReads(db, { resolveFileUrl: async () => null }),
  };
};

describe("legacy commit on the engine", () => {
  it("reports a stale expectation as version_conflict and writes nothing", async () => {
    const { db, commit } = await setup();
    await commit(
      { model: "bundles", operation: "insert", row: bundle },
      { model: "releases", operation: "insert", row: release },
      { model: "releaseCatalogs", operation: "put", row: catalog(1) },
    );

    const staleRelease = await commitLegacyChanges(db, {
      changes: [
        {
          model: "releases",
          operation: "update",
          where: { id: release.id },
          update: { revision: 2 },
        },
      ],
      expectations: [{ model: "releases", id: release.id, revision: 2 }],
    });
    expect(staleRelease).toEqual({
      committed: false,
      conflict: {
        changeIndex: -1,
        reason: "version_conflict",
        model: "releases",
        key: release.id,
        expectedVersion: 2,
        actualVersion: 1,
      },
    });

    const staleCatalog = await commitLegacyChanges(db, {
      changes: [
        { model: "releaseCatalogs", operation: "put", row: catalog(2) },
      ],
      expectations: [
        {
          model: "releaseCatalogs",
          scopeKey: release.scope_key,
          generation: null,
        },
      ],
    });
    expect(staleCatalog).toMatchObject({
      committed: false,
      conflict: { reason: "version_conflict", actualVersion: 1 },
    });
  });

  it("reports missing update targets as not_found and ignores missing deletes", async () => {
    const { commit } = await setup();
    await expect(
      commit(
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "bundles",
          operation: "update",
          where: { id: other.id },
          update: { git_commit_hash: "abc" },
        },
      ),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 1, reason: "not_found" },
    });
    await expect(
      commit({
        model: "releases",
        operation: "update",
        where: { id: release.id },
        update: { message: "missing" },
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 0, reason: "not_found" },
    });
    await expect(
      commit(
        { model: "bundles", operation: "delete", where: { id: bundle.id } },
        { model: "releases", operation: "delete", where: { id: release.id } },
        { model: "channels", operation: "delete", where: { id: "missing" } },
      ),
    ).resolves.toEqual({ committed: true });
  });

  it("refuses deleting a bundle or channel a release uses, naming the change", async () => {
    const { commit, reads } = await setup();
    await commit(
      { model: "bundles", operation: "insert", row: bundle },
      { model: "releases", operation: "insert", row: release },
    );
    await expect(
      commit(
        {
          model: "channels",
          operation: "insert",
          row: createChannelRowFixture("beta"),
          onConflict: "ignore",
        },
        { model: "bundles", operation: "delete", where: { id: bundle.id } },
      ),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 1, reason: "referenced" },
    });
    await expect(
      commit({
        model: "channels",
        operation: "delete",
        where: { id: channel.id },
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 0, reason: "referenced" },
    });
    await expect(reads.getBundle(bundle.id)).resolves.toMatchObject({
      bundle,
    });
    await expect(reads.listChannels()).resolves.toEqual([channel]);
  });

  it("cascades patches from either bundle and deletes one owner's patches", async () => {
    const { commit, reads } = await setup();
    const third = createBundleRowFixture("403");
    const fromBase = createBundlePatchRowFixture("1", other.id, bundle.id);
    const fromOther = createBundlePatchRowFixture("2", third.id, other.id);
    await commit(
      { model: "bundles", operation: "insert", row: bundle },
      { model: "bundles", operation: "insert", row: other },
      { model: "bundles", operation: "insert", row: third },
      { model: "bundlePatches", operation: "insert", row: fromBase },
      { model: "bundlePatches", operation: "insert", row: fromOther },
    );
    await expect(reads.getBundle(bundle.id)).resolves.toMatchObject({
      childCount: 1,
    });

    await commit({
      model: "bundles",
      operation: "delete",
      where: { id: bundle.id },
    });
    await expect(reads.getBundle(other.id)).resolves.toMatchObject({
      patches: [],
      childCount: 1,
    });
    await commit({
      model: "bundlePatches",
      operation: "delete",
      where: { bundleId: third.id },
    });
    await expect(reads.getBundle(third.id)).resolves.toMatchObject({
      patches: [],
    });
    await expect(reads.getBundle(other.id)).resolves.toMatchObject({
      childCount: 0,
    });
    await expect(reads.countBundles()).resolves.toBe(2);
  });

  it("rejects a patch to a missing bundle and rolls back the whole commit", async () => {
    const { commit, reads } = await setup();
    await expect(
      commit(
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "bundlePatches",
          operation: "insert",
          row: createBundlePatchRowFixture("3", bundle.id, other.id),
        },
      ),
    ).rejects.toBeInstanceOf(DatabaseConstraintError);
    await expect(reads.getBundle(bundle.id)).resolves.toBeNull();
    await expect(reads.countBundles()).resolves.toBe(0);
  });

  it("gives a release written without its catalog a placeholder that reads as absent", async () => {
    const { db, commit, reads } = await setup();
    await commit(
      { model: "bundles", operation: "insert", row: bundle },
      { model: "releases", operation: "insert", row: release },
    );
    await expect(
      reads.getReleaseCatalogRow(release.scope_key),
    ).resolves.toBeNull();

    await expect(
      commitLegacyChanges(db, {
        changes: [
          { model: "releaseCatalogs", operation: "put", row: catalog(1) },
        ],
        expectations: [
          {
            model: "releaseCatalogs",
            scopeKey: release.scope_key,
            generation: null,
          },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      reads.getReleaseCatalogRow(release.scope_key),
    ).resolves.toEqual(catalog(1));
  });

  it("keeps bundle totals and auto-patch base candidates with the rows", async () => {
    const { commit, reads } = await setup();
    const android = { ...other, platform: "android" as const };
    await commit(
      { model: "bundles", operation: "insert", row: bundle },
      { model: "bundles", operation: "insert", row: android },
      { model: "releases", operation: "insert", row: release },
    );
    await expect(reads.countBundles()).resolves.toBe(2);
    await expect(reads.countBundles("ios")).resolves.toBe(1);
    await expect(reads.countBundles("android")).resolves.toBe(1);

    const key = targetBaseCandidateKey({
      channelId: channel.id,
      platform: "ios",
      fingerprintHash: null,
      appVersion: "1.0.0",
    })!;
    const newest = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    await expect(reads.findBaseBundleIds(key, newest, 3)).resolves.toEqual([
      bundle.id,
    ]);
    await commit({
      model: "releases",
      operation: "update",
      where: { id: release.id },
      update: { enabled: false, revision: 2 },
    });
    await expect(reads.findBaseBundleIds(key, newest, 3)).resolves.toEqual([]);

    await commit({
      model: "bundles",
      operation: "update",
      where: { id: android.id },
      update: { platform: "ios" },
    });
    await expect(reads.countBundles("ios")).resolves.toBe(2);
    await expect(reads.countBundles("android")).resolves.toBe(0);
  });

  it("rejects malformed input and a release on another platform's bundle", async () => {
    const { db, commit } = await setup();
    await expect(
      commitLegacyChanges(db, { changes: [{ model: "unknown" }] } as never),
    ).rejects.toBeInstanceOf(DatabasePluginInputError);
    await expect(
      commit({
        model: "bundles",
        operation: "insert",
        row: { ...bundle, platform: "android" },
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      commit({ model: "releases", operation: "insert", row: release }),
    ).rejects.toBeInstanceOf(DatabasePluginInputError);
  });
});
