import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { type HotUpdaterKyselyDatabase, kyselyAdapter } from "./kysely";

describe("patch pagination", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<HotUpdaterKyselyDatabase>[] = [];

  afterEach(async () => {
    for (const kysely of kyselyInstances.splice(0)) await kysely.destroy();
    for (const database of databases.splice(0)) await database.close();
  });

  it("uses the patch id as a stable tie-breaker across Kysely pages", async () => {
    // Given
    const queries: string[] = [];
    const database = new PGlite();
    databases.push(database);
    const kysely = new Kysely<HotUpdaterKyselyDatabase>({
      dialect: new PGliteDialect(database),
      log(event) {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
    kyselyInstances.push(kysely);
    await database.exec(`
      create table bundle_patches (
        id text primary key,
        bundle_id text not null,
        base_bundle_id text not null,
        base_file_hash text not null,
        patch_file_hash text not null,
        patch_storage_uri text not null,
        order_index integer not null
      );
      insert into bundle_patches values
        ('bundle-1:base-c', 'bundle-1', 'base-c', 'base-hash', 'patch-hash', 'file:c', 0),
        ('bundle-1:base-a', 'bundle-1', 'base-a', 'base-hash', 'patch-hash', 'file:a', 0),
        ('bundle-1:base-b', 'bundle-1', 'base-b', 'base-hash', 'patch-hash', 'file:b', 0);
    `);
    const adapter = kyselyAdapter({ db: kysely, provider: "postgresql" });

    // When
    const firstPage = await adapter.bundlePatches.list({
      limit: 2,
      orderBy: { field: "orderIndex", direction: "asc" },
    });
    const secondPage = await adapter.bundlePatches.list({
      limit: 2,
      cursor: { after: firstPage.pagination.nextCursor ?? undefined },
      orderBy: { field: "orderIndex", direction: "asc" },
    });

    // Then
    expect(firstPage.data.map((patch) => patch.id)).toEqual([
      "bundle-1:base-a",
      "bundle-1:base-b",
    ]);
    expect(secondPage.data.map((patch) => patch.id)).toEqual([
      "bundle-1:base-c",
    ]);
    expect(
      queries.filter((query) => query.includes('from "bundle_patches"')),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /order by "order_index" asc, "id" asc limit .* offset/,
        ),
      ]),
    );
  });
});
