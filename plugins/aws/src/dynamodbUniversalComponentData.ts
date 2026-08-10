import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  UniversalComponentDataAdapter,
  UniversalComponentOrderedScanSchema,
  UniversalComponentRow,
  UniversalComponentScalar,
  UniversalComponentSchema,
  UniversalComponentSchemaVersion,
  UniversalComponentTableSchema,
} from "@hot-updater/plugin-core";
import {
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  getUniversalComponentTable,
  resolveUniversalComponentMigrationState,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
  validateUniversalComponentAppend,
  validateUniversalComponentOrderedScan,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";

import type { DynamoDBStore } from "./dynamodbDatabaseStore";

export const DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX =
  "_hot-updater#component-data";
export const DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY = "_hot-updater";

const catalogSortKey = "catalog";

type StoredItem = Record<string, unknown>;

class DynamoDBUniversalComponentSchemaDriftError extends Error {
  readonly name = "DynamoDBUniversalComponentSchemaDriftError";
}

class DynamoDBUniversalComponentStoredDataError extends Error {
  readonly name = "DynamoDBUniversalComponentStoredDataError";
}

class DynamoDBUniversalComponentIndexError extends Error {
  readonly name = "DynamoDBUniversalComponentIndexError";
}

const componentPartition = (schema: UniversalComponentSchema): string =>
  `${DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX}#${schema.id}`;

const tablePartition = (
  schema: UniversalComponentSchema,
  table: string,
): string => `${componentPartition(schema)}#table#${table}`;

const scanPartition = (
  schema: UniversalComponentSchema,
  accessPattern: string,
): string => `${componentPartition(schema)}#scan#${accessPattern}`;

const catalogKey = (schema: UniversalComponentSchema) => ({
  pk: componentPartition(schema),
  sk: catalogSortKey,
});

const markerKey = (schema: UniversalComponentSchema) => ({
  pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
  sk: getUniversalComponentSchemaMarkerKey(schema),
});

const versionShape = (version: UniversalComponentSchemaVersion): string =>
  JSON.stringify(version);

const itemString = (item: StoredItem, key: string): string => {
  const value = item[key];
  if (typeof value !== "string") {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid component item ${key}`,
    );
  }
  return value;
};

const itemRow = (item: StoredItem): UniversalComponentRow => {
  const value = item.data;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DynamoDBUniversalComponentStoredDataError(
      "Invalid component item data",
    );
  }
  return value as UniversalComponentRow;
};

const stableRowValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableRowValue).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableRowValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stringBytes = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sortableNumber = (input: number): string => {
  const value = Object.is(input, -0) ? 0 : input;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bytes = new Uint8Array(buffer);
  if ((bytes[0]! & 0x80) === 0) {
    bytes[0]! ^= 0x80;
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index]! ^= 0xff;
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

const scalarSortKey = (value: UniversalComponentScalar): string =>
  `${typeof value === "number" ? sortableNumber(value) : stringBytes(value)}!`;

const tupleSortKey = (values: readonly UniversalComponentScalar[]): string =>
  values.map(scalarSortKey).join("");

const primaryKeyColumn = (table: UniversalComponentTableSchema): string =>
  table.columns.find(({ primaryKey }) => primaryKey)?.name ??
  (() => {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Component table ${table.name} has no primary key`,
    );
  })();

const primaryKeyValue = (
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): string => {
  const value = row[primaryKeyColumn(table)];
  if (typeof value !== "string") {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid primary key for component table ${table.name}`,
    );
  }
  return value;
};

const primarySortKey = (
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): string => scalarSortKey(primaryKeyValue(table, row));

const scanValues = (
  scan: UniversalComponentOrderedScanSchema,
  row: UniversalComponentRow,
): readonly UniversalComponentScalar[] =>
  scan.columns.map((column) => {
    const value = row[column];
    if (typeof value !== "number" && typeof value !== "string") {
      throw new DynamoDBUniversalComponentStoredDataError(
        `Invalid ordered value for component access pattern ${scan.name}`,
      );
    }
    return value;
  });

const scanSortKey = (
  scan: UniversalComponentOrderedScanSchema,
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): string =>
  `${tupleSortKey(scanValues(scan, row))}~${scalarSortKey(
    primaryKeyValue(table, row),
  )}`;

const queryPartition = async (
  store: DynamoDBStore,
  partition: string,
): Promise<StoredItem[]> => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const items: StoredItem[] = [];
  do {
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ExclusiveStartKey: exclusiveStartKey,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": partition },
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

const getSetting = async (
  store: DynamoDBStore,
  key: { readonly pk: string; readonly sk: string },
): Promise<string | null> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: key,
      ProjectionExpression: "#value",
      ExpressionAttributeNames: { "#value": "value" },
    }),
  );
  if (Item === undefined) return null;
  if (typeof Item.value !== "string") {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Invalid component setting ${key.sk}`,
    );
  }
  return Item.value;
};

