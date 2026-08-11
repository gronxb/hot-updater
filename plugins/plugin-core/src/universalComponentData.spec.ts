import { describe, expect, it, vi } from "vitest";

import { getCapabilityContributions } from "./capabilities";
import type { UniversalComponentArtifact } from "./universalComponentData";
import {
  attachUniversalComponentDataAdapter,
  defineUniversalComponentSchema,
  evaluateUniversalComponentCheck,
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  getUniversalComponentSchemaVersion,
  isUniversalComponentDataValue,
  resolveUniversalComponentMigrationState,
  resolveUniversalComponentUnmarkedState,
  UniversalComponentDataNotReadyError,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
  universalComponentDataAdapterCapability,
  validateUniversalComponentAppend,
  validateUniversalComponentGet,
  validateUniversalComponentOrderedScan,
  validateUniversalComponentRow,
} from "./universalComponentData";

const schema = () =>
  defineUniversalComponentSchema({
    id: "audit-log",
    versions: [
      {
        version: "1",
        tables: [
          {
            name: "audit_records",
            columns: [
              { name: "id", type: "string", primaryKey: true },
              { name: "recorded_at_ms", type: "integer" },
              { name: "message", type: "string" },
            ],
          },
        ],
        orderedScans: [
          {
            name: "chronological",
            table: "audit_records",
            columns: ["recorded_at_ms", "id"],
          },
        ],
      },
    ],
  });

const versionedSchema = () =>
  defineUniversalComponentSchema({
    id: "lifecycle-log",
    unmarked: {
      adopt: [
        { version: "1", when: ["1.0"] },
        { version: "2", when: [null, "0.9", "1.0", "2.0"] },
      ],
      createWhen: [null, "0.9"],
      discriminatorKey: "legacy.schema",
      knownValues: [null, "0.9", "1.0", "2.0"],
    },
    versions: [
      {
        orderedScans: [
          {
            columns: ["recorded_at_ms", "id"],
            name: "chronological",
            table: "lifecycle_records",
          },
        ],
        tables: [
          {
            checks: [
              {
                expression: {
                  column: "kind",
                  op: "in",
                  values: ["CREATED", "UPDATED"],
                },
                name: "known_kind",
              },
              {
                expression: { column: "source_id", op: "is-not-null" },
                name: "source_present",
              },
              {
                enforcement: "validation",
                expression: { column: "message", op: "non-empty" },
                name: "message_present",
              },
              {
                enforcement: "validation",
                expression: {
                  expressions: [
                    { column: "recorded_at_ms", op: "integer" },
                    { column: "recorded_at_ms", op: "gte", value: 0 },
                    {
                      column: "recorded_at_ms",
                      op: "lte",
                      value: Number.MAX_SAFE_INTEGER,
                    },
                  ],
                  op: "all",
                },
                name: "valid_timestamp",
              },
            ],
            columns: [
              { name: "id", primaryKey: true, type: "uuid" },
              { name: "kind", type: "string" },
              { name: "source_id", type: "uuid" },
              { name: "message", type: "string" },
              { name: "recorded_at_ms", type: "float" },
            ],
            indexes: [
              {
                columns: ["recorded_at_ms", "id"],
                name: "lifecycle_chronological",
              },
            ],
            name: "lifecycle_records",
          },
        ],
        version: "1",
      },
      {
        orderedScans: [
          {
            columns: ["recorded_at_ms", "id"],
            name: "chronological",
            table: "lifecycle_records",
          },
        ],
        tables: [
          {
            checks: [
              {
                expression: {
                  expressions: [
                    {
                      expressions: [
                        {
                          column: "kind",
                          op: "in",
                          values: ["CREATED", "UPDATED"],
                        },
                        { column: "source_id", op: "is-not-null" },
                      ],
                      op: "all",
                    },
                    {
                      expressions: [
                        { column: "kind", op: "eq", value: "UNCHANGED" },
                        { column: "source_id", op: "is-null" },
                      ],
                      op: "all",
                    },
                  ],
                  op: "any",
                },
                name: "kind_source_shape",
              },
              {
                enforcement: "validation",
                expression: { column: "message", op: "non-empty" },
                name: "message_present",
              },
              {
                enforcement: "validation",
                expression: {
                  expressions: [
                    { column: "recorded_at_ms", op: "integer" },
                    { column: "recorded_at_ms", op: "gte", value: 0 },
                    {
                      column: "recorded_at_ms",
                      op: "lte",
                      value: Number.MAX_SAFE_INTEGER,
                    },
                  ],
                  op: "all",
                },
                name: "valid_timestamp",
              },
            ],
            columns: [
              { name: "id", primaryKey: true, type: "uuid" },
              { name: "kind", type: "string" },
              { name: "source_id", nullable: true, type: "uuid" },
              { name: "message", type: "string" },
              { name: "recorded_at_ms", type: "float" },
            ],
            indexes: [
              {
                columns: ["recorded_at_ms", "id"],
                name: "lifecycle_chronological",
              },
              {
                columns: ["source_id", "recorded_at_ms"],
                name: "lifecycle_by_source",
              },
            ],
            name: "lifecycle_records",
          },
        ],
        version: "2",
      },
    ],
  });

