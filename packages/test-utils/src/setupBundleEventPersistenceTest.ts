import { expect, it } from "vitest";

const retainedEventId = "0195a408-8f13-7d9b-8df4-123456789abc";
const expiredEventId = "0195a408-8f12-7000-8000-000000000000";

const event = {
  id: retainedEventId,
  kind: "APP_READY",
  installId: "integration-install",
  activeBundleId: "0195a408-8f10-7000-8000-000000000000",
  platform: "ios",
  channel: "production",
  payload: {
    status: "STABLE",
    sdkVersion: "1.0.0",
    defaultChannel: "production",
    isChannelSwitched: false,
  },
} as const;

type AppReadyEvent = Omit<typeof event, "id"> & { readonly id: string };

interface EventPersistenceRuntime {
  readonly bundleEvents?: {
    readonly append: (params: {
      readonly event: AppReadyEvent;
    }) => Promise<void>;
    readonly deleteBeforeId?: (params: {
      readonly beforeId: string;
    }) => Promise<void>;
    readonly list: (params: {
      readonly limit: number;
      readonly orderBy: {
        readonly field: "id";
        readonly direction: "asc";
      };
    }) => Promise<{
      readonly data: readonly {
        readonly id: string;
        readonly payload: unknown;
      }[];
    }>;
  };
  readonly commit: () => Promise<void>;
}

export const setupBundleEventPersistenceTest = ({
  countEventRows,
  countEventRowsById,
  getRuntime,
}: {
  readonly countEventRows: () => Promise<number>;
  readonly countEventRowsById: (id: string) => Promise<number>;
  readonly getRuntime: () => EventPersistenceRuntime;
}) => {
  it("persists idempotent bundle events and applies retention", async () => {
    const runtime = getRuntime();
    const bundleEvents = runtime.bundleEvents;
    if (!bundleEvents?.deleteBeforeId) {
      throw new Error("The database adapter must expose event retention.");
    }

    await bundleEvents.append({
      event: { ...event, id: expiredEventId },
    });
    await bundleEvents.append({ event });
    await bundleEvents.append({ event });
    await runtime.commit();

    const persisted = await bundleEvents.list({
      limit: 10,
      orderBy: { field: "id", direction: "asc" },
    });
    expect(await countEventRowsById(retainedEventId)).toBe(1);
    expect(await countEventRows()).toBe(2);
    expect(persisted.data).toHaveLength(2);
    expect(
      persisted.data.find(({ id }) => id === retainedEventId)?.payload,
    ).toEqual(event.payload);

    await bundleEvents.deleteBeforeId({ beforeId: retainedEventId });

    const retained = await bundleEvents.list({
      limit: 10,
      orderBy: { field: "id", direction: "asc" },
    });
    expect(await countEventRows()).toBe(1);
    expect(retained.data.map(({ id }) => id)).toEqual([retainedEventId]);
  });
};
