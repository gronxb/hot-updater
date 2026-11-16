import {
  createEngine,
  createEngineDatabase,
  createKvAdapter,
  type HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  createMemoryKeyValueStore,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { checkServerData } from "./doctor/serverData";

const id = (n: number) =>
  `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A database on a key-value store, migrated, and core over it. */
const setup = async () => {
  const store = createMemoryKeyValueStore();
  const database = createEngineDatabase({
    name: "kv",
    adapter: createKvAdapter({ store }),
  });
  await (await database.createMigrator!().migrateToLatest()).execute();
  const { core } = createHotUpdater({
    database,
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  });
  return { store, database, core: core as HotUpdaterCoreApi };
};

/** An app-version release, then fingerprints A and B: three scopes. */
const deployThreeScopes = async (core: HotUpdaterCoreApi) => {
  const scopeKeys: string[] = [];
  for (const [n, fingerprintHash] of [
    [1, null],
    [2, "fingerprint-a"],
    [3, "fingerprint-b"],
  ] as const) {
    const [deployed] = await core.deploy([
      {
        bundle: {
          id: id(n),
          platform: "ios",
          gitCommitHash: null,
          manifestStorageUri: `storage://artifacts/${n}/manifest.json`,
          manifestFileHash: `manifest-hash-${n}`,
          assetBaseStorageUri: "storage://assets",
          metadata: {},
        },
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: fingerprintHash === null ? "1.0.x" : null,
        },
      },
    ]);
    scopeKeys.push(deployed!.release!.scope_key);
  }
  return scopeKeys;
};

const loseCatalogRow = async (
  database: Parameters<typeof createEngine>[0],
  scopeKey: string,
) => {
  await createEngine(database).core.transaction(async (tx) => {
    const row = await tx.findOne("release_catalogs", { scope_key: scopeKey });
    await tx.delete("release_catalogs", row!);
  });
};

describe("doctor's walk of the releases' scopes", () => {
  it("names releases an earlier release's server wrote without the scope index, and finds every scope once db migrate writes it", async () => {
    const { store, database, core } = await setup();
    const [appVersion, fingerprintA] = await deployThreeScopes(core);
    // As a 1.1.x server whose schema fence passed before the migration
    // writes them: releases without `scopes` items.
    const { items } = await store.query({
      pk: "releases#scopes#",
      order: "asc",
      limit: 100,
    });
    await store.write(
      items.map(({ sk }) => ({
        type: "delete" as const,
        key: { pk: "releases#scopes#", sk },
      })),
    );
    await loseCatalogRow(database, fingerprintA!);

    const before = await checkServerData(core);
    expect(before.issues).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "RELEASE_SCOPES_UNINDEXED",
        message: expect.stringContaining(appVersion!),
      }),
    ]);

    // The settings already match, and db migrate still writes the items.
    const migration = await database.createMigrator!().migrateToLatest();
    expect(migration.operations).toEqual([
      {
        type: "custom",
        description: "Write the index items rows lack: releases.scopes",
      },
    ]);
    await migration.execute();
    await expect(
      database.createMigrator!().migrateToLatest(),
    ).resolves.toMatchObject({ operations: [] });

    const after = await checkServerData(core);
    expect(after.issues).toEqual([
      expect.objectContaining({
        code: "RELEASE_CATALOG_IDENTITY_MISSING",
        scopeKey: fingerprintA,
      }),
    ]);
  });

  it("reports no lost catalog for a scope item whose release a 1.1.x server deleted", async () => {
    const { store, database, core } = await setup();
    const [, , fingerprintB] = await deployThreeScopes(core);
    const [release] = await core.listReleases({
      filter: { kind: "scope", scopeKey: fingerprintB! },
      limit: 1,
    });
    const { items } = await store.query({
      pk: "releases#scopes#",
      order: "asc",
      limit: 100,
    });
    const orphan = items.find(({ value }) => value.id === release!.id)!;
    // A 1.1.x server deletes the release and leaves its `scopes` item.
    const { release: disabled } = await core.updateReleasePolicy({
      releaseId: release!.id,
      patch: { enabled: false },
    });
    await core.deleteRelease({
      releaseId: release!.id,
      expectedRevision: disabled!.revision,
    });
    await store.write([
      {
        type: "put",
        key: { pk: "releases#scopes#", sk: orphan.sk },
        value: orphan.value,
      },
    ]);
    await expect(core.listReleaseScopeKeys({ limit: 100 })).resolves.toContain(
      fingerprintB,
    );

    // With its tombstone catalog, the scope is checked as any other.
    const kept = await checkServerData(core);
    expect(kept.issues).toEqual([]);
    expect(
      kept.scopes.find(({ scopeKey }) => scopeKey === fingerprintB)?.state,
    ).toBe("verified");

    // Without it, the scope has no releases, so nothing is missing.
    await loseCatalogRow(database, fingerprintB!);
    const lost = await checkServerData(core);
    expect(lost.issues).toEqual([]);
    expect(lost.scopes.map(({ scopeKey }) => scopeKey)).not.toContain(
      fingerprintB,
    );
  });

  it("checks the catalogued scopes on a server without the walk, and says what it could not look for", async () => {
    const { core } = await setup();
    await deployThreeScopes(core);
    const older: HotUpdaterCoreApi = {
      ...core,
      listReleaseScopeKeys: async () => {
        throw Object.assign(
          new Error(
            "The server at https://example.com/admin has no release scope route (GET /release-scopes answered 404).",
          ),
          { status: 404 },
        );
      },
    };

    const status = await checkServerData(older);

    expect(status.scopes.map(({ state }) => state)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
    expect(status.issues).toEqual([
      {
        type: "warning",
        code: "RELEASE_SCOPES_UNCHECKED",
        message:
          "The server has no release scope route, so doctor checked only the scopes with a catalog row.",
        resolution:
          "Upgrade the server's @hot-updater/server, then rerun doctor.",
      },
    ]);
  });

  it("names a walk that failed otherwise by its error, not as an older server", async () => {
    const { core } = await setup();
    await deployThreeScopes(core);
    const failing: HotUpdaterCoreApi = {
      ...core,
      listReleaseScopeKeys: async () => {
        throw Object.assign(new Error("socket hang up"), { status: 502 });
      },
    };

    const status = await checkServerData(failing);

    expect(status.issues).toEqual([
      expect.objectContaining({
        code: "RELEASE_SCOPES_UNCHECKED",
        message: expect.stringContaining("socket hang up"),
        resolution: "Fix what the message names, then rerun doctor.",
      }),
    ]);
  });
});
