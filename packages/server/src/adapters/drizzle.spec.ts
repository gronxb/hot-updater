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
});
