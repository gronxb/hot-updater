import { createEngine, createMemoryAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createVaultApi, VaultInputError } from "./api";
import { vault } from "./index";

/** A vault on one in-memory database, counting the database's reads. */
const start = () => {
  const plugin = vault();
  const db = createEngine(
    { name: "memory", adapter: createMemoryAdapter() },
    { plugins: [plugin] },
  ).database(plugin);
  let reads = 0;
  const counted: typeof db = {
    findOne: (...args) => {
      reads += 1;
      return db.findOne(...args);
    },
    findByKeys: (...args) => {
      reads += 1;
      return db.findByKeys(...args);
    },
    findMany: (...args) => {
      reads += 1;
      return db.findMany(...args);
    },
    findAggregates: (...args) => {
      reads += 1;
      return db.findAggregates(...args);
    },
    transaction: (fn) => db.transaction(fn),
  };
  return {
    api: createVaultApi({ db: counted, now: () => 5_000, options: {} }),
    db,
    reads: () => reads,
  };
};

describe("vault audit log", () => {
  it("appends entries in one write, reading nothing", async () => {
    const { api, db, reads } = start();
    await api.recordAudit({
      entries: [
        {
          actor: "tok-ci",
          action: "read",
          secretId: "sec-keystore",
          outcome: "allowed",
          context: { name: "release-keystore", ciRun: "run-1" },
        },
        { actor: "tok-ci", action: "list", outcome: "allowed" },
        {
          actor: "tok-ci",
          action: "read",
          outcome: "denied",
          context: { name: "asc-api-key" },
        },
      ],
    });

    expect(reads()).toBe(0);
    const { rows } = await db.findMany("audit", {
      index: "byTime",
      where: {},
      limit: 10,
    });
    expect(
      [...rows].sort((left, right) =>
        left.action === right.action
          ? left.outcome.localeCompare(right.outcome)
          : left.action.localeCompare(right.action),
      ),
    ).toEqual([
      {
        id: expect.stringMatching(/^aud-/u),
        at_ms: 5_000,
        actor: "tok-ci",
        action: "list",
        secret_id: null,
        outcome: "allowed",
        context: {},
      },
      {
        id: expect.stringMatching(/^aud-/u),
        at_ms: 5_000,
        actor: "tok-ci",
        action: "read",
        secret_id: "sec-keystore",
        outcome: "allowed",
        context: { name: "release-keystore", ciRun: "run-1" },
      },
      {
        id: expect.stringMatching(/^aud-/u),
        at_ms: 5_000,
        actor: "tok-ci",
        action: "read",
        secret_id: null,
        outcome: "denied",
        context: { name: "asc-api-key" },
      },
    ]);
  });

  it("refuses an entry the log cannot hold, writing none of the batch", async () => {
    const { api, db } = start();
    for (const entry of [
      { actor: "", action: "read", outcome: "allowed" },
      { actor: "tok-ci", action: "write", outcome: "allowed" },
      { actor: "tok-ci", action: "read", outcome: "maybe" },
      {
        actor: "tok-ci",
        action: "read",
        outcome: "allowed",
        context: { blob: "x".repeat(5_000) },
      },
    ]) {
      await expect(
        api.recordAudit({
          entries: [
            { actor: "tok-ci", action: "list", outcome: "allowed" },
            entry as never,
          ],
        }),
      ).rejects.toBeInstanceOf(VaultInputError);
    }
    const { rows } = await db.findMany("audit", {
      index: "byTime",
      where: {},
      limit: 10,
    });
    expect(rows).toEqual([]);
  });
});
