import {
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  getUniversalComponentSchemaVersion,
  getUniversalComponentTable,
  resolveUniversalComponentMigrationState,
  type UniversalComponentArtifact,
  type UniversalComponentDataAdapter,
  type UniversalComponentDataSource,
  type UniversalComponentRow,
  type UniversalComponentSchema,
  UniversalComponentSchemaNotReadyError,
  type UniversalComponentTableSchema,
  validateUniversalComponentOrderedScan,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";
import {
  FieldPath,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

const SETTINGS_COLLECTION = "private_hot_updater_settings";
const VALIDATION_PAGE_SIZE = 500;

type FirestoreIndex = {
  readonly collectionGroup: string;
  readonly fields: readonly {
    readonly fieldPath: string;
    readonly order: "ASCENDING";
  }[];
  readonly queryScope: "COLLECTION";
};

type FirestoreIndexFile = Readonly<Record<string, unknown>> & {
  readonly fieldOverrides: readonly unknown[];
  readonly indexes: readonly unknown[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJson(value));

const parseIndexFile = (
  contents: string,
  source: string,
): FirestoreIndexFile => {
  const parsed: unknown = JSON.parse(contents);
  if (
    !isRecord(parsed) ||
    (parsed.indexes !== undefined && !Array.isArray(parsed.indexes)) ||
    (parsed.fieldOverrides !== undefined &&
      !Array.isArray(parsed.fieldOverrides))
  ) {
    throw new TypeError(`Invalid Firestore index JSON: ${source}`);
  }
  return {
    ...parsed,
    fieldOverrides: parsed.fieldOverrides ?? [],
    indexes: parsed.indexes ?? [],
  };
};

const mergeJsonEntries = (entries: readonly unknown[]): readonly unknown[] =>
  [
    ...new Map(entries.map((entry) => [canonicalJson(entry), entry])).values(),
  ].toSorted((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );

/**
 * Merges version-tagged component fragments into a Firebase CLI aggregate.
 * The caller owns reading and writing the aggregate file.
 */
export const mergeFirebaseComponentIndexArtifacts = (
  existingContents: string,
  componentArtifacts: readonly UniversalComponentArtifact[],
): string => {
  const existing = parseIndexFile(existingContents, "existing aggregate");
  const fragments = componentArtifacts.map((artifact) =>
    parseIndexFile(artifact.contents, artifact.path),
  );
  const merged = canonicalizeJson({
    ...existing,
    fieldOverrides: mergeJsonEntries([
      ...existing.fieldOverrides,
      ...fragments.flatMap((fragment) => fragment.fieldOverrides),
    ]),
    indexes: mergeJsonEntries([
      ...existing.indexes,
      ...fragments.flatMap((fragment) => fragment.indexes),
    ]),
  });
  return `${JSON.stringify(merged, null, 2)}\n`;
};

const validateRow = (
  schema: UniversalComponentSchema,
  version: string,
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
  documentId?: string,
): string => {
  validateUniversalComponentRow(schema, {
    row,
    table: table.name,
    version,
  });
  const primaryKey = table.columns.find((column) => column.primaryKey)!;
  const primaryKeyValue = row[primaryKey.name] as string;
  if (documentId !== undefined && documentId !== primaryKeyValue) {
    throw new TypeError(
      `Component document key does not match ${table.name}.${primaryKey.name}`,
    );
  }
  return primaryKeyValue;
};

const assertIndexesSupported = (schema: UniversalComponentSchema): void => {
  for (const schemaVersion of schema.versions) {
    for (const table of schemaVersion.tables) {
      if (table.indexes?.some((index) => index.unique) === true) {
        throw new TypeError(
          `Firebase cannot enforce unique component index on ${table.name}`,
        );
      }
    }
  }
};

const createIndexes = (
  schema: UniversalComponentSchema,
  version: string,
): readonly FirestoreIndex[] => {
  assertIndexesSupported(schema);
  const target = getUniversalComponentSchemaVersion(schema, version);
  const definitions = (target.orderedScans ?? []).map((scan) => ({
    columns: scan.columns,
    table: getUniversalComponentTable(schema, scan.table, version),
  }));
  const indexes = new Map<string, FirestoreIndex>();
  for (const definition of definitions) {
    if (definition.columns.length < 2) continue;
    const key = `${definition.table.name}:${definition.columns.join(",")}`;
    indexes.set(key, {
      collectionGroup: definition.table.name,
      fields: definition.columns.map((fieldPath) => ({
        fieldPath,
        order: "ASCENDING",
      })),
      queryScope: "COLLECTION",
    });
  }
  return [...indexes.values()];
};

const createArtifact = (
  schema: UniversalComponentSchema,
  version: string,
): UniversalComponentArtifact => ({
  contents: `${JSON.stringify(
    { fieldOverrides: [], indexes: createIndexes(schema, version) },
    null,
    2,
  )}\n`,
  path: `firestore.indexes.${schema.id}.${version}.json`,
  targetVersion: version,
});

export class FirebaseUniversalComponentSchemaStateError extends Error {
  readonly name = "FirebaseUniversalComponentSchemaStateError";

  constructor(readonly setting: string) {
    super(`Invalid universal component schema setting: ${setting}`);
  }
}

const settingValue = async (
  db: Firestore,
  setting: string,
): Promise<unknown> => {
  const document = await db.collection(SETTINGS_COLLECTION).doc(setting).get();
  if (!document.exists) return null;
  const data = document.data();
  if (
    isRecord(data) &&
    Reflect.ownKeys(data).length === 1 &&
    Object.hasOwn(data, "value")
  ) {
    return Reflect.get(data, "value");
  }
  throw new FirebaseUniversalComponentSchemaStateError(setting);
};

const markerValue = async (
  db: Firestore,
  schema: UniversalComponentSchema,
): Promise<string | null> => {
  const setting = getUniversalComponentSchemaMarkerKey(schema);
  const value = await settingValue(db, setting);
  if (value === null || typeof value === "string") return value;
  throw new FirebaseUniversalComponentSchemaStateError(setting);
};

const assertMarker = async (
  db: Firestore,
  schema: UniversalComponentSchema,
): Promise<void> => {
  const expectedVersion = getUniversalComponentLatestSchema(schema).version;
  const actualVersion = await markerValue(db, schema);
  if (actualVersion !== expectedVersion) {
    throw new UniversalComponentSchemaNotReadyError(
      schema.id,
      expectedVersion,
      actualVersion,
    );
  }
};

const validatePhysicalIndexes = async (
  db: Firestore,
  schema: UniversalComponentSchema,
  version: string,
): Promise<void> => {
  assertIndexesSupported(schema);
  const target = getUniversalComponentSchemaVersion(schema, version);
  await Promise.all(
    (target.orderedScans ?? []).map(async (scan) => {
      let query: Query = db.collection(scan.table);
      for (const column of scan.columns) {
        query = query.orderBy(column, "asc");
      }
      await query.limit(1).get();
    }),
  );
};

type StoredDocument = {
  readonly documentId: string;
  readonly row: UniversalComponentRow;
};

type StoredDocumentVisitor = (
  tableName: string,
  document: StoredDocument,
) => void;

const visitStoredDocuments = async (
  db: Firestore,
  schema: UniversalComponentSchema,
  visit: StoredDocumentVisitor,
): Promise<boolean> => {
  let hasDocuments = false;
  for (const table of getUniversalComponentLatestSchema(schema).tables) {
    let cursor: QueryDocumentSnapshot | undefined;
    while (true) {
      const ordered = db
        .collection(table.name)
        .orderBy(FieldPath.documentId(), "asc")
        .limit(VALIDATION_PAGE_SIZE);
      const snapshot = await (
        cursor === undefined ? ordered : ordered.startAfter(cursor)
      ).get();
      for (const document of snapshot.docs) {
        hasDocuments = true;
        visit(table.name, {
          documentId: document.id,
          row: document.data(),
        });
      }
      if (snapshot.size < VALIDATION_PAGE_SIZE) break;
      cursor = snapshot.docs.at(-1);
      if (cursor === undefined) break;
    }
  }
  return hasDocuments;
};

type ValidateIndexes = (
  schema: UniversalComponentSchema,
  version: string,
) => Promise<void>;

type SelectPhysicalVersion = (
  compatibleVersions: readonly string[],
) => string | null;

const inspectPhysicalVersion = async (
  db: Firestore,
  schema: UniversalComponentSchema,
  validateIndexes: ValidateIndexes,
  selectPhysicalVersion?: SelectPhysicalVersion,
): Promise<string | null> => {
  let lastError: unknown;
  const candidates = new Map(
    schema.versions.map((version) => [version.version, version]),
  );
  const hasDocuments = await visitStoredDocuments(
    db,
    schema,
    (tableName, document) => {
      for (const [versionName, version] of candidates) {
        const table = version.tables.find(({ name }) => name === tableName)!;
        try {
          validateRow(
            schema,
            versionName,
            table,
            document.row,
            document.documentId,
          );
        } catch (error: unknown) {
          candidates.delete(versionName);
          lastError = error;
        }
      }
      if (candidates.size === 0) {
        throw new TypeError("Stored Firebase component data has schema drift", {
          cause: lastError,
        });
      }
    },
  );
  const compatibleVersions = schema.versions
    .toReversed()
    .filter(({ version }) => candidates.has(version))
    .map(({ version }) => version);
  if (selectPhysicalVersion !== undefined) {
    const selected = selectPhysicalVersion(compatibleVersions);
    if (selected === null) {
      if (hasDocuments) {
        throw new TypeError(
          "Cannot select an absent Firebase component schema with stored documents",
        );
      }
      return null;
    }
    if (!candidates.has(selected)) {
      throw new TypeError(
        `Selected incompatible Firebase component schema version: ${selected}`,
      );
    }
    await validateIndexes(schema, selected);
    return selected;
  }
  for (const version of compatibleVersions) {
    try {
      await validateIndexes(schema, version);
      return version;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new TypeError("Stored Firebase component data has schema drift", {
    cause: lastError,
  });
};

const validateLatestPhysicalState = async (
  db: Firestore,
  schema: UniversalComponentSchema,
  validateIndexes: ValidateIndexes,
): Promise<void> => {
  const latest = getUniversalComponentLatestSchema(schema);
  await visitStoredDocuments(db, schema, (tableName, document) => {
    const table = latest.tables.find(({ name }) => name === tableName)!;
    validateRow(
      schema,
      latest.version,
      table,
      document.row,
      document.documentId,
    );
  });
  await validateIndexes(schema, latest.version);
};

const writeMarker = async (
  db: Firestore,
  schema: UniversalComponentSchema,
  version: string,
): Promise<void> => {
  const batch = db.batch();
  batch.set(
    db
      .collection(SETTINGS_COLLECTION)
      .doc(getUniversalComponentSchemaMarkerKey(schema)),
    { value: version },
  );
  await batch.commit();
};

type FirebaseUniversalComponentDataAdapterOptions = {
  readonly selectPhysicalVersion?: SelectPhysicalVersion;
  readonly validateIndexes?: ValidateIndexes;
};

export const createFirebaseUniversalComponentDataAdapter = (
  db: Firestore,
  options: FirebaseUniversalComponentDataAdapterOptions = {},
): UniversalComponentDataAdapter => {
  const validateIndexes: ValidateIndexes =
    options.validateIndexes ??
    ((schema, version) => validatePhysicalIndexes(db, schema, version));
  return {
    artifacts: (schema) => [
      createArtifact(schema, getUniversalComponentLatestSchema(schema).version),
    ],
    bind(schema): UniversalComponentDataSource {
      const latest = getUniversalComponentLatestSchema(schema);
      createIndexes(schema, latest.version);
      let physicallyReady = false;
      const assertReady = async (): Promise<void> => {
        await assertMarker(db, schema);
        if (physicallyReady) return;
        await validateLatestPhysicalState(db, schema, validateIndexes);
        physicallyReady = true;
      };
      return {
        schema,
        async append(input) {
          await assertReady();
          const table = getUniversalComponentTable(
            schema,
            input.table,
            latest.version,
          );
          const documentId = validateRow(
            schema,
            latest.version,
            table,
            input.row,
          );
          await db.collection(table.name).doc(documentId).create(input.row);
        },
        assertReady,
        async orderedScan(input) {
          await assertReady();
          const accessPattern = validateUniversalComponentOrderedScan(
            schema,
            input,
          );
          const table = getUniversalComponentTable(schema, accessPattern.table);
          let query: Query = db.collection(table.name);
          for (const column of accessPattern.columns) {
            query = query.orderBy(column, "asc");
          }
          query = query.endBefore(...input.beforePrefixExclusive);
          if (input.afterExclusive !== undefined) {
            query = query.startAfter(...input.afterExclusive);
          }
          const snapshot = await query.limit(input.limit).get();
          return snapshot.docs.map((document) => {
            const row = document.data();
            validateRow(schema, latest.version, table, row, document.id);
            return row;
          });
        },
      };
    },
    async migrate(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      const actualVersion = await markerValue(db, schema);
      if (
        actualVersion !== null &&
        !schema.versions.some((version) => version.version === actualVersion)
      ) {
        throw new UniversalComponentSchemaNotReadyError(
          schema.id,
          latest.version,
          actualVersion,
        );
      }

      const policy = schema.unmarked;
      const discriminatorValue =
        policy === undefined
          ? null
          : await settingValue(db, policy.discriminatorKey);
      if (
        discriminatorValue !== null &&
        typeof discriminatorValue !== "string"
      ) {
        throw new FirebaseUniversalComponentSchemaStateError(
          policy?.discriminatorKey ?? schema.id,
        );
      }
      if (
        policy !== undefined &&
        !policy.knownValues.includes(discriminatorValue)
      ) {
        throw new UniversalComponentSchemaNotReadyError(
          schema.id,
          latest.version,
          null,
        );
      }

      const physicalVersion =
        actualVersion === latest.version
          ? await validateLatestPhysicalState(db, schema, validateIndexes).then(
              () => latest.version,
            )
          : await inspectPhysicalVersion(
              db,
              schema,
              validateIndexes,
              options.selectPhysicalVersion,
            ).then(async (version) => {
              if (version !== null || actualVersion === null) return version;
              await validateLatestPhysicalState(db, schema, validateIndexes);
              return latest.version;
            });
      const decision = resolveUniversalComponentMigrationState(schema, {
        discriminatorValue,
        markerVersion: actualVersion,
        physicalVersion,
      });
      if (decision.kind === "reject") {
        throw new UniversalComponentSchemaNotReadyError(
          schema.id,
          latest.version,
          null,
        );
      }
      if (decision.kind === "ready") {
        return { changed: false, version: latest.version };
      }
      if (decision.kind === "create" || decision.kind === "migrate") {
        await validateLatestPhysicalState(db, schema, validateIndexes);
      }
      await writeMarker(db, schema, latest.version);
      return { changed: true, version: latest.version };
    },
  };
};
