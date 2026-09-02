import { createHash } from "node:crypto";

import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  BundleEventRow,
  InsightsModel,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsInstallationRow,
  InsightsPageEventsInput,
  InsightsPageEventsResult,
  InsightsReadVersions,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsEventContract,
  assertInsightsFailedReadContract,
  assertInsightsMaintenanceInputContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  canonicalInsightsJson,
  INSIGHTS_CURSOR_MAX_BYTES,
  INSIGHTS_EVENT_ID_PATTERN,
  INSIGHTS_EVENT_MAX_BYTES,
  InsightsContractError,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
} from "@hot-updater/plugin-core/internal";

export const DYNAMODB_INSIGHTS_V2_PREFIX = "_hot-updater#insights-v2" as const;
export const DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION = 2;
export const DYNAMODB_INSIGHTS_V2_STORAGE_REVISION = "dynamodb-i2-v1";
export const DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS = 32;
export const DYNAMODB_INSIGHTS_V2_GLOBAL_SHARDS = 16;
export const DYNAMODB_INSIGHTS_V2_INSTALL_SHARDS = 8;
export const DYNAMODB_INSIGHTS_V2_BUNDLE_SHARDS = 16;
export const DYNAMODB_INSIGHTS_V2_LATEST_SHARDS = 16;
export const DYNAMODB_INSIGHTS_RAW_EVENT_MAX_BYTES = INSIGHTS_EVENT_MAX_BYTES;
export const DYNAMODB_INSIGHTS_PAGE_MAX_BYTES = INSIGHTS_PAGE_MAX_BYTES;
export const DYNAMODB_INSIGHTS_STEP_MAX_BYTES =
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES;
export const DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES = 4 * 1_024 * 1_024;
export const DYNAMODB_INSIGHTS_TRANSACTION_MAX_ACTIONS = 100;
export const DYNAMODB_INSIGHTS_ITEM_MAX_BYTES = 400 * 1_024;
export const DYNAMODB_INSIGHTS_MIGRATION_MAX_ITEMS = 32;
export const DYNAMODB_INSIGHTS_PROJECTION_MAX_ITEMS = 32;

const EVENT_CURSOR_VERSION = 3;
const INSTALLATION_CURSOR_VERSION = 3;
const MAX_CURSOR_BYTES = INSIGHTS_CURSOR_MAX_BYTES;
const UUID_V7 = INSIGHTS_EVENT_ID_PATTERN;
const textEncoder = new TextEncoder();
const MIGRATION_JOB_ID = "dynamodb-insights-v2-migration";
const PROJECTION_JOB_ID = "dynamodb-insights-v2-projection";

type TransactItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

export interface DynamoDBInsightsV2Store {
  readonly tableName: string;
  readonly insightsDatabaseNamespace: string;
  readonly client: {
    send(command: unknown): Promise<any>;
  };
}

export class DynamoDBInsightsV2InputError extends Error {
  readonly name = "DynamoDBInsightsV2InputError";
}

export class DynamoDBInsightsV2RawEventSizeError extends Error {
  readonly name = "DynamoDBInsightsV2RawEventSizeError";

  constructor(readonly byteLength: number) {
    super(
      `DynamoDB Insights event is ${byteLength} bytes; maximum is ${DYNAMODB_INSIGHTS_RAW_EVENT_MAX_BYTES}`,
    );
  }
}

export class DynamoDBInsightsV2DuplicateEventError extends Error {
  readonly name = "DynamoDBInsightsV2DuplicateEventError";

  constructor(readonly eventId: string) {
    super(`DynamoDB Insights event "${eventId}" has conflicting contents`);
  }
}

export class DynamoDBInsightsV2HashCollisionError extends Error {
  readonly name = "DynamoDBInsightsV2HashCollisionError";

  constructor(readonly value: string) {
    super(`DynamoDB Insights SHA-256 collision for ${JSON.stringify(value)}`);
  }
}

export class DynamoDBInsightsV2StorageCorruptionError extends Error {
  readonly name = "DynamoDBInsightsV2StorageCorruptionError";
}

export class DynamoDBInsightsV2BudgetError extends Error {
  readonly name = "DynamoDBInsightsV2BudgetError";

  constructor(
    readonly kind:
      | "actions"
      | "item-bytes"
      | "requests"
      | "transaction-bytes"
      | "step-bytes",
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(
      `DynamoDB Insights ${kind} budget is ${actual}; maximum is ${maximum}`,
    );
  }
}

const withRequestBudget = (
  store: DynamoDBInsightsV2Store,
  maximum: number,
): DynamoDBInsightsV2Store => {
  let requests = 0;
  return {
    tableName: store.tableName,
    insightsDatabaseNamespace: store.insightsDatabaseNamespace,
    client: {
      send(command) {
        requests += 1;
        if (requests > maximum) {
          throw new DynamoDBInsightsV2BudgetError(
            "requests",
            requests,
            maximum,
          );
        }
        return store.client.send(command);
      },
    },
  };
};

export class DynamoDBInsightsV2NotReadyError extends Error {
  readonly name = "DynamoDBInsightsV2NotReadyError";

  constructor(readonly operation: "events" | "installations") {
    super(`DynamoDB Insights ${operation} projection is not ready`);
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const DATABASE_NAMESPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const dynamoDBInsightsV2Namespace = (
  store: Pick<DynamoDBInsightsV2Store, "insightsDatabaseNamespace">,
): string => {
  if (!DATABASE_NAMESPACE.test(store.insightsDatabaseNamespace)) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights database namespace must be a lowercase UUID",
    );
  }
  return store.insightsDatabaseNamespace;
};

const compareInsightsEventRows = (
  left: Pick<BundleEventRow, "received_at_ms" | "id">,
  right: Pick<BundleEventRow, "received_at_ms" | "id">,
): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

export const dynamoDBInsightsInstallationHash = (installId: string): string =>
  sha256(canonicalInsightsJson(installId));

const shard = (value: string, count: number): number =>
  Number.parseInt(sha256(value).slice(0, 8), 16) % count;

const padded = (value: number, width = 20): string =>
  Math.trunc(value).toString().padStart(width, "0");

const eventOrder = (
  row: Pick<BundleEventRow, "id" | "received_at_ms">,
): string => `${padded(row.received_at_ms, 16)}#${row.id}`;

const sourcePartition = (sourceShard: number): string =>
  `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#${padded(sourceShard, 2)}`;
const sourceSortKey = (sequence: number): string => `e#${padded(sequence)}`;
const sourceLedgerSortKey = (sequence: number, eventId: string): string =>
  `${sourceSortKey(sequence)}#${eventId}`;
const sourceLedgerAfter = (sequence: number): string =>
  `${sourceSortKey(sequence)}#\uffff`;
const sourceClockKey = (sourceShard: number) => ({
  pk: sourcePartition(sourceShard),
  sk: "!clock",
});
const sourceEventKey = (
  sourceShard: number,
  sequence: number,
  eventId: string,
) => ({
  pk: sourcePartition(sourceShard),
  sk: sourceLedgerSortKey(sequence, eventId),
});
const eventGuardKey = (eventId: string) => {
  const digest = sha256(eventId);
  return {
    pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#event-ids#${digest.slice(0, 2)}`,
    sk: digest,
  };
};
const stateKey = (name: string) => ({
  pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
  sk: name,
});

export const validateDynamoDBInsightsV2Event = (
  value: BundleEventRow,
): {
  readonly row: BundleEventRow;
  readonly json: string;
  readonly digest: string;
  readonly byteLength: number;
} => {
  try {
    assertInsightsEventContract(value);
  } catch (cause) {
    if (
      cause instanceof InsightsContractError &&
      cause.reason === "event-too-large" &&
      cause.actualBytes !== undefined
    ) {
      throw new DynamoDBInsightsV2RawEventSizeError(cause.actualBytes);
    }
    throw new DynamoDBInsightsV2InputError("Invalid DynamoDB Insights event", {
      cause,
    });
  }
  const json = canonicalInsightsJson(value);
  const row = JSON.parse(json) as BundleEventRow;
  const byteLength = textEncoder.encode(json).byteLength;
  if (byteLength > DYNAMODB_INSIGHTS_RAW_EVENT_MAX_BYTES) {
    throw new DynamoDBInsightsV2RawEventSizeError(byteLength);
  }
  return { row, json, digest: sha256(json), byteLength };
};

const marshallDynamoDBRecord = (value: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      marshallDynamoDBValue(item),
    ]),
  );

const marshallDynamoDBValue = (value: unknown): unknown => {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshallDynamoDBValue) };
  if (typeof value === "object") return { M: marshallDynamoDBRecord(value) };
  throw new DynamoDBInsightsV2InputError(
    "DynamoDB Insights transaction contains an unsupported value",
  );
};

export const dynamoDBInsightsMarshalledItemBytes = (
  item: Record<string, unknown>,
): number =>
  textEncoder.encode(JSON.stringify(marshallDynamoDBRecord(item))).byteLength;

export const dynamoDBInsightsTransactionRequestBytes = (
  actions: readonly TransactItem[],
): number => {
  const transactItems = actions.map((action) => {
    const [kind, operation] = Object.entries(action)[0]!;
    const input = operation as Record<string, unknown>;
    return {
      [kind]: {
        ...input,
        ...(input.Item && typeof input.Item === "object"
          ? { Item: marshallDynamoDBRecord(input.Item) }
          : {}),
        ...(input.Key && typeof input.Key === "object"
          ? { Key: marshallDynamoDBRecord(input.Key) }
          : {}),
        ...(input.ExpressionAttributeValues &&
        typeof input.ExpressionAttributeValues === "object"
          ? {
              ExpressionAttributeValues: marshallDynamoDBRecord(
                input.ExpressionAttributeValues,
              ),
            }
          : {}),
      },
    };
  });
  return textEncoder.encode(
    JSON.stringify({
      ClientRequestToken: "0".repeat(36),
      ReturnConsumedCapacity: "TOTAL",
      TransactItems: transactItems,
    }),
  ).byteLength;
};

export const assertDynamoDBInsightsTransactionBudget = (
  actions: readonly TransactItem[],
): number => {
  if (actions.length > DYNAMODB_INSIGHTS_TRANSACTION_MAX_ACTIONS) {
    throw new DynamoDBInsightsV2BudgetError(
      "actions",
      actions.length,
      DYNAMODB_INSIGHTS_TRANSACTION_MAX_ACTIONS,
    );
  }
  for (const action of actions) {
    const item = action.Put?.Item;
    if (item === undefined) continue;
    const itemBytes = dynamoDBInsightsMarshalledItemBytes(item);
    if (itemBytes >= DYNAMODB_INSIGHTS_ITEM_MAX_BYTES) {
      throw new DynamoDBInsightsV2BudgetError(
        "item-bytes",
        itemBytes,
        DYNAMODB_INSIGHTS_ITEM_MAX_BYTES - 1,
      );
    }
  }
  const byteLength = dynamoDBInsightsTransactionRequestBytes(actions);
  if (byteLength >= DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES) {
    throw new DynamoDBInsightsV2BudgetError(
      "transaction-bytes",
      byteLength,
      DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES - 1,
    );
  }
  return byteLength;
};

const transactionToken = (
  store: DynamoDBInsightsV2Store,
  scope: string,
  actions: readonly TransactItem[],
) =>
  sha256(
    `${dynamoDBInsightsV2Namespace(store)}\n${scope}\n${JSON.stringify(actions)}`,
  ).slice(0, 36);

const cancellationReasons = (error: unknown): readonly unknown[] => {
  const reasons =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "CancellationReasons")
      : undefined;
  return Array.isArray(reasons) ? reasons : [];
};

const conditionalCancellationIndexes = (error: unknown): readonly number[] =>
  cancellationReasons(error).flatMap((reason, index) =>
    typeof reason === "object" &&
    reason !== null &&
    Reflect.get(reason, "Code") === "ConditionalCheckFailed"
      ? [index]
      : [],
  );

const errorName = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? Reflect.get(error, "name")
    : undefined;

export const isRetryableDynamoDBInsightsError = (error: unknown): boolean => {
  const name = errorName(error);
  if (
    name === "TransactionConflictException" ||
    name === "ProvisionedThroughputExceededException" ||
    name === "ThrottlingException" ||
    name === "RequestLimitExceeded"
  ) {
    return true;
  }
  if (name !== "TransactionCanceledException") return false;
  const reasons = cancellationReasons(error);
  return reasons.some((reason) => {
    const code =
      typeof reason === "object" && reason !== null
        ? Reflect.get(reason, "Code")
        : undefined;
    return (
      code === "TransactionConflict" ||
      code === "ProvisionedThroughputExceeded" ||
      code === "ThrottlingError"
    );
  });
};

