import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";

import { minMax, sleep } from "./util/utils";

export interface MockDatabaseConfig {
  /** How long each read and write waits, picked between min and max milliseconds. */
  readonly latency: { readonly min: number; readonly max: number };
}

export interface MockDatabase extends EngineDatabase {
  /** The same data without the delay, to seed it quickly. */
  readonly withoutLatency: () => EngineDatabase;
}

/**
 * An in-memory database on the storage engine that answers after a delay,
 * for demos and tests. It starts empty and needs no migration.
 */
export const mockDatabase = (config: MockDatabaseConfig): MockDatabase => {
  const memory = createMemoryAdapter();
  const wait = () => sleep(minMax(config.latency.min, config.latency.max));
  const adapter: DatabaseAdapter = {
    ...memory,
    id: "mock",
    get: async (table, keys) => {
      await wait();
      return memory.get(table, keys);
    },
    query: async (table, request) => {
      await wait();
      return memory.query(table, request);
    },
    write: async (ops) => {
      await wait();
      return memory.write(ops);
    },
  };
  return {
    name: "mockDatabase",
    adapter,
    withoutLatency: () => ({ name: "mockDatabase", adapter: memory }),
  };
};
