import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { ORMProvider } from "../db/types";
import { drizzleAdapter } from "./drizzle";

const providers = [
  "postgresql",
  "sqlite",
  "mysql",
] as const satisfies readonly ORMProvider[];

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

describe("Drizzle patch commit retries", () => {
  it.each(providers)(
    "upserts an already persisted patch when a %s commit retries",
    async (provider) => {
      // Given
      const bundles = pgTable("bundles", { id: text("id") });
      const bundlePatches = pgTable("bundle_patches", {
        id: text("id"),
        bundle_id: text("bundle_id"),
        base_bundle_id: text("base_bundle_id"),
        order_index: integer("order_index"),
      });
      const bundleEvents = pgTable("bundle_events", { id: text("id") });
      const eventFailure = new Error("event append failed");
      let patchExists = false;
      let eventAttempts = 0;
      const executePatchInsert = vi.fn(async () => {
        if (patchExists) throw new Error("duplicate patch primary key");
        patchExists = true;
      });
      const upsertPatch = vi.fn(async (_args: unknown) => {
        patchExists = true;
      });
      const appendEvent = vi.fn(async (_args?: unknown) => {
        eventAttempts += 1;
        if (eventAttempts === 1) throw eventFailure;
      });
      const openDatabase = vi.fn(async () => ({
        _: {
          fullSchema: {
            bundles,
            bundle_events: bundleEvents,
            bundle_patches: bundlePatches,
          },
        },
        $count: vi.fn(async () => 0),
        delete: vi.fn(),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn(() =>
            table === bundlePatches
              ? {
                  execute: executePatchInsert,
                  onConflictDoUpdate: upsertPatch,
                  onDuplicateKeyUpdate: upsertPatch,
                }
              : {
                  onConflictDoNothing: appendEvent,
                  onDuplicateKeyUpdate: appendEvent,
                },
          ),
        })),
        query: {},
        select: vi.fn(),
        update: vi.fn(),
      }));
      const adapter = drizzleAdapter({
        db: openDatabase,
        provider,
        schema: {
          bundles,
          bundle_events: bundleEvents,
          bundle_patches: bundlePatches,
        },
      });
      if (!adapter.bundleEvents) {
        throw new Error("Drizzle adapter must expose bundle events.");
      }
      await adapter.bundlePatches.insert({
        patch: {
          id: "bundle-1:base-1",
          bundleId: "bundle-1",
          baseBundleId: "base-1",
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "s3://bucket/patch",
          orderIndex: 0,
        },
      });
      await adapter.bundleEvents.append({ event });

      // When
      await expect(adapter.commit()).rejects.toBe(eventFailure);
      await expect(adapter.commit()).resolves.toBeUndefined();

      // Then
      expect(patchExists).toBe(true);
      expect(executePatchInsert).not.toHaveBeenCalled();
      expect(upsertPatch).toHaveBeenCalledTimes(2);
      expect(appendEvent).toHaveBeenCalledTimes(2);
      expect(openDatabase).toHaveBeenCalledOnce();
    },
  );
});