const sendTransaction = async (
  store: DynamoDBInsightsV2Store,
  scope: string,
  actions: readonly TransactItem[],
): Promise<void> => {
  assertDynamoDBInsightsTransactionBudget(actions);
  await store.client.send(
    new TransactWriteCommand({
      ClientRequestToken: transactionToken(store, scope, actions),
      ReturnConsumedCapacity: "TOTAL",
      TransactItems: [...actions],
    }),
  );
};

const getStrong = async (
  store: DynamoDBInsightsV2Store,
  key: { readonly pk: string; readonly sk: string },
): Promise<Record<string, unknown> | undefined> => {
  const result = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      Key: key,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  return result.Item;
};

const batchGetStrong = async (
  store: DynamoDBInsightsV2Store,
  keys: readonly { readonly pk: string; readonly sk: string }[],
): Promise<readonly Record<string, unknown>[]> => {
  if (keys.length === 0) return [];
  const output: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
      const result = await store.client.send(
        new BatchGetCommand({
          RequestItems: {
            [store.tableName]: {
              ConsistentRead: true,
              Keys: pending,
            },
          },
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      output.push(...(result.Responses?.[store.tableName] ?? []));
      pending = result.UnprocessedKeys?.[store.tableName]?.Keys ?? [];
    }
    if (pending.length > 0) {
      throw new Error(
        `DynamoDB Insights left ${pending.length} BatchGet keys unprocessed`,
      );
    }
  }
  return output;
};

const putIfAbsent = async (
  store: DynamoDBInsightsV2Store,
  item: Record<string, unknown>,
): Promise<void> => {
  try {
    await store.client.send(
      new PutCommand({
        TableName: store.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
        ReturnConsumedCapacity: "TOTAL",
      }),
    );
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
  }
};

export const initializeDynamoDBInsightsV2 = async (
  store: DynamoDBInsightsV2Store,
): Promise<void> => {
  const databaseNamespace = dynamoDBInsightsV2Namespace(store);
  const readinessNames = [
    "source",
    "projection#events",
    "projection#installations",
  ] as const;
  const readinessKeys = readinessNames.map(stateKey);
  const sourceKeys = Array.from(
    { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
    (_, sourceShard) => sourceClockKey(sourceShard),
  );
  const projectionKeys = Array.from(
    { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
    (_, sourceShard) => stateKey(`projection#source#${padded(sourceShard, 2)}`),
  );
  const layoutItem = {
    ...stateKey("layout"),
    item_type: "insights-layout",
    layout_version: DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
    storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
    database_namespace: databaseNamespace,
    source_shards: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS,
    global_shards: DYNAMODB_INSIGHTS_V2_GLOBAL_SHARDS,
    installation_shards: DYNAMODB_INSIGHTS_V2_INSTALL_SHARDS,
    bundle_shards: DYNAMODB_INSIGHTS_V2_BUNDLE_SHARDS,
    latest_shards: DYNAMODB_INSIGHTS_V2_LATEST_SHARDS,
  };
  let layout = await getStrong(store, stateKey("layout"));
  if (layout === undefined) {
    const initialItems = [
      layoutItem,
      ...readinessNames.map((name) => ({
        ...stateKey(name),
        item_type: "insights-readiness",
        job_id: name === "source" ? MIGRATION_JOB_ID : PROJECTION_JOB_ID,
        state: "preparing",
        storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
      })),
      ...sourceKeys.map((key) => ({
        ...key,
        item_type: "source-clock",
        sequence: 0,
      })),
      ...projectionKeys.map((key) => ({
        ...key,
        item_type: "insights-projection-checkpoint",
        job_id: PROJECTION_JOB_ID,
        sequence: 0,
      })),
    ];
    try {
      await sendTransaction(
        store,
        `initialize:${databaseNamespace}`,
        initialItems.map((item) => ({
          Put: {
            TableName: store.tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        })),
      );
    } catch (error) {
      layout = await getStrong(store, stateKey("layout"));
      if (layout === undefined) {
        if (conditionalCancellationIndexes(error).length > 0) {
          throw new DynamoDBInsightsV2StorageCorruptionError(
            "DynamoDB Insights initialization collided with partial storage",
          );
        }
        throw error;
      }
    }
    layout = await getStrong(store, stateKey("layout"));
  }
  if (
    layout?.item_type !== "insights-layout" ||
    layout.layout_version !== DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION ||
    layout.storage_revision !== DYNAMODB_INSIGHTS_V2_STORAGE_REVISION ||
    layout.database_namespace !== databaseNamespace ||
    layout.source_shards !== DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
    layout.global_shards !== DYNAMODB_INSIGHTS_V2_GLOBAL_SHARDS ||
    layout.installation_shards !== DYNAMODB_INSIGHTS_V2_INSTALL_SHARDS ||
    layout.bundle_shards !== DYNAMODB_INSIGHTS_V2_BUNDLE_SHARDS ||
    layout.latest_shards !== DYNAMODB_INSIGHTS_V2_LATEST_SHARDS
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights v2 layout is incompatible",
    );
  }
  const keys = [...readinessKeys, ...sourceKeys, ...projectionKeys];
  const persisted = await batchGetStrong(store, keys);
  assertExactItems(persisted, keys, "initialization");
  readinessNames.forEach((name, index) => {
    persistedReadiness(itemAt(persisted, readinessKeys[index]!), name);
  });
  sourceKeys.forEach((key) => {
    persistedClock(itemAt(persisted, key), key, "source-clock");
  });
  projectionKeys.forEach((key) => {
    persistedClock(
      itemAt(persisted, key),
      key,
      "insights-projection-checkpoint",
    );
  });
};

const clockSequence = (item: Record<string, unknown>): number => {
  if (!Number.isSafeInteger(item.sequence) || Number(item.sequence) < 0) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights source clock is invalid",
    );
  }
  return Number(item.sequence);
};

const nextSafeSequence = (sequence: number): number => {
  if (sequence === Number.MAX_SAFE_INTEGER) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights sequence is exhausted",
    );
  }
  return sequence + 1;
};

const nextSafeRevision = (revision: number): number => {
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights revision is exhausted",
    );
  }
  return revision + 1;
};

const guardMatches = (
  item: Record<string, unknown> | undefined,
  eventId: string,
  digest: string,
): boolean => item?.event_id === eventId && item?.row_digest === digest;

const assertEventGuard = (
  item: Record<string, unknown>,
  eventId: string,
): void => {
  const key = eventGuardKey(eventId);
  if (
    item.pk !== key.pk ||
    item.sk !== key.sk ||
    item.item_type !== "event-id-guard" ||
    item.event_id !== eventId ||
    typeof item.row_digest !== "string" ||
    !Number.isSafeInteger(item.source_shard) ||
    !Number.isSafeInteger(item.source_sequence)
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights event guard is invalid",
    );
  }
};

const sourceRecord = (
  sourceShard: number,
  sequence: number,
  event: ReturnType<typeof validateDynamoDBInsightsV2Event>,
): SourceItem => ({
  ...sourceEventKey(sourceShard, sequence, event.row.id),
  item_type: "source-event",
  source_shard: sourceShard,
  source_sequence: sequence,
  event_id: event.row.id,
  row_digest: event.digest,
  raw_bytes: event.byteLength,
  row: event.row,
});

const sourcePut = (
  store: DynamoDBInsightsV2Store,
  source: SourceItem,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: source,
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const guardPut = (
  store: DynamoDBInsightsV2Store,
  sourceShard: number,
  sequence: number,
  event: ReturnType<typeof validateDynamoDBInsightsV2Event>,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: {
      ...eventGuardKey(event.row.id),
      item_type: "event-id-guard",
      event_id: event.row.id,
      row_digest: event.digest,
      source_shard: sourceShard,
      source_sequence: sequence,
    },
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const clockWrite = (
  store: DynamoDBInsightsV2Store,
  sourceShard: number,
  previous: number,
  next: number,
): TransactItem => ({
  Update: {
    TableName: store.tableName,
    Key: sourceClockKey(sourceShard),
    ConditionExpression: "#type = :type AND #sequence = :previous",
    UpdateExpression: "SET #sequence = :next",
    ExpressionAttributeNames: {
      "#type": "item_type",
      "#sequence": "sequence",
    },
    ExpressionAttributeValues: {
      ":type": "source-clock",
      ":previous": previous,
      ":next": next,
    },
  },
});

const recordAppendCorruption = async (
  store: DynamoDBInsightsV2Store,
  sourceShard: number,
  sourceSequence: number,
  sourceCorrupt: boolean,
): Promise<DynamoDBInsightsV2StorageCorruptionError> => {
  const error = new DynamoDBInsightsV2StorageCorruptionError(
    "DynamoDB Insights append collided with persisted storage",
  );
  const poison = {
    sourceShard,
    sourceSequence,
    code: error.name,
    message: error.message,
  };
  await sendTransaction(
    store,
    `append:corruption:${sourceShard}:${sourceSequence}`,
    [
      ...(sourceCorrupt
        ? [readinessPut(store, "source", "failed", { poison })]
        : []),
      readinessPut(store, "projection#events", "failed", { poison }),
      readinessPut(store, "projection#installations", "failed", { poison }),
    ],
  );
  return error;
};

export const appendDynamoDBInsightsV2 = async (
  store: DynamoDBInsightsV2Store,
  value: BundleEventRow,
  initialized = false,
): Promise<void> => {
  const event = validateDynamoDBInsightsV2Event(value);
  const sourceShard = shard(event.row.id, DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS);
  if (!initialized) await initializeDynamoDBInsightsV2(store);
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const checkpointKey = stateKey(
      `projection#source#${padded(sourceShard, 2)}`,
    );
    const [guard, clock, checkpoint] = await Promise.all([
      getStrong(store, eventGuardKey(event.row.id)),
      getStrong(store, sourceClockKey(sourceShard)),
      getStrong(store, checkpointKey),
    ]);
    if (guard !== undefined) {
      assertEventGuard(guard, event.row.id);
      if (guardMatches(guard, event.row.id, event.digest)) return;
      throw new DynamoDBInsightsV2DuplicateEventError(event.row.id);
    }
    const previous = persistedClock(
      clock,
      sourceClockKey(sourceShard),
      "source-clock",
    );
    const sequence = nextSafeSequence(previous);
    const source = sourceRecord(sourceShard, sequence, event);
    const projectInline =
      persistedClock(
        checkpoint,
        checkpointKey,
        "insights-projection-checkpoint",
      ) === previous;
    const currentCandidate = projectInline
      ? await getStrong(
          store,
          installationCurrentCandidateKey(
            dynamoDBInsightsInstallationHash(source.row.install_id),
            sourceShard,
          ),
        )
      : undefined;
    const parsedCurrentCandidate =
      currentCandidate === undefined
        ? undefined
        : parseInstallationCandidate(
            currentCandidate,
            source.row.install_id,
            dynamoDBInsightsInstallationHash(source.row.install_id),
            sourceShard,
            true,
          );
    if (
      parsedCurrentCandidate !== undefined &&
      parsedCurrentCandidate.projectedSequence > previous
    ) {
      continue;
    }
    const actions = [
      guardPut(store, sourceShard, sequence, event),
      sourcePut(store, source),
      clockWrite(store, sourceShard, previous, sequence),
      ...(projectInline
        ? [
            ...pointerActions(store, source),
            ...installationActions(store, source, currentCandidate),
            projectionCheckpointAction(store, sourceShard, previous, sequence),
          ]
        : []),
    ];
    try {
      await sendTransaction(
        store,
        `append:${event.row.id}:${sourceShard}:${sequence}`,
        actions,
      );
      return;
    } catch (error) {
      lastError = error;
      const committedGuard = await getStrong(
        store,
        eventGuardKey(event.row.id),
      );
      if (committedGuard !== undefined) {
        assertEventGuard(committedGuard, event.row.id);
      }
      if (guardMatches(committedGuard, event.row.id, event.digest)) return;
      if (committedGuard !== undefined) {
        throw new DynamoDBInsightsV2DuplicateEventError(event.row.id);
      }
      const conditional = conditionalCancellationIndexes(error);
      const checkpointIndex = projectInline ? actions.length - 1 : -1;
      const currentCandidateIndex = actions.findIndex(
        (action) =>
          action.Put?.Item?.item_type === "installation-current-candidate",
      );
      if (conditional.length > 0) {
        const committedClock = persistedClock(
          await getStrong(store, sourceClockKey(sourceShard)),
          sourceClockKey(sourceShard),
          "source-clock",
        );
        if (committedClock > previous) {
          if (
            conditional.includes(2) &&
            conditional.every(
              (index) =>
                index === 2 ||
                index === checkpointIndex ||
                index === currentCandidateIndex,
            )
          ) {
            if (conditional.includes(currentCandidateIndex)) {
              const candidateKey = installationCurrentCandidateKey(
                dynamoDBInsightsInstallationHash(source.row.install_id),
                sourceShard,
              );
              const [committedCheckpointItem, committedCandidateItem] =
                await Promise.all([
                  getStrong(store, checkpointKey),
                  getStrong(store, candidateKey),
                ]);
              let reconciled = false;
              try {
                const committedCheckpoint = persistedClock(
                  committedCheckpointItem,
                  checkpointKey,
                  "insights-projection-checkpoint",
                );
                const committedCandidate =
                  committedCandidateItem === undefined
                    ? undefined
                    : parseInstallationCandidate(
                        committedCandidateItem,
                        source.row.install_id,
                        dynamoDBInsightsInstallationHash(source.row.install_id),
                        sourceShard,
                        true,
                      );
                reconciled =
                  committedCheckpoint > previous &&
                  committedCheckpoint <= committedClock &&
                  committedCandidate !== undefined &&
                  committedCandidate.projectedSequence > previous &&
                  committedCandidate.projectedSequence <= committedCheckpoint &&
                  committedCandidate.recordDigest !==
                    parsedCurrentCandidate?.recordDigest;
              } catch {
                reconciled = false;
              }
              if (!reconciled) {
                throw await recordAppendCorruption(
                  store,
                  sourceShard,
                  sequence,
                  false,
                );
              }
            }
            continue;
          }
          throw await recordAppendCorruption(
            store,
            sourceShard,
            sequence,
            conditional.includes(1),
          );
        }
        if (committedClock < previous) {
          throw await recordAppendCorruption(
            store,
            sourceShard,
            sequence,
            true,
          );
        }
      }
      if (conditional.length > 0) {
        throw await recordAppendCorruption(
          store,
          sourceShard,
          sequence,
          conditional.includes(1),
        );
      }
      if (!isRetryableDynamoDBInsightsError(error)) throw error;
    }
  }
  throw lastError;
};

type ReadinessState = "ready" | "preparing" | "failed";

export interface DynamoDBInsightsV2Readiness {
  readonly storageRevision: string;
  readonly source: ReadinessState;
  readonly events: ReadinessState;
  readonly installations: ReadinessState;
}

type DynamoDBInsightsReadVersions = Omit<
  InsightsReadVersions,
  | "schemaVersion"
  | "storageVersion"
  | "projectionGeneration"
  | "sourceGeneration"
> & {
  readonly schemaVersion: string;
  readonly storageVersion: string;
  readonly projectionGeneration: string;
  readonly sourceGeneration: string;
};

type DynamoDBInsightsV2State = {
  readonly readiness: DynamoDBInsightsV2Readiness;
  readonly versions: DynamoDBInsightsReadVersions;
  readonly sourceVector: readonly number[];
  readonly projectionVector: readonly number[];
};

const itemAt = (
  items: readonly Record<string, unknown>[],
  key: { readonly pk: string; readonly sk: string },
): Record<string, unknown> | undefined => {
  const matches = items.filter(
    (item) => item.pk === key.pk && item.sk === key.sk,
  );
  if (matches.length > 1) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      `DynamoDB Insights item ${key.pk}/${key.sk} is duplicated`,
    );
  }
  return matches[0];
};

