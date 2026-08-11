import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  defineUniversalComponentSchema,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
} from "@hot-updater/plugin-core";
import type { UniversalComponentSchema } from "@hot-updater/plugin-core";
import {
  setupUniversalComponentDataAdapterTestSuite,
  setupUniversalComponentMigrationTestSuite,
  syntheticAuditLogSchema,
  type SyntheticUniversalComponentMigrationState,
} from "@hot-updater/test-utils";
import { describe, expect, it, vi } from "vitest";

import type { DynamoDBStore } from "./dynamoDB";
import {
  createDynamoDBUniversalComponentDataAdapter,
  DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX,
  DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
} from "./dynamoDB";

type Item = Record<string, unknown>;

const itemKey = (item: Item): string =>
  `${String(item.pk)}\u0000${String(item.sk)}`;

class InMemoryDynamoDB {
  readonly items = new Map<string, Item>();
  readonly puts: Item[] = [];
  failMarkerWrite = false;
  queryPageSize = 2;

  clear(): void {
    this.items.clear();
    this.puts.length = 0;
    this.failMarkerWrite = false;
  }

  deletePartition(partition: string): void {
    for (const [key, item] of this.items) {
      if (item.pk === partition) this.items.delete(key);
    }
  }

  put(item: Item): void {
    if (
      this.failMarkerWrite &&
      item.pk === DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY &&
      typeof item.sk === "string" &&
      item.sk.startsWith("schema.")
    ) {
      this.failMarkerWrite = false;
      throw new Error("injected marker write failure");
    }
    this.puts.push(item);
    this.items.set(itemKey(item), item);
  }

  async send(command: unknown): Promise<{
    readonly Item?: Item;
    readonly Items?: Item[];
    readonly LastEvaluatedKey?: Item;
  }> {
    if (command instanceof GetCommand) {
      const key = command.input.Key as Item;
      const item = this.items.get(itemKey(key));
      if (item === undefined) return {};
      return command.input.ProjectionExpression === undefined
        ? { Item: item }
        : { Item: { value: item.value } };
    }
    if (command instanceof PutCommand) {
      this.put(command.input.Item as Item);
      return {};
    }
    if (command instanceof DeleteCommand) {
      this.items.delete(itemKey(command.input.Key as Item));
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const puts = (command.input.TransactItems ?? []).map(({ Put }) => Put!);
      for (const put of puts) {
        if (
          put.ConditionExpression !== undefined &&
          this.items.has(itemKey(put.Item as Item))
        ) {
          const error = new Error("conditional write failed");
          error.name = "TransactionCanceledException";
          throw error;
        }
      }
      for (const put of puts) this.put(put.Item as Item);
      return {};
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<
        string,
        unknown
      >;
      const partition = values[":pk"];
      const after = values[":after"];
      const before = values[":before"];
      const expression = command.input.KeyConditionExpression ?? "";
      const matching = [...this.items.values()]
        .filter(({ pk }) => pk === partition)
        .filter(({ sk }) => {
          if (typeof sk !== "string") return false;
          if (
            expression.includes("BETWEEN") &&
            typeof after === "string" &&
            typeof before === "string"
          ) {
            return sk >= after && sk <= before;
          }
          return typeof before !== "string" || sk < before;
        })
        .sort((left, right) =>
          String(left.sk) < String(right.sk)
            ? -1
            : String(left.sk) > String(right.sk)
              ? 1
              : 0,
        );
      const exclusiveStartKey = command.input.ExclusiveStartKey as
        | Item
        | undefined;
      const start =
        exclusiveStartKey === undefined
          ? 0
          : matching.findIndex(
              (item) => itemKey(item) === itemKey(exclusiveStartKey),
            ) + 1;
      const pageSize = Math.min(
        command.input.Limit ?? this.queryPageSize,
        this.queryPageSize,
      );
      const items = matching.slice(start, start + pageSize);
      const last = items.at(-1);
      return {
        Items: items,
        ...(last !== undefined && start + items.length < matching.length
          ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      };
    }
    throw new TypeError("Unsupported in-memory DynamoDB command");
  }
}

let database = new InMemoryDynamoDB();

const createStore = (): DynamoDBStore => ({
  client: database as unknown as DynamoDBDocumentClient,
  tableName: "component-data-test",
});

setupUniversalComponentDataAdapterTestSuite({
  name: "DynamoDB universal component data adapter",
  createAdapter: () => {
    database = new InMemoryDynamoDB();
    return createDynamoDBUniversalComponentDataAdapter(createStore());
  },
  dispose: () => undefined,
  readinessFailures: [
    {
      name: "missing access projection",
      async prepare(_adapter, schema) {
        const seedAdapter =
          createDynamoDBUniversalComponentDataAdapter(createStore());
        await seedAdapter.migrate?.(schema);
        const source = seedAdapter.bind(schema);
        await source.append({
          row: {
            accepted: true,
            action: "readiness-check",
            actor_id: null,
            id: "readiness-row",
            payload: { source: "readiness" },
            recorded_at_ms: 1,
            risk_score: 0.5,
          },
          table: "audit_records",
        });
        database.deletePartition(
          `${DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX}#${schema.id}#scan#chronological`,
        );
      },
    },
  ],
  reset: () => database.clear(),
});

const componentPartition = (schema: UniversalComponentSchema): string =>
  `${DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX}#${schema.id}`;

const testStringSortKey = (value: string): string =>
  `${Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}!`;

const testNumberSortKey = (input: number): string => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Object.is(input, -0) ? 0 : input, false);
  const bytes = new Uint8Array(buffer);
  if ((bytes[0]! & 0x80) === 0) {
    bytes[0]! ^= 0x80;
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index]! ^= 0xff;
    }
  }
  return `${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}!`;
};

