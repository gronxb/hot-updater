import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

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
      recordInsights: ({ event, installation }) =>
        mutate(async () => {
          if (data.bundleEvents.has(event.id)) return;
          const current = data.bundleInstallations.get(event.install_id);
          const isNewer =
            !current ||
            event.received_at_ms > current.received_at_ms ||
            (event.received_at_ms === current.received_at_ms &&
              event.id > current.id);
          data.bundleEvents.set(event.id, { ...event });
          if (isNewer) {
            data.bundleInstallations.set(event.install_id, {
              ...installation,
            });
          }
        }),
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
