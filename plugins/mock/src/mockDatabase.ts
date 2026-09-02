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
import type { MockInsightsDatabaseNamespaces } from "./mockInsights";
import { minMax, sleep } from "./util/utils";

export type { MockDatabaseData } from "./mockDatabaseState";
export { createMockDatabaseData } from "./mockDatabaseState";

export interface MockDatabaseConfig extends MockInsightsDatabaseNamespaces {
  readonly latency: { readonly min: number; readonly max: number };
  readonly data?: MockDatabaseData;
}

export const mockDatabase = (config: MockDatabaseConfig) => {
  const implementation: DatabasePluginImplementation = (() => {
    const data = config.data ?? createMockDatabaseData(config);
    if (
      data.insightsDatabaseNamespace !== config.insightsDatabaseNamespace ||
      data.otherInsightsDatabaseNamespace !==
        config.otherInsightsDatabaseNamespace
    ) {
      throw new Error("Mock Insights database namespaces do not match data");
    }
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
      insights: data.insights.model,
      create: (input) => mutate(() => state.create(input)),
      update: (input) => mutate(() => state.update(input)),
      delete: (input) => mutate(() => state.delete(input)),
      count: (input) => read(() => state.count(input)),
      findOne: (input) => read(() => state.findOne(input)),
      findMany: (input) => read(() => state.findMany(input)),
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
