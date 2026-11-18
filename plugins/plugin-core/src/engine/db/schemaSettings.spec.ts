import { describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../database/memoryAdapter";
import { readSettings } from "../database/fence";
import {
  coreSettings,
  migrateCoreSchema,
  toolingTargetOf,
} from "./coreDatabase";
import { writeSchemaSettings } from "./schemaSettings";

describe("migrateCoreSchema, which a managed provider's init runs", () => {
  it("refuses a database a newer release migrated, and leaves its settings as they were", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB");
    await writeSchemaSettings(
      adapter,
      "dynamoDB",
      { "schema.core": "1.3.0" },
      [],
    );

    await expect(migrateCoreSchema(adapter, "dynamoDB")).rejects.toThrow(
      `dynamoDB: the database was migrated by Hot Updater 1.3.0 (schema.core "1.3.0", this CLI's "${coreSettings["schema.core"]}"). Upgrade hot-updater to 1.3.0 or later; nothing was written.`,
    );
    const [row] = await readSettings(adapter, ["schema.core"]);
    expect(row?.value).toBe("1.3.0");
  });
});

describe("the settings a migration never moves back", () => {
  /** A plugin as its factory returns it; official ones carry the brand. */
  const plugin = (id: string, official: boolean) =>
    Object.assign(
      { id, schemaVersion: "1.0.0", schema: {} },
      official
        ? { [Symbol.for("@hot-updater/server/official-plugin")]: true }
        : {},
    );

  it("are the engine's, core's and the official plugins'", () => {
    expect(
      toolingTargetOf([plugin("insights", true), plugin("notes", false)])
        .ordered,
    ).toEqual(["schema.engine", "schema.core", "schema.insights"]);
  });

  it("refuses an official plugin's newer version, and records a plugin of your own as configured", async () => {
    const adapter = createMemoryAdapter();
    const plugins = [plugin("insights", true), plugin("notes", false)];
    await migrateCoreSchema(adapter, "memory", plugins);
    await writeSchemaSettings(
      adapter,
      "memory",
      { "schema.insights": "1.1.0", "schema.notes": "2.0.0" },
      [],
    );
    await expect(migrateCoreSchema(adapter, "memory", plugins)).rejects.toThrow(
      'memory: the database was migrated by a newer Hot Updater (schema.insights "1.1.0", this CLI\'s "1.0.0"). Upgrade hot-updater and its plugins to that version; nothing was written.',
    );

    await writeSchemaSettings(
      adapter,
      "memory",
      { "schema.insights": "1.0.0" },
      [],
    );
    await migrateCoreSchema(adapter, "memory", plugins);
    const [notes] = await readSettings(adapter, ["schema.notes"]);
    expect(notes?.value).toBe("1.0.0");
  });
});
