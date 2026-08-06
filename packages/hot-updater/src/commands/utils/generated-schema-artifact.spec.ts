import path from "path";

import { describe, expect, it } from "vitest";

import { resolveGeneratedSchemaOutputPath } from "./generated-schema-artifact";

describe("generated schema artifact", () => {
  it("resolves relative artifact paths inside the selected output directory", () => {
    expect(
      resolveGeneratedSchemaOutputPath(
        { code: "export {};", path: "db/hot-updater-schema.ts" },
        "/repo/out",
      ),
    ).toBe(path.resolve("/repo/out/db/hot-updater-schema.ts"));
  });

  it("rejects absolute artifact paths", () => {
    expect(() =>
      resolveGeneratedSchemaOutputPath(
        { code: "export {};", path: "/tmp/hot-updater-schema.ts" },
        "/repo/out",
      ),
    ).toThrow("Generated schema path must be relative");
  });

  it("rejects artifact paths escaping the selected output directory", () => {
    expect(() =>
      resolveGeneratedSchemaOutputPath(
        { code: "export {};", path: "../hot-updater-schema.ts" },
        "/repo/out",
      ),
    ).toThrow("Generated schema path escapes output directory");
  });
});
