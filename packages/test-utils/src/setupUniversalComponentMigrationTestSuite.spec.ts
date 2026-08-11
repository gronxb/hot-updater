import {
  evaluateUniversalComponentCheck,
  getUniversalComponentLatestSchema,
  getUniversalComponentTable,
  resolveUniversalComponentMigrationState,
  type UniversalComponentDataAdapter,
  type UniversalComponentRow,
  type UniversalComponentSchema,
  UniversalComponentSchemaNotReadyError,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  setupUniversalComponentMigrationTestSuite,
  syntheticAuditLogMigrationSchema,
  syntheticMigrationLegacyEvidence,
  syntheticMigrationValidationOnlyCorruptRow,
  syntheticMigrationVersions,
  type SyntheticUniversalComponentMigrationState,
  type UniversalComponentMigrationMutationCounts,
  type UniversalComponentMigrationTestHarness,
} from "./setupUniversalComponentMigrationTestSuite";

const tableName = "audit_history_records";

describe("synthetic universal component migration fixture", () => {
  it.each(["1", "2"])(
    "keeps validation-only corruption out of version %s physical checks",
    (version) => {
      const table = getUniversalComponentTable(
        syntheticAuditLogMigrationSchema,
        tableName,
        version,
      );
      const storageChecks = (table.checks ?? []).filter(
        ({ enforcement }) => enforcement !== "validation",
      );

      expect(storageChecks.length).toBeGreaterThan(0);
      expect(
        storageChecks.every(({ expression }) =>
          evaluateUniversalComponentCheck(
            expression,
            syntheticMigrationValidationOnlyCorruptRow,
          ),
        ),
      ).toBe(true);
      expect(() =>
        validateUniversalComponentRow(syntheticAuditLogMigrationSchema, {
          row: syntheticMigrationValidationOnlyCorruptRow,
          table: tableName,
          version,
        }),
      ).toThrow("Invalid row for component table");
    },
  );
});

