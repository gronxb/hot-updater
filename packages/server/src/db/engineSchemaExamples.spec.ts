import fs from "node:fs";
import path from "node:path";

import { toolingTargetOf } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { generateDrizzleEngineSchema } from "./engineDrizzleSchema";
import { generatePrismaEngineSchema } from "./enginePrismaSchema";

const examples = path.resolve(
  import.meta.dirname,
  "../../../../examples-server",
);
const read = (file: string) =>
  fs.readFileSync(path.join(examples, file), "utf8");

/** Core's tables alone: `native_builds` reads the same in every example. */
const { schema } = toolingTargetOf([]);

const prismaModel = (code: string) =>
  code.match(/model native_builds \{[^}]*\}/u)?.[0];
const drizzleTable = (code: string) =>
  code.match(/export const native_builds = [\s\S]*?\n\]\);/u)?.[0];

describe("native_builds in the examples' generated schemas", () => {
  it.each([
    ["sqlite", "express-prisma-sqlite/prisma/schema.prisma"],
    ["postgresql", "hono-prisma-postgres/prisma/schema.prisma"],
  ] as const)("matches Prisma on %s (%s)", (provider, file) => {
    const generated = prismaModel(generatePrismaEngineSchema(provider, schema));
    expect(prismaModel(read(file))).toBe(generated);
  });

  it.each([
    ["sqlite", "elysia-drizzle-libsql/hot-updater-schema.ts"],
    ["postgresql", "hono-drizzle-pglite/hot-updater-schema.ts"],
  ] as const)("matches Drizzle on %s (%s)", (dialect, file) => {
    const generated = drizzleTable(
      generateDrizzleEngineSchema(dialect, schema),
    );
    expect(drizzleTable(read(file))).toBe(generated);
  });

  it("holds its booleans NOT NULL and one store build per scope in a slot", () => {
    const prisma = prismaModel(
      generatePrismaEngineSchema("postgresql", schema),
    );
    expect(prisma).toContain("  is_store_build Boolean\n");
    expect(prisma).toContain("  is_sandbox Boolean\n");
    expect(prisma).toContain(
      "  store_build_scope_key String? @db.VarChar(2048)",
    );
    expect(prisma).toContain(
      '@@unique([store_build_scope_key], map: "native_builds_byStoreBuild")',
    );
    expect(prisma).not.toMatch(/\bstore_build\b(?!_)/u);
  });
});
