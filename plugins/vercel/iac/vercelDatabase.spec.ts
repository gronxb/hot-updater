import { PGlite } from "@electric-sql/pglite";
import { createSqlAdapter, migrateCoreSchema } from "@hot-updater/plugin-core";
import { pgliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import {
  moveBlobStoreReferences,
  referencedBlobStores,
} from "./vercelDatabase";

const PUBLIC = "store_Public1";
const PRIVATE = "store_Private1";
const uri = (store: string, key: string) => `vercel-blob://${store}/${key}`;

/** How many storage URIs name `store`. */
const countBlobStoreReferences = async (db: PGlite, store: string) => {
  const prefix = `vercel-blob://${store}/`;
  let count = 0;
  for (const [table, column] of [
    ["bundles", "manifest_storage_uri"],
    ["bundles", "asset_base_storage_uri"],
    ["bundle_patches", "patch_storage_uri"],
    ["native_builds", "artifact_storage_uri"],
  ]) {
    const exists = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1",
      [table],
    );
    if (exists.rows[0]!.n === 0) continue;
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE left("${column}", length($1)) = $1`,
      [prefix],
    );
    count += rows[0]!.n;
  }
  return count;
};

/** A database this release's init created, with a bundle and a patch in `store`. */
const databaseWith = async (store: string) => {
  const db = new PGlite();
  await migrateCoreSchema(
    createSqlAdapter({ executor: pgliteExecutor(db) }),
    "postgres",
  );
  for (const id of ["b1", "b2"]) {
    await db.query(
      `INSERT INTO "bundles" ("id", "platform", "metadata", "manifest_storage_uri", "manifest_file_hash", "asset_base_storage_uri")
       VALUES ($1, 'ios', '{}', $2, 'hash', $3)`,
      [id, uri(store, `${id}/manifest.json`), uri(store, `${id}/files`)],
    );
  }
  await db.query(
    `INSERT INTO "bundle_patches" ("id", "bundle_id", "base_bundle_id", "base_file_hash", "patch_file_hash", "patch_storage_uri", "byte_size", "order_index")
     VALUES ('b2:b1', 'b2', 'b1', 'base', 'patch', $1, 1, 0)`,
    [uri(store, "b2/patches/b1.bsdiff")],
  );
  return db;
};

const uris = async (db: PGlite) => ({
  bundles: (
    await db.query<{ id: string; m: string; a: string; v: number }>(
      `SELECT "id", "manifest_storage_uri" AS m, "asset_base_storage_uri" AS a, "_v" AS v FROM "bundles" ORDER BY "id"`,
    )
  ).rows,
  patches: (
    await db.query<{ p: string }>(
      `SELECT "patch_storage_uri" AS p FROM "bundle_patches"`,
    )
  ).rows,
});

describe("moving a Blob store's storage URIs", () => {
  it("points every URI that names the public store at the private one, keeping its key", async () => {
    const db = await databaseWith(PUBLIC);
    // A store whose ID starts like the public one's is another store.
    await db.query(
      `INSERT INTO "bundles" ("id", "platform", "metadata", "manifest_storage_uri", "manifest_file_hash", "asset_base_storage_uri")
       VALUES ('other', 'ios', '{}', $1, 'hash', $1)`,
      [uri(`${PUBLIC}2`, "other/manifest.json")],
    );

    expect(await countBlobStoreReferences(db, PUBLIC)).toBe(5);
    expect(await moveBlobStoreReferences(db, PUBLIC, PRIVATE)).toBe(5);

    expect(await uris(db)).toEqual({
      bundles: [
        {
          id: "b1",
          m: uri(PRIVATE, "b1/manifest.json"),
          a: uri(PRIVATE, "b1/files"),
          v: 2,
        },
        {
          id: "b2",
          m: uri(PRIVATE, "b2/manifest.json"),
          a: uri(PRIVATE, "b2/files"),
          v: 2,
        },
        {
          id: "other",
          m: uri(`${PUBLIC}2`, "other/manifest.json"),
          a: uri(`${PUBLIC}2`, "other/manifest.json"),
          v: 0,
        },
      ],
      patches: [{ p: uri(PRIVATE, "b2/patches/b1.bsdiff") }],
    });
    expect(await countBlobStoreReferences(db, PUBLIC)).toBe(0);
    // A rerun moves nothing.
    expect(await moveBlobStoreReferences(db, PUBLIC, PRIVATE)).toBe(0);
  });

  it("moves native build artifacts, and a database of an earlier release without that table", async () => {
    const db = await databaseWith(PUBLIC);
    await db.query(
      `INSERT INTO "native_builds" ("id", "scope_key", "platform", "channel_id", "min_bundle_id", "artifact_kind", "artifact_storage_uri", "byte_size", "created_at_ms", "is_store_build", "is_sandbox")
       VALUES ('n1', 'scope', 'ios', 'channel:production', 'b1', 'ipa', $1, 1, 0, false, false)`,
      [uri(PUBLIC, "native/n1.ipa")],
    );
    expect(await moveBlobStoreReferences(db, PUBLIC, PRIVATE)).toBe(6);
    expect(
      (
        await db.query<{ u: string }>(
          `SELECT "artifact_storage_uri" AS u FROM "native_builds"`,
        )
      ).rows,
    ).toEqual([{ u: uri(PRIVATE, "native/n1.ipa") }]);

    const earlier = await databaseWith(PUBLIC);
    await earlier.exec('DROP TABLE "native_builds"');
    expect(await countBlobStoreReferences(earlier, PUBLIC)).toBe(5);
    expect(await moveBlobStoreReferences(earlier, PUBLIC, PRIVATE)).toBe(5);
  });

  it("copies what a bundle written before the lock needs, then moves it too, while writes wait", async () => {
    const db = await databaseWith(PUBLIC);
    const locks: string[] = [];

    const moved = await moveBlobStoreReferences(
      db,
      PUBLIC,
      PRIVATE,
      async () => {
        locks.push(
          ...(
            await db.query<{ relname: string }>(
              `SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
              WHERE l.mode = 'ExclusiveLock' AND c.relname IN ('bundles', 'bundle_patches', 'native_builds')
              ORDER BY c.relname`,
            )
          ).rows.map(({ relname }) => relname),
        );
        // A deploy's row that committed before the lock: the copy made while
        // locked brings its objects, and the move then takes it.
        await db.query(
          `INSERT INTO "bundles" ("id", "platform", "metadata", "manifest_storage_uri", "manifest_file_hash", "asset_base_storage_uri")
         VALUES ('b3', 'ios', '{}', $1, 'hash', $2)`,
          [uri(PUBLIC, "b3/manifest.json"), uri(PUBLIC, "b3/files")],
        );
      },
    );

    expect(locks).toEqual(["bundle_patches", "bundles", "native_builds"]);
    expect(moved).toBe(7);
    expect(await countBlobStoreReferences(db, PUBLIC)).toBe(0);
  });

  it("moves nothing when the copy made while locked fails", async () => {
    const db = await databaseWith(PUBLIC);

    await expect(
      moveBlobStoreReferences(db, PUBLIC, PRIVATE, async () => {
        throw new Error("copy failed");
      }),
    ).rejects.toThrow("copy failed");

    expect(await countBlobStoreReferences(db, PUBLIC)).toBe(5);
  });

  it("lists the stores the URIs name", async () => {
    const db = await databaseWith(PUBLIC);
    await db.query(`UPDATE "bundle_patches" SET "patch_storage_uri" = $1`, [
      uri(PRIVATE, "b2/patches/b1.bsdiff"),
    ]);
    expect(await referencedBlobStores(db)).toEqual(new Set([PUBLIC, PRIVATE]));
  });

  it("counts nothing on an empty database", async () => {
    expect(await countBlobStoreReferences(new PGlite(), PUBLIC)).toBe(0);
    expect(await referencedBlobStores(new PGlite())).toEqual(new Set());
  });
});
