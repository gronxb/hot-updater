import { HotUpdaterSchemaMigrationRequiredError } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { isSchemaFenceRefusal } from "./schemaFenceRefusal";

describe("isSchemaFenceRefusal", () => {
  it("recognizes the fence's error, from this or another copy of plugin-core, and nothing else", () => {
    expect(
      isSchemaFenceRefusal(
        new HotUpdaterSchemaMigrationRequiredError("kysely", undefined, {
          key: "schema.core",
          expected: "1.0.0",
          found: "1.2.0",
        }),
      ),
    ).toBe(true);
    expect(
      isSchemaFenceRefusal(
        Object.assign(new Error("copy"), {
          name: "HotUpdaterSchemaMigrationRequiredError",
        }),
      ),
    ).toBe(true);
    expect(isSchemaFenceRefusal(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isSchemaFenceRefusal("HotUpdaterSchemaMigrationRequiredError")).toBe(
      false,
    );
  });
});
