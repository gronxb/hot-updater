import {
  createDatabasePlugin,
  compareInsightsText,
  type BundleEventRow,
  MAX_BUNDLE_PATCHES,
} from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

import { matchesMockDatabaseWhere } from "./mockDatabaseQuery";
import {
  cloneMockDatabaseData,
  createMockDatabaseData,
  createMockDatabaseState,
  type MockDatabaseData,
  replaceMockDatabaseData,
} from "./mockDatabaseState";
import { minMax, sleep } from "./util/utils";

export type { MockDatabaseData } from "./mockDatabaseState";
export { createMockDatabaseData } from "./mockDatabaseState";

export interface MockDatabaseConfig {
  readonly latency: { readonly min: number; readonly max: number };
  readonly data?: MockDatabaseData;
}

export const mockDatabase = (config: MockDatabaseConfig) => {
  const implementation: DatabasePluginImplementation = (() => {
    const data = config.data ?? createMockDatabaseData();
    const state = createMockDatabaseState(data);
    let operationQueue: Promise<void> = Promise.resolve();

    const waitForLatency = (): Promise<void> =>
      sleep(minMax(config.latency.min, config.latency.max));

    const mutate = <TResult>(
      operation: () => Promise<TResult>,
    ): Promise<TResult> => {
      const result = operationQueue.then(async () => {
        await waitForLatency();
        return operation();
      });
      operationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const read = <TResult>(
      operation: () => Promise<TResult>,
    ): Promise<TResult> => mutate(operation);

    return {
      create: (input) => mutate(() => state.create(input)),
      update: (input) => mutate(() => state.update(input)),
      delete: (input) => mutate(() => state.delete(input)),
      count: (input) => read(() => state.count(input)),
      findOne: (input) => read(() => state.findOne(input)),
      findMany: (input) => read(() => state.findMany(input)),
      recordInsights: ({ event }) =>
        mutate(async () => {
          if (!data.bundleEvents.has(event.id))
            data.bundleEvents.set(event.id, structuredClone(event));
        }),
      findLatestInsightsEvents: (input) =>
        read(async () => {
          const rows = latestEvents(data.bundleEvents.values()).filter((row) =>
            matchesMockDatabaseWhere<"bundle_events">(
              row,
              latestInsightsWhere(input),
            ),
          );
          return rows
            .sort((a, b) => compareInsightsText(a.install_id, b.install_id))
            .slice(0, "installId" in input ? 1 : input.limit);
        }),
      countLatestInsightsEvents: (input) =>
        read(
          async () =>
            latestEvents(data.bundleEvents.values()).filter((row) =>
              latestInsightsCountGroups(input).some((where) =>
                matchesMockDatabaseWhere<"bundle_events">(row, where),
              ),
            ).length,
        ),
      insertChannel: (input) =>
        mutate(async () => {
          const existing = [...data.channels.values()].find(
            ({ name }) => name === input.row.name,
          );
          if (existing) return { row: existing, inserted: false };
          await state.create({ model: "channels", data: input.row });
          return { row: input.row, inserted: true };
        }),
      deleteChannel: ({ id }) =>
        mutate(async () => {
          if (!data.channels.has(id)) {
            return { deleted: false, reason: "not_found" };
          }
          if (
            [...data.releases.values()].some((row) => row.channel_id === id)
          ) {
            return { deleted: false, reason: "not_empty" };
          }
          data.channels.delete(id);
          return { deleted: true };
        }),
      publishBundlePatch: (input) =>
        mutate(async () => {
          if (input.row.bundle_id === input.row.base_bundle_id) {
            throw new Error(
              "A bundle patch cannot reference its owner as base",
            );
          }
          if (
            !data.bundles.has(input.row.bundle_id) ||
            !data.bundles.has(input.row.base_bundle_id)
          ) {
            return { published: false as const, reason: "not_found" as const };
          }
          const existing = [...data.bundlePatches.values()]
            .filter(({ bundle_id }) => bundle_id === input.row.bundle_id)
            .sort(
              (left, right) =>
                left.order_index - right.order_index ||
                left.id.localeCompare(right.id),
            );
          const previous =
            existing.find(({ id }) => id === input.row.id) ?? null;
          if (previous === null && existing.length >= MAX_BUNDLE_PATCHES) {
            return {
              published: false as const,
              reason: "limit_exceeded" as const,
            };
          }
          const remaining = existing.filter(({ id }) => id !== input.row.id);
          const ordered =
            input.position === "primary"
              ? [input.row, ...remaining]
              : [...remaining, input.row];
          const patches = ordered.map((row, order_index) => ({
            ...row,
            order_index,
          }));
          for (const [id, patch] of data.bundlePatches) {
            if (patch.bundle_id === input.row.bundle_id) {
              data.bundlePatches.delete(id);
            }
          }
          for (const patch of patches) {
            data.bundlePatches.set(patch.id, patch);
          }
          return structuredClone({
            patches,
            previous,
            published: true as const,
          });
        }),
      transaction: (callback) =>
        mutate(async () => {
          const transactionData = cloneMockDatabaseData(data);
          const result = await callback(
            createMockDatabaseState(transactionData),
          );
          replaceMockDatabaseData(data, transactionData);
          return result;
        }),
    };
  })();
  const adapter = createDatabasePluginAdapter("mockDatabase", implementation);
  return createDatabasePlugin({
    name: "mockDatabase",
    models: adapter.models,
    commit: adapter.commit,
  });
};

const latestEvents = (events: Iterable<BundleEventRow>): BundleEventRow[] => {
  const latest = new Map<string, BundleEventRow>();
  for (const event of events) {
    const previous = latest.get(event.install_id);
    if (
      !previous ||
      event.received_at_ms > previous.received_at_ms ||
      (event.received_at_ms === previous.received_at_ms &&
        event.id > previous.id)
    )
      latest.set(event.install_id, event);
  }
  return [...latest.values()];
};
