import {
  createMemoryAdapter,
  type DatabaseAdapter,
  type EngineDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";

/**
 * A server definition whose database refuses every call once it is closed,
 * as a pool does: what doctor's spec loads through the CLI's own path. The
 * module loads once per process, so its state lives on `globalThis`, where
 * the spec reads it.
 */
export interface ClosingServerState {
  closed: boolean;
  closes: number;
  callsAfterClose: number;
  database: EngineDatabase;
  hotUpdater: ReturnType<typeof createHotUpdater>;
}

const memory = createMemoryAdapter();

const state = {
  closed: false,
  closes: 0,
  callsAfterClose: 0,
} as ClosingServerState;

const refuseWhenClosed = () => {
  if (state.closed) {
    state.callsAfterClose += 1;
    throw new Error("The database pool has ended.");
  }
};

const adapter: DatabaseAdapter = {
  ...memory,
  get: async (table, keys) => {
    refuseWhenClosed();
    return memory.get(table, keys);
  },
  query: async (table, request) => {
    refuseWhenClosed();
    return memory.query(table, request);
  },
  write: async (ops) => {
    refuseWhenClosed();
    return memory.write(ops);
  },
};

state.database = { name: "closing", adapter };
state.hotUpdater = createHotUpdater({
  database: state.database,
  clientAccess: "public",
});
(globalThis as { __closingServer?: ClosingServerState }).__closingServer =
  state;

export const hotUpdater = state.hotUpdater;

export const closeDatabase = async (): Promise<void> => {
  state.closed = true;
  state.closes += 1;
};