describe("universal component data", () => {
  it("classifies marker and declared-state readiness failures without inventing a marker", () => {
    const marker = new UniversalComponentSchemaNotReadyError(
      "audit-log",
      "2",
      "1",
    );
    const cause = new TypeError("missing chronological index");
    const state = new UniversalComponentDataStateNotReadyError(
      "audit-log",
      "2",
      "index",
      { cause },
    );

    expect(marker).toBeInstanceOf(UniversalComponentDataNotReadyError);
    expect(marker).toMatchObject({
      actualVersion: "1",
      componentId: "audit-log",
      expectedVersion: "2",
    });
    expect(marker.message).toBe(
      "Component audit-log requires schema version 2; found 1.",
    );
    expect(state).toBeInstanceOf(UniversalComponentDataNotReadyError);
    expect(state).toMatchObject({
      cause,
      componentId: "audit-log",
      expectedVersion: "2",
      reason: "index",
    });
    expect(state).not.toHaveProperty("actualVersion");
  });

  it("defines an immutable component schema with a derived marker", () => {
    const defined = schema();

    expect(getUniversalComponentSchemaMarkerKey(defined)).toBe(
      "schema.audit-log",
    );
    expect(getUniversalComponentLatestSchema(defined).version).toBe("1");
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.versions[0].tables[0].columns)).toBe(true);
  });

  it.each([
    {
      name: "duplicate versions",
      mutate: () => ({
        id: "audit-log",
        versions: [schema().versions[0], schema().versions[0]] as const,
      }),
    },
    {
      name: "unknown access-pattern columns",
      mutate: () => ({
        id: "audit-log",
        versions: [
          {
            ...schema().versions[0],
            orderedScans: [
              {
                name: "chronological",
                table: "audit_records",
                columns: ["missing"] as [string],
              },
            ],
          },
        ] as const,
      }),
    },
    {
      name: "tables without one primary key",
      mutate: () => ({
        id: "audit-log",
        versions: [
          {
            version: "1",
            tables: [
              {
                name: "audit_records",
                columns: [{ name: "id", type: "string" as const }],
              },
            ],
          },
        ] as const,
      }),
    },
    {
      name: "non-portable primary keys",
      mutate: () => ({
        id: "audit-log",
        versions: [
          {
            version: "1",
            tables: [
              {
                name: "audit_records",
                columns: [
                  { name: "id", primaryKey: true, type: "integer" as const },
                ],
              },
            ],
          },
        ] as const,
      }),
    },
    {
      name: "nullable ordered scan columns",
      mutate: () => ({
        id: "audit-log",
        versions: [
          {
            ...schema().versions[0],
            tables: [
              {
                ...schema().versions[0].tables[0],
                columns: [
                  { name: "id", primaryKey: true, type: "string" as const },
                  {
                    name: "recorded_at_ms",
                    nullable: true as const,
                    type: "integer" as const,
                  },
                  { name: "message", type: "string" as const },
                ],
              },
            ],
          },
        ] as const,
      }),
    },
  ])("rejects $name", ({ mutate }) => {
    expect(() => defineUniversalComponentSchema(mutate())).toThrow(
      "Invalid universal component schema",
    );
  });

  it("attaches a neutral adapter capability to a database carrier", () => {
    const bind = vi.fn();
    const database = attachUniversalComponentDataAdapter(
      { name: "synthetic" },
      () => ({ bind }),
    );
    const [contribution] = getCapabilityContributions(database);

    expect(contribution?.token).toBe(universalComponentDataAdapterCapability);
    expect(
      contribution?.create({ database: {} as never, storages: [] }),
    ).toEqual({ bind });
  });

  it("validates rows and portable ordered cursors against the latest schema", () => {
    const defined = schema();
    expect(
      validateUniversalComponentAppend(defined, {
        table: "audit_records",
        row: { id: "record-1", message: "created", recorded_at_ms: 100 },
      }).name,
    ).toBe("audit_records");
    expect(
      validateUniversalComponentOrderedScan(defined, {
        accessPattern: "chronological",
        afterExclusive: [100, "record-1"],
        beforePrefixExclusive: [200],
        limit: 10,
      }).columns,
    ).toEqual(["recorded_at_ms", "id"]);
    expect(
      validateUniversalComponentGet(defined, {
        primaryKey: "record-1",
        table: "audit_records",
      }).name,
    ).toBe("audit_records");

    expect(() =>
      validateUniversalComponentAppend(defined, {
        table: "audit_records",
        row: { id: "record-1", message: "created" },
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentOrderedScan(defined, {
        accessPattern: "chronological",
        afterExclusive: [100],
        beforePrefixExclusive: [200],
        limit: 10,
      }),
    ).toThrow("Invalid scan input");
    expect(() =>
      validateUniversalComponentGet(defined, {
        primaryKey: "invalid/key",
        table: "audit_records",
      }),
    ).toThrow("Invalid primary key");
  });
});

