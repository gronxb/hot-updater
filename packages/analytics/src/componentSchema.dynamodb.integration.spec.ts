import {
  defineUniversalComponentSchema,
  UniversalComponentDataStateNotReadyError,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

// nx-ignore-next-line
import {
  createDynamoDBUniversalComponentDataAdapter,
  DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX,
  DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
} from "../../../plugins/aws/src/dynamoDB";
import { analyticsComponentSchema } from "./componentSchema";
import type { BundleEventPersistenceRow } from "./provider/persistence";
import { createUniversalComponentAnalyticsPersistence } from "./provider/universalComponentPersistence";

type Item = Record<string, unknown>;
type DynamoStore = Parameters<
  typeof createDynamoDBUniversalComponentDataAdapter
>[0];

type CommandInput = {
  readonly ExclusiveStartKey?: Item;
  readonly ExpressionAttributeValues?: Record<string, unknown>;
  readonly Item?: Item;
  readonly Key?: Item;
  readonly KeyConditionExpression?: string;
  readonly Limit?: number;
  readonly ProjectionExpression?: string;
  readonly TransactItems?: readonly {
    readonly Put?: {
      readonly ConditionExpression?: string;
      readonly Item?: Item;
    };
  }[];
};

const itemKey = (item: Item): string =>
  `${String(item.pk)}\u0000${String(item.sk)}`;

const requiredItem = (item: Item | undefined): Item => {
  if (item === undefined) throw new TypeError("DynamoDB item is required");
  return item;
};

const commandInput = (command: unknown): CommandInput => {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command)
  ) {
    throw new TypeError("Unsupported in-memory DynamoDB command");
  }
  return command.input as CommandInput;
};

const commandName = (command: unknown): string => {
  if (
    typeof command !== "object" ||
    command === null ||
    !("constructor" in command)
  ) {
    throw new TypeError("Unsupported in-memory DynamoDB command");
  }
  return (command.constructor as { readonly name: string }).name;
};

class InMemoryDynamoDB {
  readonly items = new Map<string, Item>();
  readonly queriedPartitions: string[] = [];
  queryPageSize = 2;

  put(item: Item): void {
    this.items.set(itemKey(item), item);
  }

