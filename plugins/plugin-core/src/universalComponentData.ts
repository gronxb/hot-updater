import {
  attachCapabilityContribution,
  defineSharedCapability,
} from "./capabilities";
import type {
  CapabilityToken,
  HotUpdaterInfrastructureRuntime,
} from "./capabilities";
import { isDatabaseJsonValue } from "./databaseJsonValue";
import type { DatabaseJsonObject, DatabaseJsonValue } from "./types";

export type UniversalComponentColumnType =
  | "boolean"
  | "float"
  | "integer"
  | "json"
  | "string"
  /** Native UUID where available; logically a non-empty string. */
  | "uuid";

export type UniversalComponentScalar = number | string;
export type UniversalComponentCheckValue = boolean | number | string;
export type UniversalComponentRow = DatabaseJsonObject;

export type UniversalComponentCheckExpression =
  | {
      readonly expressions: readonly [
        UniversalComponentCheckExpression,
        ...UniversalComponentCheckExpression[],
      ];
      readonly op: "all" | "any";
    }
  | {
      readonly column: string;
      readonly op: "eq";
      readonly value: UniversalComponentCheckValue;
    }
  | {
      readonly column: string;
      readonly op: "in";
      readonly values: readonly [
        UniversalComponentCheckValue,
        ...UniversalComponentCheckValue[],
      ];
    }
  | {
      readonly column: string;
      readonly op: "gte" | "lte";
      readonly value: number;
    }
  | {
      readonly column: string;
      readonly op: "integer" | "is-not-null" | "is-null" | "non-empty";
    };

export interface UniversalComponentCheckSchema {
  /**
   * `storage` (the default) is compiled into and inspected against physical
   * storage. `validation` is evaluated only during row preflight. Both are
   * evaluated by validateUniversalComponentRow.
   */
  readonly enforcement?: "storage" | "validation";
  readonly expression: UniversalComponentCheckExpression;
  readonly name: string;
}

export interface UniversalComponentColumnSchema {
  readonly name: string;
  readonly type: UniversalComponentColumnType;
  readonly nullable?: true;
  readonly primaryKey?: true;
}

export interface UniversalComponentIndexSchema {
  readonly name: string;
  readonly columns: readonly [string, ...string[]];
  readonly unique?: true;
}

export interface UniversalComponentOrderedScanSchema {
  readonly name: string;
  readonly table: string;
  /** Ascending lexicographic cursor columns. */
  readonly columns: readonly [string, ...string[]];
}

export interface UniversalComponentTableSchema {
  readonly name: string;
  readonly columns: readonly UniversalComponentColumnSchema[];
  readonly checks?: readonly UniversalComponentCheckSchema[];
  readonly indexes?: readonly UniversalComponentIndexSchema[];
}

export interface UniversalComponentSchemaVersion {
  readonly version: string;
  readonly tables: readonly UniversalComponentTableSchema[];
  readonly orderedScans?: readonly UniversalComponentOrderedScanSchema[];
}

export interface UniversalComponentSchema {
  readonly id: string;
  /** Rules for adopting physical state created before the component marker. */
  readonly unmarked?: UniversalComponentUnmarkedPolicy;
  /** Oldest to newest. The final entry is the runtime schema. */
  readonly versions: readonly [
    UniversalComponentSchemaVersion,
    ...UniversalComponentSchemaVersion[],
  ];
}

export type UniversalComponentUnmarkedValue = string | null;

export interface UniversalComponentUnmarkedAdoption {
  readonly version: string;
  readonly when: readonly [
    UniversalComponentUnmarkedValue,
    ...UniversalComponentUnmarkedValue[],
  ];
}

export interface UniversalComponentUnmarkedPolicy {
  readonly adopt: readonly UniversalComponentUnmarkedAdoption[];
  readonly createWhen: readonly UniversalComponentUnmarkedValue[];
  readonly discriminatorKey: string;
  readonly knownValues: readonly [
    UniversalComponentUnmarkedValue,
    ...UniversalComponentUnmarkedValue[],
  ];
}

export type UniversalComponentUnmarkedDecision =
  | { readonly kind: "adopt"; readonly version: string }
  | { readonly kind: "create" }
  | { readonly kind: "reject" };

export interface UniversalComponentUnmarkedState {
  readonly discriminatorValue: UniversalComponentUnmarkedValue;
  readonly physicalVersion: string | null;
}

