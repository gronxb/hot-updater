import {
  createDatabaseAdapter,
  type DatabaseAdapterImplementation,
  resolveUpdateInfoFromBundles,
  rowsToBundles,
} from "@hot-updater/plugin-core";

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

export const mockDatabase = createDatabaseAdapter<MockDatabaseConfig>({
  name: "mockDatabase",
  factory: (config): DatabaseAdapterImplementation => {
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
      getUpdateInfo: (args, context) =>
        read(() =>
          resolveUpdateInfoFromBundles({
            args,
            bundles: rowsToBundles(
              [...data.bundles.values()],
              [...data.bundlePatches.values()],
              [...data.bundles.values()],
              [...data.channels.values()],
            ),
            context,
          }),
        ),
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
  },
});