const assertExactItems = (
  items: readonly Record<string, unknown>[],
  keys: readonly { readonly pk: string; readonly sk: string }[],
  scope: string,
): void => {
  const expected = new Set(keys.map((key) => `${key.pk}\n${key.sk}`));
  if (
    items.length !== keys.length ||
    items.some(
      (item) => !expected.has(`${String(item.pk)}\n${String(item.sk)}`),
    )
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      `DynamoDB Insights ${scope} item set is invalid`,
    );
  }
  keys.forEach((key) => itemAt(items, key));
};

const persistedReadiness = (
  item: Record<string, unknown> | undefined,
  name: "source" | "projection#events" | "projection#installations",
): ReadinessState => {
  const key = stateKey(name);
  const expectedJob = name === "source" ? MIGRATION_JOB_ID : PROJECTION_JOB_ID;
  if (
    item === undefined ||
    item.pk !== key.pk ||
    item.sk !== key.sk ||
    item.item_type !== "insights-readiness" ||
    item.job_id !== expectedJob ||
    item.storage_revision !== DYNAMODB_INSIGHTS_V2_STORAGE_REVISION ||
    (item.state !== "ready" &&
      item.state !== "preparing" &&
      item.state !== "failed")
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      `DynamoDB Insights readiness ${name} is invalid`,
    );
  }
  return item.state;
};

const persistedClock = (
  item: Record<string, unknown> | undefined,
  key: { readonly pk: string; readonly sk: string },
  itemType: "source-clock" | "insights-projection-checkpoint",
): number => {
  if (
    item === undefined ||
    item.pk !== key.pk ||
    item.sk !== key.sk ||
    item.item_type !== itemType ||
    (itemType === "insights-projection-checkpoint" &&
      item.job_id !== PROJECTION_JOB_ID)
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      `DynamoDB Insights ${itemType} is invalid`,
    );
  }
  return clockSequence(item);
};

const generation = (
  kind: "source" | "projection",
  vector: readonly number[],
): string =>
  `${DYNAMODB_INSIGHTS_V2_STORAGE_REVISION}:${kind}:${sha256(
    canonicalInsightsJson(vector),
  )}`;

const readDynamoDBInsightsV2State = async (
  store: DynamoDBInsightsV2Store,
): Promise<DynamoDBInsightsV2State> => {
  await initializeDynamoDBInsightsV2(store);
  const readinessKeys = [
    stateKey("source"),
    stateKey("projection#events"),
    stateKey("projection#installations"),
  ] as const;
  const sourceKeys = Array.from(
    { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
    (_, sourceShard) => sourceClockKey(sourceShard),
  );
  const projectionKeys = Array.from(
    { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
    (_, sourceShard) => stateKey(`projection#source#${padded(sourceShard, 2)}`),
  );
  const items = await batchGetStrong(store, [
    ...readinessKeys,
    ...sourceKeys,
    ...projectionKeys,
  ]);
  assertExactItems(
    items,
    [...readinessKeys, ...sourceKeys, ...projectionKeys],
    "state",
  );
  const sourceState = persistedReadiness(
    itemAt(items, readinessKeys[0]),
    "source",
  );
  const eventsState = persistedReadiness(
    itemAt(items, readinessKeys[1]),
    "projection#events",
  );
  const installationsState = persistedReadiness(
    itemAt(items, readinessKeys[2]),
    "projection#installations",
  );
  const sourceVector = sourceKeys.map((key) =>
    persistedClock(itemAt(items, key), key, "source-clock"),
  );
  const projectionVector = projectionKeys.map((key) =>
    persistedClock(itemAt(items, key), key, "insights-projection-checkpoint"),
  );
  if (
    projectionVector.some(
      (sequence, sourceShard) => sequence > sourceVector[sourceShard]!,
    )
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights projection is ahead of its source",
    );
  }
  const caughtUp = projectionVector.every(
    (sequence, sourceShard) => sequence === sourceVector[sourceShard],
  );
  const effective = (state: ReadinessState): ReadinessState =>
    state === "failed"
      ? "failed"
      : sourceState === "ready" && state === "ready" && caughtUp
        ? "ready"
        : "preparing";
  return {
    readiness: {
      storageRevision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
      source: sourceState,
      events: effective(eventsState),
      installations: effective(installationsState),
    },
    versions: {
      schemaVersion: String(DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION),
      storageVersion: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
      sourceGeneration: generation("source", sourceVector),
      projectionGeneration: generation("projection", projectionVector),
    },
    sourceVector,
    projectionVector,
  };
};

export const getDynamoDBInsightsV2Readiness = async (
  store: DynamoDBInsightsV2Store,
): Promise<DynamoDBInsightsV2Readiness> => {
  return (await readDynamoDBInsightsV2State(store)).readiness;
};

const readinessPut = (
  store: DynamoDBInsightsV2Store,
  name: string,
  state: ReadinessState,
  detail: Record<string, unknown> = {},
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: {
      ...stateKey(name),
      item_type: "insights-readiness",
      job_id: name === "source" ? MIGRATION_JOB_ID : PROJECTION_JOB_ID,
      state,
      storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
      ...detail,
    },
    ...(name.startsWith("projection#") && state === "ready"
      ? {
          ConditionExpression: "#state <> :failed",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":failed": "failed" },
        }
      : name.startsWith("projection#") && state === "failed"
        ? {
            ConditionExpression:
              "attribute_not_exists(#state) OR #state <> :failed",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":failed": "failed" },
          }
        : {}),
  },
});

type LegacyCheckpoint = {
  readonly pk: string;
  readonly sk: string;
  readonly item_type: "insights-migration-job";
  readonly job_id: string;
  readonly revision: number;
  readonly boundary_sk: string | null;
  readonly after_sk: string;
  readonly state: "running" | "done" | "failed";
  readonly poison?: unknown;
};

const isLegacyCheckpoint = (
  item: Record<string, unknown> | undefined,
): item is LegacyCheckpoint =>
  item !== undefined &&
  item.item_type === "insights-migration-job" &&
  item.job_id === MIGRATION_JOB_ID &&
  Number.isSafeInteger(item.revision) &&
  Number(item.revision) >= 1 &&
  typeof item.after_sk === "string" &&
  (typeof item.boundary_sk === "string" || item.boundary_sk === null) &&
  (item.state === "running" ||
    item.state === "done" ||
    item.state === "failed");

export const DYNAMODB_INSIGHTS_LEGACY_PARTITION = "bundle_events";

const initializeLegacyCheckpoint = async (
  store: DynamoDBInsightsV2Store,
): Promise<LegacyCheckpoint> => {
  const existing = await getStrong(store, stateKey("migration#legacy"));
  if (isLegacyCheckpoint(existing)) return existing;
  const boundaryPage = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": DYNAMODB_INSIGHTS_LEGACY_PARTITION,
      },
      ProjectionExpression: "#sk",
      Limit: 1,
      ScanIndexForward: false,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const boundary = boundaryPage.Items?.[0]?.sk;
  if (boundary !== undefined && typeof boundary !== "string") {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights legacy boundary is invalid",
    );
  }
  const checkpoint: LegacyCheckpoint = {
    ...stateKey("migration#legacy"),
    item_type: "insights-migration-job",
    job_id: MIGRATION_JOB_ID,
    revision: 1,
    boundary_sk: boundary ?? null,
    after_sk: "",
    state: boundary === undefined ? "done" : "running",
  };
  await putIfAbsent(store, checkpoint);
  const canonical = await getStrong(store, stateKey("migration#legacy"));
  if (!isLegacyCheckpoint(canonical)) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights migration checkpoint is invalid",
    );
  }
  if (canonical.state === "done" && canonical.boundary_sk === null) {
    await sendTransaction(store, "migration:empty", [
      readinessPut(store, "source", "ready", { boundary_sk: null }),
    ]);
  }
  return canonical;
};

const parseLegacyEvent = (
  item: Record<string, unknown>,
): ReturnType<typeof validateDynamoDBInsightsV2Event> => {
  if (
    item.pk !== DYNAMODB_INSIGHTS_LEGACY_PARTITION ||
    typeof item.sk !== "string" ||
    item.version !== 1 ||
    typeof item.row !== "object" ||
    item.row === null
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights legacy item is malformed",
    );
  }
  const event = validateDynamoDBInsightsV2Event(item.row as BundleEventRow);
  if (item.sk !== eventOrder(event.row)) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights legacy key does not match its event",
    );
  }
  return event;
};

const checkpointWrite = (
  store: DynamoDBInsightsV2Store,
  checkpoint: LegacyCheckpoint,
  next: Omit<
    LegacyCheckpoint,
    "pk" | "sk" | "item_type" | "job_id" | "revision"
  >,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: {
      ...stateKey("migration#legacy"),
      item_type: "insights-migration-job",
      job_id: MIGRATION_JOB_ID,
      ...next,
      revision: nextSafeRevision(checkpoint.revision),
    },
    ConditionExpression: "#revision = :revision AND #after = :after",
    ExpressionAttributeNames: {
      "#revision": "revision",
      "#after": "after_sk",
    },
    ExpressionAttributeValues: {
      ":revision": checkpoint.revision,
      ":after": checkpoint.after_sk,
    },
  },
});

export type DynamoDBInsightsMigrationStep =
  | { readonly state: "done"; readonly migrated: number }
  | {
      readonly state: "running";
      readonly migrated: number;
      readonly cursor: string;
    }
  | { readonly state: "failed"; readonly poison: unknown };

