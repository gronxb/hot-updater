import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  NIL_UUID,
} from "@hot-updater/core";
import {
  compileReleaseCatalog,
  releaseRowToRelease,
  type ReleaseRow,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
  createReleaseRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { createDatabaseEngine } from "../database/database";
import type { ReadMeasurement } from "../database/engine";
import { resolveSchema } from "../database/resolveSchema";
import { createStorageAccess } from "../storageAccess";
import { coreModule, createCoreReads, targetBaseCandidateKey } from "./index";

const fixtureMissingId = "01900000-0000-7000-8000-00000000ffff";
const channel = { id: "channel-production", name: "production" };
const channelKey = encodeChannelKey("production");
const scopeKey = createReleaseCatalogScopeKey({
  channelKey,
  platform: "ios",
  strategy: "APP_VERSION",
});
const base = createBundleRowFixture("301");
const target = {
  ...createBundleRowFixture("302"),
  asset_base_storage_uri: "storage://test-bucket/assets",
};
const patch = {
  ...createBundlePatchRowFixture("1", target.id, base.id),
  byte_size: 10,
};
const release: ReleaseRow = {
  ...createReleaseRowFixture("1", target, channel),
  scope_key: scopeKey,
};

const setup = async () => {
  const engine = createDatabaseEngine({
    adapter: createMemoryAdapter(),
    schema: resolveSchema([coreModule]),
    verify: true,
  });
  const db = engine.database(coreModule);
  const compilation = await compileReleaseCatalog({
    strategy: "APP_VERSION",
    releases: [releaseRowToRelease(release)],
  });
  await db.transaction(async (tx) => {
    tx.create("channels", channel);
    tx.create("bundles", base);
    tx.create("bundles", target);
    tx.create("bundle_patches", patch);
    tx.create("release_catalogs", {
      scope_key: scopeKey,
      catalog_id: "01900000-0000-7000-8000-000000000001",
      strategy: "APP_VERSION",
      channel_id: channel.id,
      channel_key: channelKey,
      platform: "ios",
      fingerprint_hash: null,
      generation: 1,
      payload: compilation.canonicalPayload,
      catalog_hash: compilation.catalogHash,
      byte_size: compilation.byteSize,
      is_tombstone: false,
      updated_at_ms: 1,
    });
    tx.create("releases", release);
    tx.aggregate("bundle_totals", { platform_key: "*" }, { bundles: 2 });
    tx.aggregate("bundle_totals", { platform_key: "ios" }, { bundles: 2 });
  });
  const { readStorageText, resolveFileUrl } = createStorageAccess([
    createReleaseCatalogTestStorage() as StoragePluginWith<"get">,
  ]);
  return {
    engine,
    reads: createCoreReads(db, { readStorageText, resolveFileUrl }),
  };
};

describe("core reads", () => {
  it("answers an update check with one point read of the scope's catalog", async () => {
    const { engine, reads } = await setup();
    const measured = await engine.measureReads(() =>
      reads.getReleaseCatalog({
        strategy: "APP_VERSION",
        platform: "ios",
        channelKey,
        appVersion: "1.0.0",
      }),
    );
    // `rows` counts query rows; a point read counts its keys
    expect(measured.adapter).toEqual({ gets: 1, keys: 1, queries: 0, rows: 0 });
    expect(measured.engine).toEqual({ calls: 1, rows: 1 });
    expect(measured.result?.releases.map(({ releaseId }) => releaseId)).toEqual(
      [release.id],
    );

    await expect(
      reads.getReleaseCatalog({
        strategy: "APP_VERSION",
        platform: "android",
        channelKey,
        appVersion: "1.0.0",
      }),
    ).resolves.toBeNull();
  });

  it("resolves an artifact with one batch read of both bundles and one unique read of their patch", async () => {
    const { engine, reads } = await setup();
    const measured = await engine.measureReads(() =>
      reads.getArtifactInfo(target.id, base.id, 1),
    );
    expect(measured.adapter).toEqual({ gets: 1, keys: 2, queries: 1, rows: 1 });
    expect(measured.engine).toEqual({ calls: 2, rows: 3 });
    expect(measured.result).toMatchObject({
      artifactProtocolVersion: 1,
      manifestFileHash: target.manifest_file_hash,
    });

    const full = await engine.measureReads(() =>
      reads.getArtifactInfo(target.id, NIL_UUID, 1),
    );
    expect(full.adapter).toEqual({ gets: 1, keys: 1, queries: 0, rows: 0 });
    await expect(
      reads.getArtifactInfo(fixtureMissingId, NIL_UUID, 1),
    ).resolves.toBeNull();
  });

  it("keeps each read-budget API within its budget at both boundaries", async () => {
    const { engine, reads } = await setup();
    const targetDetail = { bundle: target, patches: [patch], childCount: 0 };
    const baseDetail = { bundle: base, patches: [], childCount: 1 };
    const budgets: {
      api: string;
      read: () => Promise<unknown>;
      result: unknown;
      adapter: ReadMeasurement<unknown>["adapter"];
      engine: ReadMeasurement<unknown>["engine"];
    }[] = [
      {
        api: "bundle list page: limit rows + one byBundle query per bundle with patches",
        read: () =>
          reads.listBundles({ platform: "ios", order: "desc", limit: 10 }),
        result: [targetDetail, baseDetail],
        adapter: { gets: 0, keys: 0, queries: 2, rows: 3 },
        engine: { calls: 2, rows: 3 },
      },
      {
        api: "bundle total: one counter row",
        read: () => reads.countBundles("ios"),
        result: 2,
        adapter: { gets: 0, keys: 0, queries: 1, rows: 1 },
        engine: { calls: 1, rows: 1 },
      },
      {
        api: "bundle children: nothing extra, the count is on the row",
        read: () => reads.getBundle(base.id),
        result: baseDetail,
        adapter: { gets: 1, keys: 1, queries: 0, rows: 0 },
        engine: { calls: 1, rows: 1 },
      },
      {
        api: "release list: limit rows from one index",
        read: () =>
          reads.listReleases({
            filter: {
              kind: "channelPlatform",
              channelId: channel.id,
              platform: "ios",
              enabled: true,
            },
            limit: 10,
          }),
        result: [release],
        adapter: { gets: 0, keys: 0, queries: 1, rows: 1 },
        engine: { calls: 1, rows: 1 },
      },
      {
        api: "deploy latest release id: byScope descending, limit 1",
        read: () => reads.latestReleaseId(scopeKey),
        result: release.id,
        adapter: { gets: 0, keys: 0, queries: 1, rows: 1 },
        engine: { calls: 1, rows: 1 },
      },
      {
        api: "channel by name: one read",
        read: () => reads.findChannelByName("production"),
        result: channel,
        adapter: { gets: 0, keys: 0, queries: 1, rows: 1 },
        engine: { calls: 1, rows: 1 },
      },
    ];
    for (const budget of budgets) {
      const measured = await engine.measureReads(budget.read);
      expect({ api: budget.api, ...measured }, budget.api).toEqual({
        api: budget.api,
        result: budget.result,
        adapter: budget.adapter,
        engine: budget.engine,
      });
    }
  });

  it("reads bundles, releases, catalogs, and channels through their indexes", async () => {
    const { reads } = await setup();
    await expect(reads.getBundle(target.id)).resolves.toEqual({
      bundle: target,
      patches: [patch],
      childCount: 0,
    });
    await expect(reads.getBundle(fixtureMissingId)).resolves.toBeNull();
    await expect(
      reads.listPatchesFromBase(base.id, { limit: 10 }),
    ).resolves.toEqual([patch]);
    await expect(reads.countBundles()).resolves.toBe(2);
    await expect(reads.countBundles("android")).resolves.toBe(0);
    await expect(
      reads.listBundles({ order: "asc", after: base.id, limit: 10 }),
    ).resolves.toEqual([{ bundle: target, patches: [patch], childCount: 0 }]);

    for (const filter of [
      { kind: "all" },
      { kind: "bundle", bundleId: target.id },
      { kind: "scope", scopeKey },
      { kind: "channelPlatform", channelId: channel.id, platform: "ios" },
    ] as const) {
      await expect(reads.listReleases({ filter, limit: 10 })).resolves.toEqual([
        release,
      ]);
    }
    await expect(
      reads.listReleases({
        filter: { kind: "scope", scopeKey },
        after: release.id,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(reads.getRelease(release.id)).resolves.toEqual(release);
    await expect(reads.getReleaseCatalogRow(scopeKey)).resolves.toMatchObject({
      generation: 1,
    });
    await expect(
      reads.listReleaseCatalogs({ limit: 10 }),
    ).resolves.toHaveLength(1);
    await expect(reads.listChannels()).resolves.toEqual([channel]);
    await expect(reads.findChannelByName("staging")).resolves.toBeNull();
  });

  it("finds auto-patch bases newest first below the new bundle, and drops a candidate at zero", async () => {
    const { engine, reads } = await setup();
    const key = targetBaseCandidateKey({
      channelId: channel.id,
      platform: "ios",
      fingerprintHash: null,
      appVersion: "1.2.3",
    })!;
    const ids = ["1", "2", "3", "4"].map(
      (n) => `01900000-0000-7000-8000-00000000000${n}`,
    );
    const db = engine.database(coreModule);
    await db.transaction(async (tx) => {
      for (const id of ids.slice(0, 3)) {
        tx.aggregate(
          "base_candidates",
          { candidate_key: key, bundle_id: id },
          { releases: 1 },
        );
      }
      tx.aggregate(
        "base_candidates",
        { candidate_key: `${key}-other`, bundle_id: ids[0]! },
        { releases: 1 },
      );
    });
    const found = await engine.measureReads(() =>
      reads.findBaseBundleIds(key, ids[3]!, 2),
    );
    expect(found.result).toEqual([ids[2], ids[1]]);
    expect(found.adapter).toEqual({ gets: 0, keys: 0, queries: 1, rows: 2 });
    await expect(reads.findBaseBundleIds(key, ids[2]!, 3)).resolves.toEqual([
      ids[1],
      ids[0],
    ]);

    await db.transaction(async (tx) => {
      tx.aggregate(
        "base_candidates",
        { candidate_key: key, bundle_id: ids[1]! },
        { releases: -1 },
      );
    });
    await expect(reads.findBaseBundleIds(key, ids[3]!, 3)).resolves.toEqual([
      ids[2],
      ids[0],
    ]);
  });
});