const createHarness = (): UniversalComponentMigrationTestHarness => {
  let state: SyntheticUniversalComponentMigrationState = {
    componentVersion: null,
    legacyVersion: syntheticMigrationLegacyEvidence.fresh,
    physicalState: "absent",
    rows: [],
  };
  const mutations: {
    markerWrites: number;
    physicalWrites: number;
    rowWrites: number;
  } = { markerWrites: 0, physicalWrites: 0, rowWrites: 0 };
  let markerWriteFailure = false;

  const assertKnownSchema = (schema: UniversalComponentSchema): void => {
    if (schema.id !== syntheticAuditLogMigrationSchema.id) {
      throw new TypeError(`Unexpected component schema ${schema.id}`);
    }
  };

  const validateRows = (schema: UniversalComponentSchema): void => {
    for (const row of state.rows) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new TypeError("Invalid stored synthetic component row");
      }
      validateUniversalComponentRow(schema, {
        row: row as UniversalComponentRow,
        table: tableName,
        version: syntheticMigrationVersions.latest,
      });
    }
  };

  const writeLatestMarker = (): void => {
    if (markerWriteFailure) {
      markerWriteFailure = false;
      throw new Error("synthetic marker write failed");
    }
    mutations.markerWrites += 1;
    state = {
      ...state,
      componentVersion: syntheticMigrationVersions.latest,
    };
  };

  const migrate = async (
    schema: UniversalComponentSchema,
  ): Promise<{ readonly changed: boolean; readonly version: string }> => {
    assertKnownSchema(schema);
    const latest = getUniversalComponentLatestSchema(schema).version;
    if (
      (state.componentVersion !== null &&
        typeof state.componentVersion !== "string") ||
      (state.legacyVersion !== null && typeof state.legacyVersion !== "string")
    ) {
      throw new TypeError("Invalid synthetic component migration marker");
    }
    if (state.physicalState === "drift") {
      throw new TypeError("Synthetic component physical schema drift");
    }
    const physicalVersion =
      state.physicalState === "absent"
        ? null
        : state.physicalState === "version-1"
          ? syntheticMigrationVersions.legacy
          : syntheticMigrationVersions.latest;
    const decision = resolveUniversalComponentMigrationState(schema, {
      discriminatorValue: state.legacyVersion,
      markerVersion: state.componentVersion,
      physicalVersion,
    });
    if (decision.kind === "reject") {
      throw new TypeError(
        "Synthetic component migration state is incompatible",
      );
    }
    if (decision.kind === "ready") {
      validateRows(schema);
      return { changed: false, version: latest };
    }
    if (
      decision.kind === "create" ||
      ((decision.kind === "adopt" || decision.kind === "migrate") &&
        decision.fromVersion === syntheticMigrationVersions.legacy)
    ) {
      state = { ...state, physicalState: "version-2" };
      mutations.physicalWrites += 1;
    }

    validateRows(schema);
    writeLatestMarker();
    return { changed: true, version: latest };
  };

  const adapter: UniversalComponentDataAdapter = {
    artifacts() {
      return [
        {
          contents: "synthetic version 2 migration",
          path: "component-data/audit-history/synthetic.txt",
          targetVersion: syntheticMigrationVersions.latest,
        },
      ];
    },
    bind(schema) {
      assertKnownSchema(schema);
      const assertReady = async (): Promise<void> => {
        if (
          state.componentVersion !== syntheticMigrationVersions.latest ||
          state.physicalState !== "version-2"
        ) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            syntheticMigrationVersions.latest,
            typeof state.componentVersion === "string"
              ? state.componentVersion
              : null,
          );
        }
        validateRows(schema);
      };
      return {
        schema,
        async append(input) {
          await assertReady();
          validateUniversalComponentRow(schema, {
            ...input,
            version: syntheticMigrationVersions.latest,
          });
          state = {
            ...state,
            rows: [...state.rows, structuredClone(input.row)],
          };
          mutations.rowWrites += 1;
        },
        assertReady,
        async create(input) {
          await assertReady();
          validateUniversalComponentRow(schema, {
            ...input,
            version: syntheticMigrationVersions.latest,
          });
          const existing = state.rows.some(
            (row) =>
              typeof row === "object" &&
              row !== null &&
              !Array.isArray(row) &&
              Reflect.get(row, "id") === input.row.id,
          );
          if (existing) return "existing";
          state = {
            ...state,
            rows: [...state.rows, structuredClone(input.row)],
          };
          mutations.rowWrites += 1;
          return "created";
        },
        async get(input) {
          await assertReady();
          const row = state.rows.find(
            (candidate) =>
              typeof candidate === "object" &&
              candidate !== null &&
              !Array.isArray(candidate) &&
              Reflect.get(candidate, "id") === input.primaryKey,
          );
          return row === undefined
            ? null
            : (structuredClone(row) as UniversalComponentRow);
        },
        async orderedScan() {
          await assertReady();
          return structuredClone(
            state.rows,
          ) as readonly UniversalComponentRow[];
        },
      };
    },
    migrate,
  };

  return {
    adapter,
    failNextMarkerWrite() {
      markerWriteFailure = true;
    },
    inspect(schema) {
      assertKnownSchema(schema);
      return structuredClone(state);
    },
    mutationCounts(): UniversalComponentMigrationMutationCounts {
      return { ...mutations };
    },
    seed(schema, initial) {
      assertKnownSchema(schema);
      state = structuredClone(initial);
      mutations.markerWrites = 0;
      mutations.physicalWrites = 0;
      mutations.rowWrites = 0;
      markerWriteFailure = false;
    },
  };
};

setupUniversalComponentMigrationTestSuite({
  createHarness,
  name: "in-memory universal component migration",
  supportsArtifacts: true,
  supportsMarkerWriteFailure: true,
});
