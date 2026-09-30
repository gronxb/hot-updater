import { appendFileSync } from "node:fs";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { AggregateBatching } from "@hot-updater/plugin-core";
import {
  aggregateBatchingModule,
  createDatabaseEngine,
  createKvAdapter,
  resolveSchema,
} from "@hot-updater/server/database";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import type { CoreReader } from "@hot-updater/server/plugins";
import {
  insights,
  insightsSchema,
  type BundleEventRow,
} from "@hot-updater/server/plugins/insights";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type DynamoDBLocal,
  startDynamoDBLocal,
} from "./dynamoDB.integration-fixture";
import { createDynamoDBStore } from "./dynamoDBStore";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A UTC day start; the scenario's first event is 10:05 that day. */
const D0 = Date.UTC(2026, 8, 21);

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/**
 * A value's size under DynamoDB's item size rules: UTF-8 bytes for strings,
 * one byte per two significant digits plus one for numbers, one byte for
 * null and booleans, and 3 bytes plus 1 an element for lists and maps.
 */
const valueBytes = (value: unknown): number => {
  if (typeof value === "string") return utf8(value);
  if (typeof value === "number") {
    const digits = String(Math.abs(value))
      .replace(".", "")
      .replace(/^0+/, "")
      .replace(/0+$/, "");
    return Math.ceil(Math.max(digits.length, 1) / 2) + 1;
  }
  if (value === null || value === undefined || typeof value === "boolean") {
    return 1;
  }
  const entries = Array.isArray(value)
    ? value.map((entry) => ["", entry] as const)
    : Object.entries(value as object);
  return entries.reduce(
    (sum, [name, entry]) => sum + 1 + utf8(name) + valueBytes(entry),
    3,
  );
};

const itemBytes = (item: Readonly<Record<string, unknown>>) =>
  Object.entries(item).reduce(
    (sum, [name, value]) => sum + utf8(name) + valueBytes(value),
    0,
  );

interface TransactItem {
  readonly Put?: { readonly Item: Record<string, unknown> };
  readonly Update?: {
    readonly Key: Record<string, unknown>;
    readonly UpdateExpression: string;
    readonly ExpressionAttributeNames?: Record<string, string>;
    readonly ExpressionAttributeValues?: Record<string, unknown>;
  };
  readonly Delete?: { readonly Key: Record<string, unknown> };
  readonly ConditionCheck?: { readonly Key: Record<string, unknown> };
}

/**
 * The size of the item a transaction item writes, read from the request: a
 * put's item; an update's key and the attributes its `SET` gives, each
 * counter at its start plus its step; a delete's or a check's key. Deletes
 * here remove gauge rows and index copies, all under 1 KB, so sizing them by
 * key charges them as DynamoDB does.
 */
