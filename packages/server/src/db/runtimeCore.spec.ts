import type { Bundle } from "@hot-updater/core";
import type {
  DatabaseBundleEvent,
  DatabaseBundleEventInput,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import type {
  DatabasePluginDeclaration,
  DatabasePluginRuntime,
} from "@hot-updater/plugin-core/internal";
import { createDatabasePlugin } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: ["device-1"],
  patches: [
    {
      baseBundleId: "base-1",
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/patch.zip",
    },
  ],
};

const appReadyEvent = {
  kind: "APP_READY",
  installId: "install-1",
  activeBundleId: baseBundle.id,
  previousActiveBundleId: null,
  crashedBundleId: null,
  platform: "ios",
  channel: "production",
  appVersion: "1.0.0",
  fingerprintHash: null,
  cohort: "730",
  payload: {
    status: "STABLE",
    sdkVersion: "0.31.0",
    defaultChannel: "production",
    isChannelSwitched: false,
  },
} satisfies DatabaseBundleEventInput;

const createMemoryDatabase = (
  options: { readonly withBundleEvents?: boolean } = {},
) => {
  const bundles = new Map<string, DatabaseBundleRecord>();
  const events = new Map<string, DatabaseBundleEvent>();
  const patches = new Map<string, DatabaseBundlePatch>();
  const database = createDatabasePlugin({
    name: "memory-v2",
    connect: () => {
      const connection = {
        bundles: {
          getById: async ({ bundleId }) => bundles.get(bundleId) ?? null,
          findRecords: async () => {
            return Array.from(bundles.values());
          },
          insert: async ({ bundle }) => {
            bundles.set(bundle.id, bundle);
          },
          update: async ({ bundleId, patch }) => {
            const current = bundles.get(bundleId);
            if (current) {
              bundles.set(bundleId, { ...current, ...patch });
            }
          },
          delete: async ({ bundleId }) => {
            bundles.delete(bundleId);
          },
        },
        patches: {
          storage: "embedded",
          findPatches: async () => Array.from(patches.values()),
          getBundlePatches: async ({ bundleId }) =>
            Array.from(patches.values()).filter(
              (patch) => patch.bundleId === bundleId,
            ),
          replaceBundlePatches: async ({ bundleId, patches: nextPatches }) => {
            for (const [patchId, patch] of patches) {
              if (patch.bundleId === bundleId) {
                patches.delete(patchId);
              }
            }
            for (const patch of nextPatches) {
              patches.set(
                patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
                {
                  ...patch,
                  id: patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
                },
              );
            }
          },
        },
      } satisfies DatabasePluginDeclaration;

      if (options.withBundleEvents === false) {
        return connection;
      }

      return {
        ...connection,
        bundleEvents: {
          findEvents: async () => {
            return Array.from(events.values());
          },
          append: async ({ event }) => {
            events.set(event.id, event);
          },
          deleteBeforeId: async ({ beforeId }) => {
            for (const eventId of events.keys()) {
              if (eventId.localeCompare(beforeId) < 0) {
                events.delete(eventId);
              }
            }
          },
        },
      } satisfies DatabasePluginDeclaration;
    },
  })({}) as DatabasePluginRuntime;

  return { bundles, database, events, patches };
};

describe("createRuntimeDatabaseCore", () => {
  it("bridges v2 runtime resources into the public Hot Updater API", async () => {
    const { bundles, database, patches } = createMemoryDatabase();
    const hotUpdater = createHotUpdater({ database });

    await hotUpdater.insertBundle(baseBundle);

    expect(bundles.get(baseBundle.id)).not.toHaveProperty("patches");
    expect(patches.get(`${baseBundle.id}:base-1`)).toMatchObject({
      bundleId: baseBundle.id,
      baseBundleId: "base-1",
    });
    await expect(
      hotUpdater.getBundleById(baseBundle.id),
    ).resolves.toMatchObject({
      id: baseBundle.id,
      patches: baseBundle.patches,
      patchBaseBundleId: "base-1",
    });

    await hotUpdater.updateBundleById(baseBundle.id, {
      patches: [
        {
          baseBundleId: "base-2",
          baseFileHash: "base-hash-2",
          patchFileHash: "patch-hash-2",
          patchStorageUri: "s3://bucket/patch-2.zip",
        },
      ],
    });

    expect(patches.has(`${baseBundle.id}:base-1`)).toBe(false);
    expect(patches.has(`${baseBundle.id}:base-2`)).toBe(true);

    await hotUpdater.deleteBundleById(baseBundle.id);

    expect(bundles.has(baseBundle.id)).toBe(false);
    expect(patches.size).toBe(0);
  });

  it("commits app-ready bundle events when the provider exposes bundleEvents", async () => {
    const { database, events } = createMemoryDatabase();
    const hotUpdater = createHotUpdater({ database });
    const appendBundleEvent = hotUpdater.appendBundleEvent;
    if (!appendBundleEvent) {
      throw new Error("appendBundleEvent is not available");
    }

    await appendBundleEvent(appReadyEvent);

    const persisted = Array.from(events.values());
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject(appReadyEvent);
    expect(persisted[0]?.id).toEqual(expect.any(String));
  });

  it("rejects app-ready bundle events when bundleEvents is omitted", async () => {
    const { database } = createMemoryDatabase({ withBundleEvents: false });
    const hotUpdater = createHotUpdater({ database });
    const appendBundleEvent = hotUpdater.appendBundleEvent;
    if (!appendBundleEvent) {
      throw new Error("appendBundleEvent is not available");
    }

    await expect(appendBundleEvent(appReadyEvent)).rejects.toThrow(
      "Bundle events are not supported by this database provider.",
    );
  });

  it("bridges event retention deletes through the public runtime API", async () => {
    // Given
    const { database, events } = createMemoryDatabase();
    const hotUpdater = createHotUpdater({ database });
    events.set("018f0000-0000-7000-8000-000000000000", {
      ...appReadyEvent,
      id: "018f0000-0000-7000-8000-000000000000",
    });
    events.set("01900000-0000-7000-8000-000000000000", {
      ...appReadyEvent,
      id: "01900000-0000-7000-8000-000000000000",
    });

    // When
    await hotUpdater.deleteBundleEventsBefore({
      beforeId: "01900000-0000-7000-8000-000000000000",
    });

    // Then
    expect(Array.from(events.keys())).toEqual([
      "01900000-0000-7000-8000-000000000000",
    ]);
  });
});
