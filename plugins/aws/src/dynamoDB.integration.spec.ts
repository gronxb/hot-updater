import {
  DescribeTimeToLiveCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHotUpdater } from "@hot-updater/server";
import {
  createKvAdapter,
  type PhysicalTable,
  SETTINGS_TABLE,
} from "@hot-updater/server/database";
import {
  createDatabaseCoreApi,
  createDatabasePluginApis,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import { insightsTestSuite } from "@hot-updater/server/plugins/insights/testing";
import {
  setupDatabaseAdapterConformanceSuite,
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dynamoDB } from "./dynamoDB";
import {
  type DynamoDBLocal,
  startDynamoDBLocal,
} from "./dynamoDB.integration-fixture";
import { migrateDynamoDB } from "./dynamoDBMigration";
import { createDynamoDBStore, DYNAMODB_TTL_ATTRIBUTE } from "./dynamoDBStore";

let local: DynamoDBLocal;
beforeAll(async () => {
  local = await startDynamoDBLocal();
}, 180_000);
afterAll(async () => {
  await local?.stop();
});

setupDatabaseAdapterConformanceSuite({
  name: "key-value (DynamoDB Local)",
  // 34 conformance inserts are 102 items, over DynamoDB's 100 per transaction.
  maxOps: 33,
  // DynamoDB deletes expired items itself, by their `_ttl`.
  retention: "ttl",
  createAdapter: async ({ nativePageSize }) => {
    const tableName = local.tableName();
    const store = createDynamoDBStore({
      client: local.client,
      tableName,
      nativePageSize,
    });
    await store.migrations!.apply();
    return {
      adapter: createKvAdapter({ store }),
      cleanup: async () => {
        await local.dropTable(tableName);
      },
    };
  },
});

describe("dynamoDB store", () => {
  it("reads no item past an exclusive upper bound, in either order", async () => {
    const client = new DynamoDBClient(local.config);
    let itemsRead = 0;
    client.middlewareStack.add(
      (next) => async (args) => {
        const result = await next(args);
        const output = result.output as { Items?: unknown[] } | undefined;
        itemsRead += output?.Items?.length ?? 0;
        return result;
      },
      // Outermost, so `output` is the deserialized response.
      { step: "initialize" },
    );
    const tableName = local.tableName();
    const store = createDynamoDBStore({ client, tableName });
    await store.migrations!.apply();
    const sk = (key: string) => `${key}\u0001`;
    await store.write(
      ["a", "b", "c"].map((key) => ({
        key: { pk: "p", sk: sk(key) },
        type: "put" as const,
        value: { id: key },
      })),
    );

    for (const order of ["asc", "desc"] as const) {
      itemsRead = 0;
      const page = await store.query({
        pk: "p",
        gte: sk("a"),
        lt: sk("c"),
        lte: "c",
        order,
        limit: 10,
      });

      expect(page.items.map((item) => item.sk)).toEqual(
        order === "asc" ? [sk("a"), sk("b")] : [sk("b"), sk("a")],
      );
      expect(itemsRead).toBe(2);
    }
    client.destroy();
    await local.dropTable(tableName);
  });
});

describe("dynamoDB TTL", () => {
  it("turns on TTL for `_ttl` and stamps it on every item of an expiring row", async () => {
    const client = new DynamoDBClient(local.config);
    const tableName = local.tableName();
    const store = createDynamoDBStore({ client, tableName });
    await store.migrations!.apply();
    // A second migration leaves the enabled TTL as it is.
    await store.migrations!.apply();
    const { TimeToLiveDescription } = await client.send(
      new DescribeTimeToLiveCommand({ TableName: tableName }),
    );
    expect(TimeToLiveDescription).toMatchObject({
      AttributeName: DYNAMODB_TTL_ATTRIBUTE,
      TimeToLiveStatus: expect.stringMatching(/^ENABL/u),
    });

    const expiring: PhysicalTable = {
      name: "expiring",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "grp", type: "string", nullable: false },
        { name: "at", type: "integer", nullable: false },
        { name: "_v", type: "integer", nullable: false },
      ],
      key: ["id"],
      indexes: [{ name: "byGroup", eq: ["grp"], sort: ["at"] }],
      retention: { column: "at", ms: 86_400_000 },
    };
    const adapter = createKvAdapter({ store });
    await adapter.write([
      {
        type: "insert",
        table: expiring,
        row: { id: "a", grp: "g", at: 1_000, _v: 0 },
      },
    ]);

    const { Items = [] } = await DynamoDBDocumentClient.from(client).send(
      new ScanCommand({ TableName: tableName }),
    );
    const stamped = Items.filter((item) => item.pk !== SETTINGS_TABLE.name);
    // The row and its index copy, in epoch seconds, rounded up.
    expect(stamped.map((item) => item[DYNAMODB_TTL_ATTRIBUTE])).toEqual([
      86_401, 86_401,
    ]);
    expect(await adapter.get(expiring, [["a"]])).toEqual([
      { id: "a", grp: "g", at: 1_000, _v: 0 },
    ]);
    client.destroy();
    await local.dropTable(tableName);
  });
});

describe("dynamoDB", () => {
  const tableName = `hot-updater-plugin-${process.pid}`;
  const config = () => ({ ...local.config, tableName });

  /** Deletes every item but the schema settings, which the database checks first. */
  const clear = async () => {
    const documents = DynamoDBDocumentClient.from(local.client);
    for (let start: Record<string, unknown> | undefined; ; ) {
      const page = await documents.send(
        new ScanCommand({
          TableName: tableName,
          ProjectionExpression: "pk, sk",
          ExclusiveStartKey: start,
        }),
      );
      const keys = (page.Items ?? []).filter(
        ({ pk }) => pk !== SETTINGS_TABLE.name,
      );
      for (let at = 0; at < keys.length; at += 25) {
        await documents.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: keys
                .slice(at, at + 25)
                .map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
            },
          }),
        );
      }
      start = page.LastEvaluatedKey;
      if (start === undefined) return;
    }
  };

  it("serves only after the migration writes the schema settings", async () => {
    const fenced = { ...local.config, tableName: local.tableName() };
    const database = dynamoDB(fenced);
    const core = createDatabaseCoreApi(database);
    // No table yet: the fence reads DynamoDB's missing table as a missing schema.
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await migrateDynamoDB(fenced);
    await migrateDynamoDB(fenced);
    await expect(core.listChannels()).resolves.toEqual([]);
    await database.dispose?.();
  });

  setupDatabaseTestSuite({
    name: "dynamoDB (DynamoDB Local)",
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({
          ...options,
          plugins: [insights()],
          clientAccess: "public",
        }).handlers,
      ),
    plugins: [
      insightsTestSuite({
        createModel: (database) =>
          createInsightsModel(
            createDatabasePluginApis(database, [insights()]).insights,
          ),
      }),
    ],
    createDatabase: () => dynamoDB(config()),
    migrate: async () => {
      await migrateDynamoDB(config(), [insights()]);
    },
    reset: clear,
    dispose: async (database) => {
      await database.dispose?.();
    },
  });
});
