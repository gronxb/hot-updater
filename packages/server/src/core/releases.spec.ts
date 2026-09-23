import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  compileReleaseCatalog,
  releaseRowToRelease,
  type BundleRow,
  type ReleaseCatalogScope,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { createDatabaseEngine } from "../database/database";
import { resolveSchema } from "../database/resolveSchema";
import {
  changeReleases,
  commitLegacyChanges,
  coreModule,
  createCoreReads,
  insertChannel,
  rebuildCatalog,
  targetBaseCandidateKey,
  type ReleaseChangeInput,
} from "./index";

const channel = { id: "channel-production", name: "production" };
const channelKey = encodeChannelKey(channel.name);
const scope: ReleaseCatalogScope = {
  channelId: channel.id,
  channelName: channel.name,
  platform: "ios",
  scopeKey: createReleaseCatalogScopeKey({
    channelKey,
    platform: "ios",
    strategy: "APP_VERSION",
  }),
  strategy: "APP_VERSION",
  fingerprintHash: null,
};

const releaseOf = (bundle: BundleRow): Omit<ReleaseRow, "id"> => ({
  revision: 1,
  scope_key: scope.scopeKey,
  channel_id: channel.id,
  platform: "ios",
  kind: "BUNDLE",
  bundle_id: bundle.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

const deploy = (bundle: BundleRow): ReleaseChangeInput => ({
  scope,
  bundle: { row: bundle, patches: [] },
  change: { operation: "insert", row: releaseOf(bundle) },
  updatedAtMs: 10,
});

const setup = async () => {
  const engine = createDatabaseEngine({
    adapter: createMemoryAdapter(),
    schema: resolveSchema([coreModule]),
    verify: true,
  });
  const db = engine.database(coreModule);
  await insertChannel(db, channel);
  return {
    engine,
    db,
    reads: createCoreReads(db, { resolveFileUrl: async () => null }),
  };
};

const baseKey = targetBaseCandidateKey({
  channelId: channel.id,
  platform: "ios",
  fingerprintHash: null,
  appVersion: "1.0.0",
})!;
const NEWEST = "ffffffff-ffff-7fff-bfff-ffffffffffff";

describe("release changes rooted at the catalog", () => {
  it("deploys a bundle with its release and compiles the scope's catalog in one transaction", async () => {
    const { db, reads } = await setup();
    const bundle = createBundleRowFixture("501");
    const patchBase = createBundleRowFixture("500");
    await commitLegacyChanges(db, {
      changes: [{ model: "bundles", operation: "insert", row: patchBase }],
    });
    const patch = createBundlePatchRowFixture("1", bundle.id, patchBase.id);
    const [result] = await changeReleases(db, [
      { ...deploy(bundle), bundle: { row: bundle, patches: [patch] } },
    ]);
    const release = result!.release!;
    expect(release.id > bundle.id).toBe(true);
    const compiled = await compileReleaseCatalog({
      strategy: "APP_VERSION",
      releases: [releaseRowToRelease(release)],
    });
    expect(result!.catalog).toMatchObject({
      scope_key: scope.scopeKey,
      channel_key: channelKey,
      generation: 1,
      payload: compiled.canonicalPayload,
      catalog_hash: compiled.catalogHash,
      is_tombstone: false,
      updated_at_ms: 10,
    });
    await expect(
      reads.getReleaseCatalog({
        strategy: "APP_VERSION",
        platform: "ios",
        channelKey,
        appVersion: "1.0.0",
      }),
    ).resolves.toMatchObject({
      generation: 1,
      releases: [{ releaseId: release.id, bundleId: bundle.id }],
    });
    await expect(reads.getBundle(bundle.id)).resolves.toMatchObject({
      patches: [patch],
    });
    await expect(reads.countBundles("ios")).resolves.toBe(2);
    await expect(reads.findBaseBundleIds(baseKey, NEWEST, 3)).resolves.toEqual([
      bundle.id,
    ]);
  });

  it("updates and deletes a release with the next catalog generation each", async () => {
    const { db, reads } = await setup();
    const bundle = createBundleRowFixture("511");
    const [deployed] = await changeReleases(db, [deploy(bundle)]);
    const id = deployed!.release!.id;

    const [disabled] = await changeReleases(db, [
      {
        scope,
        change: { operation: "update", id, update: { enabled: false } },
        updatedAtMs: 20,
      },
    ]);
    expect(disabled!.release).toMatchObject({ revision: 2, enabled: false });
    expect(disabled!.catalog).toMatchObject({
      generation: 2,
      is_tombstone: true,
      catalog_id: deployed!.catalog.catalog_id,
    });
    await expect(reads.findBaseBundleIds(baseKey, NEWEST, 3)).resolves.toEqual(
      [],
    );

    const [deleted] = await changeReleases(db, [
      { scope, change: { operation: "delete", id }, updatedAtMs: 30 },
    ]);
    expect(deleted).toMatchObject({
      release: null,
      catalog: { generation: 3 },
    });
    await expect(reads.getRelease(id)).resolves.toBeNull();
  });

  it("orders ids after the scope's latest release and refuses one that does not sort after it", async () => {
    const { db } = await setup();
    const first = createBundleRowFixture("521");
    const second = createBundleRowFixture("522");
    const [one] = await changeReleases(db, [deploy(first)]);
    const [two] = await changeReleases(db, [deploy(second)]);
    expect(two!.release!.id > one!.release!.id).toBe(true);

    await expect(
      changeReleases(db, [
        {
          scope,
          change: {
            operation: "insert",
            row: { ...releaseOf(first), id: one!.release!.id },
          },
          updatedAtMs: 40,
        },
      ]),
    ).rejects.toMatchObject({ code: "NON_MONOTONIC_RELEASE_ID" });
  });

  it("refuses a release outside its scope and a scope whose catalog history is missing", async () => {
    const { db } = await setup();
    await expect(
      changeReleases(db, [
        {
          scope,
          change: { operation: "delete", id: NEWEST },
          updatedAtMs: 50,
        },
      ]),
    ).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });

    const bundle = createBundleRowFixture("531");
    await commitLegacyChanges(db, {
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "releases",
          operation: "insert",
          row: { ...releaseOf(bundle), id: NEWEST },
        },
      ],
    });
    await expect(
      changeReleases(db, [deploy(createBundleRowFixture("532"))]),
    ).rejects.toMatchObject({ code: "CATALOG_IDENTITY_MISSING" });
    await expect(rebuildCatalog(db, scope, 60)).rejects.toMatchObject({
      code: "CATALOG_IDENTITY_MISSING",
    });
  });

  it("serializes concurrent deploys in one scope through its catalog row", async () => {
    const { db, reads } = await setup();
    const bundles = Array.from({ length: 8 }, (_, n) =>
      createBundleRowFixture(String(541 + n)),
    );
    const results = await Promise.all(
      bundles.map((bundle) => changeReleases(db, [deploy(bundle)])),
    );
    const generations = results.map(([result]) => result!.catalog.generation);
    expect(generations.toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const byGeneration = results
      .map(([result]) => result!)
      .sort((a, b) => a.catalog.generation - b.catalog.generation);
    const ids = byGeneration.map(({ release }) => release!.id);
    expect(ids).toEqual(ids.toSorted());
    await expect(
      reads.getReleaseCatalogRow(scope.scopeKey),
    ).resolves.toMatchObject({ generation: 8 });
    await expect(
      reads.listReleases({
        filter: { kind: "scope", scopeKey: scope.scopeKey },
        limit: 10,
      }),
    ).resolves.toHaveLength(8);
  });

  it("reads only the scope's enabled releases and its latest id, all of them used", async () => {
    const { engine, db } = await setup();
    const bundles = Array.from({ length: 5 }, (_, n) =>
      createBundleRowFixture(String(551 + n)),
    );
    const deployed: string[] = [];
    for (const bundle of bundles) {
      const [result] = await changeReleases(db, [deploy(bundle)]);
      deployed.push(result!.release!.id);
    }
    for (const id of deployed.slice(0, 2)) {
      await changeReleases(db, [
        {
          scope,
          change: { operation: "update", id, update: { enabled: false } },
          updatedAtMs: 70,
        },
      ]);
    }
    const measured = await engine.measureReads(() =>
      changeReleases(db, [deploy(createBundleRowFixture("556"))]),
    );
    // three enabled releases for the compile, one row for the latest id
    expect(measured.adapter.rows).toBe(4);
    expect(measured.adapter.queries).toBe(2);
  });

  it("rebuilds a catalog only when its releases changed underneath it", async () => {
    const { db } = await setup();
    const [deployed] = await changeReleases(db, [
      deploy(createBundleRowFixture("561")),
    ]);
    await expect(rebuildCatalog(db, scope, 80)).resolves.toMatchObject({
      changed: false,
      catalog: { generation: 1 },
    });
    await commitLegacyChanges(db, {
      changes: [
        {
          model: "releases",
          operation: "update",
          where: { id: deployed!.release!.id },
          update: { message: "hotfix", revision: 2 },
        },
      ],
    });
    await expect(rebuildCatalog(db, scope, 90)).resolves.toMatchObject({
      changed: true,
      catalog: { generation: 2, updated_at_ms: 90 },
    });
  });
});