const failMigration = async (
  store: DynamoDBInsightsV2Store,
  checkpoint: LegacyCheckpoint,
  legacyKey: string,
  error: unknown,
): Promise<DynamoDBInsightsMigrationStep> => {
  const poison = {
    legacyKey,
    code: errorName(error) ?? "InvalidEvent",
    message:
      error instanceof Error ? error.message.slice(0, 1_024) : "Invalid event",
  };
  try {
    await sendTransaction(store, `migration:poison:${checkpoint.revision}`, [
      checkpointWrite(store, checkpoint, {
        boundary_sk: checkpoint.boundary_sk,
        after_sk: checkpoint.after_sk,
        state: "failed",
        poison,
      }),
      readinessPut(store, "source", "failed", { poison }),
    ]);
  } catch (cause) {
    const current = await getStrong(store, stateKey("migration#legacy"));
    if (isLegacyCheckpoint(current) && current.state === "failed") {
      return { state: "failed", poison: current.poison };
    }
    throw cause;
  }
  return { state: "failed", poison };
};

export const runDynamoDBInsightsLegacyBackfillStep = async (
  baseStore: DynamoDBInsightsV2Store,
  input: { readonly maxItems: number; readonly maxRequests: number },
): Promise<DynamoDBInsightsMigrationStep> => {
  assertInsightsMaintenanceInputContract(input);
  if (
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > DYNAMODB_INSIGHTS_MIGRATION_MAX_ITEMS ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 14
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Migration step requires maxItems 1..32 and maxRequests at least 14",
    );
  }
  const store = withRequestBudget(baseStore, input.maxRequests);
  await initializeDynamoDBInsightsV2(store);
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const checkpoint = await initializeLegacyCheckpoint(store);
    if (checkpoint.state === "done") return { state: "done", migrated: 0 };
    if (checkpoint.state === "failed") {
      return { state: "failed", poison: checkpoint.poison };
    }
    if (checkpoint.boundary_sk === null) {
      throw new DynamoDBInsightsV2InputError(
        "Running migration has no boundary",
      );
    }
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ConsistentRead: true,
        KeyConditionExpression:
          checkpoint.after_sk === ""
            ? "#pk = :pk AND #sk <= :boundary"
            : "#pk = :pk AND #sk BETWEEN :after AND :boundary",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": DYNAMODB_INSIGHTS_LEGACY_PARTITION,
          ":boundary": checkpoint.boundary_sk,
          ...(checkpoint.after_sk === ""
            ? {}
            : { ":after": checkpoint.after_sk }),
        },
        Limit: input.maxItems + (checkpoint.after_sk === "" ? 0 : 1),
        ScanIndexForward: true,
        ReturnConsumedCapacity: "TOTAL",
      }),
    );
    const legacyItems = (page.Items ?? [])
      .filter(
        (item: Record<string, unknown>) => item.sk !== checkpoint.after_sk,
      )
      .slice(0, input.maxItems);
    if (legacyItems.length === 0) {
      await sendTransaction(store, `migration:done:${checkpoint.revision}`, [
        checkpointWrite(store, checkpoint, {
          boundary_sk: checkpoint.boundary_sk,
          after_sk: checkpoint.after_sk,
          state: "done",
        }),
        readinessPut(store, "source", "ready", {
          boundary_sk: checkpoint.boundary_sk,
        }),
      ]);
      return { state: "done", migrated: 0 };
    }
    const parsedEvents: ReturnType<typeof validateDynamoDBInsightsV2Event>[] =
      [];
    for (const item of legacyItems) {
      try {
        parsedEvents.push(parseLegacyEvent(item));
      } catch (error) {
        return failMigration(store, checkpoint, String(item.sk), error);
      }
    }
    const eventById = new Map<
      string,
      ReturnType<typeof validateDynamoDBInsightsV2Event>
    >();
    for (let index = 0; index < parsedEvents.length; index++) {
      const event = parsedEvents[index]!;
      const previous = eventById.get(event.row.id);
      if (previous !== undefined && previous.digest !== event.digest) {
        return failMigration(
          store,
          checkpoint,
          String(legacyItems[index]!.sk),
          new DynamoDBInsightsV2DuplicateEventError(event.row.id),
        );
      }
      eventById.set(event.row.id, event);
    }
    const events = [...eventById.values()];
    const stepBytes = events.reduce((sum, event) => sum + event.byteLength, 0);
    if (stepBytes > DYNAMODB_INSIGHTS_STEP_MAX_BYTES) {
      throw new DynamoDBInsightsV2BudgetError(
        "step-bytes",
        stepBytes,
        DYNAMODB_INSIGHTS_STEP_MAX_BYTES,
      );
    }
    const guardKeys = events.map((event) => eventGuardKey(event.row.id));
    const touchedShards = [
      ...new Set(
        events.map((event) =>
          shard(event.row.id, DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS),
        ),
      ),
    ];
    const existing = await batchGetStrong(store, [
      ...guardKeys,
      ...touchedShards.map(sourceClockKey),
    ]);
    const byKey = new Map(
      existing.map((item) => [`${String(item.pk)}\n${String(item.sk)}`, item]),
    );
    const get = (key: { readonly pk: string; readonly sk: string }) =>
      byKey.get(`${key.pk}\n${key.sk}`);
    for (let index = 0; index < events.length; index++) {
      const guard = get(guardKeys[index]!);
      if (
        guard !== undefined &&
        !guardMatches(guard, events[index]!.row.id, events[index]!.digest)
      ) {
        return failMigration(
          store,
          checkpoint,
          String(legacyItems[index]!.sk),
          new DynamoDBInsightsV2DuplicateEventError(events[index]!.row.id),
        );
      }
    }
    const clocks = new Map(
      touchedShards.map((sourceShard) => [
        sourceShard,
        persistedClock(
          get(sourceClockKey(sourceShard)),
          sourceClockKey(sourceShard),
          "source-clock",
        ),
      ]),
    );
    const nextClocks = new Map(clocks);
    const actions: TransactItem[] = [];
    const retryableConditionals = new Set<number>();
    let migrated = 0;
    for (const event of events) {
      if (get(eventGuardKey(event.row.id)) !== undefined) continue;
      const sourceShard = shard(
        event.row.id,
        DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS,
      );
      const previousSequence = nextClocks.get(sourceShard);
      if (previousSequence === undefined) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "DynamoDB Insights source clock is missing",
        );
      }
      const sequence = nextSafeSequence(previousSequence);
      nextClocks.set(sourceShard, sequence);
      retryableConditionals.add(actions.length);
      actions.push(guardPut(store, sourceShard, sequence, event));
      actions.push(
        sourcePut(store, sourceRecord(sourceShard, sequence, event)),
      );
      migrated += 1;
    }
    for (const [sourceShard, next] of nextClocks) {
      const previous = clocks.get(sourceShard) ?? 0;
      if (next !== previous) {
        retryableConditionals.add(actions.length);
        actions.push(clockWrite(store, sourceShard, previous, next));
      }
    }
    const lastKey = String(legacyItems.at(-1)!.sk);
    const done =
      lastKey === checkpoint.boundary_sk ||
      (page.LastEvaluatedKey === undefined &&
        legacyItems.length < input.maxItems);
    retryableConditionals.add(actions.length);
    actions.push(
      checkpointWrite(store, checkpoint, {
        boundary_sk: checkpoint.boundary_sk,
        after_sk: lastKey,
        state: done ? "done" : "running",
      }),
    );
    if (done) {
      actions.push(
        readinessPut(store, "source", "ready", {
          boundary_sk: checkpoint.boundary_sk,
        }),
      );
    }
    try {
      await sendTransaction(
        store,
        `migration:${checkpoint.revision}:${lastKey}`,
        actions,
      );
      return done
        ? { state: "done", migrated }
        : { state: "running", migrated, cursor: lastKey };
    } catch (error) {
      lastError = error;
      const current = await getStrong(store, stateKey("migration#legacy"));
      if (
        isLegacyCheckpoint(current) &&
        current.after_sk === lastKey &&
        current.revision === nextSafeRevision(checkpoint.revision)
      ) {
        return current.state === "done"
          ? { state: "done", migrated }
          : { state: "running", migrated, cursor: lastKey };
      }
      const conditional = conditionalCancellationIndexes(error);
      if (
        conditional.length > 0 &&
        conditional.every((index) => retryableConditionals.has(index))
      ) {
        continue;
      }
      if (conditional.length > 0) {
        return failMigration(
          store,
          checkpoint,
          lastKey,
          new DynamoDBInsightsV2StorageCorruptionError(
            "DynamoDB Insights migration collided with source storage",
          ),
        );
      }
      if (!isRetryableDynamoDBInsightsError(error)) throw error;
    }
  }
  throw lastError;
};

type SourceItem = {
  readonly pk: string;
  readonly sk: string;
  readonly item_type: "source-event";
  readonly source_shard: number;
  readonly source_sequence: number;
  readonly event_id: string;
  readonly row_digest: string;
  readonly raw_bytes: number;
  readonly row: BundleEventRow;
};

const parseSourceItem = (item: Record<string, unknown>): SourceItem => {
  if (
    item.item_type !== "source-event" ||
    typeof item.pk !== "string" ||
    typeof item.sk !== "string" ||
    !Number.isSafeInteger(item.source_shard) ||
    Number(item.source_shard) < 0 ||
    Number(item.source_shard) >= DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
    !Number.isSafeInteger(item.source_sequence) ||
    Number(item.source_sequence) < 1 ||
    typeof item.event_id !== "string" ||
    typeof item.row_digest !== "string" ||
    !Number.isSafeInteger(item.raw_bytes) ||
    typeof item.row !== "object" ||
    item.row === null
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights source item is invalid",
    );
  }
  let event: ReturnType<typeof validateDynamoDBInsightsV2Event>;
  try {
    event = validateDynamoDBInsightsV2Event(item.row as BundleEventRow);
  } catch (cause) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights source item event is invalid",
      { cause },
    );
  }
  const expectedKey = sourceEventKey(
    Number(item.source_shard),
    Number(item.source_sequence),
    event.row.id,
  );
  if (
    item.pk !== expectedKey.pk ||
    item.sk !== expectedKey.sk ||
    event.row.id !== item.event_id ||
    event.digest !== item.row_digest ||
    event.byteLength !== item.raw_bytes
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights source item checksum is invalid",
    );
  }
  return item as unknown as SourceItem;
};

type PointerStream = {
  readonly directoryPk: string;
  readonly pointerPk: (bucket: string) => string;
  readonly bucketMs: number;
};

const directoryItem = (
  stream: PointerStream,
  bucket: string,
): Record<string, unknown> => {
  const key = { pk: stream.directoryPk, sk: bucket };
  return {
    ...key,
    item_type: "event-directory",
    record_digest: sha256(
      canonicalInsightsJson([key.pk, key.sk, "event-directory"]),
    ),
  };
};

const globalStream = (pointerShard: number): PointerStream => ({
  directoryPk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#dir#g#${padded(pointerShard, 2)}`,
  pointerPk: (bucket) =>
    `${DYNAMODB_INSIGHTS_V2_PREFIX}#ptr#g#${bucket}#${padded(pointerShard, 2)}`,
  bucketMs: 60 * 60 * 1_000,
});

const installStream = (
  installHash: string,
  movement: "a" | "r",
  pointerShard: number,
): PointerStream => ({
  directoryPk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#dir#i#${installHash}#${movement}#${padded(pointerShard, 2)}`,
  pointerPk: (bucket) =>
    `${DYNAMODB_INSIGHTS_V2_PREFIX}#ptr#i#${installHash}#${movement}#${bucket}#${padded(pointerShard, 2)}`,
  bucketMs: 24 * 60 * 60 * 1_000,
});

const bundleStream = (
  bundleHash: string,
  movement: "a" | "r",
  pointerShard: number,
): PointerStream => ({
  directoryPk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#dir#b#${bundleHash}#${movement}#${padded(pointerShard, 2)}`,
  pointerPk: (bucket) =>
    `${DYNAMODB_INSIGHTS_V2_PREFIX}#ptr#b#${bundleHash}#${movement}#${bucket}#${padded(pointerShard, 2)}`,
  bucketMs: 60 * 60 * 1_000,
});

const bucketFor = (timestamp: number, bucketMs: number): string =>
  padded(Math.floor(timestamp / bucketMs), 16);