describe("versioned universal component schemas", () => {
  const v1Row = {
    id: "event-1",
    kind: "CREATED",
    message: "created",
    recorded_at_ms: 100,
    source_id: "bundle-a",
  };

  it("canonicalizes compatible v1/v2 declarations and target artifacts", () => {
    const defined = versionedSchema();
    const v1Table = defined.versions[0].tables[0];
    const artifact: UniversalComponentArtifact = {
      contents: "provider-specific migration",
      path: "schema.sql",
      targetVersion: "2",
    };

    expect(getUniversalComponentSchemaVersion(defined, "1").version).toBe("1");
    expect(getUniversalComponentLatestSchema(defined).version).toBe("2");
    expect(artifact.targetVersion).toBe("2");
    expect(Object.isFrozen(defined.unmarked)).toBe(true);
    expect(Object.isFrozen(defined.unmarked?.knownValues)).toBe(true);
    expect(
      Object.isFrozen(defined.versions[1].tables[0].checks?.[0]?.expression),
    ).toBe(true);
    expect(
      v1Table.checks?.find(({ name }) => name === "known_kind"),
    ).not.toHaveProperty("enforcement");
    expect(
      v1Table.checks?.find(({ name }) => name === "message_present"),
    ).toMatchObject({ enforcement: "validation" });
    expect(
      Object.isFrozen(
        v1Table.checks?.find(({ name }) => name === "message_present"),
      ),
    ).toBe(true);

    const explicitStorage = defineUniversalComponentSchema({
      id: "lifecycle-log",
      versions: [
        {
          ...defined.versions[0],
          tables: [
            {
              ...v1Table,
              checks: v1Table.checks?.map((check) =>
                check.name === "known_kind"
                  ? { ...check, enforcement: "storage" as const }
                  : check,
              ),
            },
          ],
        },
      ],
    });
    expect(explicitStorage.versions[0].tables[0].checks?.[0]).toEqual(
      v1Table.checks?.[0],
    );
  });

  it("validates exact rows against the requested schema version", () => {
    const defined = versionedSchema();
    const unchangedRow = {
      ...v1Row,
      kind: "UNCHANGED",
      source_id: null,
    };

    // UUID is a provider storage semantic. The portable contract intentionally
    // preserves legacy non-empty identifiers that are not UUID syntax.
    expect(
      validateUniversalComponentRow(defined, {
        row: v1Row,
        table: "lifecycle_records",
        version: "1",
      }).name,
    ).toBe("lifecycle_records");
    expect(
      validateUniversalComponentRow(defined, {
        row: unchangedRow,
        table: "lifecycle_records",
        version: "2",
      }).name,
    ).toBe("lifecycle_records");
    expect(
      validateUniversalComponentAppend(defined, {
        row: unchangedRow,
        table: "lifecycle_records",
      }).name,
    ).toBe("lifecycle_records");

    expect(() =>
      validateUniversalComponentRow(defined, {
        row: unchangedRow,
        table: "lifecycle_records",
        version: "1",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(defined, {
        row: { ...v1Row, kind: "UPDATED", source_id: null },
        table: "lifecycle_records",
        version: "2",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(defined, {
        row: { ...v1Row, message: "" },
        table: "lifecycle_records",
        version: "1",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(defined, {
        row: { ...v1Row, recorded_at_ms: 0.5 },
        table: "lifecycle_records",
        version: "1",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(defined, {
        row: { ...v1Row, unexpected: true },
        table: "lifecycle_records",
        version: "1",
      }),
    ).toThrow("Invalid row for component table");
    expect(() =>
      validateUniversalComponentRow(defined, {
        row: v1Row,
        table: "lifecycle_records",
        version: "3",
      }),
    ).toThrow("Unknown component schema version");
  });

  it("evaluates nested checks with two-valued semantics", () => {
    const expression =
      versionedSchema().versions[1].tables[0].checks?.[0]?.expression;

    expect(expression).toBeDefined();
    expect(
      evaluateUniversalComponentCheck(expression!, {
        ...v1Row,
        kind: "UNCHANGED",
        source_id: null,
      }),
    ).toBe(true);
    expect(
      evaluateUniversalComponentCheck(expression!, {
        ...v1Row,
        kind: "UNCHANGED",
      }),
    ).toBe(false);
  });

  it("normalizes unmarked adoption decisions", () => {
    const defined = versionedSchema();

    expect(
      resolveUniversalComponentUnmarkedState(defined, {
        discriminatorValue: null,
        physicalVersion: null,
      }),
    ).toEqual({ kind: "create" });
    expect(
      resolveUniversalComponentUnmarkedState(defined, {
        discriminatorValue: "1.0",
        physicalVersion: "1",
      }),
    ).toEqual({ kind: "adopt", version: "1" });
    expect(
      resolveUniversalComponentUnmarkedState(defined, {
        discriminatorValue: "1.0",
        physicalVersion: "2",
      }),
    ).toEqual({ kind: "adopt", version: "2" });
    expect(
      resolveUniversalComponentUnmarkedState(defined, {
        discriminatorValue: "0.9",
        physicalVersion: "1",
      }),
    ).toEqual({ kind: "reject" });
    expect(
      resolveUniversalComponentUnmarkedState(defined, {
        discriminatorValue: "future",
        physicalVersion: null,
      }),
    ).toEqual({ kind: "reject" });
  });

  it("normalizes marked migration and interrupted-marker recovery", () => {
    const defined = versionedSchema();

    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "1.0",
        markerVersion: null,
        physicalVersion: "1",
      }),
    ).toEqual({
      fromVersion: "1",
      kind: "migrate",
      targetVersion: "2",
    });
    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "1.0",
        markerVersion: null,
        physicalVersion: "2",
      }),
    ).toEqual({
      fromVersion: "2",
      kind: "adopt",
      targetVersion: "2",
    });
    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "1.0",
        markerVersion: "1",
        physicalVersion: "1",
      }),
    ).toEqual({
      fromVersion: "1",
      kind: "migrate",
      targetVersion: "2",
    });
    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "1.0",
        markerVersion: "1",
        physicalVersion: "2",
      }),
    ).toEqual({
      fromVersion: "2",
      kind: "adopt",
      targetVersion: "2",
    });
    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "2.0",
        markerVersion: "2",
        physicalVersion: "2",
      }),
    ).toEqual({ kind: "ready", version: "2" });
    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "1.0",
        markerVersion: "2",
        physicalVersion: "1",
      }),
    ).toEqual({ kind: "reject" });
    expect(
      resolveUniversalComponentMigrationState(defined, {
        discriminatorValue: "future",
        markerVersion: "2",
        physicalVersion: "2",
      }),
    ).toEqual({ kind: "reject" });
  });

  it("rejects adjacent transitions that require data migration", () => {
    const defined = versionedSchema();
    const v2 = defined.versions[1];
    const table = v2.tables[0];

    expect(() =>
      defineUniversalComponentSchema({
        id: "lifecycle-log",
        versions: [
          defined.versions[0],
          {
            ...v2,
            tables: [
              {
                ...table,
                columns: [
                  ...table.columns,
                  { name: "new_field", type: "string" },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow("unsupported transition 1 to 2");
    expect(() =>
      defineUniversalComponentSchema({
        id: "lifecycle-log",
        versions: [
          defined.versions[0],
          {
            ...v2,
            tables: [
              {
                ...table,
                columns: table.columns.map((column) =>
                  column.name === "recorded_at_ms"
                    ? { ...column, type: "integer" as const }
                    : column,
                ),
              },
            ],
          },
        ],
      }),
    ).toThrow("unsupported transition 1 to 2");
  });

  it("allows validation-only checks to change across adjacent versions", () => {
    const defined = versionedSchema();
    const v1 = defined.versions[0];
    const table = v1.tables[0];

    const transitioned = defineUniversalComponentSchema({
      id: "lifecycle-log",
      versions: [
        v1,
        {
          ...v1,
          tables: [
            {
              ...table,
              checks: table.checks?.map((check) =>
                check.name === "message_present"
                  ? {
                      ...check,
                      expression: {
                        column: "message",
                        op: "in" as const,
                        values: ["created", "updated"] as const,
                      },
                    }
                  : check,
              ),
            },
          ],
          version: "2",
        },
      ],
    });

    expect(transitioned.versions).toHaveLength(2);
    expect(
      transitioned.versions[1].tables[0].checks?.find(
        ({ name }) => name === "message_present",
      ),
    ).toMatchObject({ enforcement: "validation" });
  });

  it("rejects invalid checks and unmarked policies", () => {
    const defined = versionedSchema();
    const v1 = defined.versions[0];
    const table = v1.tables[0];

    expect(() =>
      defineUniversalComponentSchema({
        id: "lifecycle-log",
        versions: [
          {
            ...v1,
            tables: [
              {
                ...table,
                checks: [
                  {
                    expression: { column: "missing", op: "non-empty" },
                    name: "missing_column",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow("unknown column");
    expect(() =>
      defineUniversalComponentSchema({
        ...defined,
        unmarked: {
          ...defined.unmarked!,
          createWhen: ["future"],
        },
      }),
    ).toThrow("createWhen contains an unknown value");
    expect(() =>
      defineUniversalComponentSchema({
        id: "lifecycle-log",
        versions: [
          {
            ...v1,
            tables: [
              {
                ...table,
                checks: [
                  {
                    enforcement: "runtime" as "validation",
                    expression: { column: "message", op: "non-empty" },
                    name: "message_present",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow("Invalid universal component schema");
    expect(() =>
      defineUniversalComponentSchema({
        id: "lifecycle-log",
        versions: [
          {
            ...v1,
            tables: [
              {
                ...table,
                checks: [
                  {
                    expression: { column: "message", op: "non-empty" },
                    name: "same_name",
                  },
                  {
                    enforcement: "validation",
                    expression: { column: "message", op: "non-empty" },
                    name: "same_name",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow("duplicate check same_name");
  });

  it("accepts only finite nested JSON data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(
      isUniversalComponentDataValue({
        flags: [true, null],
        metrics: { count: 1, ratio: 0.5 },
      }),
    ).toBe(true);
    expect(isUniversalComponentDataValue({ nested: [Number.NaN] })).toBe(false);
    expect(
      isUniversalComponentDataValue({
        nested: { value: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
    expect(isUniversalComponentDataValue(new Date(0))).toBe(false);
    expect(isUniversalComponentDataValue(cyclic)).toBe(false);
  });
});