const seedMigrationState = (
  schema: UniversalComponentSchema,
  state: SyntheticUniversalComponentMigrationState,
): void => {
  database.clear();
  if (state.componentVersion !== null) {
    database.put({
      pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
      sk: `schema.${schema.id}`,
      value: state.componentVersion,
    });
  }
  if (state.legacyVersion !== null) {
    database.put({
      pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
      sk: schema.unmarked?.discriminatorKey,
      value: state.legacyVersion,
    });
  }
  if (state.physicalState !== "absent") {
    const version =
      state.physicalState === "version-2"
        ? schema.versions[1]!
        : schema.versions[0];
    database.put({
      pk: componentPartition(schema),
      shape:
        state.physicalState === "drift" ? "drift" : JSON.stringify(version),
      sk: "catalog",
      value: version.version,
    });
  }
  for (const value of state.rows) {
    const row = value as Record<string, unknown>;
    const id = String(row.id);
    const recordedAtMs = Number(row.recorded_at_ms);
    database.put({
      data: row,
      pk: `${componentPartition(schema)}#table#audit_history_records`,
      sk: testStringSortKey(id),
    });
    database.put({
      data: row,
      pk: `${componentPartition(schema)}#scan#chronological`,
      primary: id,
      sk: `${testNumberSortKey(recordedAtMs)}${testStringSortKey(id)}~${testStringSortKey(id)}`,
    });
  }
  database.puts.length = 0;
};

const inspectMigrationState = (
  schema: UniversalComponentSchema,
): SyntheticUniversalComponentMigrationState => {
  const marker = database.items.get(
    itemKey({
      pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
      sk: `schema.${schema.id}`,
    }),
  )?.value;
  const legacy = database.items.get(
    itemKey({
      pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
      sk: schema.unmarked?.discriminatorKey,
    }),
  )?.value;
  const catalog = database.items.get(
    itemKey({ pk: componentPartition(schema), sk: "catalog" }),
  );
  const physicalState = (() => {
    if (catalog === undefined) return "absent";
    if (
      catalog.value === schema.versions[0].version &&
      catalog.shape === JSON.stringify(schema.versions[0])
    ) {
      return "version-1";
    }
    if (
      catalog.value === schema.versions[1]?.version &&
      catalog.shape === JSON.stringify(schema.versions[1])
    ) {
      return "version-2";
    }
    return "drift";
  })();
  const rows = [...database.items.values()]
    .filter(
      ({ pk }) =>
        pk === `${componentPartition(schema)}#table#audit_history_records`,
    )
    .map(({ data }) => data);
  return {
    componentVersion: marker ?? null,
    legacyVersion: legacy ?? null,
    physicalState,
    rows,
  };
};

setupUniversalComponentMigrationTestSuite({
  name: "DynamoDB universal component migration matrix",
  createHarness: () => {
    database = new InMemoryDynamoDB();
    return {
      adapter: createDynamoDBUniversalComponentDataAdapter(createStore()),
      failNextMarkerWrite() {
        database.failMarkerWrite = true;
      },
      inspect: inspectMigrationState,
      seed: seedMigrationState,
    };
  },
  supportsMarkerWriteFailure: true,
});

const columns = [
  { name: "id", primaryKey: true, type: "string" },
  { name: "recorded_at_ms", type: "integer" },
  { name: "actor_id", nullable: true, type: "string" },
] as const;

const chronological = [
  {
    columns: ["recorded_at_ms", "id"],
    name: "chronological",
    table: "records",
  },
] as const;

const schemaV1 = defineUniversalComponentSchema({
  id: "migration-log",
  versions: [
    {
      orderedScans: chronological,
      tables: [{ columns, name: "records" }],
      version: "1",
    },
  ],
});