const streamsForEvent = (row: BundleEventRow): readonly PointerStream[] => {
  const streams: PointerStream[] = [
    globalStream(shard(row.id, DYNAMODB_INSIGHTS_V2_GLOBAL_SHARDS)),
  ];
  if (row.type === "UPDATE_APPLIED" || row.type === "RECOVERED") {
    const movement = row.type === "UPDATE_APPLIED" ? "a" : "r";
    streams.push(
      installStream(
        dynamoDBInsightsInstallationHash(row.install_id),
        movement,
        shard(row.id, DYNAMODB_INSIGHTS_V2_INSTALL_SHARDS),
      ),
      bundleStream(
        sha256(
          canonicalInsightsJson(
            row.type === "UPDATE_APPLIED"
              ? row.to_bundle_id
              : row.from_bundle_id,
          ),
        ),
        movement,
        shard(row.id, DYNAMODB_INSIGHTS_V2_BUNDLE_SHARDS),
      ),
    );
  }
  return streams;
};

const pointerActions = (
  store: DynamoDBInsightsV2Store,
  source: SourceItem,
): readonly TransactItem[] =>
  streamsForEvent(source.row).flatMap((stream) => {
    const bucket = bucketFor(source.row.received_at_ms, stream.bucketMs);
    const directory = directoryItem(stream, bucket);
    return [
      {
        Put: {
          TableName: store.tableName,
          Item: directory,
          ConditionExpression:
            "attribute_not_exists(#pk) OR (#type = :type AND #digest = :digest)",
          ExpressionAttributeNames: {
            "#pk": "pk",
            "#type": "item_type",
            "#digest": "record_digest",
          },
          ExpressionAttributeValues: {
            ":type": "event-directory",
            ":digest": directory.record_digest,
          },
        },
      },
      {
        Put: {
          TableName: store.tableName,
          Item: {
            pk: stream.pointerPk(bucket),
            sk: eventOrder(source.row),
            item_type: "event-pointer",
            event_id: source.row.id,
            source_pk: source.pk,
            source_sk: source.sk,
            raw_bytes: source.raw_bytes,
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      },
    ] as readonly TransactItem[];
  });

const installationIdentityKey = (installId: string) => {
  const installHash = dynamoDBInsightsInstallationHash(installId);
  return {
    pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#latest#${installHash[0]}`,
    sk: installHash,
  };
};

const installationCandidateKey = (
  installHash: string,
  sourceShard: number,
  sourceSequence: number,
  projectionEventId = "",
) => ({
  pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#latest-history#${installHash}#${padded(sourceShard, 2)}`,
  sk: `${sourceSortKey(sourceSequence)}#${projectionEventId}`,
});

const installationCurrentCandidateKey = (
  installHash: string,
  sourceShard: number,
) => ({
  pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#latest-current#${installHash[0]}`,
  sk: `${installHash}#${padded(sourceShard, 2)}`,
});

const installationActions = (
  store: DynamoDBInsightsV2Store,
  source: SourceItem,
  currentItem: Record<string, unknown> | undefined,
): readonly TransactItem[] => {
  const installHash = dynamoDBInsightsInstallationHash(source.row.install_id);
  const current =
    currentItem === undefined
      ? undefined
      : parseInstallationCandidate(
          currentItem,
          source.row.install_id,
          installHash,
          source.source_shard,
          true,
        );
  if (
    current !== undefined &&
    current.projectedSequence >= source.source_sequence
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Installation current candidate is ahead of projection",
    );
  }
  const nextOrder = eventOrder(source.row);
  const candidate =
    current !== undefined && current.eventOrder > nextOrder
      ? {
          install_id: current.installId,
          install_hash: current.installHash,
          event_id: current.eventId,
          source_shard: current.sourceShard,
          source_sequence: current.sourceSequence,
          projected_sequence: source.source_sequence,
          projection_event_id: source.event_id,
          event_order: current.eventOrder,
          source_pk: current.sourcePk,
          source_sk: current.sourceSk,
          raw_bytes: current.rawBytes,
        }
      : {
          install_id: source.row.install_id,
          install_hash: installHash,
          event_id: source.event_id,
          source_shard: source.source_shard,
          source_sequence: source.source_sequence,
          projected_sequence: source.source_sequence,
          projection_event_id: source.event_id,
          event_order: nextOrder,
          source_pk: source.pk,
          source_sk: source.sk,
          raw_bytes: source.raw_bytes,
        };
  const history = {
    ...installationCandidateKey(
      installHash,
      source.source_shard,
      source.source_sequence,
      source.event_id,
    ),
    item_type: "installation-candidate",
    ...candidate,
  };
  const currentCandidate = {
    ...installationCurrentCandidateKey(installHash, source.source_shard),
    item_type: "installation-current-candidate",
    ...candidate,
  };
  return [
    {
      Update: {
        TableName: store.tableName,
        Key: installationIdentityKey(source.row.install_id),
        ConditionExpression:
          "attribute_not_exists(#pk) OR (#type = :type AND #install = :install)",
        UpdateExpression:
          "SET #type = if_not_exists(#type, :type), #install = if_not_exists(#install, :install), #source = :present",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#type": "item_type",
          "#install": "install_id",
          "#source": `source_shard_${padded(source.source_shard, 2)}`,
        },
        ExpressionAttributeValues: {
          ":type": "installation-identity",
          ":install": source.row.install_id,
          ":present": true,
        },
      },
    },
    {
      Put: {
        TableName: store.tableName,
        Item: {
          ...history,
          record_digest: sha256(canonicalInsightsJson(history)),
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    },
    {
      Put: {
        TableName: store.tableName,
        Item: {
          ...currentCandidate,
          record_digest: sha256(canonicalInsightsJson(currentCandidate)),
        },
        ConditionExpression:
          current === undefined
            ? "attribute_not_exists(#pk)"
            : "#digest = :digest",
        ExpressionAttributeNames:
          current === undefined
            ? { "#pk": "pk" }
            : { "#digest": "record_digest" },
        ...(current === undefined
          ? {}
          : {
              ExpressionAttributeValues: {
                ":digest": current.recordDigest,
              },
            }),
      },
    },
  ];
};

const projectionCheckpointAction = (
  store: DynamoDBInsightsV2Store,
  sourceShard: number,
  previous: number,
  next: number,
): TransactItem => ({
  Update: {
    TableName: store.tableName,
    Key: stateKey(`projection#source#${padded(sourceShard, 2)}`),
    ConditionExpression:
      "#type = :type AND #job = :job AND #sequence = :previous",
    UpdateExpression: "SET #sequence = :next",
    ExpressionAttributeNames: {
      "#type": "item_type",
      "#job": "job_id",
      "#sequence": "sequence",
    },
    ExpressionAttributeValues: {
      ":type": "insights-projection-checkpoint",
      ":job": PROJECTION_JOB_ID,
      ":previous": previous,
      ":next": next,
    },
  },
});

const failProjection = async (
  store: DynamoDBInsightsV2Store,
  sourceShard: number,
  sourceSequence: number,
  error: unknown,
): Promise<void> => {
  const poison = {
    sourceShard,
    sourceSequence,
    code: errorName(error) ?? "InvalidProjectionSource",
    message:
      error instanceof Error ? error.message.slice(0, 1_024) : "Invalid source",
  };
  try {
    await sendTransaction(
      store,
      `projection:poison:${sourceShard}:${sourceSequence}`,
      [
        readinessPut(store, "projection#events", "failed", { poison }),
        readinessPut(store, "projection#installations", "failed", { poison }),
      ],
    );
  } catch (cause) {
    const readiness = await batchGetStrong(store, [
      stateKey("projection#events"),
      stateKey("projection#installations"),
    ]);
    if (readiness.some((item) => item.state === "failed")) return;
    throw cause;
  }
};

const refreshProjectionReadiness = async (
  store: DynamoDBInsightsV2Store,
): Promise<void> => {
  const keys = [
    stateKey("source"),
    stateKey("projection#events"),
    stateKey("projection#installations"),
    ...Array.from(
      { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
      (_, sourceShard) => [
        sourceClockKey(sourceShard),
        stateKey(`projection#source#${padded(sourceShard, 2)}`),
      ],
    ).flat(),
  ];
  const items = await batchGetStrong(store, keys);
  assertExactItems(items, keys, "projection readiness");
  const sourceState = persistedReadiness(
    itemAt(items, stateKey("source")),
    "source",
  );
  const eventState = persistedReadiness(
    itemAt(items, stateKey("projection#events")),
    "projection#events",
  );
  const installationState = persistedReadiness(
    itemAt(items, stateKey("projection#installations")),
    "projection#installations",
  );
  if (
    sourceState !== "ready" ||
    eventState === "failed" ||
    installationState === "failed"
  ) {
    return;
  }
  const caughtUp = Array.from(
    { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
    (_, sourceShard) => {
      const sourceKey = sourceClockKey(sourceShard);
      const projectionKey = stateKey(
        `projection#source#${padded(sourceShard, 2)}`,
      );
      const source = persistedClock(
        itemAt(items, sourceKey),
        sourceKey,
        "source-clock",
      );
      const projection = persistedClock(
        itemAt(items, projectionKey),
        projectionKey,
        "insights-projection-checkpoint",
      );
      if (projection > source) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "DynamoDB Insights projection is ahead of its source",
        );
      }
      return projection === source;
    },
  ).every(Boolean);
  if (!caughtUp) return;
  await sendTransaction(store, "projection:ready", [
    readinessPut(store, "projection#events", "ready"),
    readinessPut(store, "projection#installations", "ready"),
  ]);
};

export interface DynamoDBInsightsProjectionStep {
  readonly sourceShard: number;
  readonly projected: number;
  readonly nextSequence: number;
  readonly caughtUp: boolean;
}

export const runDynamoDBInsightsProjectionStep = async (
  baseStore: DynamoDBInsightsV2Store,
  input: {
    readonly sourceShard: number;
    readonly maxItems: number;
    readonly maxRequests: number;
  },
): Promise<DynamoDBInsightsProjectionStep> => {
  assertInsightsMaintenanceInputContract(input);
  if (
    !Number.isSafeInteger(input.sourceShard) ||
    input.sourceShard < 0 ||
    input.sourceShard >= DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > DYNAMODB_INSIGHTS_PROJECTION_MAX_ITEMS ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 14
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Projection step has invalid sourceShard/maxItems/maxRequests",
    );
  }
  const store = withRequestBudget(baseStore, input.maxRequests);
  await initializeDynamoDBInsightsV2(store);
  const readiness = await batchGetStrong(store, [
    stateKey("projection#events"),
    stateKey("projection#installations"),
  ]);
  const eventState = persistedReadiness(
    itemAt(readiness, stateKey("projection#events")),
    "projection#events",
  );
  const installationState = persistedReadiness(
    itemAt(readiness, stateKey("projection#installations")),
    "projection#installations",
  );
  if (eventState === "failed" || installationState === "failed") {
    throw new DynamoDBInsightsV2NotReadyError("events");
  }
  const allowed = Math.min(
    input.maxItems,
    Math.floor((input.maxRequests - 12) / 2),
  );
  const checkpointKey = stateKey(
    `projection#source#${padded(input.sourceShard, 2)}`,
  );
  const checkpoint = await getStrong(store, checkpointKey);
  let sequence = persistedClock(
    checkpoint,
    checkpointKey,
    "insights-projection-checkpoint",
  );
  const page = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk AND #sk > :after",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": sourcePartition(input.sourceShard),
        ":after": sourceLedgerAfter(sequence),
      },
      Limit: allowed,
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  let sources: SourceItem[];
  try {
    sources = (page.Items ?? []).map(parseSourceItem);
  } catch (error) {
    await failProjection(
      store,
      input.sourceShard,
      nextSafeSequence(sequence),
      error,
    );
    throw error;
  }
  const stepBytes = sources.reduce((sum, source) => sum + source.raw_bytes, 0);
  if (stepBytes > DYNAMODB_INSIGHTS_STEP_MAX_BYTES) {
    throw new DynamoDBInsightsV2BudgetError(
      "step-bytes",
      stepBytes,
      DYNAMODB_INSIGHTS_STEP_MAX_BYTES,
    );
  }
  let projected = 0;
  for (const source of sources) {
    if (
      source.source_shard !== input.sourceShard ||
      source.source_sequence !== nextSafeSequence(sequence)
    ) {
      const corruption = new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights source ledger has a gap",
      );
      await failProjection(
        store,
        input.sourceShard,
        nextSafeSequence(sequence),
        corruption,
      );
      throw corruption;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      const currentCandidate = await getStrong(
        store,
        installationCurrentCandidateKey(
          dynamoDBInsightsInstallationHash(source.row.install_id),
          input.sourceShard,
        ),
      );
      if (currentCandidate !== undefined) {
        const current = parseInstallationCandidate(
          currentCandidate,
          source.row.install_id,
          dynamoDBInsightsInstallationHash(source.row.install_id),
          input.sourceShard,
          true,
        );
        if (current.projectedSequence >= source.source_sequence) {
          const committed = persistedClock(
            await getStrong(store, checkpointKey),
            checkpointKey,
            "insights-projection-checkpoint",
          );
          if (committed >= source.source_sequence) break;
          throw new DynamoDBInsightsV2StorageCorruptionError(
            "Installation candidate is ahead of its projection checkpoint",
          );
        }
      }
      const actions = [
        ...pointerActions(store, source),
        ...installationActions(store, source, currentCandidate),
        projectionCheckpointAction(
          store,
          input.sourceShard,
          sequence,
          source.source_sequence,
        ),
      ];
      try {
        await sendTransaction(
          store,
          `projection:${input.sourceShard}:${source.source_sequence}`,
          actions,
        );
        break;
      } catch (error) {
        lastError = error;
        const committed = await getStrong(store, checkpointKey);
        const committedSequence = persistedClock(
          committed,
          checkpointKey,
          "insights-projection-checkpoint",
        );
        if (committedSequence >= source.source_sequence) break;
        const conditional = conditionalCancellationIndexes(error);
        if (
          conditional.length > 0 &&
          conditional.every(
            (index) =>
              index === actions.length - 1 ||
              actions[index]?.Put?.Item?.item_type ===
                "installation-current-candidate",
          )
        ) {
          continue;
        }
        if (conditional.length > 0) {
          const corruption = new DynamoDBInsightsV2StorageCorruptionError(
            "DynamoDB Insights projection collided with persisted storage",
          );
          await failProjection(
            store,
            input.sourceShard,
            source.source_sequence,
            corruption,
          );
          throw corruption;
        }
        if (!isRetryableDynamoDBInsightsError(error)) throw error;
        if (attempt === 5) throw lastError;
      }
    }
    sequence = source.source_sequence;
    projected += 1;
  }
  let caughtUp = false;
  if (page.LastEvaluatedKey === undefined) {
    const sourceKey = sourceClockKey(input.sourceShard);
    const sourceSequence = persistedClock(
      await getStrong(store, sourceKey),
      sourceKey,
      "source-clock",
    );
    if (sourceSequence < sequence) {
      const corruption = new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights projection is ahead of its source",
      );
      await failProjection(
        store,
        input.sourceShard,
        nextSafeSequence(sourceSequence),
        corruption,
      );
      throw corruption;
    }
    if (sourceSequence === sequence) {
      caughtUp = true;
    } else {
      const probe = await store.client.send(
        new QueryCommand({
          TableName: store.tableName,
          ConsistentRead: true,
          KeyConditionExpression: "#pk = :pk AND #sk > :after",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": sourcePartition(input.sourceShard),
            ":after": sourceLedgerAfter(sequence),
          },
          Limit: 1,
          ScanIndexForward: true,
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      const next = probe.Items?.[0];
      let parsed: SourceItem | undefined;
      try {
        parsed = next === undefined ? undefined : parseSourceItem(next);
      } catch (error) {
        await failProjection(
          store,
          input.sourceShard,
          nextSafeSequence(sequence),
          error,
        );
        throw error;
      }
      if (
        parsed === undefined ||
        parsed.source_shard !== input.sourceShard ||
        parsed.source_sequence !== nextSafeSequence(sequence)
      ) {
        const corruption = new DynamoDBInsightsV2StorageCorruptionError(
          "DynamoDB Insights source ledger has a gap",
        );
        await failProjection(
          store,
          input.sourceShard,
          nextSafeSequence(sequence),
          corruption,
        );
        throw corruption;
      }
    }
  }
  if (caughtUp) await refreshProjectionReadiness(store);
  return {
    sourceShard: input.sourceShard,
    projected,
    nextSequence: sequence,
    caughtUp,
  };
};

