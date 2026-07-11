import { PGlite } from "@electric-sql/pglite";
import type {
  BundleListQuery,
  BundlePatchListQuery,
} from "@hot-updater/plugin-core";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it, vi } from "vitest";

import { drizzleAdapter } from "./drizzle";
import { type HotUpdaterKyselyDatabase, kyselyAdapter } from "./kysely";
import { prismaAdapter } from "./prisma";

const emptyBundleQuery: BundleListQuery = {
  limit: 2,
  cursor: { after: "offset:0" },
  where: { id: { in: [] } },
};

const emptyPatchQuery: BundlePatchListQuery = {
  limit: 2,
  cursor: { after: "offset:0" },
  where: { bundleIdIn: [] },
};

describe("official ORM empty IN queries", () => {
  it("short-circuits Kysely without executing SQL", async () => {
    // Given
    const queries: string[] = [];
    const pglite = new PGlite();
    const db = new Kysely<HotUpdaterKyselyDatabase>({
      dialect: new PGliteDialect(pglite),
      log(event) {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
    const adapter = kyselyAdapter({ db, provider: "postgresql" });

    // When
    const [bundles, patches] = await Promise.all([
      adapter.bundles.list(emptyBundleQuery),
      adapter.bundlePatches.list(emptyPatchQuery),
    ]);

    // Then
    expect(bundles.data).toEqual([]);
    expect(patches.data).toEqual([]);
    expect(queries).toEqual([]);
    await db.destroy();
    await pglite.close();
  });

  it("short-circuits Drizzle without invoking query or count", async () => {
    // Given
    const bundles = pgTable("bundles", { id: text("id") });
    const bundlePatches = pgTable("bundle_patches", { id: text("id") });
    const bundleEvents = pgTable("bundle_events", { id: text("id") });
    const bundleFindMany = vi.fn(async () => []);
    const patchFindMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const adapter = drizzleAdapter({
      db: {
        _: {
          fullSchema: {
            bundles,
            bundle_events: bundleEvents,
            bundle_patches: bundlePatches,
          },
        },
        $count: count,
        delete: vi.fn(),
        insert: vi.fn(),
        query: {
          bundle_patches: { findMany: patchFindMany },
          bundles: { findMany: bundleFindMany },
        },
        select: vi.fn(),
        update: vi.fn(),
      },
      provider: "postgresql",
    });

    // When
    const [bundlePage, patchPage] = await Promise.all([
      adapter.bundles.list(emptyBundleQuery),
      adapter.bundlePatches.list(emptyPatchQuery),
    ]);

    // Then
    expect(bundlePage.data).toEqual([]);
    expect(patchPage.data).toEqual([]);
    expect(bundleFindMany).not.toHaveBeenCalled();
    expect(patchFindMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("short-circuits Prisma without invoking query or count", async () => {
    // Given
    const bundleFindMany = vi.fn(async () => []);
    const bundleCount = vi.fn(async () => 0);
    const patchFindMany = vi.fn(async () => []);
    const patchCount = vi.fn(async () => 0);
    const adapter = prismaAdapter({
      prisma: {
        bundles: { count: bundleCount, findMany: bundleFindMany },
        bundle_patches: { count: patchCount, findMany: patchFindMany },
      },
      provider: "postgresql",
    });

    // When
    const [bundlePage, patchPage] = await Promise.all([
      adapter.bundles.list(emptyBundleQuery),
      adapter.bundlePatches.list(emptyPatchQuery),
    ]);

    // Then
    expect(bundlePage.data).toEqual([]);
    expect(patchPage.data).toEqual([]);
    expect(bundleFindMany).not.toHaveBeenCalled();
    expect(bundleCount).not.toHaveBeenCalled();
    expect(patchFindMany).not.toHaveBeenCalled();
    expect(patchCount).not.toHaveBeenCalled();
  });
});
