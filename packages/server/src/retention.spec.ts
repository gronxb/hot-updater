import { definePlugin, defineTable } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./index";
import { createRuntimeDatabase } from "./runtime.testFixtures";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A plugin whose notes expire a day after their `at`. */
const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      {
        id: { type: "string", maxLength: 36 },
        at: { type: "integer" },
      },
      { key: ["id"], retention: { field: "at", days: 1 } },
    ),
  },
  init: ({ db }) => ({
    api: {
      write: (id: string, at: number) =>
        db.transaction(async (tx) => {
          tx.create("notes", { id, at });
        }),
      read: (id: string) => db.findOne("notes", { id }),
    },
  }),
});

const createServer = (database = createRuntimeDatabase()) =>
  createHotUpdater({ clientAccess: "public", database, plugins: [notes] });

describe("server retention", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes before the write that takes the lease, which keeps what it writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const hotUpdater = createServer();
    // A fresh database: the first write takes the lease with nothing to prune.
    await hotUpdater.api.notes.write("old", Date.now() - 2 * DAY);
    await expect(hotUpdater.api.notes.read("old")).resolves.not.toBeNull();

    vi.setSystemTime(Date.now() + HOUR + 1);
    await hotUpdater.api.notes.write("new", Date.now());
    await expect(hotUpdater.api.notes.read("old")).resolves.toBeNull();
    await expect(hotUpdater.api.notes.read("new")).resolves.not.toBeNull();
  });

  it("prunes during a write once the lease is due, on one server an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const database = createRuntimeDatabase();
    const [one, two] = [createServer(database), createServer(database)];

    // The first write takes the lease, due in an hour; nothing has expired.
    await one.api.notes.write("fresh", Date.now());
    // Within the hour no write prunes: the other server reads the lease.
    await two.api.notes.write("stale", Date.now() - 2 * DAY);
    await one.api.notes.write("second", Date.now());
    await expect(one.api.notes.read("stale")).resolves.not.toBeNull();

    // Once it is due, the next write, on either server, takes it and prunes.
    vi.setSystemTime(Date.now() + HOUR + 1);
    await two.api.notes.write("third", Date.now());
    await expect(one.api.notes.read("stale")).resolves.toBeNull();
    await expect(one.api.notes.read("fresh")).resolves.not.toBeNull();
  });
});