type EventCursor = {
  readonly version: number;
  readonly namespace: string;
  readonly scope: string;
  readonly before: number;
  readonly since: number;
  readonly last: readonly [number, string] | null;
  readonly buckets: readonly (string | null)[];
};

const encodeCursor = (value: unknown): string => {
  const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
  assertInsightsCursorContract(cursor);
  return cursor;
};

const decodeCursor = (cursor: string): unknown => {
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DynamoDBInsightsV2InputError("Invalid DynamoDB Insights cursor");
  }
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new DynamoDBInsightsV2InputError("Invalid DynamoDB Insights cursor");
  }
};

const scopeDigest = (input: InsightsPageEventsInput): string =>
  sha256(canonicalInsightsJson(input.selector));

const streamsForScope = (
  scope: InsightsPageEventsInput["selector"],
): readonly PointerStream[] => {
  if (scope.kind === "all") {
    return Array.from(
      { length: DYNAMODB_INSIGHTS_V2_GLOBAL_SHARDS },
      (_, index) => globalStream(index),
    );
  }
  const valueHash = sha256(
    canonicalInsightsJson(
      scope.kind === "installationId" ? scope.installId : scope.bundleId,
    ),
  );
  const count =
    scope.kind === "installationId"
      ? DYNAMODB_INSIGHTS_V2_INSTALL_SHARDS
      : DYNAMODB_INSIGHTS_V2_BUNDLE_SHARDS;
  return (["a", "r"] as const).flatMap((movement) =>
    Array.from({ length: count }, (_, index) =>
      scope.kind === "installationId"
        ? installStream(valueHash, movement, index)
        : bundleStream(valueHash, movement, index),
    ),
  );
};

const readEventCursor = (
  store: DynamoDBInsightsV2Store,
  input: InsightsPageEventsInput,
  streamCount: number,
): EventCursor | undefined => {
  if (input.cursor === undefined) return undefined;
  const value = decodeCursor(input.cursor);
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "version") !== EVENT_CURSOR_VERSION ||
    Reflect.get(value, "namespace") !== dynamoDBInsightsV2Namespace(store) ||
    Reflect.get(value, "scope") !== scopeDigest(input) ||
    Reflect.get(value, "before") !== input.beforeReceivedAtMs ||
    Reflect.get(value, "since") !== (input.sinceReceivedAtMs ?? 0) ||
    !Array.isArray(Reflect.get(value, "buckets")) ||
    Reflect.get(value, "buckets").length !== streamCount
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Event cursor does not match request",
    );
  }
  const parsed = value as EventCursor;
  if (
    parsed.buckets.some(
      (bucket) =>
        bucket !== null &&
        (typeof bucket !== "string" || !/^[0-9]{16}$/.test(bucket)),
    ) ||
    (parsed.last !== null &&
      (!Array.isArray(parsed.last) ||
        parsed.last.length !== 2 ||
        !Number.isSafeInteger(parsed.last[0]) ||
        parsed.last[0] < (input.sinceReceivedAtMs ?? 0) ||
        parsed.last[0] >= input.beforeReceivedAtMs ||
        !UUID_V7.test(parsed.last[1])))
  ) {
    throw new DynamoDBInsightsV2InputError("Invalid event cursor state");
  }
  return parsed;
};

const directoryBucket = async (
  store: DynamoDBInsightsV2Store,
  stream: PointerStream,
  beforeBucket: string | undefined,
  input: InsightsPageEventsInput,
): Promise<string | null> => {
  if (input.beforeReceivedAtMs === 0) return null;
  const maximum =
    beforeBucket ?? bucketFor(input.beforeReceivedAtMs - 1, stream.bucketMs);
  const minimum = bucketFor(input.sinceReceivedAtMs ?? 0, stream.bucketMs);
  if (maximum < minimum) return null;
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :minimum AND :maximum",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": stream.directoryPk,
        ":minimum": minimum,
        ":maximum": maximum,
      },
      Limit: 1,
      ScanIndexForward: false,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const item: Record<string, unknown> | undefined = result.Items?.[0];
  if (item === undefined) return null;
  const bucket = item.sk;
  if (
    item.pk !== stream.directoryPk ||
    typeof bucket !== "string" ||
    !/^[0-9]{16}$/.test(bucket) ||
    item.item_type !== "event-directory" ||
    item.record_digest !==
      sha256(canonicalInsightsJson([item.pk, bucket, item.item_type])) ||
    Object.keys(item).some(
      (field) => !["pk", "sk", "item_type", "record_digest"].includes(field),
    )
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Invalid event directory item",
    );
  }
  return bucket;
};

type EventPointer = {
  readonly pk: string;
  readonly sk: string;
  readonly event_id: string;
  readonly source_pk: string;
  readonly source_sk: string;
  readonly raw_bytes: number;
};

const parsePointer = (
  item: Record<string, unknown>,
  expectedPartition: string,
): EventPointer => {
  if (
    item.item_type !== "event-pointer" ||
    item.pk !== expectedPartition ||
    typeof item.sk !== "string" ||
    !/^\d{16}#[0-9a-f-]{36}$/.test(item.sk) ||
    typeof item.event_id !== "string" ||
    !UUID_V7.test(item.event_id) ||
    !item.sk.endsWith(`#${item.event_id}`) ||
    typeof item.source_pk !== "string" ||
    typeof item.source_sk !== "string" ||
    !Number.isSafeInteger(item.raw_bytes) ||
    Number(item.raw_bytes) < 0 ||
    Number(item.raw_bytes) > DYNAMODB_INSIGHTS_RAW_EVENT_MAX_BYTES ||
    Object.keys(item).some(
      (field) =>
        ![
          "pk",
          "sk",
          "item_type",
          "event_id",
          "source_pk",
          "source_sk",
          "raw_bytes",
        ].includes(field),
    )
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Invalid event pointer item",
    );
  }
  return item as unknown as EventPointer;
};

const readDynamoDBInsightsEventPage = async (
  store: DynamoDBInsightsV2Store,
  input: InsightsPageEventsInput,
  cursor: EventCursor | undefined,
): Promise<{
  readonly rows: readonly BundleEventRow[];
  readonly nextCursor: string | null;
}> => {
  if ((input.sinceReceivedAtMs ?? 0) === input.beforeReceivedAtMs) {
    return { rows: [], nextCursor: null };
  }
  const streams = streamsForScope(input.selector);
  const buckets: (string | null)[] = cursor
    ? await Promise.all(
        cursor.buckets.map((bucket, index) =>
          bucket === null
            ? directoryBucket(store, streams[index]!, undefined, input)
            : bucket,
        ),
      )
    : await Promise.all(
        streams.map((stream) =>
          directoryBucket(store, stream, undefined, input),
        ),
      );
  const upper = cursor?.last
    ? `${padded(cursor.last[0], 16)}#${cursor.last[1]}`
    : `${padded(input.beforeReceivedAtMs, 16)}#`;
  const lower = `${padded(input.sinceReceivedAtMs ?? 0, 16)}#`;
  const pages = await Promise.all(
    streams.map(async (stream, index) => {
      const bucket = buckets[index];
      if (bucket === null)
        return { pointers: [] as EventPointer[], more: false };
      const result = await store.client.send(
        new QueryCommand({
          TableName: store.tableName,
          ConsistentRead: true,
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": stream.pointerPk(bucket),
            ":lower": lower,
            ":upper": upper,
          },
          Limit: input.limit + 1,
          ScanIndexForward: false,
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      const pointers: EventPointer[] = (result.Items ?? [])
        .map((item: Record<string, unknown>) =>
          parsePointer(item, stream.pointerPk(bucket)),
        )
        .filter((pointer: EventPointer) => pointer.sk !== upper);
      if (pointers.length === 0 && result.LastEvaluatedKey === undefined) {
        buckets[index] = await directoryBucket(
          store,
          stream,
          padded(Number(bucket) - 1, 16),
          input,
        );
      }
      return {
        pointers,
        more:
          pointers.length > 0 ||
          result.LastEvaluatedKey !== undefined ||
          buckets[index] !== null,
      };
    }),
  );
  const pointers = pages
    .flatMap((page) => page.pointers)
    .sort((left, right) =>
      left.sk < right.sk ? 1 : left.sk > right.sk ? -1 : 0,
    );
  if (
    new Set(pointers.map((pointer) => pointer.event_id)).size !==
    pointers.length
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Duplicate event projection pointer",
    );
  }
  const selected: EventPointer[] = [];
  let pageBytes = 0;
  const payloadBudget =
    DYNAMODB_INSIGHTS_PAGE_MAX_BYTES - MAX_CURSOR_BYTES - 32 * 1_024;
  for (const pointer of pointers) {
    if (selected.length === input.limit) break;
    const nextBytes = pageBytes + pointer.raw_bytes;
    if (selected.length > 0 && nextBytes > payloadBudget) break;
    selected.push(pointer);
    pageBytes = nextBytes;
  }
  const sourceItems = await batchGetStrong(
    store,
    selected.map((pointer) => ({
      pk: pointer.source_pk,
      sk: pointer.source_sk,
    })),
  );
  const sourceByKey = new Map(
    sourceItems.map((item) => [`${String(item.pk)}\n${String(item.sk)}`, item]),
  );
  const rows = selected.map((pointer) => {
    const source = sourceByKey.get(
      `${pointer.source_pk}\n${pointer.source_sk}`,
    );
    if (source === undefined) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "Event pointer source is missing",
      );
    }
    const parsed = parseSourceItem(source);
    const belongsToProjection = streamsForEvent(parsed.row).some(
      (stream) =>
        stream.pointerPk(
          bucketFor(parsed.row.received_at_ms, stream.bucketMs),
        ) === pointer.pk,
    );
    const belongsToScope =
      input.selector.kind === "all" ||
      (input.selector.kind === "installationId"
        ? parsed.row.install_id === input.selector.installId &&
          (parsed.row.type === "UPDATE_APPLIED" ||
            parsed.row.type === "RECOVERED")
        : (parsed.row.type === "UPDATE_APPLIED" &&
            parsed.row.to_bundle_id === input.selector.bundleId) ||
          (parsed.row.type === "RECOVERED" &&
            parsed.row.from_bundle_id === input.selector.bundleId));
    if (
      parsed.event_id !== pointer.event_id ||
      pointer.sk !== eventOrder(parsed.row) ||
      pointer.raw_bytes !== parsed.raw_bytes ||
      !belongsToProjection ||
      !belongsToScope
    ) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "Event pointer source does not match",
      );
    }
    return parsed.row;
  });
  rows.sort(compareInsightsEventRows);
  const last = rows.at(-1);
  const hasBuffered = pointers.length > selected.length;
  const hasMore = hasBuffered || pages.some((page) => page.more);
  return {
    rows,
    nextCursor:
      hasMore && (last !== undefined || cursor?.last !== null)
        ? encodeCursor({
            version: EVENT_CURSOR_VERSION,
            namespace: dynamoDBInsightsV2Namespace(store),
            scope: scopeDigest(input),
            before: input.beforeReceivedAtMs,
            since: input.sinceReceivedAtMs ?? 0,
            last: last
              ? ([last.received_at_ms, last.id] as const)
              : (cursor?.last ?? null),
            buckets,
          } satisfies EventCursor)
        : hasMore
          ? encodeCursor({
              version: EVENT_CURSOR_VERSION,
              namespace: dynamoDBInsightsV2Namespace(store),
              scope: scopeDigest(input),
              before: input.beforeReceivedAtMs,
              since: input.sinceReceivedAtMs ?? 0,
              last: null,
              buckets,
            } satisfies EventCursor)
          : null,
  };
};