  async send(command: unknown): Promise<{
    readonly Item?: Item;
    readonly Items?: Item[];
    readonly LastEvaluatedKey?: Item;
  }> {
    const input = commandInput(command);
    switch (commandName(command)) {
      case "GetCommand": {
        const item = this.items.get(itemKey(requiredItem(input.Key)));
        if (item === undefined) return {};
        return input.ProjectionExpression === undefined
          ? { Item: item }
          : { Item: { value: item.value } };
      }
      case "PutCommand":
        this.put(requiredItem(input.Item));
        return {};
      case "DeleteCommand":
        this.items.delete(itemKey(requiredItem(input.Key)));
        return {};
      case "TransactWriteCommand": {
        const puts = (input.TransactItems ?? []).map(({ Put }) => {
          if (Put === undefined) {
            throw new TypeError("Only DynamoDB transaction puts are supported");
          }
          return { ...Put, Item: requiredItem(Put.Item) };
        });
        for (const put of puts) {
          if (
            put.ConditionExpression !== undefined &&
            this.items.has(itemKey(put.Item))
          ) {
            throw new Error("conditional write failed");
          }
        }
        for (const put of puts) this.put(put.Item);
        return {};
      }
      case "QueryCommand": {
        const values = input.ExpressionAttributeValues ?? {};
        const partition = values[":pk"];
        if (typeof partition !== "string") {
          throw new TypeError("DynamoDB query partition is required");
        }
        this.queriedPartitions.push(partition);
        const after = values[":after"];
        const before = values[":before"];
        const expression = input.KeyConditionExpression ?? "";
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
            String(left.sk).localeCompare(String(right.sk)),
          );
        const start =
          input.ExclusiveStartKey === undefined
            ? 0
            : matching.findIndex(
                (item) => itemKey(item) === itemKey(input.ExclusiveStartKey!),
              ) + 1;
        const pageSize = Math.min(
          input.Limit ?? this.queryPageSize,
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
      default:
        throw new TypeError("Unsupported in-memory DynamoDB command");
    }
  }
}

const analyticsV1Schema = defineUniversalComponentSchema({
  id: analyticsComponentSchema.id,
  versions: [analyticsComponentSchema.versions[0]],
});

const appliedRow: BundleEventPersistenceRow = {
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  from_bundle_id: "00000000-0000-4000-8000-000000000010",
  id: "00000000-0000-4000-8000-000000000001",
  install_id: "install-applied",
  platform: "ios",
  received_at_ms: 1_000,
  sdk_version: "1.2.3",
  to_bundle_id: "00000000-0000-4000-8000-000000000020",
  type: "UPDATE_APPLIED",
  update_strategy: "appVersion",
  user_id: null,
  username: null,
};

const recoveredRow: BundleEventPersistenceRow = {
  ...appliedRow,
  from_bundle_id: "00000000-0000-4000-8000-000000000011",
  id: "00000000-0000-4000-8000-000000000002",
  install_id: "install-recovered",
  type: "RECOVERED",
  update_strategy: "fingerprint",
};

const unchangedRow = (
  sequence: number,
  receivedAtMs: number,
): BundleEventPersistenceRow => ({
  ...appliedRow,
  from_bundle_id: null,
  id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  install_id: `install-${sequence}`,
  received_at_ms: receivedAtMs,
  type: "UNCHANGED",
  update_strategy: null,
});

const componentPartition = `${DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX}#analytics`;
const tablePartition = `${componentPartition}#table#bundle_events`;
const markerKey = itemKey({
  pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
  sk: "schema.analytics",
});

const createHarness = () => {
  const database = new InMemoryDynamoDB();
  const store: DynamoStore = {
    client: database as unknown as DynamoStore["client"],
    tableName: "analytics-component-data-test",
  };
  return {
    adapter: createDynamoDBUniversalComponentDataAdapter(store),
    database,
    store,
  };
};

describe("Analytics schema on the generic DynamoDB component adapter", () => {
  it("creates logical version 2 and round-trips ordered Analytics events", async () => {
    const { adapter, database } = createHarness();

    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });
    expect(database.items.get(markerKey)?.value).toBe("2");

    const persistence = createUniversalComponentAnalyticsPersistence(
      adapter.bind(analyticsComponentSchema),
    );
    const unchanged = unchangedRow(3, 2_000);
    await persistence.append(recoveredRow);
    await persistence.append(unchanged);
    await persistence.append(appliedRow);

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2_000, limit: 10 }),
    ).resolves.toEqual([appliedRow, recoveredRow]);
    await expect(
      persistence.scan({
        after: {
          id: appliedRow.id,
          receivedAtMs: appliedRow.received_at_ms,
        },
        beforeReceivedAtMs: 2_001,
        limit: 1,
      }),
    ).resolves.toEqual([recoveredRow]);
  });

  it("migrates the exact Analytics v1 contract without changing its rows", async () => {
    const { adapter, database } = createHarness();
    await adapter.migrate?.(analyticsV1Schema);
    await adapter.bind(analyticsV1Schema).append({
      row: appliedRow,
      table: "bundle_events",
    });

    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });

    expect(database.items.get(markerKey)?.value).toBe("2");
    const persistence = createUniversalComponentAnalyticsPersistence(
      adapter.bind(analyticsComponentSchema),
    );
    await expect(
      persistence.scan({ beforeReceivedAtMs: 1_001, limit: 10 }),
    ).resolves.toEqual([appliedRow]);
  });

  it("rejects a latest-marker store with a corrupt row on a later page", async () => {
    const { adapter, database, store } = createHarness();
    await adapter.migrate?.(analyticsComponentSchema);
    const source = adapter.bind(analyticsComponentSchema);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await source.append({
        row: unchangedRow(100 + sequence, sequence),
        table: "bundle_events",
      });
    }
    expect(database.items.get(markerKey)?.value).toBe("2");

    const primaryItems = [...database.items.values()]
      .filter(({ pk }) => pk === tablePartition)
      .sort((left, right) => String(left.sk).localeCompare(String(right.sk)));
    const lateItem = primaryItems.at(-1);
    if (lateItem === undefined || typeof lateItem.data !== "object") {
      throw new TypeError("Expected a late Analytics row");
    }
    database.put({
      ...lateItem,
      data: { ...(lateItem.data as Item), platform: "web" },
    });
    database.queriedPartitions.length = 0;

    const readiness = createDynamoDBUniversalComponentDataAdapter(store)
      .bind(analyticsComponentSchema)
      .assertReady();
    await expect(readiness).rejects.toMatchObject({
      componentId: "analytics",
      expectedVersion: "2",
      reason: "stored-data",
    });
    await expect(readiness).rejects.toBeInstanceOf(
      UniversalComponentDataStateNotReadyError,
    );
    expect(
      database.queriedPartitions.filter(
        (partition) => partition === tablePartition,
      ),
    ).toHaveLength(3);
    expect(database.items.get(markerKey)?.value).toBe("2");
  });
});
