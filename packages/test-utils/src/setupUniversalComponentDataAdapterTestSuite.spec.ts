import {
  getUniversalComponentLatestSchema,
  type UniversalComponentDataAdapter,
  type UniversalComponentRow,
  type UniversalComponentScalar,
  type UniversalComponentSchema,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";

import { setupUniversalComponentDataAdapterTestSuite } from "./setupUniversalComponentDataAdapterTestSuite";

type ComponentState = {
  readonly rows: Map<string, UniversalComponentRow[]>;
  version: string | null;
};

const components = new Map<string, ComponentState>();

const stateFor = (schema: UniversalComponentSchema): ComponentState => {
  const existing = components.get(schema.id);
  if (existing !== undefined) return existing;
  const state: ComponentState = { rows: new Map(), version: null };
  components.set(schema.id, state);
  return state;
};

const compareScalar = (
  left: UniversalComponentScalar,
  right: UniversalComponentScalar,
): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
};

const compareTuple = (
  left: readonly UniversalComponentScalar[],
  right: readonly UniversalComponentScalar[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareScalar(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
};

const adapter: UniversalComponentDataAdapter = {
  bind(schema) {
    const latest = getUniversalComponentLatestSchema(schema);
    const state = stateFor(schema);
    const assertReady = async () => {
      if (state.version !== latest.version) {
        throw new UniversalComponentSchemaNotReadyError(
          schema.id,
          latest.version,
          state.version,
        );
      }
    };
    return {
      schema,
      assertReady,
      async append(input) {
        await assertReady();
        const rows = state.rows.get(input.table) ?? [];
        rows.push(structuredClone(input.row));
        state.rows.set(input.table, rows);
      },
      async orderedScan(input) {
        await assertReady();
        const accessPattern = latest.orderedScans?.find(
          ({ name }) => name === input.accessPattern,
        );
        if (accessPattern === undefined) {
          throw new TypeError(`Unknown access pattern ${input.accessPattern}`);
        }
        const tuple = (row: UniversalComponentRow) =>
          accessPattern.columns.map(
            (column) => row[column] as UniversalComponentScalar,
          );
        return (state.rows.get(accessPattern.table) ?? [])
          .filter(
            (row) =>
              input.afterExclusive === undefined ||
              compareTuple(tuple(row), input.afterExclusive) > 0,
          )
          .filter(
            (row) =>
              compareTuple(
                tuple(row).slice(0, input.beforePrefixExclusive.length),
                input.beforePrefixExclusive,
              ) < 0,
          )
          .toSorted((left, right) => compareTuple(tuple(left), tuple(right)))
          .slice(0, input.limit)
          .map((row) => structuredClone(row));
      },
    };
  },
  async migrate(schema) {
    const state = stateFor(schema);
    const latest = getUniversalComponentLatestSchema(schema).version;
    if (state.version !== null && state.version !== latest) {
      throw new UniversalComponentSchemaNotReadyError(
        schema.id,
        latest,
        state.version,
      );
    }
    const changed = state.version !== latest;
    state.version = latest;
    return { changed, version: latest };
  },
};

setupUniversalComponentDataAdapterTestSuite({
  name: "in-memory universal component data adapter",
  createAdapter: () => adapter,
  dispose: () => undefined,
  reset: () => components.clear(),
  setStoredVersion: (_adapter, schema, version) => {
    stateFor(schema).version = version;
  },
});