type LiveInstallationInput = Extract<
  InsightsLiveInstallationPageInput,
  { readonly kind: "all" | "installationId" }
>;

type InstallationCursor = {
  readonly version: number;
  readonly namespace: string;
  readonly kind: "all";
  readonly projectionGeneration: string;
  readonly projectionVector: readonly number[];
  readonly shard: number;
  readonly after: string | null;
};

const readInstallationCursor = (
  store: DynamoDBInsightsV2Store,
  input: LiveInstallationInput,
): InstallationCursor | undefined => {
  if (input.kind !== "all" || input.cursor === undefined) return undefined;
  const value = decodeCursor(input.cursor);
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "version") !== INSTALLATION_CURSOR_VERSION ||
    Reflect.get(value, "namespace") !== dynamoDBInsightsV2Namespace(store) ||
    Reflect.get(value, "kind") !== "all" ||
    typeof Reflect.get(value, "projectionGeneration") !== "string" ||
    !Array.isArray(Reflect.get(value, "projectionVector")) ||
    (Reflect.get(value, "projectionVector") as unknown[]).length !==
      DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
    !(Reflect.get(value, "projectionVector") as unknown[]).every(
      (sequence) => Number.isSafeInteger(sequence) && Number(sequence) >= 0,
    ) ||
    !Number.isSafeInteger(Reflect.get(value, "shard")) ||
    Number(Reflect.get(value, "shard")) < 0 ||
    Number(Reflect.get(value, "shard")) >= DYNAMODB_INSIGHTS_V2_LATEST_SHARDS ||
    (Reflect.get(value, "after") !== null &&
      (typeof Reflect.get(value, "after") !== "string" ||
        !/^[0-9a-f]{64}$/.test(String(Reflect.get(value, "after")))))
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Installation cursor does not match request",
    );
  }
  const cursor = value as InstallationCursor;
  if (
    cursor.projectionGeneration !==
    generation("projection", cursor.projectionVector)
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Installation cursor projection does not match request",
    );
  }
  return cursor;
};

const unavailableVersions: InsightsReadVersions = {
  schemaVersion: null,
  storageVersion: null,
  projectionGeneration: null,
  sourceGeneration: null,
};

const storageCorruptionPage = <
  T extends InsightsPageEventsResult | InsightsLiveInstallationPage,
>(
  versions: InsightsReadVersions,
): T => {
  const result = {
    state: "failed" as const,
    versions,
    error: { code: "storage-corruption" as const },
  };
  assertInsightsFailedReadContract(result);
  return result as T;
};

export const pageDynamoDBInsightsEvents = async (
  store: DynamoDBInsightsV2Store,
  input: InsightsPageEventsInput,
): Promise<InsightsPageEventsResult> => {
  const canonical = readInsightsPageEventsInput(input);
  const streams = streamsForScope(canonical.selector);
  const cursor = readEventCursor(store, canonical, streams.length);
  let state: DynamoDBInsightsV2State;
  try {
    state = await readDynamoDBInsightsV2State(store);
  } catch (error) {
    if (error instanceof DynamoDBInsightsV2StorageCorruptionError) {
      return storageCorruptionPage(unavailableVersions);
    }
    throw error;
  }
  const { readiness, versions } = state;
  if (readiness.source === "failed" || readiness.events === "failed") {
    const sourceFailed = readiness.source === "failed";
    const result: InsightsPageEventsResult = {
      state: "failed",
      versions,
      error: {
        code: sourceFailed ? "migration-poison" : "preparation-failed",
        jobId: sourceFailed ? MIGRATION_JOB_ID : PROJECTION_JOB_ID,
      },
    };
    assertInsightsFailedReadContract(result);
    return result;
  }
  if (readiness.source !== "ready" || readiness.events !== "ready") {
    const result: InsightsPageEventsResult = {
      state: "preparing",
      versions,
      job: {
        id: readiness.source !== "ready" ? MIGRATION_JOB_ID : PROJECTION_JOB_ID,
      },
    };
    assertInsightsPreparingReadContract(result);
    return result;
  }
  let page: Awaited<ReturnType<typeof readDynamoDBInsightsEventPage>>;
  let committed: DynamoDBInsightsV2State;
  try {
    page = await readDynamoDBInsightsEventPage(store, canonical, cursor);
    committed = await readDynamoDBInsightsV2State(store);
  } catch (error) {
    if (error instanceof DynamoDBInsightsV2StorageCorruptionError) {
      return storageCorruptionPage(versions);
    }
    throw error;
  }
  const result: InsightsPageEventsResult = {
    state: "ready",
    versions: { ...committed.versions, projectionGeneration: null },
    data: {
      data: page.rows,
      nextCursor: page.nextCursor,
      hasNext: page.nextCursor !== null,
      consistency: {
        kind: "live",
        cutoff: {
          kind: "event-time",
          beforeReceivedAtMs: canonical.beforeReceivedAtMs,
        },
      },
      total: { state: "unavailable" },
    },
  };
  assertInsightsPageContract(result, canonical.limit);
  return result;
};

const installationRow = (row: BundleEventRow): InsightsInstallationRow => ({
  id: row.id,
  install_id: row.install_id,
  user_id: row.user_id,
  username: row.username,
  to_bundle_id: row.to_bundle_id,
  type: row.type,
  platform: row.platform,
  app_version: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  received_at_ms: row.received_at_ms,
});

const parseInstallationIdentity = (
  item: Record<string, unknown>,
): {
  readonly installId: string;
  readonly installHash: string;
  readonly sourceShards: readonly number[];
} => {
  const installId = item.install_id;
  if (typeof installId !== "string") {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Invalid installation identity item",
    );
  }
  const expected = installationIdentityKey(installId);
  if (
    item.item_type !== "installation-identity" ||
    item.pk !== expected.pk ||
    item.sk !== expected.sk ||
    Object.keys(item).some(
      (field) =>
        !["pk", "sk", "item_type", "install_id"].includes(field) &&
        !/^source_shard_[0-9]{2}$/.test(field),
    )
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Invalid installation identity item",
    );
  }
  const sourceShards = Object.entries(item).flatMap(([field, value]) => {
    const match = /^source_shard_([0-9]{2})$/.exec(field);
    if (match === null) return [];
    const sourceShard = Number(match[1]);
    if (
      value !== true ||
      sourceShard < 0 ||
      sourceShard >= DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS
    ) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "Invalid installation identity source shard",
      );
    }
    return [sourceShard];
  });
  if (sourceShards.length === 0) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Installation identity has no source shard",
    );
  }
  return { installId, installHash: expected.sk, sourceShards };
};

type InstallationCandidate = {
  readonly eventId: string;
  readonly installId: string;
  readonly installHash: string;
  readonly eventOrder: string;
  readonly sourcePk: string;
  readonly sourceSk: string;
  readonly sourceShard: number;
  readonly sourceSequence: number;
  readonly projectedSequence: number;
  readonly rawBytes: number;
  readonly recordDigest: string;
};

const parseInstallationCandidate = (
  item: Record<string, unknown>,
  installId: string,
  installHash: string,
  sourceShard: number,
  current = false,
): InstallationCandidate => {
  const sourceSequence = item.source_sequence;
  const projectedSequence = item.projected_sequence;
  const expected =
    Number.isSafeInteger(sourceSequence) &&
    Number(sourceSequence) > 0 &&
    Number.isSafeInteger(projectedSequence) &&
    Number(projectedSequence) >= Number(sourceSequence) &&
    typeof item.projection_event_id === "string" &&
    UUID_V7.test(item.projection_event_id)
      ? current
        ? installationCurrentCandidateKey(installHash, sourceShard)
        : installationCandidateKey(
            installHash,
            sourceShard,
            Number(projectedSequence),
            item.projection_event_id,
          )
      : undefined;
  const sourceKey =
    expected === undefined || typeof item.event_id !== "string"
      ? undefined
      : sourceEventKey(sourceShard, Number(sourceSequence), item.event_id);
  if (
    item.item_type !==
      (current ? "installation-current-candidate" : "installation-candidate") ||
    expected === undefined ||
    sourceKey === undefined ||
    item.pk !== expected.pk ||
    item.sk !== expected.sk ||
    item.install_id !== installId ||
    item.install_hash !== installHash ||
    item.source_shard !== sourceShard ||
    item.source_pk !== sourceKey.pk ||
    item.source_sk !== sourceKey.sk ||
    typeof item.event_order !== "string" ||
    !item.event_order.endsWith(`#${item.event_id}`) ||
    !Number.isSafeInteger(item.raw_bytes) ||
    Number(item.raw_bytes) < 0 ||
    Number(item.raw_bytes) > DYNAMODB_INSIGHTS_RAW_EVENT_MAX_BYTES ||
    typeof item.record_digest !== "string" ||
    Object.keys(item).some(
      (field) =>
        ![
          "pk",
          "sk",
          "item_type",
          "install_id",
          "install_hash",
          "event_id",
          "source_shard",
          "source_sequence",
          "projected_sequence",
          "projection_event_id",
          "event_order",
          "source_pk",
          "source_sk",
          "raw_bytes",
          "record_digest",
        ].includes(field),
    ) ||
    item.record_digest !==
      sha256(
        canonicalInsightsJson(
          Object.fromEntries(
            Object.entries(item).filter(([field]) => field !== "record_digest"),
          ),
        ),
      )
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "Invalid installation candidate item",
    );
  }
  return {
    eventId: String(item.event_id),
    installId,
    installHash,
    eventOrder: item.event_order,
    sourcePk: item.source_pk,
    sourceSk: item.source_sk,
    sourceShard,
    sourceSequence: Number(sourceSequence),
    projectedSequence: Number(projectedSequence),
    rawBytes: Number(item.raw_bytes),
    recordDigest: item.record_digest,
  };
};

type InstallationIdentity = ReturnType<typeof parseInstallationIdentity>;

