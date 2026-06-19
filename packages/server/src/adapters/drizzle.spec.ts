import { describe, expect, it, vi } from "vitest";

import { createNodeHotUpdater as createHotUpdater } from "../db";
import { drizzleAdapter } from "./drizzle";

describe("drizzleAdapter", () => {
  it("generates schema without resolving a lazy runtime database", () => {
    const getDB = vi.fn(() => {
      throw new Error("runtime database should not be opened");
    });

    const hotUpdater = createHotUpdater({
      database: drizzleAdapter({
        db: getDB,
        provider: "postgresql",
      }),
    });

    const schema = hotUpdater.generateSchema("latest");

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
          findMany: vi.fn(async () => [{ channel: "production" }]),
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
    })();

    expect(getDB).not.toHaveBeenCalled();

    await expect(plugin.getChannels()).resolves.toEqual(["production"]);
    expect(getDB).toHaveBeenCalledOnce();
  });

  it("requires schema for lazy runtime database configs", async () => {
    const getDB = vi.fn(() => {
      throw new Error("runtime database should not be opened");
    });

    const plugin = drizzleAdapter({
      db: getDB,
      provider: "postgresql",
    })();

    await expect(plugin.getChannels()).rejects.toThrow(
      "[hot-updater] Drizzle adapter requires schema when db is lazy.",
    );
    expect(getDB).not.toHaveBeenCalled();
  });
});
