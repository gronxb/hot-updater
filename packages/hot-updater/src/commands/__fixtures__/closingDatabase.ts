import {
  createMemoryAdapter,
  type DatabaseAdapter,
  type EngineDatabase,
} from "@hot-updater/plugin-core";

/** What a closing database records, for the spec to read. */
export interface ClosingDatabaseState {
  closed: boolean;
  closes: number;
  callsAfterClose: number;
}

/**
 * A database that refuses every call once it is disposed, as a pool does
 * once it has ended: what doctor's spec configures, to check that a run
 * closes its server once, after the last check that reads it.
 */
export const createClosingDatabase = (): {
  readonly database: EngineDatabase;
  readonly state: ClosingDatabaseState;
} => {
  const memory = createMemoryAdapter();
  const state: ClosingDatabaseState = {
    closed: false,
    closes: 0,
    callsAfterClose: 0,
  };
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
  return {
    database: {
      name: "closing",
      adapter,
      dispose: async () => {
        state.closed = true;
        state.closes += 1;
      },
    },
    state,
  };
};
