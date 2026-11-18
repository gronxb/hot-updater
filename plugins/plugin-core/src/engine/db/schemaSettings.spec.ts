import { describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../database/memoryAdapter";
import { readSettings } from "../database/fence";
import { coreSettings, migrateCoreSchema } from "./coreDatabase";
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
