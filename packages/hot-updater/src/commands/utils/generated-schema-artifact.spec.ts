import path from "path";

import { describe, expect, it } from "vitest";

import { resolveGeneratedSchemaOutputPath } from "./generated-schema-artifact";
import { resolveGeneratedSchemaPlaceholderPath } from "./generated-schema-placeholder";

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

  it("rejects placeholder imports that resolve outside the project directory", () => {
    const error = Object.assign(
      new Error("Cannot find module '../../hot-updater-schema'"),
      {
        requireStack: ["/repo/project/src/db.ts"],
      },
    );

    expect(resolveGeneratedSchemaPlaceholderPath(error, "/repo/project")).toBe(
      undefined,
    );
  });

  it("accepts exact placeholder paths reported as absolute by the loader", () => {
    const error = Object.assign(
      new Error("Cannot find module '/repo/project/hot-updater-schema'"),
      {
        requireStack: ["/repo/project/src/db.ts"],
      },
    );

    expect(resolveGeneratedSchemaPlaceholderPath(error, "/repo/project")).toBe(
      path.resolve("/repo/project/hot-updater-schema.ts"),
    );
  });
});
