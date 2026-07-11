import { describe, expect, it, vi } from "vitest";

import { createPrismaDatabase, prismaAdapter, prismaDatabase } from "./prisma";

describe("prismaAdapter", () => {
  it("exposes Prisma as the official database middle layer with the old alias", () => {
    expect(prismaDatabase).toBe(createPrismaDatabase);
    expect(prismaAdapter).toBe(prismaDatabase);
  });

  it("exposes Prisma as the middle layer and provider as the database layer", () => {
    const adapter = prismaDatabase({
      prisma: {},
      provider: "postgresql",
    });

    expect(adapter.adapterName).toBe("prisma");
    expect(adapter.provider).toBe("postgresql");

    if (!adapter.generateSchema) {
      throw new Error("Prisma adapter must provide schema generation.");
    }

    const schema = adapter.generateSchema("latest");

    expect(schema.path).toBe("./prisma/schema/hot_updater.prisma");
    expect(schema.code).toContain("model bundles");
    expect(schema.code).toContain("@db.Uuid");
  });

  it("pushes filtered bundle, patch, and event windows into Prisma", async () => {
    // Given
    const bundles = {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    };
    const bundlePatches = {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    };
    const bundleEvents = {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    };
    const adapter = prismaAdapter({
      prisma: {
        bundles,
        bundle_events: bundleEvents,
        bundle_patches: bundlePatches,
      },
      provider: "postgresql",
    });
    if (!adapter.bundleEvents) {
      throw new Error("Prisma adapter must expose bundle events.");
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
      orderBy: { field: "orderIndex", direction: "desc" },
      where: { bundleId: "bundle-1" },
    });
    await adapter.bundleEvents.list({
      limit: 2,
      cursor: { after: "offset:0" },
      orderBy: { field: "id", direction: "asc" },
      where: { installId: "install-1" },
    });

    // Then
    expect(bundles.findMany).toHaveBeenCalledOnce();
    expect(bundles.findMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
      skip: 1,
      take: 2,
      where: { channel: "production" },
    });
    expect(bundlePatches.findMany).toHaveBeenCalledOnce();
    expect(bundlePatches.findMany).toHaveBeenCalledWith({
      orderBy: [{ order_index: "desc" }, { id: "desc" }],
      skip: 1,
      take: 2,
      where: { bundle_id: "bundle-1" },
    });
    expect(bundleEvents.findMany).toHaveBeenCalledOnce();
    expect(bundleEvents.findMany).toHaveBeenCalledWith({
      orderBy: { id: "asc" },
      skip: 1,
      take: 2,
      where: { install_id: "install-1" },
    });
    expect(bundles.count).toHaveBeenCalledWith({
      where: { channel: "production" },
    });
    expect(bundlePatches.count).toHaveBeenCalledWith({
      where: { bundle_id: "bundle-1" },
    });
    expect(bundleEvents.count).toHaveBeenCalledWith({
      where: { install_id: "install-1" },
    });
  });

  it("combines equality, set, and nullability filters with AND semantics", async () => {
    // Given
    const bundles = {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    };
    const bundlePatches = {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    };
    const adapter = prismaAdapter({
      prisma: { bundles, bundle_patches: bundlePatches },
      provider: "postgresql",
    });

    // When
    await adapter.bundles.list({
      limit: 1,
      cursor: { after: "offset:0" },
      where: {
        targetAppVersion: "1.0.0",
        targetAppVersionIn: ["1.0.0", "2.0.0"],
        targetAppVersionNotNull: true,
      },
    });
    await adapter.bundlePatches.list({
      limit: 1,
      cursor: { after: "offset:0" },
      where: {
        id: "patch-1",
        idIn: ["patch-1", "patch-2"],
        bundleId: "bundle-1",
        bundleIdIn: ["bundle-1", "bundle-2"],
        baseBundleId: "base-1",
        baseBundleIdIn: ["base-1", "base-2"],
      },
    });

    // Then
    const bundleWhere = {
      target_app_version: {
        equals: "1.0.0",
        in: ["1.0.0", "2.0.0"],
        not: null,
      },
    };
    const patchWhere = {
      id: { equals: "patch-1", in: ["patch-1", "patch-2"] },
      bundle_id: {
        equals: "bundle-1",
        in: ["bundle-1", "bundle-2"],
      },
      base_bundle_id: {
        equals: "base-1",
        in: ["base-1", "base-2"],
      },
    };
    expect(bundles.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: bundleWhere }),
    );
    expect(bundles.count).toHaveBeenCalledWith({ where: bundleWhere });
    expect(bundlePatches.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: patchWhere }),
    );
    expect(bundlePatches.count).toHaveBeenCalledWith({ where: patchWhere });
  });
});