export interface UniversalComponentMigrationState extends UniversalComponentUnmarkedState {
  readonly markerVersion: string | null;
}

export type UniversalComponentMigrationDecision =
  | {
      readonly kind: "adopt";
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | { readonly kind: "create"; readonly targetVersion: string }
  | {
      readonly kind: "migrate";
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "reject" };

export interface UniversalComponentArtifact {
  readonly contents: string;
  readonly path: string;
  /** Declared schema version that the artifact creates or migrates to. */
  readonly targetVersion: string;
}

export interface UniversalComponentMigrationResult {
  readonly changed: boolean;
  readonly version: string;
}

export interface UniversalComponentAppendInput {
  readonly row: UniversalComponentRow;
  readonly table: string;
}

export interface UniversalComponentGetInput {
  readonly primaryKey: string;
  readonly table: string;
}

export interface UniversalComponentRowValidationInput extends UniversalComponentAppendInput {
  readonly version: string;
}

export interface UniversalComponentOrderedScanInput {
  readonly accessPattern: string;
  /** Exclusive cursor containing every access-pattern column. */
  readonly afterExclusive?: readonly UniversalComponentScalar[];
  /** Exclusive upper-bound prefix, starting at the first cursor column. */
  readonly beforePrefixExclusive: readonly UniversalComponentScalar[];
  readonly limit: number;
}

export interface UniversalComponentDataSource {
  readonly schema: UniversalComponentSchema;
  /**
   * Implementations must reject writes with
   * UniversalComponentDataNotReadyError while declared component state is not
   * ready. Operational backend errors must remain distinguishable.
   */
  append(input: UniversalComponentAppendInput): Promise<void>;
  /**
   * Creates a row only when its declared primary key is absent. Existing rows
   * must remain unchanged. Readiness and operational-error semantics match
   * append().
   */
  create(input: UniversalComponentAppendInput): Promise<"created" | "existing">;
  /**
   * Reads one row by the declared primary key. Missing rows resolve to null.
   * Readiness and operational-error semantics match orderedScan().
   */
  get(input: UniversalComponentGetInput): Promise<UniversalComponentRow | null>;
  /**
   * A latest-marker mismatch or a failed physical-schema, index, or stored-data
   * readiness validation must reject with UniversalComponentDataNotReadyError.
   * Operational backend errors must not be reclassified as readiness failures.
   */
  assertReady(): Promise<void>;
  /**
   * Implementations must reject reads with UniversalComponentDataNotReadyError
   * while declared component state is not ready. Operational backend errors
   * must remain distinguishable.
   */
  orderedScan(
    input: UniversalComponentOrderedScanInput,
  ): Promise<readonly UniversalComponentRow[]>;
}

export interface UniversalComponentDataAdapter {
  /** Pure synchronous binding. It must not create or migrate physical state. */
  bind(schema: UniversalComponentSchema): UniversalComponentDataSource;
  /** Generates provider artifacts for declared target schema versions. */
  artifacts?(
    schema: UniversalComponentSchema,
  ): readonly UniversalComponentArtifact[];
  /**
   * Validates physical catalogs against storage-enforced checks and rows
   * against every check, applies only declared adjacent transitions, then
   * writes the component marker last.
   */
  migrate?(
    schema: UniversalComponentSchema,
  ): Promise<UniversalComponentMigrationResult>;
}

export class UniversalComponentDataNotReadyError extends Error {
  readonly name: string = "UniversalComponentDataNotReadyError";

  constructor(
    readonly componentId: string,
    readonly expectedVersion: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class UniversalComponentSchemaNotReadyError extends UniversalComponentDataNotReadyError {
  readonly name = "UniversalComponentSchemaNotReadyError";

  constructor(
    componentId: string,
    expectedVersion: string,
    readonly actualVersion: string | null,
  ) {
    super(
      componentId,
      expectedVersion,
      `Component ${componentId} requires schema version ${expectedVersion}; found ${actualVersion ?? "no marker"}.`,
    );
  }
}

export type UniversalComponentDataStateNotReadyReason =
  | "index"
  | "physical-schema"
  | "stored-data";

export class UniversalComponentDataStateNotReadyError extends UniversalComponentDataNotReadyError {
  readonly name = "UniversalComponentDataStateNotReadyError";

  constructor(
    componentId: string,
    expectedVersion: string,
    readonly reason: UniversalComponentDataStateNotReadyReason,
    options?: ErrorOptions,
  ) {
    super(
      componentId,
      expectedVersion,
      `Component ${componentId} schema version ${expectedVersion} is not ready: ${reason}.`,
      options,
    );
  }
}

export class UniversalComponentDataContractError extends TypeError {
  readonly name = "UniversalComponentDataContractError";
}

const componentIdPattern = /^[a-z][a-z0-9-]*$/;
const columnTypes = new Set<UniversalComponentColumnType>([
  "boolean",
  "float",
  "integer",
  "json",
  "string",
  "uuid",
]);
const markerKeyPattern = /^[a-z][a-z0-9._-]*$/;
const storageNamePattern = /^[a-z][a-z0-9_]*$/;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const invalidSchema = (message: string): never => {
  throw new TypeError(`Invalid universal component schema: ${message}`);
};

const freezeColumn = (
  column: UniversalComponentColumnSchema,
): UniversalComponentColumnSchema =>
  Object.freeze({
    name: column.name,
    type: column.type,
    ...(column.nullable ? { nullable: true as const } : {}),
    ...(column.primaryKey ? { primaryKey: true as const } : {}),
  });

const isCheckValue = (value: unknown): value is UniversalComponentCheckValue =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "string";

const checkValueMatchesColumn = (
  value: UniversalComponentCheckValue,
  column: UniversalComponentColumnSchema,
): boolean => {
  switch (column.type) {
    case "boolean":
      return typeof value === "boolean";
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "json":
      return false;
    case "string":
    case "uuid":
      return typeof value === "string";
  }
};

const freezeCheckExpression = (
  value: UniversalComponentCheckExpression,
  columns: ReadonlyMap<string, UniversalComponentColumnSchema>,
  ancestors = new Set<object>(),
): UniversalComponentCheckExpression => {
  if (!isObject(value) || ancestors.has(value)) {
    return invalidSchema("check expression must be an acyclic object");
  }
  ancestors.add(value);
  try {
    const op = Reflect.get(value, "op");
    if (op === "all" || op === "any") {
      const expressions = Reflect.get(value, "expressions");
      if (!Array.isArray(expressions) || expressions.length === 0) {
        return invalidSchema(`${op} check requires expressions`);
      }
      return Object.freeze({
        expressions: Object.freeze(
          expressions.map((expression) =>
            freezeCheckExpression(expression, columns, ancestors),
          ),
        ) as readonly [
          UniversalComponentCheckExpression,
          ...UniversalComponentCheckExpression[],
        ],
        op,
      });
    }

    const columnName = Reflect.get(value, "column");
    const column =
      typeof columnName === "string" ? columns.get(columnName) : undefined;
    if (column === undefined) {
      return invalidSchema(`check has an unknown column ${String(columnName)}`);
    }
    if (op === "eq") {
      const expected = Reflect.get(value, "value");
      if (
        !isCheckValue(expected) ||
        !checkValueMatchesColumn(expected, column)
      ) {
        return invalidSchema(`eq check has an invalid value for ${columnName}`);
      }
      return Object.freeze({ column: columnName, op, value: expected });
    }
    if (op === "in") {
      const expected = Reflect.get(value, "values");
      if (
        !Array.isArray(expected) ||
        expected.length === 0 ||
        new Set(expected).size !== expected.length ||
        expected.some(
          (item) =>
            !isCheckValue(item) || !checkValueMatchesColumn(item, column),
        )
      ) {
        return invalidSchema(`in check has invalid values for ${columnName}`);
      }
      return Object.freeze({
        column: columnName,
        op,
        values: Object.freeze([...expected]) as readonly [
          UniversalComponentCheckValue,
          ...UniversalComponentCheckValue[],
        ],
      });
    }
    if (op === "gte" || op === "lte") {
      const expected = Reflect.get(value, "value");
      if (
        (column.type !== "float" && column.type !== "integer") ||
        typeof expected !== "number" ||
        !Number.isFinite(expected)
      ) {
        return invalidSchema(`${op} check requires a numeric column and value`);
      }
      return Object.freeze({ column: columnName, op, value: expected });
    }
    if (op === "integer") {
      if (column.type !== "float" && column.type !== "integer") {
        return invalidSchema("integer check requires a numeric column");
      }
      return Object.freeze({ column: columnName, op });
    }
    if (op === "non-empty") {
      if (column.type !== "string" && column.type !== "uuid") {
        return invalidSchema("non-empty check requires a string column");
      }
      return Object.freeze({ column: columnName, op });
    }
    if (op === "is-null" || op === "is-not-null") {
      if (op === "is-null" && column.nullable !== true) {
        return invalidSchema("is-null check requires a nullable column");
      }
      return Object.freeze({ column: columnName, op });
    }
    return invalidSchema(`unknown check operation ${String(op)}`);
  } finally {
    ancestors.delete(value);
  }
};

const freezeVersion = (
  version: UniversalComponentSchemaVersion,
): UniversalComponentSchemaVersion => {
  if (typeof version.version !== "string" || version.version.length === 0) {
    return invalidSchema("version must be a non-empty string");
  }
  if (!Array.isArray(version.tables) || version.tables.length === 0) {
    return invalidSchema(`version ${version.version} requires a table`);
  }
  const tableNames = new Set<string>();
  const tables: UniversalComponentTableSchema[] = version.tables.map(
    (table: UniversalComponentTableSchema) => {
      if (!storageNamePattern.test(table.name) || tableNames.has(table.name)) {
        return invalidSchema(`invalid or duplicate table ${table.name}`);
      }
      tableNames.add(table.name);
      if (!Array.isArray(table.columns) || table.columns.length === 0) {
        return invalidSchema(`table ${table.name} requires a column`);
      }
      const columnNames = new Set<string>();
      let primaryKeys = 0;
      const columns: UniversalComponentColumnSchema[] = table.columns.map(
        (column: UniversalComponentColumnSchema) => {
          if (
            !storageNamePattern.test(column.name) ||
            columnNames.has(column.name) ||
            !columnTypes.has(column.type)
          ) {
            return invalidSchema(
              `invalid or duplicate column ${table.name}.${column.name}`,
            );
          }
          columnNames.add(column.name);
          if (column.primaryKey) primaryKeys += 1;
          return freezeColumn(column);
        },
      );
      if (primaryKeys !== 1) {
        return invalidSchema(`table ${table.name} requires one primary key`);
      }
      const primaryKey = columns.find(
        (column: UniversalComponentColumnSchema) => column.primaryKey,
      )!;
      if (
        (primaryKey.type !== "string" && primaryKey.type !== "uuid") ||
        primaryKey.nullable === true
      ) {
        return invalidSchema(
          `table ${table.name} requires a non-nullable string or uuid primary key`,
        );
      }
      const indexNames = new Set<string>();
      const indexes = (table.indexes ?? []).map(
        (index: UniversalComponentIndexSchema) => {
          if (
            !storageNamePattern.test(index.name) ||
            indexNames.has(index.name)
          ) {
            return invalidSchema(`invalid or duplicate index ${index.name}`);
          }
          indexNames.add(index.name);
          if (!Array.isArray(index.columns) || index.columns.length === 0) {
            return invalidSchema(`index ${index.name} requires columns`);
          }
          if (
            index.columns.some((column: string) => !columnNames.has(column))
          ) {
            return invalidSchema(`index ${index.name} has an unknown column`);
          }
          if (new Set(index.columns).size !== index.columns.length) {
            return invalidSchema(`index ${index.name} repeats a column`);
          }
          return Object.freeze({
            columns: Object.freeze([...index.columns]) as readonly [
              string,
              ...string[],
            ],
            name: index.name,
            ...(index.unique ? { unique: true as const } : {}),
          });
        },
      );
      const columnsByName = new Map<string, UniversalComponentColumnSchema>(
        columns.map((column) => [column.name, column] as const),
      );
      const checkNames = new Set<string>();
      const checks: UniversalComponentCheckSchema[] = (table.checks ?? []).map(
        (check: UniversalComponentCheckSchema) => {
          if (
            !storageNamePattern.test(check.name) ||
            checkNames.has(check.name) ||
            (check.enforcement !== undefined &&
              check.enforcement !== "storage" &&
              check.enforcement !== "validation")
          ) {
            return invalidSchema(`invalid or duplicate check ${check.name}`);
          }
          checkNames.add(check.name);
          return Object.freeze({
            ...(check.enforcement === "validation"
              ? { enforcement: "validation" as const }
              : {}),
            expression: freezeCheckExpression(check.expression, columnsByName),
            name: check.name,
          });
        },
      );
      return Object.freeze({
        checks: Object.freeze(checks),
        columns: Object.freeze(columns),
        indexes: Object.freeze(indexes),
        name: table.name,
      });
    },
  );
  const accessPatternNames = new Set<string>();
  const orderedScans = (version.orderedScans ?? []).map((scan) => {
    if (
      !storageNamePattern.test(scan.name) ||
      accessPatternNames.has(scan.name)
    ) {
      return invalidSchema(`invalid or duplicate access pattern ${scan.name}`);
    }
    accessPatternNames.add(scan.name);
    const table = tables.find((candidate) => candidate.name === scan.table);
    if (table === undefined) {
      return invalidSchema(`access pattern ${scan.name} has an unknown table`);
    }
    if (!Array.isArray(scan.columns) || scan.columns.length === 0) {
      return invalidSchema(`access pattern ${scan.name} requires columns`);
    }
    const columnsByName = new Map<string, UniversalComponentColumnSchema>(
      table.columns.map(
        (column: UniversalComponentColumnSchema) =>
          [column.name, column] as const,
      ),
    );
    if (scan.columns.some((column) => !columnsByName.has(column))) {
      return invalidSchema(`access pattern ${scan.name} has an unknown column`);
    }
    if (new Set(scan.columns).size !== scan.columns.length) {
      return invalidSchema(`access pattern ${scan.name} repeats a column`);
    }
    if (
      scan.columns.some((column) => {
        const definition = columnsByName.get(column)!;
        return (
          definition.nullable === true ||
          !["float", "integer", "string", "uuid"].includes(definition.type)
        );
      })
    ) {
      return invalidSchema(
        `access pattern ${scan.name} requires non-nullable ordered columns`,
      );
    }
    return Object.freeze({
      columns: Object.freeze([...scan.columns]) as readonly [
        string,
        ...string[],
      ],
      name: scan.name,
      table: scan.table,
    });
  });
  return Object.freeze({
    orderedScans: Object.freeze(orderedScans),
    tables: Object.freeze(tables),
    version: version.version,
  });
};

const stableColumnDefinition = (
  column: UniversalComponentColumnSchema,
): Readonly<
  Pick<UniversalComponentColumnSchema, "name" | "primaryKey" | "type">
> => ({
  name: column.name,
  ...(column.primaryKey ? { primaryKey: true } : {}),
  type: column.type,
});

const validateAdjacentTransition = (
  previous: UniversalComponentSchemaVersion,
  next: UniversalComponentSchemaVersion,
): void => {
  if (
    previous.tables.length !== next.tables.length ||
    previous.tables.some((table, tableIndex) => {
      const nextTable = next.tables[tableIndex];
      return (
        nextTable === undefined ||
        table.name !== nextTable.name ||
        table.columns.length !== nextTable.columns.length ||
        table.columns.some((column, columnIndex) => {
          const nextColumn = nextTable.columns[columnIndex];
          return (
            nextColumn === undefined ||
            JSON.stringify(stableColumnDefinition(column)) !==
              JSON.stringify(stableColumnDefinition(nextColumn))
          );
        })
      );
    })
  ) {
    return invalidSchema(
      `unsupported transition ${previous.version} to ${next.version}; table and column identity, order, type, and primary key must remain stable`,
    );
  }
};

const validUnmarkedValue = (
  value: unknown,
): value is UniversalComponentUnmarkedValue =>
  value === null || (typeof value === "string" && value.length > 0);

const uniqueUnmarkedValues = (
  values: unknown,
  name: string,
  allowEmpty: boolean,
): readonly UniversalComponentUnmarkedValue[] => {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.some((value) => !validUnmarkedValue(value)) ||
    new Set(values).size !== values.length
  ) {
    return invalidSchema(`${name} requires unique string or null values`);
  }
  return Object.freeze([...values]);
};

const freezeUnmarkedPolicy = (
  componentId: string,
  policy: UniversalComponentUnmarkedPolicy,
  versions: readonly UniversalComponentSchemaVersion[],
): UniversalComponentUnmarkedPolicy => {
  if (
    !isObject(policy) ||
    !markerKeyPattern.test(policy.discriminatorKey) ||
    policy.discriminatorKey === `schema.${componentId}`
  ) {
    return invalidSchema(
      "unmarked policy requires a distinct discriminator key",
    );
  }
  const knownValues = uniqueUnmarkedValues(
    policy.knownValues,
    "unmarked knownValues",
    false,
  ) as UniversalComponentUnmarkedPolicy["knownValues"];
  const known = new Set(knownValues);
  const createWhen = uniqueUnmarkedValues(
    policy.createWhen,
    "unmarked createWhen",
    true,
  );
  if (createWhen.some((value) => !known.has(value))) {
    return invalidSchema("unmarked createWhen contains an unknown value");
  }
  if (!Array.isArray(policy.adopt)) {
    return invalidSchema("unmarked adopt must be an array");
  }
  const versionNames = new Set(versions.map(({ version }) => version));
  const adoptionVersions = new Set<string>();
  const adopt: UniversalComponentUnmarkedAdoption[] = policy.adopt.map(
    (adoption) => {
      const adoptionVersion = isObject(adoption)
        ? Reflect.get(adoption, "version")
        : undefined;
      if (
        typeof adoptionVersion !== "string" ||
        !versionNames.has(adoptionVersion) ||
        adoptionVersions.has(adoptionVersion)
      ) {
        return invalidSchema(
          "unmarked adoption requires a unique known version",
        );
      }
      adoptionVersions.add(adoptionVersion);
      const when = uniqueUnmarkedValues(
        Reflect.get(adoption, "when"),
        `unmarked adoption ${adoptionVersion}`,
        false,
      ) as UniversalComponentUnmarkedAdoption["when"];
      if (when.some((value) => !known.has(value))) {
        return invalidSchema(
          `unmarked adoption ${adoptionVersion} contains an unknown value`,
        );
      }
      return Object.freeze({ version: adoptionVersion, when });
    },
  );
  return Object.freeze({
    adopt: Object.freeze(adopt),
    createWhen,
    discriminatorKey: policy.discriminatorKey,
    knownValues,
  });
};

export const defineUniversalComponentSchema = (
  schema: UniversalComponentSchema,
): UniversalComponentSchema => {
  if (!componentIdPattern.test(schema.id)) {
    return invalidSchema(`invalid component id ${schema.id}`);
  }
  if (!Array.isArray(schema.versions) || schema.versions.length === 0) {
    return invalidSchema(`component ${schema.id} requires a version`);
  }
  const versionNames = new Set<string>();
  const versions = schema.versions.map((version) => {
    if (versionNames.has(version.version)) {
      return invalidSchema(`duplicate version ${version.version}`);
    }
    versionNames.add(version.version);
    return freezeVersion(version);
  }) as unknown as UniversalComponentSchema["versions"];
  for (let index = 1; index < versions.length; index += 1) {
    validateAdjacentTransition(versions[index - 1]!, versions[index]!);
  }
  const unmarked =
    schema.unmarked === undefined
      ? undefined
      : freezeUnmarkedPolicy(schema.id, schema.unmarked, versions);
  return Object.freeze({
    id: schema.id,
    ...(unmarked === undefined ? {} : { unmarked }),
    versions: Object.freeze(versions),
  });
};

export const getUniversalComponentSchemaMarkerKey = (
  schema: Pick<UniversalComponentSchema, "id">,
): `schema.${string}` => `schema.${schema.id}`;

export const getUniversalComponentLatestSchema = (
  schema: UniversalComponentSchema,
): UniversalComponentSchemaVersion =>
  schema.versions[schema.versions.length - 1]!;

const contractError = (message: string): never => {
  throw new UniversalComponentDataContractError(message);
};

export const getUniversalComponentSchemaVersion = (
  schema: UniversalComponentSchema,
  version: string,
): UniversalComponentSchemaVersion =>
  schema.versions.find((candidate) => candidate.version === version) ??
  contractError(`Unknown component schema version: ${version}`);

export const getUniversalComponentTable = (
  schema: UniversalComponentSchema,
  tableName: string,
  version = getUniversalComponentLatestSchema(schema).version,
): UniversalComponentTableSchema => {
  const table = getUniversalComponentSchemaVersion(schema, version).tables.find(
    ({ name }) => name === tableName,
  );
  return table ?? contractError(`Unknown component table: ${tableName}`);
};

export const resolveUniversalComponentUnmarkedState = (
  schema: UniversalComponentSchema,
  state: UniversalComponentUnmarkedState,
): UniversalComponentUnmarkedDecision => {
  const physicalVersion = state.physicalVersion;
  if (
    physicalVersion !== null &&
    !schema.versions.some(({ version }) => version === physicalVersion)
  ) {
    return Object.freeze({ kind: "reject" });
  }
  const policy = schema.unmarked;
  if (policy === undefined) {
    return Object.freeze(
      physicalVersion === null
        ? { kind: "create" as const }
        : { kind: "adopt" as const, version: physicalVersion },
    );
  }
  if (!policy.knownValues.includes(state.discriminatorValue)) {
    return Object.freeze({ kind: "reject" });
  }
  if (physicalVersion === null) {
    return Object.freeze(
      policy.createWhen.includes(state.discriminatorValue)
        ? { kind: "create" as const }
        : { kind: "reject" as const },
    );
  }
  const adoption = policy.adopt.find(
    ({ version }) => version === physicalVersion,
  );
  return Object.freeze(
    adoption?.when.includes(state.discriminatorValue) === true
      ? { kind: "adopt" as const, version: physicalVersion }
      : { kind: "reject" as const },
  );
};

export const resolveUniversalComponentMigrationState = (
  schema: UniversalComponentSchema,
  state: UniversalComponentMigrationState,
): UniversalComponentMigrationDecision => {
  const targetVersion = getUniversalComponentLatestSchema(schema).version;
  if (state.markerVersion === null) {
    const decision = resolveUniversalComponentUnmarkedState(schema, state);
    switch (decision.kind) {
      case "adopt":
        return Object.freeze({
          fromVersion: decision.version,
          kind: decision.version === targetVersion ? "adopt" : "migrate",
          targetVersion,
        });
      case "create":
        return Object.freeze({ kind: "create", targetVersion });
      case "reject":
        return Object.freeze({ kind: "reject" });
    }
  }

  if (
    schema.unmarked !== undefined &&
    !schema.unmarked.knownValues.includes(state.discriminatorValue)
  ) {
    return Object.freeze({ kind: "reject" });
  }
  const markerIndex = schema.versions.findIndex(
    ({ version }) => version === state.markerVersion,
  );
  const physicalIndex = schema.versions.findIndex(
    ({ version }) => version === state.physicalVersion,
  );
  if (
    markerIndex === -1 ||
    physicalIndex === -1 ||
    markerIndex > physicalIndex
  ) {
    return Object.freeze({ kind: "reject" });
  }
  if (
    markerIndex === schema.versions.length - 1 &&
    physicalIndex === markerIndex
  ) {
    return Object.freeze({ kind: "ready", version: targetVersion });
  }
  if (physicalIndex === schema.versions.length - 1) {
    return Object.freeze({
      fromVersion: targetVersion,
      kind: "adopt",
      targetVersion,
    });
  }
  return Object.freeze({
    fromVersion: schema.versions[physicalIndex]!.version,
    kind: "migrate",
    targetVersion,
  });
};

export const getUniversalComponentOrderedScan = (
  schema: UniversalComponentSchema,
  accessPattern: string,
): UniversalComponentOrderedScanSchema => {
  const scan = getUniversalComponentLatestSchema(schema).orderedScans?.find(
    ({ name }) => name === accessPattern,
  );
  return (
    scan ?? contractError(`Unknown component access pattern: ${accessPattern}`)
  );
};

const valueMatchesColumn = (
  value: DatabaseJsonValue | undefined,
  column: UniversalComponentColumnSchema,
): boolean => {
  if (value === null) return column.nullable === true;
  switch (column.type) {
    case "boolean":
      return typeof value === "boolean";
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "json":
      return value !== undefined && isUniversalComponentDataValue(value);
    case "string":
      return typeof value === "string";
    case "uuid":
      // Native UUID providers enforce syntax. Existing document providers use
      // non-empty logical identifiers, so the shared contract preserves them.
      return typeof value === "string" && value.length > 0;
  }
};

export const evaluateUniversalComponentCheck = (
  expression: UniversalComponentCheckExpression,
  row: UniversalComponentRow,
): boolean => {
  switch (expression.op) {
    case "all":
      return expression.expressions.every((item) =>
        evaluateUniversalComponentCheck(item, row),
      );
    case "any":
      return expression.expressions.some((item) =>
        evaluateUniversalComponentCheck(item, row),
      );
    case "eq":
      return row[expression.column] === expression.value;
    case "in":
      return expression.values.includes(
        row[expression.column] as UniversalComponentCheckValue,
      );
    case "gte": {
      const value = row[expression.column];
      return typeof value === "number" && value >= expression.value;
    }
    case "lte": {
      const value = row[expression.column];
      return typeof value === "number" && value <= expression.value;
    }
    case "integer":
      return Number.isSafeInteger(row[expression.column]);
    case "is-not-null":
      return row[expression.column] !== null;
    case "is-null":
      return row[expression.column] === null;
    case "non-empty": {
      const value = row[expression.column];
      return typeof value === "string" && value.length > 0;
    }
  }
};

export const validateUniversalComponentRow = (
  schema: UniversalComponentSchema,
  input: UniversalComponentRowValidationInput,
): UniversalComponentTableSchema => {
  const table = getUniversalComponentTable(schema, input.table, input.version);
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const primaryKey = table.columns.find((column) => column.primaryKey)!;
  const primaryKeyValue = input.row[primaryKey.name];
  if (
    Reflect.ownKeys(input.row).length !== table.columns.length ||
    Object.keys(input.row).some((name) => !columns.has(name)) ||
    typeof primaryKeyValue !== "string" ||
    primaryKeyValue.length === 0 ||
    primaryKeyValue.includes("/") ||
    table.columns.some(
      (column) =>
        !Object.hasOwn(input.row, column.name) ||
        !valueMatchesColumn(input.row[column.name], column),
    ) ||
    (table.checks ?? []).some(
      ({ expression }) =>
        !evaluateUniversalComponentCheck(expression, input.row),
    )
  ) {
    return contractError(
      `Invalid row for component table: ${input.table}@${input.version}`,
    );
  }
  return table;
};

export const validateUniversalComponentAppend = (
  schema: UniversalComponentSchema,
  input: UniversalComponentAppendInput,
): UniversalComponentTableSchema =>
  validateUniversalComponentRow(schema, {
    ...input,
    version: getUniversalComponentLatestSchema(schema).version,
  });

export const validateUniversalComponentGet = (
  schema: UniversalComponentSchema,
  input: UniversalComponentGetInput,
): UniversalComponentTableSchema => {
  const table = getUniversalComponentTable(schema, input.table);
  if (
    typeof input.primaryKey !== "string" ||
    input.primaryKey.length === 0 ||
    input.primaryKey.includes("/")
  ) {
    return contractError(
      `Invalid primary key for component table: ${input.table}`,
    );
  }
  return table;
};

export const validateUniversalComponentOrderedScan = (
  schema: UniversalComponentSchema,
  input: UniversalComponentOrderedScanInput,
): UniversalComponentOrderedScanSchema => {
  const scan = getUniversalComponentOrderedScan(schema, input.accessPattern);
  const table = getUniversalComponentTable(schema, scan.table);
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const matchesCursor = (values: readonly UniversalComponentScalar[]) =>
    values.every((value, index) => {
      const columnName = scan.columns[index];
      return (
        columnName !== undefined &&
        valueMatchesColumn(value, columns.get(columnName)!)
      );
    });
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.beforePrefixExclusive.length === 0 ||
    input.beforePrefixExclusive.length > scan.columns.length ||
    !matchesCursor(input.beforePrefixExclusive) ||
    (input.afterExclusive !== undefined &&
      (input.afterExclusive.length !== scan.columns.length ||
        !matchesCursor(input.afterExclusive)))
  ) {
    return contractError(
      `Invalid scan input for component access pattern: ${input.accessPattern}`,
    );
  }
  return scan;
};

export const parseUniversalComponentDataAdapter = (
  value: unknown,
): UniversalComponentDataAdapter => {
  if (
    !isObject(value) ||
    typeof Reflect.get(value, "bind") !== "function" ||
    (Reflect.get(value, "artifacts") !== undefined &&
      typeof Reflect.get(value, "artifacts") !== "function") ||
    (Reflect.get(value, "migrate") !== undefined &&
      typeof Reflect.get(value, "migrate") !== "function")
  ) {
    throw new TypeError("Invalid universal component data adapter");
  }
  return value as UniversalComponentDataAdapter;
};

export const universalComponentDataAdapterCapability: CapabilityToken<UniversalComponentDataAdapter> =
  defineSharedCapability({
    id: "hot-updater.component-data.adapter@1",
    parse: parseUniversalComponentDataAdapter,
  });

export const attachUniversalComponentDataAdapter = <TCarrier extends object>(
  carrier: TCarrier extends (...args: never[]) => unknown ? never : TCarrier,
  create: (
    runtime: HotUpdaterInfrastructureRuntime,
  ) => UniversalComponentDataAdapter,
): TCarrier =>
  attachCapabilityContribution(carrier, {
    create,
    token: universalComponentDataAdapterCapability,
  });

export const isUniversalComponentDataValue = (
  value: unknown,
): value is DatabaseJsonValue => isDatabaseJsonValue(value);