const getCatalog = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
): Promise<{ readonly shape: string; readonly version: string } | null> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: catalogKey(schema),
    }),
  );
  if (Item === undefined) return null;
  if (typeof Item.value !== "string" || typeof Item.shape !== "string") {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Invalid component catalog ${schema.id}`,
    );
  }
  return { shape: Item.shape, version: Item.value };
};

const assertCatalogVersion = (
  schema: UniversalComponentSchema,
  catalog: { readonly shape: string; readonly version: string } | null,
  version: UniversalComponentSchemaVersion,
): void => {
  if (
    catalog?.version !== version.version ||
    catalog.shape !== versionShape(version)
  ) {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Component ${schema.id} physical catalog does not match version ${version.version}`,
    );
  }
};

const parsePrimaryItem = (
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
  table: UniversalComponentTableSchema,
  item: StoredItem,
): UniversalComponentRow => {
  const row = itemRow(item);
  if (
    itemString(item, "pk") !== tablePartition(schema, table.name) ||
    itemString(item, "sk") !== primarySortKey(table, row)
  ) {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid stored item for component table ${table.name}`,
    );
  }
  try {
    validateUniversalComponentRow(schema, {
      row,
      table: table.name,
      version: version.version,
    });
  } catch (error) {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid stored row for component table ${table.name}`,
      { cause: error },
    );
  }
  return row;
};

const loadRows = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<ReadonlyMap<string, readonly UniversalComponentRow[]>> => {
  const rows = new Map<string, readonly UniversalComponentRow[]>();
  for (const table of version.tables) {
    const items = await queryPartition(
      store,
      tablePartition(schema, table.name),
    );
    rows.set(
      table.name,
      items.map((item) => parsePrimaryItem(schema, version, table, item)),
    );
  }
  return rows;
};

const assertIndexes = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
  rows: ReadonlyMap<string, readonly UniversalComponentRow[]>,
): Promise<void> => {
  for (const scan of version.orderedScans ?? []) {
    const table = getUniversalComponentTable(
      schema,
      scan.table,
      version.version,
    );
    const expected = new Map(
      (rows.get(table.name) ?? []).map((row) => [
        scanSortKey(scan, table, row),
        {
          primary: primaryKeyValue(table, row),
          row: stableRowValue(row),
        },
      ]),
    );
    const items = await queryPartition(store, scanPartition(schema, scan.name));
    if (items.length !== expected.size) {
      throw new DynamoDBUniversalComponentIndexError(
        `Component access pattern ${scan.name} is incomplete`,
      );
    }
    for (const item of items) {
      const row = itemRow(item);
      const sk = itemString(item, "sk");
      if (
        itemString(item, "pk") !== scanPartition(schema, scan.name) ||
        sk !== scanSortKey(scan, table, row) ||
        itemString(item, "primary") !== primaryKeyValue(table, row) ||
        expected.get(sk)?.primary !== primaryKeyValue(table, row) ||
        expected.get(sk)?.row !== stableRowValue(row)
      ) {
        throw new DynamoDBUniversalComponentIndexError(
          `Invalid component access pattern ${scan.name}`,
        );
      }
    }
  }
};

const validatePhysicalState = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<ReadonlyMap<string, readonly UniversalComponentRow[]>> => {
  assertCatalogVersion(schema, await getCatalog(store, schema), version);
  const rows = await loadRows(store, schema, version);
  await assertIndexes(store, schema, version, rows);
  return rows;
};

const putCatalog = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: {
        ...catalogKey(schema),
        shape: versionShape(version),
        value: version.version,
      },
    }),
  );
};

const putMarker = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: string,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: { ...markerKey(schema), value: version },
    }),
  );
};