const schemaV2 = defineUniversalComponentSchema({
  id: "migration-log",
  versions: [
    schemaV1.versions[0],
    {
      orderedScans: chronological,
      tables: [
        {
          checks: [
            {
              expression: { column: "recorded_at_ms", op: "gte", value: 0 },
              name: "recorded_at_non_negative",
            },
          ],
          columns,
          name: "records",
        },
      ],
      version: "2",
    },
  ],
});

describe("DynamoDB universal component migration", () => {
  it("validates an adjacent transition and records the component marker last", async () => {
    database = new InMemoryDynamoDB();
    const adapter = createDynamoDBUniversalComponentDataAdapter(createStore());
    await adapter.migrate?.(schemaV1);
    await adapter.bind(schemaV1).append({
      row: { actor_id: null, id: "row-1", recorded_at_ms: 1 },
      table: "records",
    });
    database.puts.length = 0;

    await expect(adapter.migrate?.(schemaV2)).resolves.toEqual({
      changed: true,
      version: "2",
    });

    expect(database.puts.at(-1)).toMatchObject({
      pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
      sk: "schema.migration-log",
      value: "2",
    });
    await expect(
      adapter.bind(schemaV2).orderedScan({
        accessPattern: "chronological",
        beforePrefixExclusive: [2],
        limit: 10,
      }),
    ).resolves.toEqual([{ actor_id: null, id: "row-1", recorded_at_ms: 1 }]);
  });

  it("fails closed after an interrupted marker write and converges on retry", async () => {
    database = new InMemoryDynamoDB();
    const adapter = createDynamoDBUniversalComponentDataAdapter(createStore());
    await adapter.migrate?.(schemaV1);
    database.failMarkerWrite = true;

    await expect(adapter.migrate?.(schemaV2)).rejects.toThrow(
      "injected marker write failure",
    );
    await expect(adapter.bind(schemaV2).assertReady()).rejects.toMatchObject({
      actualVersion: "1",
    });

    await expect(adapter.migrate?.(schemaV2)).resolves.toEqual({
      changed: true,
      version: "2",
    });
    await expect(adapter.bind(schemaV2).assertReady()).resolves.toBeUndefined();
  });

  it("does not rewrite a component that is already at its declared version", async () => {
    database = new InMemoryDynamoDB();
    const adapter = createDynamoDBUniversalComponentDataAdapter(createStore());
    await adapter.migrate?.(schemaV2);
    database.puts.length = 0;

    await expect(adapter.migrate?.(schemaV2)).resolves.toEqual({
      changed: false,
      version: "2",
    });
    expect(database.puts).toEqual([]);
  });

  it("classifies physical catalog drift separately from a missing marker", async () => {
    database = new InMemoryDynamoDB();
    const adapter = createDynamoDBUniversalComponentDataAdapter(createStore());

    await expect(
      adapter.bind(syntheticAuditLogSchema).assertReady(),
    ).rejects.toBeInstanceOf(UniversalComponentSchemaNotReadyError);
    await adapter.migrate?.(syntheticAuditLogSchema);
    database.put({
      pk: `${DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX}#${syntheticAuditLogSchema.id}`,
      shape: "drift",
      sk: "catalog",
      value: "1",
    });

    await expect(
      createDynamoDBUniversalComponentDataAdapter(createStore())
        .bind(syntheticAuditLogSchema)
        .assertReady(),
    ).rejects.toMatchObject({
      reason: "physical-schema",
    });
    await expect(
      createDynamoDBUniversalComponentDataAdapter(createStore())
        .bind(syntheticAuditLogSchema)
        .assertReady(),
    ).rejects.toBeInstanceOf(UniversalComponentDataStateNotReadyError);
  });

  it("notifies the database lifecycle only after component writes", async () => {
    database = new InMemoryDynamoDB();
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const adapter = createDynamoDBUniversalComponentDataAdapter(
      createStore(),
      onDatabaseUpdated,
    );
    await adapter.migrate?.(syntheticAuditLogSchema);
    const source = adapter.bind(syntheticAuditLogSchema);
    const row = {
      accepted: true,
      action: "component-write",
      actor_id: null,
      id: "component-write",
      payload: { source: "dynamodb" },
      recorded_at_ms: 1,
      risk_score: 0.5,
    } as const;

    await expect(source.create({ row, table: "audit_records" })).resolves.toBe(
      "created",
    );
    await expect(source.create({ row, table: "audit_records" })).resolves.toBe(
      "existing",
    );
    await expect(
      source.append({ row, table: "audit_records" }),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });

    expect(onDatabaseUpdated).toHaveBeenCalledOnce();
  });
});
