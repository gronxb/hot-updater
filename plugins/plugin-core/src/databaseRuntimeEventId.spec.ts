import { describe, expect, it } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";
import type { DatabasePluginResourceDeclaration } from "./databaseConnectionSpec";
import type { DatabaseBundleEvent } from "./types";

describe("database runtime event identity", () => {
  it("preserves a provided event id through commit", async () => {
    // Given
    const eventId = "0195a408-8f13-7d9b-8df4-123456789abc";
    const persistedEvents: DatabaseBundleEvent[] = [];
    const connection: DatabasePluginResourceDeclaration = {
      bundles: {
        getById: async () => null,
        findRecords: async () => [],
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      patches: {
        storage: "embedded",
        findPatches: async () => [],
        getBundlePatches: async () => [],
        replaceBundlePatches: async () => undefined,
      },
      bundleEvents: {
        findEvents: async () => persistedEvents,
        append: async ({ event }) => {
          persistedEvents.push(event);
        },
      },
    };
    const runtime = createDatabasePlugin({
      name: "event-id",
      connect: () => connection,
    })({});

    // When
    await runtime.bundleEvents?.append({
      event: {
        id: eventId,
        kind: "APP_READY",
        installId: "install-id",
        activeBundleId: "bundle-id",
        platform: "ios",
        channel: "production",
        payload: {
          status: "STABLE",
          sdkVersion: "0.0.0",
          defaultChannel: "production",
          isChannelSwitched: false,
        },
      },
    });
    await runtime.commit();

    // Then
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]?.id).toBe(eventId);
  });

  it("delegates event retention deletes directly to the provider resource", async () => {
    // Given
    const deletedBeforeIds: string[] = [];
    const beforeId = "0195a408-8f13-7000-8000-000000000000";
    const connection: DatabasePluginResourceDeclaration = {
      bundles: {
        getById: async () => null,
        findRecords: async () => [],
        insert: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      patches: {
        storage: "embedded",
        findPatches: async () => [],
        getBundlePatches: async () => [],
        replaceBundlePatches: async () => undefined,
      },
      bundleEvents: {
        findEvents: async () => [],
        append: async () => undefined,
        deleteBeforeId: async ({ beforeId: value }) => {
          deletedBeforeIds.push(value);
        },
      },
    };
    const runtime = createDatabasePlugin({
      name: "event-retention",
      connect: () => connection,
    })({});

    // When
    await runtime.bundleEvents?.deleteBeforeId?.({ beforeId });

    // Then
    expect(deletedBeforeIds).toEqual([beforeId]);
  });
});