const installationsAtCutoff = async (
  store: DynamoDBInsightsV2Store,
  identities: readonly InstallationIdentity[],
  projectionVector: readonly number[],
): Promise<ReadonlyMap<string, InstallationCandidate | undefined>> => {
  const requested = identities.flatMap((identity) =>
    identity.sourceShards.map((sourceShard) => ({ identity, sourceShard })),
  );
  const currentItems = await batchGetStrong(
    store,
    requested.map(({ identity, sourceShard }) =>
      installationCurrentCandidateKey(identity.installHash, sourceShard),
    ),
  );
  const currentByKey = new Map(
    currentItems.map((item) => [
      `${String(item.pk)}\n${String(item.sk)}`,
      item,
    ]),
  );
  const candidates = await Promise.all(
    requested.map(async ({ identity, sourceShard }) => {
      const currentKey = installationCurrentCandidateKey(
        identity.installHash,
        sourceShard,
      );
      const currentItem = currentByKey.get(
        `${currentKey.pk}\n${currentKey.sk}`,
      );
      if (currentItem === undefined) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "Installation current candidate is missing",
        );
      }
      const current = parseInstallationCandidate(
        currentItem,
        identity.installId,
        identity.installHash,
        sourceShard,
        true,
      );
      const upper = projectionVector[sourceShard]!;
      if (current.sourceSequence <= upper) return current;
      if (upper === 0) return undefined;
      const result = await store.client.send(
        new QueryCommand({
          TableName: store.tableName,
          ConsistentRead: true,
          KeyConditionExpression: "#pk = :pk AND #sk <= :upper",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": installationCandidateKey(
              identity.installHash,
              sourceShard,
              1,
            ).pk,
            ":upper": `${sourceSortKey(upper)}#\uffff`,
          },
          Limit: 1,
          ScanIndexForward: false,
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      const items: Record<string, unknown>[] = result.Items ?? [];
      if (items.length > 1) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "Installation candidate query exceeded its limit",
        );
      }
      return items[0] === undefined
        ? undefined
        : parseInstallationCandidate(
            items[0],
            identity.installId,
            identity.installHash,
            sourceShard,
          );
    }),
  );
  const byIdentity = new Map<string, InstallationCandidate[]>();
  candidates.forEach((candidate, index) => {
    if (candidate === undefined) return;
    const installHash = requested[index]!.identity.installHash;
    const entries = byIdentity.get(installHash) ?? [];
    entries.push(candidate);
    byIdentity.set(installHash, entries);
  });
  return new Map(
    identities.map((identity) => [
      identity.installHash,
      byIdentity
        .get(identity.installHash)
        ?.sort((left, right) =>
          left.eventOrder < right.eventOrder
            ? 1
            : left.eventOrder > right.eventOrder
              ? -1
              : 0,
        )[0],
    ]),
  );
};

const hydrateInstallationCandidates = async (
  store: DynamoDBInsightsV2Store,
  candidates: readonly InstallationCandidate[],
): Promise<readonly InsightsInstallationRow[]> => {
  const keys = candidates.map((candidate) => ({
    pk: candidate.sourcePk,
    sk: candidate.sourceSk,
  }));
  const sources = await batchGetStrong(store, keys);
  assertExactItems(sources, keys, "installation source");
  return candidates.map((candidate) => {
    const source = parseSourceItem(
      itemAt(sources, {
        pk: candidate.sourcePk,
        sk: candidate.sourceSk,
      })!,
    );
    if (
      source.row.install_id !== candidate.installId ||
      source.source_shard !== candidate.sourceShard ||
      source.source_sequence !== candidate.sourceSequence ||
      eventOrder(source.row) !== candidate.eventOrder ||
      source.raw_bytes !== candidate.rawBytes
    ) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "Installation candidate source does not match",
      );
    }
    return installationRow(source.row);
  });
};

const liveVersions = (
  projectionVector: readonly number[],
): DynamoDBInsightsReadVersions => ({
  schemaVersion: String(DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION),
  storageVersion: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
  sourceGeneration: generation("source", projectionVector),
  projectionGeneration: generation("projection", projectionVector),
});

export const pageDynamoDBInsightsInstallationsCanonical = async (
  store: DynamoDBInsightsV2Store,
  input: LiveInstallationInput,
): Promise<InsightsLiveInstallationPage> => {
  const cursor = readInstallationCursor(store, input);
  let state: DynamoDBInsightsV2State | undefined;
  if (cursor === undefined) {
    try {
      state = await readDynamoDBInsightsV2State(store);
    } catch (error) {
      if (error instanceof DynamoDBInsightsV2StorageCorruptionError) {
        return storageCorruptionPage(unavailableVersions);
      }
      throw error;
    }
    const { readiness, versions } = state;
    if (readiness.source === "failed" || readiness.installations === "failed") {
      const sourceFailed = readiness.source === "failed";
      const result: InsightsLiveInstallationPage = {
        state: "failed",
        versions,
        error: {
          code: sourceFailed ? "migration-poison" : "preparation-failed",
          jobId: sourceFailed ? MIGRATION_JOB_ID : PROJECTION_JOB_ID,
        },
      };
      assertInsightsFailedReadContract(result);
      return result;
    }
    if (readiness.source !== "ready" || readiness.installations !== "ready") {
      const result: InsightsLiveInstallationPage = {
        state: "preparing",
        versions,
        job: {
          id:
            readiness.source !== "ready" ? MIGRATION_JOB_ID : PROJECTION_JOB_ID,
        },
      };
      assertInsightsPreparingReadContract(result);
      return result;
    }
  }
  const projectionVector = cursor?.projectionVector ?? state!.projectionVector;
  const versions = liveVersions(projectionVector);
  const liveConsistency = {
    kind: "live" as const,
    cutoff: {
      kind: "projection" as const,
      observedAtMs: Date.now(),
      projectionGeneration: versions.projectionGeneration!,
    },
  };
  if (input.kind === "installationId") {
    try {
      const identity = await getStrong(
        store,
        installationIdentityKey(input.installId),
      );
      const candidate =
        identity === undefined
          ? undefined
          : (
              await installationsAtCutoff(
                store,
                [parseInstallationIdentity(identity)],
                projectionVector,
              )
            ).get(dynamoDBInsightsInstallationHash(input.installId));
      const rows =
        candidate === undefined
          ? []
          : await hydrateInstallationCandidates(store, [candidate]);
      const after = await readDynamoDBInsightsV2State(store);
      if (
        after.projectionVector.some(
          (sequence, sourceShard) => sequence < projectionVector[sourceShard]!,
        )
      ) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "Installation projection regressed during exact lookup",
        );
      }
      const result: InsightsLiveInstallationPage = {
        state: "ready",
        versions,
        data: {
          data: [...rows],
          nextCursor: null,
          hasNext: false,
          consistency: liveConsistency,
          total: { state: "unavailable" },
        },
      };
      assertInsightsPageContract(result, input.limit);
      return result;
    } catch (error) {
      if (
        error instanceof DynamoDBInsightsV2StorageCorruptionError ||
        error instanceof DynamoDBInsightsV2HashCollisionError
      ) {
        return storageCorruptionPage(versions);
      }
      throw error;
    }
  }
  try {
    let pageShard = cursor?.shard ?? 0;
    let afterHash = cursor?.after ?? undefined;
    const directories: Array<{
      readonly identity: InstallationIdentity;
      readonly shard: number;
      readonly hash: string;
    }> = [];
    while (
      pageShard < DYNAMODB_INSIGHTS_V2_LATEST_SHARDS &&
      directories.length < input.limit + 1
    ) {
      const result = await store.client.send(
        new QueryCommand({
          TableName: store.tableName,
          ConsistentRead: true,
          KeyConditionExpression:
            afterHash === undefined
              ? "#pk = :pk"
              : "#pk = :pk AND #sk > :after",
          ExpressionAttributeNames: {
            "#pk": "pk",
            ...(afterHash === undefined ? {} : { "#sk": "sk" }),
          },
          ExpressionAttributeValues: {
            ":pk":
              DYNAMODB_INSIGHTS_V2_PREFIX + "#latest#" + pageShard.toString(16),
            ...(afterHash === undefined ? {} : { ":after": afterHash }),
          },
          Limit: input.limit + 1 - directories.length,
          ScanIndexForward: true,
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      const items: Record<string, unknown>[] = result.Items ?? [];
      for (const item of items) {
        const identity = parseInstallationIdentity(item);
        if (identity.installHash[0] !== pageShard.toString(16)) {
          throw new DynamoDBInsightsV2StorageCorruptionError(
            "Installation identity is in the wrong shard",
          );
        }
        directories.push({
          identity,
          shard: pageShard,
          hash: identity.installHash,
        });
      }
      const last = items.at(-1)?.sk;
      if (last !== undefined && typeof last !== "string") {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "Invalid installation identity key",
        );
      }
      if (result.LastEvaluatedKey !== undefined && last !== undefined) {
        afterHash = last;
      } else {
        pageShard += 1;
        afterHash = undefined;
      }
    }
    const candidates = await installationsAtCutoff(
      store,
      directories.map(({ identity }) => identity),
      projectionVector,
    );
    const resolved = directories.map(({ hash }) => ({
      candidate: candidates.get(hash),
    }));
    const selected: InstallationCandidate[] = [];
    let selectedBytes = 0;
    let consumed = 0;
    const payloadBudget =
      DYNAMODB_INSIGHTS_PAGE_MAX_BYTES - MAX_CURSOR_BYTES - 32 * 1_024;
    for (const entry of resolved) {
      if (entry.candidate === undefined) {
        consumed += 1;
        continue;
      }
      if (selected.length === input.limit) break;
      if (
        selected.length > 0 &&
        selectedBytes + entry.candidate.rawBytes > payloadBudget
      ) {
        break;
      }
      selected.push(entry.candidate);
      selectedBytes += entry.candidate.rawBytes;
      consumed += 1;
    }
    const rows = await hydrateInstallationCandidates(store, selected);
    const hasNext =
      consumed < directories.length ||
      pageShard < DYNAMODB_INSIGHTS_V2_LATEST_SHARDS;
    const lastConsumed = directories[consumed - 1];
    const nextCursor =
      hasNext && lastConsumed !== undefined
        ? encodeCursor({
            version: INSTALLATION_CURSOR_VERSION,
            namespace: dynamoDBInsightsV2Namespace(store),
            kind: "all",
            projectionGeneration: versions.projectionGeneration!,
            projectionVector,
            shard: lastConsumed.shard,
            after: lastConsumed.hash,
          } satisfies InstallationCursor)
        : null;
    const page: InsightsLiveInstallationPage = {
      state: "ready",
      versions,
      data: {
        data: [...rows],
        nextCursor,
        hasNext: nextCursor !== null,
        consistency: liveConsistency,
        total: { state: "unavailable" },
      },
    };
    assertInsightsPageContract(page, input.limit);
    return page;
  } catch (error) {
    if (
      error instanceof DynamoDBInsightsV2StorageCorruptionError ||
      error instanceof DynamoDBInsightsV2HashCollisionError
    ) {
      return storageCorruptionPage(versions);
    }
    throw error;
  }
};

export const pageDynamoDBInsightsInstallations = async (
  store: DynamoDBInsightsV2Store,
  input: LiveInstallationInput,
): Promise<InsightsLiveInstallationPage> => {
  const canonical = readInsightsInstallationPageInput(input);
  if (canonical.kind !== "all" && canonical.kind !== "installationId") {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB live installation reader received a published query",
    );
  }
  return pageDynamoDBInsightsInstallationsCanonical(store, canonical);
};

export interface DynamoDBInsightsV2 extends Pick<
  InsightsModel,
  "append" | "pageEvents"
> {
  append(row: BundleEventRow): Promise<void>;
  pageEvents(input: InsightsPageEventsInput): Promise<InsightsPageEventsResult>;
  pageInstallations(
    input: LiveInstallationInput,
  ): Promise<InsightsLiveInstallationPage>;
  readonly maintenance: {
    initialize(): Promise<void>;
    readiness(): Promise<DynamoDBInsightsV2Readiness>;
    migrateLegacy(input: {
      readonly maxItems: number;
      readonly maxRequests: number;
    }): Promise<DynamoDBInsightsMigrationStep>;
    project(input: {
      readonly sourceShard: number;
      readonly maxItems: number;
      readonly maxRequests: number;
    }): Promise<DynamoDBInsightsProjectionStep>;
  };
}

export const createDynamoDBInsightsV2 = (
  store: DynamoDBInsightsV2Store,
): DynamoDBInsightsV2 => {
  let initialized: Promise<void> | undefined;
  const initialize = (): Promise<void> => {
    initialized ??= initializeDynamoDBInsightsV2(store).catch((error) => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  };
  return {
    async append(row) {
      await initialize();
      await appendDynamoDBInsightsV2(store, row, true);
    },
    pageEvents: (input) => pageDynamoDBInsightsEvents(store, input),
    pageInstallations: (input) =>
      pageDynamoDBInsightsInstallations(store, input),
    maintenance: {
      initialize,
      readiness: () => getDynamoDBInsightsV2Readiness(store),
      migrateLegacy: (input) =>
        runDynamoDBInsightsLegacyBackfillStep(store, input),
      project: (input) => runDynamoDBInsightsProjectionStep(store, input),
    },
  };
};
