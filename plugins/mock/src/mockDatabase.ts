import {
  type Bundle,
  type DeviceEvent,
  type DeviceEventFilter,
  type DeviceEventListResult,
  type RolloutStats,
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { minMax, sleep } from "./util/utils";

export interface MockDatabaseConfig {
  latency: { min: number; max: number };
  initialBundles?: Bundle[];
  initialDeviceEvents?: DeviceEvent[];
}

export const mockDatabase = createDatabasePlugin<MockDatabaseConfig>({
  name: "mockDatabase",
  factory: (config) => {
    const bundles: Bundle[] = config.initialBundles ?? [];
    const deviceEvents: DeviceEvent[] = config.initialDeviceEvents ?? [];

    return {
      async getBundleById(bundleId: string) {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles.find((b) => b.id === bundleId) ?? null;
      },

      async getBundles(options) {
        const { where, limit, offset } = options ?? {};
        await sleep(minMax(config.latency.min, config.latency.max));

        const filteredBundles = bundles.filter((b) => {
          if (where?.channel && b.channel !== where.channel) {
            return false;
          }
          if (where?.platform && b.platform !== where.platform) {
            return false;
          }
          return true;
        });

        const total = filteredBundles.length;
        const data = limit
          ? filteredBundles.slice(offset, offset + limit)
          : filteredBundles;
        const pagination = calculatePagination(total, { limit, offset });

        return {
          data,
          pagination,
        };
      },

      async getChannels() {
        await sleep(minMax(config.latency.min, config.latency.max));
        return bundles
          .map((b) => b.channel)
          .filter((c, i, self) => self.indexOf(c) === i);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        await sleep(minMax(config.latency.min, config.latency.max));

        for (const op of changedSets) {
          if (op.operation === "delete") {
            const targetIndex = bundles.findIndex((b) => b.id === op.data.id);
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            bundles.splice(targetIndex, 1);
          } else if (op.operation === "insert") {
            bundles.unshift(op.data);
          } else if (op.operation === "update") {
            const targetIndex = bundles.findIndex((b) => b.id === op.data.id);
            if (targetIndex === -1) {
              throw new Error(`Bundle with id ${op.data.id} not found`);
            }
            Object.assign(bundles[targetIndex], op.data);
          }
        }
      },

      async trackDeviceEvent(event: DeviceEvent): Promise<void> {
        await sleep(minMax(config.latency.min, config.latency.max));
        deviceEvents.unshift({
          ...event,
          id: event.id ?? crypto.randomUUID(),
          createdAt: event.createdAt ?? new Date().toISOString(),
        });
      },

      async getRolloutStats(bundleId: string): Promise<RolloutStats> {
        await sleep(minMax(config.latency.min, config.latency.max));

        const bundleEvents = deviceEvents.filter(
          (e) => e.bundleId === bundleId,
        );
        const deviceMap = new Map<string, DeviceEvent>();

        for (const event of bundleEvents) {
          const existing = deviceMap.get(event.deviceId);
          if (
            !existing ||
            (event.createdAt &&
              existing.createdAt &&
              event.createdAt > existing.createdAt)
          ) {
            deviceMap.set(event.deviceId, event);
          }
        }

        const latestEvents = Array.from(deviceMap.values());
        const totalDevices = latestEvents.length;
        const promotedCount = latestEvents.filter(
          (e) => e.eventType === "PROMOTED",
        ).length;
        const recoveredCount = latestEvents.filter(
          (e) => e.eventType === "RECOVERED",
        ).length;
        const successRate =
          totalDevices > 0 ? (promotedCount / totalDevices) * 100 : 0;

        return {
          totalDevices,
          promotedCount,
          recoveredCount,
          successRate: Number(successRate.toFixed(2)),
        };
      },

      async getDeviceEvents(
        filter?: DeviceEventFilter,
      ): Promise<DeviceEventListResult> {
        await sleep(minMax(config.latency.min, config.latency.max));

        const limit = filter?.limit ?? 50;
        const offset = filter?.offset ?? 0;

        let filtered = [...deviceEvents];

        if (filter?.bundleId) {
          filtered = filtered.filter((e) => e.bundleId === filter.bundleId);
        }
        if (filter?.platform) {
          filtered = filtered.filter((e) => e.platform === filter.platform);
        }
        if (filter?.channel) {
          filtered = filtered.filter((e) => e.channel === filter.channel);
        }
        if (filter?.eventType) {
          filtered = filtered.filter((e) => e.eventType === filter.eventType);
        }

        const total = filtered.length;
        const data = filtered.slice(offset, offset + limit);
        const pagination = calculatePagination(total, { limit, offset });

        return {
          data,
          pagination,
        };
      },
    };
  },
});