const replaceIndexes = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  previous: UniversalComponentSchemaVersion,
  next: UniversalComponentSchemaVersion,
  rows: ReadonlyMap<string, readonly UniversalComponentRow[]>,
): Promise<void> => {
  for (const scan of previous.orderedScans ?? []) {
    const partition = scanPartition(schema, scan.name);
    for (const item of await queryPartition(store, partition)) {
      await store.client.send(
        new DeleteCommand({
          TableName: store.tableName,
          Key: { pk: partition, sk: itemString(item, "sk") },
        }),
      );
    }
  }
  for (const scan of next.orderedScans ?? []) {
    const table = getUniversalComponentTable(schema, scan.table, next.version);
    for (const row of rows.get(table.name) ?? []) {
      await store.client.send(
        new PutCommand({
          TableName: store.tableName,
          Item: {
            data: row,
            pk: scanPartition(schema, scan.name),
            primary: primaryKeyValue(table, row),
            sk: scanSortKey(scan, table, row),
          },
        }),
      );
    }
  }
};

export const createDynamoDBUniversalComponentDataAdapter = (
  store: DynamoDBStore,
): UniversalComponentDataAdapter => {
  const readinessValidated = new WeakSet<UniversalComponentSchema>();
  return {
    bind(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      const assertReady = async (): Promise<void> => {
        let actualVersion: string | null;
        try {
          actualVersion = await getSetting(store, markerKey(schema));
        } catch (error) {
          if (error instanceof DynamoDBUniversalComponentSchemaDriftError) {
            throw new UniversalComponentDataStateNotReadyError(
              schema.id,
              latest.version,
              "physical-schema",
              { cause: error },
            );
          }
          throw error;
        }
        if (actualVersion !== latest.version) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            latest.version,
            actualVersion,
          );
        }
        if (!readinessValidated.has(schema)) {
          try {
            await validatePhysicalState(store, schema, latest);
          } catch (error) {
            if (error instanceof DynamoDBUniversalComponentIndexError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "index",
                { cause: error },
              );
            }
            if (error instanceof DynamoDBUniversalComponentStoredDataError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "stored-data",
                { cause: error },
              );
            }
            if (error instanceof DynamoDBUniversalComponentSchemaDriftError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "physical-schema",
                { cause: error },
              );
            }
            throw error;
          }
          readinessValidated.add(schema);
        }
      };
      return {
        schema,
        assertReady,
        async append(input) {
          await assertReady();
          const table = validateUniversalComponentAppend(schema, input);
          const primary = primaryKeyValue(table, input.row);
          const transactItems = [
            {
              Put: {
                TableName: store.tableName,
                Item: {
                  data: input.row,
                  pk: tablePartition(schema, table.name),
                  sk: primarySortKey(table, input.row),
                },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": "pk" },
              },
            },
            ...(latest.orderedScans ?? [])
              .filter(({ table: tableName }) => tableName === table.name)
              .map((scan) => ({
                Put: {
                  TableName: store.tableName,
                  Item: {
                    data: input.row,
                    pk: scanPartition(schema, scan.name),
                    primary,
                    sk: scanSortKey(scan, table, input.row),
                  },
                },
              })),
          ];
          if (transactItems.length > 100) {
            throw new TypeError(
              `Component table ${table.name} exceeds the DynamoDB transaction limit`,
            );
          }
          await store.client.send(
            new TransactWriteCommand({ TransactItems: transactItems }),
          );
        },
        async orderedScan(input) {
          await assertReady();
          const scan = validateUniversalComponentOrderedScan(schema, input);
          const table = getUniversalComponentTable(schema, scan.table);
          const before = tupleSortKey(input.beforePrefixExclusive);
          const after =
            input.afterExclusive === undefined
              ? undefined
              : `${tupleSortKey(input.afterExclusive)}~\uffff`;
          if (after !== undefined && after >= before) return [];
          const parseItem = (item: StoredItem): UniversalComponentRow => {
            try {
              const row = itemRow(item);
              if (
                itemString(item, "pk") !== scanPartition(schema, scan.name) ||
                itemString(item, "sk") !== scanSortKey(scan, table, row)
              ) {
                throw new DynamoDBUniversalComponentStoredDataError(
                  `Invalid stored item for component access pattern ${scan.name}`,
                );
              }
              validateUniversalComponentRow(schema, {
                row,
                table: table.name,
                version: latest.version,
              });
              return row;
            } catch (error) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "stored-data",
                { cause: error },
              );
            }
          };
          let exclusiveStartKey: Record<string, unknown> | undefined;
          const rows: UniversalComponentRow[] = [];
          do {
            const page = await store.client.send(
              new QueryCommand({
                TableName: store.tableName,
                ExclusiveStartKey: exclusiveStartKey,
                KeyConditionExpression:
                  after === undefined
                    ? "#pk = :pk AND #sk < :before"
                    : "#pk = :pk AND #sk BETWEEN :after AND :before",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                ExpressionAttributeValues: {
                  ":before": before,
                  ":pk": scanPartition(schema, scan.name),
                  ...(after === undefined ? {} : { ":after": after }),
                },
                Limit: input.limit - rows.length,
                ScanIndexForward: true,
              }),
            );
            rows.push(...(page.Items ?? []).map(parseItem));
            exclusiveStartKey = page.LastEvaluatedKey;
          } while (
            rows.length < input.limit &&
            exclusiveStartKey !== undefined
          );
          return rows;
        },
      };
    },
    async migrate(schema) {
      readinessValidated.delete(schema);
      const latest = getUniversalComponentLatestSchema(schema);
      const marker = await getSetting(store, markerKey(schema));
      const catalog = await getCatalog(store, schema);
      const physicalVersion = catalog?.version ?? null;
      if (catalog !== null) {
        const declared = schema.versions.find(
          ({ version }) => version === physicalVersion,
        );
        if (
          declared === undefined ||
          catalog.shape !== versionShape(declared)
        ) {
          throw new DynamoDBUniversalComponentSchemaDriftError(
            `Component ${schema.id} has an unknown physical catalog`,
          );
        }
      }
      const discriminatorValue =
        schema.unmarked === undefined
          ? null
          : await getSetting(store, {
              pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
              sk: schema.unmarked.discriminatorKey,
            });
      const decision = resolveUniversalComponentMigrationState(schema, {
        discriminatorValue,
        markerVersion: marker,
        physicalVersion,
      });
      if (decision.kind === "reject") {
        throw new DynamoDBUniversalComponentSchemaDriftError(
          `Component ${schema.id} migration state is not adoptable`,
        );
      }
      if (decision.kind === "ready") {
        await validatePhysicalState(store, schema, latest);
        readinessValidated.add(schema);
        return { changed: false, version: latest.version };
      }
      if (
        decision.kind === "adopt" &&
        decision.fromVersion === latest.version
      ) {
        await validatePhysicalState(store, schema, latest);
        await putMarker(store, schema, latest.version);
        readinessValidated.add(schema);
        return { changed: true, version: latest.version };
      }
      if (decision.kind === "create") {
        const partitions = [
          ...latest.tables.map((table) => tablePartition(schema, table.name)),
          ...(latest.orderedScans ?? []).map((scan) =>
            scanPartition(schema, scan.name),
          ),
        ];
        for (const partition of partitions) {
          if ((await queryPartition(store, partition)).length > 0) {
            throw new DynamoDBUniversalComponentSchemaDriftError(
              `Component ${schema.id} contains rows without a catalog`,
            );
          }
        }
        await putCatalog(store, schema, latest);
      } else {
        const previous = schema.versions.find(
          ({ version }) => version === decision.fromVersion,
        )!;
        assertCatalogVersion(schema, catalog, previous);
        const rows = await loadRows(store, schema, previous);
        for (const target of schema.versions.slice(
          schema.versions.indexOf(previous) + 1,
        )) {
          for (const table of target.tables) {
            for (const row of rows.get(table.name) ?? []) {
              try {
                validateUniversalComponentRow(schema, {
                  row,
                  table: table.name,
                  version: target.version,
                });
              } catch (error) {
                throw new DynamoDBUniversalComponentStoredDataError(
                  `Invalid stored row for component table ${table.name}`,
                  { cause: error },
                );
              }
            }
          }
        }
        await replaceIndexes(store, schema, previous, latest, rows);
        await putCatalog(store, schema, latest);
      }
      await validatePhysicalState(store, schema, latest);
      await putMarker(store, schema, latest.version);
      readinessValidated.add(schema);
      return { changed: true, version: latest.version };
    },
  };
};