const transactItemBytes = (item: TransactItem): number => {
  if (item.Put) return itemBytes(item.Put.Item);
  if (item.Update) {
    const {
      Key,
      UpdateExpression,
      ExpressionAttributeNames: names = {},
      ExpressionAttributeValues: values = {},
    } = item.Update;
    const set: Record<string, unknown> = {};
    for (const [, name, start, step] of UpdateExpression.matchAll(
      /(#n\d+) = if_not_exists\(#n\d+, (:v\d+)\)(?: \+ (:v\d+))?/g,
    )) {
      set[names[name!]!] =
        step === undefined
          ? values[start!]
          : Number(values[start!]) + Number(values[step]);
    }
    return itemBytes({ ...Key, ...set });
  }
  return itemBytes((item.Delete ?? item.ConditionCheck)!.Key);
};

/** Transactional writes cost 2 write request units per KB of each item. */
const writeUnits = (bytes: number) => 2 * Math.max(1, Math.ceil(bytes / 1024));

interface Measured {
  readonly items: number;
  readonly wru: number;
  readonly bytes: number;
}

const RELEASES = {
  a: "01900000-0000-7000-8000-00000000000a",
  b: "01900000-0000-7000-8000-00000000000b",
} as const;
const BUNDLES = {
  a: "01900000-0000-7000-8000-0000000000ba",
  b: "01900000-0000-7000-8000-0000000000bb",
} as const;

let sequence = 0;
const eventOf = (
  receivedAt: number,
  movement:
    | { readonly type: "UNCHANGED"; readonly bundle: "a" | "b" }
    | {
        readonly type:
          | "UPDATE_DOWNLOADED"
          | "UPDATE_APPLIED"
          | "RECOVERED"
          | "UPDATE_FAILED";
        readonly from: "a" | "b";
        readonly to: "a" | "b";
        /** What the event's metadata adds: a delivery, a failure, an exit reason. */
        readonly metadata?: Record<string, unknown>;
        /** A failed check targets no release. */
        readonly check?: true;
      },
): BundleEventRow => {
  sequence += 1;
  const base = {
    id: `01900000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    install_id: "install-1",
    user_id: "user-1",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    received_at_ms: receivedAt,
  } as const;
  const metadata = {
    cohort: "1",
    fingerprint_hash: null,
    sdk_version: "1.0.0",
  };
  return (
    movement.type === "UNCHANGED"
      ? {
          ...base,
          type: "UNCHANGED",
          from_release_id: null,
          from_bundle_id: null,
          to_release_id: RELEASES[movement.bundle],
          to_bundle_id: BUNDLES[movement.bundle],
          metadata: { ...metadata, update_strategy: null },
        }
      : {
          ...base,
          type: movement.type,
          from_release_id: RELEASES[movement.from],
          from_bundle_id: BUNDLES[movement.from],
          to_release_id: movement.check ? null : RELEASES[movement.to],
          to_bundle_id: BUNDLES[movement.to],
          metadata: {
            ...metadata,
            update_strategy: "appVersion",
            ...movement.metadata,
          },
        }
  ) as BundleEventRow;
};

/**
 * One installation's day and the next, in the order the owner measured them
 * (PRD decision 59): a first launch, a relaunch in the same hour and in the
 * next, a download and its apply two hours later, a recovery the hour after,
 * a relaunch the hour after that, and a launch on each of the next two UTC
 * days: an installation's day once it only launches. Between them, a failed
 * download and a failed update check, which move no head; and last, a
 * recovery that carries Android's exit reason.
 */
const SCENARIO = [
  {
    name: "First launch",
    event: () =>
      eventOf(D0 + 10 * HOUR + 5 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
  {
    name: "Same-hour relaunch",
    event: () =>
      eventOf(D0 + 10 * HOUR + 35 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
  {
    name: "Next-hour launch",
    event: () =>
      eventOf(D0 + 11 * HOUR + 5 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
  {
    name: "UPDATE_DOWNLOADED",
    event: () =>
      eventOf(D0 + 12 * HOUR + 5 * 60_000, {
        type: "UPDATE_DOWNLOADED",
        from: "a",
        to: "b",
        // A patch delivered it: its counters go in the rows downloads use.
        metadata: { delivery: "patch" },
      }),
  },
  {
    name: "UPDATE_APPLIED",
    event: () =>
      eventOf(D0 + 12 * HOUR + 35 * 60_000, {
        type: "UPDATE_APPLIED",
        from: "a",
        to: "b",
      }),
  },
  {
    name: "RECOVERED",
    event: () =>
      eventOf(D0 + 13 * HOUR + 5 * 60_000, {
        type: "RECOVERED",
        from: "b",
        to: "a",
      }),
  },
  {
    name: "Relaunch after the recovery",
    event: () =>
      eventOf(D0 + 14 * HOUR + 5 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
  {
    name: "UPDATE_FAILED",
    event: () =>
      eventOf(D0 + 14 * HOUR + 35 * 60_000, {
        type: "UPDATE_FAILED",
        from: "a",
        to: "b",
        metadata: {
          failure: {
            stage: "download",
            reason: "http",
            resource: "artifact",
            http_status: 403,
            origin_code: "AccessDenied",
          },
        },
      }),
  },
  {
    name: "UPDATE_FAILED (check)",
    event: () =>
      eventOf(D0 + 15 * HOUR + 5 * 60_000, {
        type: "UPDATE_FAILED",
        from: "a",
        to: "a",
        check: true,
        metadata: {
          failure: { stage: "check", reason: "http", http_status: 500 },
        },
      }),
  },
  {
    name: "Next-day launch",
    event: () =>
      eventOf(D0 + DAY + 9 * HOUR + 5 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
  {
    name: "Launch the day after",
    event: () =>
      eventOf(D0 + 2 * DAY + 9 * HOUR + 5 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
  {
    name: "RECOVERED with an exit reason",
    event: () =>
      eventOf(D0 + 2 * DAY + 10 * HOUR + 5 * 60_000, {
        type: "RECOVERED",
        from: "b",
        to: "a",
        // Android 11+: one breakdown row more.
        metadata: { previous_process_exit: "CRASH" },
      }),
  },
] as const;

/**
 * The most items and write units each event may take in its one transaction
 * (PRD decision 60). A relaunch the same UTC day, on the bundle its head
 * already names, writes nothing.
 */
const BUDGETS: Readonly<
  Record<(typeof SCENARIO)[number]["name"], { items: number; wru: number }>
> = {
  "First launch": { items: 15, wru: 40 },
  "Same-hour relaunch": { items: 0, wru: 0 },
  "Next-hour launch": { items: 0, wru: 0 },
  UPDATE_DOWNLOADED: { items: 19, wru: 42 },
  UPDATE_APPLIED: { items: 26, wru: 54 },
  RECOVERED: { items: 30, wru: 66 },
  "Relaunch after the recovery": { items: 0, wru: 0 },
  UPDATE_FAILED: { items: 14, wru: 36 },
  "UPDATE_FAILED (check)": { items: 9, wru: 22 },
  "Next-day launch": { items: 21, wru: 52 },
  "Launch the day after": { items: 19, wru: 48 },
  "RECOVERED with an exit reason": { items: 23, wru: 52 },
};

let local: DynamoDBLocal;
beforeAll(async () => {
  local = await startDynamoDBLocal();
}, 180_000);
afterAll(async () => {
  await local?.stop();
});

describe("Insights write budgets on DynamoDB Local", () => {
  it("records each event in one TransactWriteItems within its item and write-unit budget", async () => {
    const client = new DynamoDBClient(local.config);
    const writes: (readonly number[])[] = [];
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === "TransactWriteItemsCommand") {
          const { TransactItems = [] } = args.input as {
            TransactItems?: readonly TransactItem[];
          };
          writes.push(TransactItems.map(transactItemBytes));
        }
        return next(args);
      },
      // Before the document client marshalls, so values are plain.
      { step: "initialize", name: "writeBudgetMeter" },
    );
    const tableName = local.tableName();
    const store = createDynamoDBStore({ client, tableName });
    await store.migrations!.apply();
    const api = createDatabasePluginApis(createKvAdapter({ store }), [
      insights(),
    ]).insights;

    const measured: Record<string, Measured> = {};
    for (const step of SCENARIO) {
      writes.length = 0;
      await api.recordEvent(step.event());
      // No retries on a table only this case writes: one write at most.
      expect(writes.length, step.name).toBeLessThanOrEqual(1);
      const sizes = writes[0] ?? [];
      measured[step.name] = {
        items: sizes.length,
        wru: sizes.reduce((sum, bytes) => sum + writeUnits(bytes), 0),
        bytes: sizes.reduce((sum, bytes) => sum + bytes, 0),
      };
    }
    client.destroy();
    await local.dropTable(tableName);

    console.table(measured);
    for (const step of SCENARIO) {
      const { items, wru } = measured[step.name]!;
      expect(
        { items, wru },
        `${step.name}: ${items} items, ${wru} WRU`,
      ).toSatisfy(
        (value: { items: number; wru: number }) =>
          value.items <= BUDGETS[step.name].items &&
          value.wru <= BUDGETS[step.name].wru,
      );
    }
  });
});

/**
 * Batched aggregates (PRD decision 59 (5)): the aggregate write units an
 * event costs, transactional against batched, over 60 simulated seconds at a
 * steady rate. Each event is a returning installation's first launch of the
 * UTC day, or one in 20 a download and one in 20 an apply, across ios and
 * android. Log mode compacts on its 60-second window; memory mode flushes
 * every 15 simulated seconds, as its timer would. With
 * HOT_UPDATER_WRITE_BUDGET_RATES=1 it measures 1, 10, and 100 events a second,
 * appending one JSON line per run to HOT_UPDATER_WRITE_BUDGET_OUT when set
 * (plans/evidence/insights-batched-aggregates.md); otherwise 10.
 */
const BATCHED_RATES =
  process.env.HOT_UPDATER_WRITE_BUDGET_RATES === "1" ? [1, 10, 100] : [10];
const BATCHED_SECONDS = 60;
const MEMORY_WINDOW_MS = 15_000;

type Mode = "transaction" | "log" | "memory";

interface BatchItem {
  readonly DeleteRequest?: { readonly Key: Record<string, unknown> };
}

/** Where an item lands: an aggregate row, the batching log or lease, or an event's own rows. */
const partitionOf = (item: TransactItem) => {
  const pk = String(
    (item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key)?.pk ??
      item.ConditionCheck?.Key.pk,
  );
  if (pk.startsWith("aggregate_log_")) return "log";
  if (pk.startsWith("aggregate_lease")) return "lease";
  return pk.startsWith("insights_") ? "aggregate" : "event";
};

const populationEvent = (
  n: number,
  install: number,
  receivedAt: number,
  type: BundleEventRow["type"],
): BundleEventRow => {
  const moving = type !== "UNCHANGED";
  return {
    id: `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    install_id: `install-${install}`,
    user_id: `user-${install}`,
    platform: install % 2 === 0 ? "ios" : "android",
    app_version: "1.0.0",
    channel: "production",
    received_at_ms: receivedAt,
    type,
    from_release_id: moving ? RELEASES.a : null,
    from_bundle_id: moving ? BUNDLES.a : null,
    to_release_id: moving ? RELEASES.b : RELEASES.a,
    to_bundle_id: moving ? BUNDLES.b : BUNDLES.a,
    metadata: {
      cohort: "1",
      fingerprint_hash: null,
      sdk_version: "1.0.0",
      update_strategy: moving ? "appVersion" : null,
    },
  } as BundleEventRow;
};

/**
 * Write units a run costs: the events' own rows, and everything their
 * aggregates cost, which is the log rows the events write plus each flush:
 * a compaction (its lease, group writes, and deletes) or a memory flush.
 */
const measureBatching = async (mode: Mode, rate: number) => {
  const client = new DynamoDBClient(local.config);
  const logBytes = new Map<string, number>();
  const cost = {
    event: 0,
    aggregate: 0,
    aggregateItems: 0,
    logPuts: 0,
    leaseWrites: 0,
    memoryFlushes: 0,
  };
  let metering = false;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (metering && context.commandName === "TransactWriteItemsCommand") {
        const { TransactItems = [] } = args.input as {
          TransactItems?: readonly TransactItem[];
        };
        const kinds = TransactItems.map(partitionOf);
        // A compaction takes and releases the lease in writes of their own.
        if (kinds.every((kind) => kind === "lease")) cost.leaseWrites += 1;
        for (const item of TransactItems) {
          const bytes = transactItemBytes(item);
          const kind = partitionOf(item);
          const key = item.Put?.Item ?? item.Delete?.Key;
          const id = key && `${key.pk}|${key.sk}`;
          if (kind === "log" && item.Put && id) logBytes.set(id, bytes);
          const units = writeUnits(
            kind === "log" && item.Delete && id
              ? (logBytes.get(id) ?? bytes)
              : bytes,
          );
          if (kind === "log" && kinds.includes("event")) cost.logPuts += units;
          if (kind === "event") cost.event += units;
          else
            [cost.aggregate, cost.aggregateItems] = [
              cost.aggregate + units,
              cost.aggregateItems + 1,
            ];
        }
      }
      if (metering && context.commandName === "BatchWriteItemCommand") {
        // Plain deletes of applied log rows: 1 write unit per KB each.
        const { RequestItems = {} } = args.input as {
          RequestItems?: Record<string, readonly BatchItem[]>;
        };
        for (const { DeleteRequest } of Object.values(RequestItems).flat()) {
          const { pk, sk } = DeleteRequest!.Key;
          const bytes = logBytes.get(`${pk}|${sk}`) ?? 1;
          cost.aggregate += Math.max(1, Math.ceil(bytes / 1024));
          cost.aggregateItems += 1;
        }
      }
      return next(args);
    },
    { step: "initialize", name: "batchingMeter" },
  );
  const tableName = local.tableName();
  const store = createDynamoDBStore({ client, tableName });
  await store.migrations!.apply();
  const adapter = createKvAdapter({ store });
  const module = { id: "insights", schema: insightsSchema } as const;
  const schema = resolveSchema([module, aggregateBatchingModule]);
  let clock = D0 + 9 * HOUR;
  const now = () => clock;
  const apiOf = (batching?: AggregateBatching) => {
    const engine = createDatabaseEngine({
      adapter,
      schema,
      ...(batching === undefined ? {} : { batching, now }),
    });
    const { api } = insights().init({
      db: engine.database(module),
      // Insights never reads core.
      core: {} as CoreReader,
      now,
    });
    return { api, flush: engine.flush };
  };
  const count = rate * BATCHED_SECONDS;
  // Every installation launched the day before; that is not measured.
  const seed = apiOf();
  for (let at = 0; at < count; at += 16) {
    await Promise.all(
      Array.from({ length: Math.min(16, count - at) }, (_, n) =>
        seed.api.recordEvent(
          populationEvent(at + n, at + n, D0 + 9 * HOUR + at + n, "UNCHANGED"),
        ),
      ),
    );
  }
  const run = apiOf(
    mode === "transaction"
      ? undefined
      : mode === "log"
        ? { mode }
        : // Flushed below at each simulated window, not on its timer.
          { mode, windowMs: 3_600_000 },
  );
  metering = true;
  const start = D0 + DAY + 10 * HOUR;
  for (let n = 0; n < count; n += 1) {
    const at = start + Math.floor((n * 1000) / rate);
    const window = (ms: number) => Math.floor((ms - start) / MEMORY_WINDOW_MS);
    if (mode === "memory" && n > 0 && window(at) > window(clock)) {
      const before = cost.aggregate;
      await run.flush();
      if (cost.aggregate > before) cost.memoryFlushes += 1;
    }
    clock = at;
    const type =
      n % 20 === 0
        ? "UPDATE_DOWNLOADED"
        : n % 20 === 1
          ? "UPDATE_APPLIED"
          : "UNCHANGED";
    await run.api.recordEvent(populationEvent(count + n, n, clock, type));
  }
  clock = start + BATCHED_SECONDS * 1000;
  const before = cost.aggregate;
  await run.flush();
  if (mode === "memory" && cost.aggregate > before) cost.memoryFlushes += 1;
  metering = false;
  client.destroy();
  await local.dropTable(tableName);
  const flushes = mode === "log" ? cost.leaseWrites / 2 : cost.memoryFlushes;
  return {
    mode,
    rate,
    events: count,
    eventWru: cost.event / count,
    aggregateWru: cost.aggregate / count,
    aggregateItems: cost.aggregateItems / count,
    flushes,
    wruPerFlush: flushes && (cost.aggregate - cost.logPuts) / flushes,
  };
};

describe("Insights write budgets with batched aggregates on DynamoDB Local", () => {
  it("cuts an event's aggregate write units at least tenfold at 10 events a second and above", async () => {
    const rows = [];
    for (const rate of BATCHED_RATES) {
      const runs = [];
      for (const mode of ["transaction", "log", "memory"] as const) {
        const row = await measureBatching(mode, rate);
        runs.push(row);
        if (process.env.HOT_UPDATER_WRITE_BUDGET_OUT) {
          appendFileSync(
            process.env.HOT_UPDATER_WRITE_BUDGET_OUT,
            `${JSON.stringify(row)}\n`,
          );
        }
      }
      rows.push(...runs);
      const [transaction, log, memory] = runs as [
        (typeof runs)[number],
        (typeof runs)[number],
        (typeof runs)[number],
      ];
      if (rate < 10) continue;
      expect(log.aggregateWru * 10, `log at ${rate}/s`).toBeLessThanOrEqual(
        transaction.aggregateWru,
      );
      expect(
        memory.aggregateWru * 10,
        `memory at ${rate}/s`,
      ).toBeLessThanOrEqual(transaction.aggregateWru);
    }
    console.table(rows);
  }, 1_800_000);
});
