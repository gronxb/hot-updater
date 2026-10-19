import { describe, expect, it } from "vitest";

import {
  isSchemaMigrationRequiredError,
  toPublicSchemaError,
} from "./schema-migration";

/** The schema fence's error as plugin-core throws it, with the driver error behind it. */
const fenceError = () =>
  Object.assign(
    new Error('"schema.vault" is missing; expected "1".', {
      cause: new Error("driver"),
    }),
    {
      name: "HotUpdaterSchemaMigrationRequiredError",
      adapterName: "d1Database",
      setting: { key: "schema.vault", expected: "1", found: null },
      settings: [{ key: "schema.vault", expected: "1", found: null }],
      plugins: ["vault"],
    },
  );

describe("toPublicSchemaError", () => {
  it("sends the fence's settings and plugins with 503, and not the driver error", () => {
    const sent = toPublicSchemaError(fenceError());

    expect(isSchemaMigrationRequiredError(sent)).toBe(true);
    expect(sent).toMatchObject({
      name: "HotUpdaterSchemaMigrationRequiredError",
      message: '"schema.vault" is missing; expected "1".',
      settings: [{ key: "schema.vault", expected: "1", found: null }],
      plugins: ["vault"],
      status: 503,
    });
    expect((sent as Error).cause).toBeUndefined();
    expect(Object.keys(sent as object).sort()).toEqual([
      "name",
      "plugins",
      "settings",
      "status",
    ]);
  });

  it("leaves any other error as it is", () => {
    const error = new Error("Offline");

    expect(toPublicSchemaError(error)).toBe(error);
    expect(isSchemaMigrationRequiredError(error)).toBe(false);
  });
});
