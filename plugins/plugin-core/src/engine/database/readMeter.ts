import type { DatabaseAdapter } from "../../database/adapter";
import type { DatabaseReadCount } from "../../database/verifyAdapter";
import type { EngineDatabase } from "../../types/databaseConfig";
import type { EngineReadCount } from "./engineReads";

export interface ReadMeasurement<T> {
  readonly result: T;
  /** Point reads and the keys they asked for, and queries and the rows they returned, at the adapter. */
  readonly adapter: DatabaseReadCount;
  /** Reads and the rows (logical rows for aggregates) the engine returned to its callers. */
  readonly engine: EngineReadCount;
}

/**
 * A database whose reads `measureReads` reports, for adapter cost analysis:
 * what each server call costs the store that bills by read.
 */
export type MeteredDatabase<TDatabase extends EngineDatabase = EngineDatabase> =
  TDatabase & {
    /**
     * Runs `read` and reports what the engines on this database read while
     * it ran, at the adapter and at the engine. A process's schema-fence
     * read and retention passes are not part of any call and are not
     * counted.
     */
    measureReads<T>(read: () => Promise<T>): Promise<ReadMeasurement<T>>;
  };

interface EngineCounter {
  total(): EngineReadCount;
  reset(): void;
}

/** What an engine on a metered database reports its reads to. */
export interface ReadMeter {
  /** The adapter the engine and its batching read through, counted. */
  wrap(adapter: DatabaseAdapter): DatabaseAdapter;
  /** Adds an engine's count of the reads it returned to callers. */
  attach(counter: EngineCounter): void;
}

const METER = Symbol.for("@hot-updater/plugin-core/read-meter");

const NO_READS: DatabaseReadCount = { gets: 0, keys: 0, queries: 0, rows: 0 };

/** The meter `meterReads` gave `database`, if it did. */
export const readMeterOf = (database: unknown): ReadMeter | undefined =>
  typeof database === "object" && database !== null
    ? (database as { readonly [METER]?: ReadMeter })[METER]
    : undefined;

/**
 * `database` with read metering, for adapter cost analysis: pass it to
 * `createHotUpdater` or `createEngine`, then `measureReads` reports what a
 * call read at the adapter and at the engine. It works on any database on
 * the storage engine, a provider's included, and every engine on it reports
 * to the same meter.
 */
export const meterReads = <TDatabase extends EngineDatabase>(
  database: TDatabase,
): MeteredDatabase<TDatabase> => {
  let adapterReads = NO_READS;
  const engines = new Set<EngineCounter>();
  const add = (count: Partial<DatabaseReadCount>) => {
    adapterReads = {
      gets: adapterReads.gets + (count.gets ?? 0),
      keys: adapterReads.keys + (count.keys ?? 0),
      queries: adapterReads.queries + (count.queries ?? 0),
      rows: adapterReads.rows + (count.rows ?? 0),
    };
  };
  const meter: ReadMeter = {
    // Inherits every other member, so it reads the adapter as it is at each
    // call, a proxy's included.
    wrap: (adapter) =>
      Object.assign(Object.create(adapter) as DatabaseAdapter, {
        async get(...args: Parameters<DatabaseAdapter["get"]>) {
          const rows = await adapter.get(...args);
          add({ gets: 1, keys: args[1].length });
          return rows;
        },
        async query(...args: Parameters<DatabaseAdapter["query"]>) {
          const rows = await adapter.query(...args);
          add({ queries: 1, rows: rows.length });
          return rows;
        },
      } satisfies Pick<DatabaseAdapter, "get" | "query">),
    attach: (counter) => {
      engines.add(counter);
    },
  };
  return {
    ...database,
    [METER]: meter,
    async measureReads<T>(read: () => Promise<T>) {
      adapterReads = NO_READS;
      for (const engine of engines) engine.reset();
      const result = await read();
      let engine: EngineReadCount = { calls: 0, rows: 0 };
      for (const counter of engines) {
        const total = counter.total();
        engine = {
          calls: engine.calls + total.calls,
          rows: engine.rows + total.rows,
        };
      }
      return { result, adapter: adapterReads, engine };
    },
  };
};
