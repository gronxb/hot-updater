import type { SQL } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { generateSchema } from "../db";
import { createHotUpdater } from "../index";
import {
  createDrizzleDatabase,
  drizzleAdapter,
  drizzleDatabase,
} from "./drizzle";

describe("drizzleAdapter", () => {
  it("exposes Drizzle as the official database middle layer with the old alias", () => {
    expect(drizzleDatabase).toBe(createDrizzleDatabase);
    expect(drizzleAdapter).toBe(drizzleDatabase);
  });

  it("generates schema without resolving a lazy runtime database", () => {
    const getDB = vi.fn(() => {
      throw new Error("runtime database should not be opened");
    });

    const hotUpdater = createHotUpdater({
      database: drizzleAdapter({
        db: getDB,
        provider: "postgresql",
        schema: { bundle_patches: {}, bundles: {} },
      }),
    });

    const schema = generateSchema(hotUpdater, "latest");

    expect(schema.path).toBe("hot-updater-schema.ts");
    expect(schema.code).toContain("pgTable");
    expect(getDB).not.toHaveBeenCalled();
  });

  it("resolves a lazy runtime database only when a database operation runs", async () => {
    const bundles = { channel: "channel" };
    const bundlePatches = { bundle_id: "bundle_id" };
    const db = {
      _: { fullSchema: { bundle_patches: bundlePatches, bundles } },
      $count: vi.fn(),
      delete: vi.fn(),
      insert: vi.fn(),
      query: {
        bundle_patches: {
          findMany: vi.fn(),
        },
        bundles: {
          findFirst: vi.fn(),
          findMany: vi.fn(async () => [
            {
              id: "bundle-1",
              channel: "production",
              enabled: true,
              should_force_update: false,
              file_hash: "file-hash",
              git_commit_hash: null,
              message: null,
              platform: "ios",
              storage_uri: "s3://bucket/bundle.zip",
              target_app_version: null,
              fingerprint_hash: null,
            },
          ]),
        },
      },
      select: vi.fn(),
      update: vi.fn(),
    };
    const getDB = vi.fn(async () => db);

    const plugin = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
      schema: { bundle_patches: bundlePatches, bundles },
    });

    expect(getDB).not.toHaveBeenCalled();

    await expect(plugin.bundles.list({ limit: 10 })).resolves.toMatchObject({
      data: expect.any(Array),
    });
    expect(getDB).toHaveBeenCalledOnce();
  });

  it("requires schema for lazy runtime database configs", async () => {
    const getDB = vi.fn(() => {
      throw new Error("runtime database should not be opened");
    });

    expect(() =>
      drizzleAdapter({
        db: getDB,
        provider: "postgresql",
      }),
    ).toThrow("[hot-updater] Drizzle adapter requires schema when db is lazy.");
    expect(getDB).not.toHaveBeenCalled();
  });

  it("pushes filtered bundle, patch, and event windows into Drizzle", async () => {
    // Given
    const bundles = pgTable("bundles", {
      id: text("id"),
      channel: text("channel"),
      platform: text("platform"),
      enabled: boolean("enabled"),
      target_app_version: text("target_app_version"),
      fingerprint_hash: text("fingerprint_hash"),
    });
    const bundlePatches = pgTable("bundle_patches", {
      id: text("id"),
      bundle_id: text("bundle_id"),
      base_bundle_id: text("base_bundle_id"),
      order_index: integer("order_index"),
    });
    const bundleEvents = pgTable("bundle_events", {
      id: text("id"),
      kind: text("kind"),
      install_id: text("install_id"),
    });
    const bundleFindMany = vi.fn(async () => []);
    const patchFindMany = vi.fn(
      async (_query?: { readonly orderBy?: readonly SQL[] }) => [],
    );
    const eventFindMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const db = {
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
        bundle_events: { findMany: eventFindMany },
        bundle_patches: { findMany: patchFindMany },
        bundles: { findMany: bundleFindMany },
      },
      select: vi.fn(),
      update: vi.fn(),
    };
    const adapter = drizzleAdapter({
      db,
      provider: "postgresql",
      schema: {
        bundles,
        bundle_events: bundleEvents,
        bundle_patches: bundlePatches,
      },
    });
    if (!adapter.bundleEvents) {
      throw new Error("Drizzle adapter must expose bundle events.");
    }

    // When
    await adapter.bundles.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "id", direction: "asc" },
      where: { channel: "production" },
    });
    await adapter.bundlePatches.list({
      limit: 2,
      cursor: { after: "offset:0" },
      where: { bundleId: "" },
    });
    await adapter.bundlePatches.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "orderIndex", direction: "desc" },
      where: { bundleId: "" },
    });
    await adapter.bundleEvents.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "id", direction: "asc" },
      where: { installId: "" },
    });

    // Then
    for (const findMany of [bundleFindMany, eventFindMany]) {
      expect(findMany).toHaveBeenCalledOnce();
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 2,
          offset: 1,
          orderBy: expect.any(Array),
          where: expect.anything(),
        }),
      );
    }
    expect(patchFindMany).toHaveBeenCalledTimes(2);
    expect(count).toHaveBeenCalledTimes(4);
    expect(count).toHaveBeenNthCalledWith(1, bundles, expect.anything());
    expect(count).toHaveBeenNthCalledWith(2, bundlePatches, expect.anything());
    expect(count).toHaveBeenNthCalledWith(3, bundlePatches, expect.anything());
    expect(count).toHaveBeenNthCalledWith(4, bundleEvents, expect.anything());
    const defaultOrder = patchFindMany.mock.calls[0]?.[0]?.orderBy;
    const descendingOrder = patchFindMany.mock.calls[1]?.[0]?.orderBy;
    if (!defaultOrder || !descendingOrder) {
      throw new Error("Patch queries must include stable order clauses.");
    }
    const dialect = new PgDialect();
    expect(defaultOrder.map((order) => dialect.sqlToQuery(order).sql)).toEqual([
      '"bundle_patches"."order_index" asc',
      '"bundle_patches"."id" asc',
    ]);
    expect(
      descendingOrder.map((order) => dialect.sqlToQuery(order).sql),
    ).toEqual([
      '"bundle_patches"."order_index" desc',
      '"bundle_patches"."id" desc',
    ]);
  });
});
