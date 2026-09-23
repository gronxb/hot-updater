import { createPluginTestHarness } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import * as engine from "../database";
import { defineTable } from "../database/schema";
import { definePlugin } from "./definePlugin";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      {
        id: { type: "string" },
        text: { type: "string" },
        at: { type: "integer" },
      },
      { key: ["id"], indexes: { byTime: { eq: [], sort: ["at"] } } },
    ),
  },
  init: ({ db, now }) => ({
    api: {
      add: (id: string, text: string) =>
        db.transaction(async (tx) => {
          tx.create("notes", { id, text, at: now() });
        }),
      latest: () =>
        db.findMany("notes", {
          index: "byTime",
          where: {},
          order: "desc",
          limit: 2,
        }),
    },
  }),
});

describe("plugin test harness", () => {
  it("runs a plugin on a namespaced memory database and measures its reads", async () => {
    const harness = await createPluginTestHarness(notes, {
      engine,
      now: () => 1,
    });
    await harness.api.add("a", "first");
    harness.setNow(() => 2);
    await harness.api.add("b", "second");
    harness.setNow(() => 3);
    await harness.api.add("c", "third");

    expect(harness.tables.map(({ name }) => name)).toEqual(["notes_notes"]);
    const measured = await harness.measureReads(() => harness.api.latest());
    expect(measured.result.rows.map(({ id }) => id)).toEqual(["c", "b"]);
    expect(measured.adapter.rows).toBe(measured.engine.rows);
    expect(measured.engine).toEqual({ calls: 1, rows: 2 });
  });
});
