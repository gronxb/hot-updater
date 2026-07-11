import { pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { drizzleAdapter } from "./drizzle";
import { prismaAdapter } from "./prisma";

const event = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  kind: "APP_READY",
  installId: "install-1",
  activeBundleId: "bundle-1",
  platform: "ios",
  channel: "production",
  payload: {
    status: "STABLE",
    sdkVersion: "1.0.0",
    defaultChannel: "production",
    isChannelSwitched: false,
  },
} as const;

describe("official ORM event persistence", () => {
  it("uses Drizzle conflict handling and retention deletion", async () => {
    // Given
    const bundles = pgTable("bundles", { id: text("id") });
    const bundlePatches = pgTable("bundle_patches", { id: text("id") });
    const bundleEvents = pgTable("bundle_events", { id: text("id") });
    const onConflictDoNothing = vi.fn(async () => undefined);
    const deleteWhere = vi.fn(async () => undefined);
    const adapter = drizzleAdapter({
      db: {
        _: {
          fullSchema: {
            bundles,
            bundle_events: bundleEvents,
            bundle_patches: bundlePatches,
          },
        },
        $count: vi.fn(async () => 0),
        delete: vi.fn(() => ({ where: deleteWhere })),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({ onConflictDoNothing })),
        })),
        query: {},
        select: vi.fn(),
        update: vi.fn(),
      },
      provider: "postgresql",
    });
    if (!adapter.bundleEvents?.deleteBeforeId) {
      throw new Error("Drizzle adapter must expose event retention.");
    }

    // When
    await adapter.bundleEvents.append({ event });
    await adapter.bundleEvents.append({ event });
    await adapter.commit();
    await adapter.bundleEvents.deleteBeforeId({ beforeId: event.id });

    // Then
    expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
    expect(deleteWhere).toHaveBeenCalledOnce();
  });

  it("uses Prisma upsert and retention deletion", async () => {
    // Given
    const upsert = vi.fn(async () => undefined);
    const deleteMany = vi.fn(async () => undefined);
    const adapter = prismaAdapter({
      prisma: {
        bundle_events: { deleteMany, upsert },
      },
      provider: "postgresql",
    });
    if (!adapter.bundleEvents?.deleteBeforeId) {
      throw new Error("Prisma adapter must expose event retention.");
    }

    // When
    await adapter.bundleEvents.append({ event });
    await adapter.bundleEvents.append({ event });
    await adapter.commit();
    await adapter.bundleEvents.deleteBeforeId({ beforeId: event.id });

    // Then
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      where: { id: event.id },
      create: expect.objectContaining({ id: event.id }),
      update: {},
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { lt: event.id } },
    });
  });
});
