import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { createKvAdapter } from "@hot-updater/server/database";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import { insights } from "@hot-updater/server/plugins/insights";
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
        readonly type: "UPDATE_DOWNLOADED" | "UPDATE_APPLIED" | "RECOVERED";
        readonly from: "a" | "b";
        readonly to: "a" | "b";
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
    username: "Alex",
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
          to_release_id: RELEASES[movement.to],
          to_bundle_id: BUNDLES[movement.to],
          metadata: { ...metadata, update_strategy: "appVersion" },
        }
  ) as BundleEventRow;
};

/**
 * One installation's day and the next, in the order the owner measured them
 * (PRD decision 59): a first launch, a relaunch in the same hour and in the
 * next, a download and its apply two hours later, a recovery the hour after,
 * a relaunch the hour after that, and a launch the next UTC day.
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
    name: "Next-day launch",
    event: () =>
      eventOf(D0 + DAY + 9 * HOUR + 5 * 60_000, {
        type: "UNCHANGED",
        bundle: "a",
      }),
  },
] as const;

/** The most items and write units each event may take in its one transaction. */
const BUDGETS: Readonly<
  Record<(typeof SCENARIO)[number]["name"], { items: number; wru: number }>
> = {
  "First launch": { items: 27, wru: 76 },
  "Same-hour relaunch": { items: 12, wru: 24 },
  "Next-hour launch": { items: 26, wru: 64 },
  UPDATE_DOWNLOADED: { items: 27, wru: 62 },
  UPDATE_APPLIED: { items: 27, wru: 58 },
  RECOVERED: { items: 33, wru: 78 },
  "Relaunch after the recovery": { items: 28, wru: 68 },
  "Next-day launch": { items: 31, wru: 84 },
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
